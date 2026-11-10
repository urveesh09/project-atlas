import { expect, it } from 'vitest';
import { canonicalJson, canonicalJsonSha256 } from '@atlas/schema';
import { createReviewWorkspace, decideReviewWorkspace, parseReviewWorkspace, reviewArchitecture, architectureExit } from '@atlas/graph';
import { architectureAnalysis, architectureFixture } from './architecture-fixture.js';

function fixture() {
  const graph = architectureFixture('a', ['src/main.ts', 'tests/helper.ts', 'tests/other.ts'], [[0, 1], [0, 2]], { roles: ['source', 'test', 'test'] });
  const report = reviewArchitecture(architectureAnalysis, graph, {
    format: 'atlas.architecture-policy/1',
    rules: [{ id: 'no-tests', kind: 'forbidden-dependency', from: { roles: ['source'] }, to: { roles: ['test'] }, edgeKinds: ['imports-value'] }],
  });
  return { report, workspace: createReviewWorkspace(report) };
}

it('retains one exact source-free report and makes structured decisions without changing policy results', () => {
  const { report, workspace } = fixture();
  expect(workspace.revision).toBe(0);
  expect(workspace.reportSha256).toBe(canonicalJsonSha256(report));
  const id = report.rows[0]!.id;
  const next = decideReviewWorkspace(workspace, 0, id, 'acknowledged', 'maintainers');
  expect(next.revision).toBe(1);
  expect(next.decisions).toEqual([{ issueId: id, reportSha256: workspace.reportSha256, state: 'acknowledged', owner: 'maintainers', changedRevision: 1 }]);
  expect(next.report).toEqual(report);
  expect(architectureExit(next.report, 'all')).toBe(3);
  expect(canonicalJson(next)).not.toContain('PRIVATE_SOURCE_SENTINEL');
  expect(parseReviewWorkspace(canonicalJson(next))).toEqual(next);
});

it('replaces only the selected decision and rejects stale or unknown issue edits', () => {
  const { workspace } = fixture(), id = workspace.report.rows[0]!.id;
  const first = decideReviewWorkspace(workspace, 0, id, 'acknowledged', 'maintainers');
  const next = decideReviewWorkspace(first, 1, id, 'deferred', 'architecture-review');
  expect(next.decisions).toHaveLength(1);
  expect(next.decisions[0]).toMatchObject({ state: 'deferred', owner: 'architecture-review', changedRevision: 2 });
  expect(() => decideReviewWorkspace(first, 0, id, 'deferred', 'unassigned')).toThrow(/revision/);
  expect(() => decideReviewWorkspace(first, 1, `ar_${'f'.repeat(64)}`, 'deferred', 'unassigned')).toThrow(/not retained/);
});

it('rejects report/digest/decision tampering, duplicates, unbounded revisions and arbitrary text', () => {
  const { workspace } = fixture(), id = workspace.report.rows[0]!.id;
  const decided = decideReviewWorkspace(workspace, 0, id, 'needs-review', 'unassigned');
  for (const mutate of [
    (value: typeof decided) => { value.reportSha256 = 'f'.repeat(64); },
    (value: typeof decided) => { value.decisions[0]!.reportSha256 = 'f'.repeat(64); },
    (value: typeof decided) => { value.decisions[0]!.issueId = `ar_${'f'.repeat(64)}`; },
    (value: typeof decided) => { value.decisions.push(value.decisions[0]!); },
    (value: typeof decided) => { value.decisions[0]!.changedRevision = 2; },
    (value: typeof decided) => { value.decisions = []; },
    (value: typeof decided) => { value.revision = 2; },
    (value: typeof decided) => { value.revision = 1_000_001; },
    (value: typeof decided) => { value.report.rules[0]!.current++; },
  ]) {
    const value = structuredClone(decided); mutate(value);
    expect(() => parseReviewWorkspace(JSON.stringify(value))).toThrow();
  }
  expect(() => parseReviewWorkspace(JSON.stringify({ ...decided, notes: 'SOURCE_OR_SECRET' }))).toThrow();
  expect(() => parseReviewWorkspace(JSON.stringify({ ...decided, decisions: [{ ...decided.decisions[0], state: 'resolved' }] }))).toThrow();
  expect(() => parseReviewWorkspace(JSON.stringify({ ...decided, decisions: [{ ...decided.decisions[0], owner: 'person@example.com' }] }))).toThrow();
  const raw = canonicalJson(workspace);
  expect(() => parseReviewWorkspace(raw.replace('"revision":0', '"revision":0,"revision":0'))).toThrow(/repeats/);
  expect(() => parseReviewWorkspace(' '.repeat(10 * 1024 * 1024 + 1))).toThrow();
});

it('rejects two retained decisions claiming the same edit revision', () => {
  const { workspace } = fixture();
  const [first, second] = workspace.report.rows;
  const one = decideReviewWorkspace(workspace, 0, first!.id, 'acknowledged', 'maintainers');
  const two = decideReviewWorkspace(one, 1, second!.id, 'deferred', 'unassigned');
  expect(parseReviewWorkspace(canonicalJson(two))).toEqual(two);
  const forged = { ...two, decisions: two.decisions.map(decision => ({ ...decision, changedRevision: 2 })) };
  expect(() => parseReviewWorkspace(canonicalJson(forged))).toThrow(/revision/);
});
