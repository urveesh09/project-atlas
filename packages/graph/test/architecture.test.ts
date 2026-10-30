import { describe, it, expect } from 'vitest';
import { canonicalJson, canonicalJsonSha256, type ArchitecturePolicy } from '@atlas/schema';
import { architectureExit, architectureMarkdown, parseArchitecturePolicy, reviewArchitecture, validateArchitectureReview } from '@atlas/graph';
import { architectureAnalysis as analysis, architectureFixture as graph } from './architecture-fixture.js';
const boundary: ArchitecturePolicy = { format: 'atlas.architecture-policy/1', rules: [{ id: 'no-prod-tests', kind: 'forbidden-dependency', from: { roles: ['source'] }, to: { roles: ['test'] }, edgeKinds: ['imports-value', 'imports-type'] }, { id: 'cycles', kind: 'cycle' }] };
const paths = ['src/main.ts', 'tests/support.ts', 'src/lib.ts'];
const roles = ['source', 'test', 'source'] as const;
const run = (g: ReturnType<typeof graph>, policy = boundary, baseline: ReturnType<typeof graph> | null = null) => reviewArchitecture(analysis, g, policy, baseline);
describe('authored architecture expectations', () => {
  it('fails closed if bounded rows would still exceed the output byte ceiling', () => {
    const paths = Array.from({length:1100},(_,i)=>`${'x'.repeat(4000)}/f${i}.ts`);
    const g = graph('a',paths,paths.map((_,i)=>[i,(i+1)%paths.length]));
    const p: ArchitecturePolicy = {format:'atlas.architecture-policy/1',rules:[{id:'all',kind:'forbidden-dependency',from:{paths:['']},to:{paths:['']},edgeKinds:['imports-value']}]};
    expect(() => run(g,p)).toThrow(/8 MiB/);
  });
  it('exposes missing lineage and baseline coverage rather than manufacturing certainty', () => {
    const now = graph('b',paths,[],{roles:[...roles]}),old = graph('a',paths,[],{roles:[...roles]});
    const file = now.nodes.find(n=>n.kind==='file')!; file.lineageId=null;
    old.coverage.limitsHit=['EVIDENCE_LIMIT'];
    expect(run(now,boundary,old).reasons).toEqual(['baseline-coverage','lineage-unavailable']);
  });
  it('preserves case/Unicode distinctions, literal wildcard paths and bounded statement evidence', () => {
    const g=graph('a',['Src/A.ts','src/A.ts','src/é.ts','src/é.ts','tests/*.ts'],Array.from({length:7},()=>[0,4]),{roles:['source','source','source','source','test']});
    const p:ArchitecturePolicy={format:'atlas.architecture-policy/1',rules:[{id:'literal',kind:'forbidden-dependency',from:{paths:['Src/A.ts']},to:{paths:['tests/*.ts']},edgeKinds:['imports-value']}]};
    const r=run(g,p);expect(r.rules[0]).toMatchObject({current:1,currentFrom:1,currentTo:1});
    expect(r.rows[0]).toMatchObject({edge:{observations:7,evidenceOmitted:3}});
    if(r.rows[0]?.kind==='forbidden-dependency')expect(r.rows[0].edge.locations).toHaveLength(4);
    const mixed = structuredClone(p); if(mixed.rules[0]?.kind==='forbidden-dependency')mixed.rules[0].from.paths=['src/é.ts'];
    expect(run(g,mixed).rules[0]).toMatchObject({current:0,currentFrom:1});
    const other = graph('a',['www.evil.com.ts','tests/helper.ts'],[[0,1]],{roles:['source','test']});
    expect(architectureMarkdown(run(other))).not.toContain('www.evil.com');
  });
  it('compares relation lineage, not snapshot IDs or paths; counts duplicate statements once', () => {
    const old = graph('a', paths, [[0, 1], [0, 1]], { roles: [...roles] });
    const now = graph('b', ['src/renamed.ts', ...paths.slice(1)], [[0, 1], [0, 1], [2, 1, 'imports-type']], { roles: [...roles] });
    const r = run(now, boundary, old);
    expect(r.rules.find(r => r.ruleId === 'no-prod-tests')).toMatchObject({ current: 2, baseline: 1, newlyObserved: 1, continuing: 1, noLongerObserved: 0 });
    expect(r.rows.map(r => r.state).sort()).toEqual(['continuing', 'newly-observed']);
    expect(r.rows.find(r => r.state === 'continuing')).toMatchObject({ edge: { observations: 2, from: { path: 'src/renamed.ts' } } });
    expect(architectureExit(r)).toBe(0);
    expect(architectureExit(r, 'new')).toBe(3);
    expect(canonicalJson(r)).not.toContain('PRIVATE_SOURCE_SENTINEL');
    expect(validateArchitectureReview(canonicalJson(r), analysis, now, old)).toEqual(r);
  });
  it('does not carry identity into a recreated file and does not label disappearance fixed', () => {
    const old = graph('a', paths, [[0, 1]], { roles: [...roles] });
    const now = graph('b', paths, [[0, 1]], { roles: [...roles], lineages: ['recreated', '1', '2'] });
    expect(run(now, boundary, old).rules.find(r => r.ruleId === 'no-prod-tests')).toMatchObject({ newlyObserved: 1, continuing: 0, noLongerObserved: 1 });
    const removed = run(graph('c', paths, [], { roles: [...roles] }), boundary, old);
    expect(removed.rules.find(r => r.ruleId === 'no-prod-tests')?.noLongerObserved).toBe(1);
    expect(canonicalJson(removed)).not.toContain('"resolved"');
  });
  it('uses AND between selector fields, OR inside fields, exact package paths and segment prefixes', () => {
    const p: ArchitecturePolicy = { format: 'atlas.architecture-policy/1', rules: [{ id: 'boundary', kind: 'forbidden-dependency', from: { paths: ['apps/web'], packages: ['apps/web'], roles: ['source'] }, to: { packages: ['apps/api'] }, edgeKinds: ['imports-value'] }] };
    const g = graph('a', ['apps/web/index.ts', 'apps/webish/index.ts', 'apps/api/index.ts'], [[0, 2], [1, 2]], { packages: ['apps/web', 'apps/web', 'apps/api'] });
    expect(run(g, p).rules[0]).toMatchObject({ current: 1, currentFrom: 1, currentTo: 1 });
  });
  it('includes inferred evidence explicitly but excludes unnamed dynamic/type edges from cycles', () => {
    const g = graph('a', paths, [[0, 1, 'imports-value', 'inferred'], [1, 0, 'imports-type'], [2, 0, 'imports-dynamic-literal']], { roles: [...roles] });
    const r = run(g);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ edge: { confidence: 'inferred' } });
    expect(r.rules.find(r => r.ruleId === 'cycles')?.current).toBe(0);
  });
  it('retains continuing and newly observed static SCCs and valid self-edge witnesses', () => {
    const old = graph('a', paths, [[0, 1], [1, 0]], { roles: [...roles] });
    const now = graph('b', paths, [[0, 1], [1, 0], [2, 2]], { roles: [...roles] });
    const p: ArchitecturePolicy = { format: 'atlas.architecture-policy/1', rules: [{ id: 'cycles', kind: 'cycle' }] };
    const r = run(now, p, old);
    expect(r.rules[0]).toMatchObject({ current: 2, baseline: 1, newlyObserved: 1, continuing: 1 });
    for (const row of r.rows)
      if (row.kind === 'cycle') {
        expect(row.witnessUnavailable).toBe(false);
        expect(row.witness[0]!.from.nodeId).toBe(row.witness.at(-1)!.to.nodeId);
      }
    const inside = run(graph('c', paths, [[0, 1], [1, 0], [0, 0]], { roles: [...roles] }), p, old);
    expect(inside.rules[0]?.continuing).toBe(1); // components, not every simple cycle
  });
  it('does not present a truncated long path as a closed cycle', () => {
    const n = 80, g = graph('a', Array.from({ length: n }, (_, i) => `f${i}.ts`), Array.from({ length: n }, (_, i) => [i, (i + 1) % n]));
    const r = run(g, { format: 'atlas.architecture-policy/1', rules: [{ id: 'cycles', kind: 'cycle' }] });
    expect(r.rows[0]).toMatchObject({ memberCount: 80, membersOmitted: 48, witness: [], witnessUnavailable: true });
    expect(r.reasons).toContain('evidence-limit');
  });
  it('counts every match even when retained evidence is capped', () => {
    const n = 2010, g = graph('a', Array.from({ length: n }, (_, i) => `f${i}.ts`), Array.from({ length: n }, (_, i) => [i, (i + 1) % n]));
    const p: ArchitecturePolicy = { format: 'atlas.architecture-policy/1', rules: [{ id: 'all', kind: 'forbidden-dependency', from: { paths: [''] }, to: { paths: [''] }, edgeKinds: ['imports-value'] }] };
    const r = run(g, p);
    expect(r.rules[0]?.current).toBe(n);
    expect(r.rows).toHaveLength(2000);
    expect(r.rowsOmitted).toBe(10);
    expect(architectureExit(r)).toBe(2);
    expect(architectureExit(r, 'all')).toBe(3);
  });
  it('never treats partial coverage or unmatched selectors as a clean evaluation', () => {
    const g = graph('a', paths, [], { roles: [...roles] });
    g.coverage.unresolved = 1;
    const r = run(g);
    expect(r.reasons).toEqual(['current-coverage']);
    expect(architectureExit(r, 'all')).toBe(2);
    expect(architectureMarkdown(r)).toContain('Current imports: 0 internal; 0 external; 0 built-in; 1 unresolved;');
    expect(architectureMarkdown(r)).toContain('Current snapshot has exclusions');
    const empty = run(graph('b', ['only.ts'], []));
    expect(empty.reasons).toContain('unmatched-selector');
    expect(() => architectureExit(r, 'new')).toThrow(/baseline/);
  });
  it('is stable under input and policy permutations and rejects report tampering', () => {
    const a = graph('a', paths, [[0, 1], [1, 0], [2, 1, 'imports-type']], { roles: [...roles] });
    const r = run(a), b = structuredClone(a);
    // Portability golden only; the independent cases above establish rule semantics.
    expect(r.rules.map(r => [r.ruleId,r.current])).toEqual([['cycles',1],['no-prod-tests',2]]);
    expect(canonicalJsonSha256(r)).toBe('65f60e0d0dfc1dd2867a3a1830af3930deff7b3deaab4be2dc7988798bf962dd');
    b.nodes.reverse();
    b.edges.reverse();
    b.importObservations.reverse();
    expect(run(b, { ...boundary, rules: [...boundary.rules].reverse() })).toEqual(r);
    const changed = structuredClone(r);
    changed.rules[0]!.current++;
    expect(() => validateArchitectureReview(canonicalJson(changed), analysis, a)).toThrow(/differs/);
  });
  it('escapes hostile Markdown/HTML paths and creates no links or source text', () => {
    const g = graph('a', ['src/[x](javascript:bad)<img>.ts', 'tests/`evil`.ts'], [[0, 1]], { roles: ['source', 'test'] });
    const md = architectureMarkdown(run(g));
    expect(md).not.toContain('<img>');
    expect(md).not.toContain('[x]');
    expect(md).not.toContain('`evil`');
    expect(md).not.toContain('PRIVATE_SOURCE_SENTINEL');
    expect(md).toContain('&#60;img&#62;');
  });
});
describe('strict architecture policy input', () => {
  it('rejects duplicate keys including escaped aliases and explicit excess nesting', () => {
    expect(() => parseArchitecturePolicy('{"format":"bad","format":"atlas.architecture-policy/1","rules":[{"id":"cycle","kind":"cycle"}]}')).toThrow(/repeats/);
    expect(() => parseArchitecturePolicy('{"format":"atlas.architecture-policy/1","rules":[{"id":"a","kind":"cycle","\\u0069d":"b"}]}')).toThrow(/repeats/);
    expect(() => parseArchitecturePolicy('['.repeat(33)+'0'+']'.repeat(33))).toThrow(/nesting/);
  });
  it.each([
    { format: 'atlas.architecture-policy/1', rules: [] },
    { ...boundary, rules: [boundary.rules[0], boundary.rules[0]] },
    { ...boundary, rules: [{ id: 'bad', kind: 'cycle', script: 'run' }] },
    { ...boundary, rules: [{ ...boundary.rules[0], from: {} }] },
    { ...boundary, rules: [{ ...boundary.rules[0], from: { paths: ['../secret'] } }] },
    { ...boundary, rules: [{ ...boundary.rules[0], to: { paths: ['C:/secret'] } }] },
    { ...boundary, rules: [{ ...boundary.rules[0], from: { roles: [] } }] },
    { ...boundary, rules: [{ ...boundary.rules[0], edgeKinds: ['declares-package'] }] },
    { ...boundary, rules: [{ ...boundary.rules[0], edgeKinds: ['imports-value', 'imports-value'] }] },
    { ...boundary, rules: [{ ...boundary.rules[0], from: { paths: ['src', 'src'] } }] },
    { ...boundary, rules: [{ id: 'a', kind: 'cycle' }, { id: 'b', kind: 'cycle' }] },
  ])('rejects invalid policy %#', value => expect(() => parseArchitecturePolicy(JSON.stringify(value))).toThrow());
  it('bounds bytes and structural depth', () => {
    expect(() => parseArchitecturePolicy(' '.repeat(65537))).toThrow();
    expect(() => parseArchitecturePolicy('['.repeat(100) + '0' + ']'.repeat(100))).toThrow();
  });
});
