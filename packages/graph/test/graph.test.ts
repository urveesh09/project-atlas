import { describe, expect, it } from 'vitest';
import { GraphIndex, POLICIES, SearchIndex, aggregateEdges, findStaticCycles, midrankPercentiles, nearestRankPercentile } from '@atlas/graph';
import {
  emptySnapshotCoverage,
  localRepositoryId,
  nodeId,
  observationId,
  type EdgeKind,
  type GraphNode,
  type GraphSnapshot,
  type ImportObservation,
} from '@atlas/schema';

/**
 * A tiny snapshot builder for graph semantics. Files live in packages by their first
 * path segment (`a/x.ts` → package `a`); `deps` lists statement-level imports.
 */
const REPO = localRepositoryId('3f2a9c4e-8b1d-4f6a-9c2e-7d5b1a0e4c3f');
const SNAP = `snap_${'5'.repeat(64)}`;

type Dep = [from: string, to: string, kind?: EdgeKind, confidence?: 'exact' | 'inferred'];

function build(files: string[], deps: Dep[], limits?: Parameters<typeof aggregateEdges>[2]) {
  const nodes: GraphNode[] = [{ id: nodeId(SNAP, 'repository', ''), kind: 'repository', label: 'r', parentId: null, lineageId: null }];
  const packages = new Set(files.map((f) => f.split('/')[0]!));
  for (const p of packages) nodes.push({ id: nodeId(SNAP, 'package', p), kind: 'package', label: p, parentId: nodes[0]!.id, lineageId: null, path: p, manifestPath: null, packageName: `@x/${p}`, workspace: true });
  const fid = (path: string) => nodeId(SNAP, 'file', path);
  for (const f of files) {
    nodes.push({
      id: fid(f),
      kind: 'file',
      label: f.split('/').at(-1)!,
      parentId: nodeId(SNAP, 'package', f.split('/')[0]!),
      lineageId: `lin_${fid(f).slice(5)}`,
      path: f,
      blobOid: 'a'.repeat(40),
      blobSha256: null,
      language: 'typescript',
      role: 'source',
      byteSize: 1,
      parseStatus: 'parsed',
      declarations: f.endsWith('util.ts') ? [{ name: 'formatMoney', kind: 'function', exported: true, range: { startOffset: 0, endOffset: 1, startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 } }] : [],
      declarationsOmitted: 0,
    });
  }
  const observations: ImportObservation[] = deps.map(([from, to, kind = 'imports-value', confidence = 'exact'], i) => {
    const range = { startOffset: i * 10, endOffset: i * 10 + 5, startLine: i + 1, startColumn: 1, endLine: i + 1, endColumn: 6 };
    return { id: observationId(SNAP, fid(from), kind, range, `./${to}`), sourceId: fid(from), kind, specifier: `./${to}`, range, status: 'resolved-internal', targetId: fid(to), reasonCode: null, resolverMode: 'bundler/esm', confidence };
  });
  const agg = aggregateEdges(SNAP, observations, limits);
  const snapshot: GraphSnapshot = {
    snapshotId: SNAP,
    repoId: REPO,
    commitOid: '1'.repeat(40),
    nodes: nodes.sort((a, b) => (a.id < b.id ? -1 : 1)),
    edges: agg.edges,
    importObservations: agg.observations,
    diagnostics: [],
    metrics: [],
    coverage: emptySnapshotCoverage(),
  };
  return { snapshot, index: new GraphIndex(snapshot), agg, fid };
}

describe('edge aggregation (plan §6.3)', () => {
  it('aggregates identical (source, target, kind, confidence) and keeps the others apart', () => {
    const { agg } = build(['a/x.ts', 'a/y.ts'], [
      ['a/x.ts', 'a/y.ts'],
      ['a/x.ts', 'a/y.ts'],
      ['a/x.ts', 'a/y.ts', 'imports-type'],
      ['a/x.ts', 'a/y.ts', 'imports-value', 'inferred'],
    ]);
    expect(agg.edges.map((e) => [e.kind, e.confidence, e.observationCount]).sort()).toEqual([
      ['imports-type', 'exact', 1],
      ['imports-value', 'exact', 2],
      ['imports-value', 'inferred', 1],
    ]);
  });

  it('truncates evidence deterministically and counts every omission', () => {
    const deps: Dep[] = Array.from({ length: 6 }, () => ['a/x.ts', 'a/y.ts']);
    const { agg } = build(['a/x.ts', 'a/y.ts'], deps, { edges: 10, evidenceRows: 4 });
    expect(agg.observations).toHaveLength(4);
    expect(agg.observationsOmitted).toBe(2);
    expect(agg.edges[0]).toMatchObject({ observationCount: 6, evidenceOmitted: 2 });
    expect(agg.edges[0]!.evidenceIds).toHaveLength(4);
  });

  it('applies the real 100,000-edge cap to a dense fixture with exact omission counts', () => {
    const files = Array.from({ length: 400 }, (_, i) => `d/f${i}.ts`); // 400·399·¾ ≈ 119,700 edges
    const deps: Dep[] = [];
    for (let i = 0; i < files.length; i++) for (let j = 0; j < files.length; j++) if (i !== j && (i + j) % 4 !== 0) deps.push([files[i]!, files[j]!]);
    const { agg } = build(files, deps);
    expect(deps.length).toBeGreaterThan(100_000);
    expect(agg.edges).toHaveLength(100_000);
    expect(agg.edgesOmitted).toBe(deps.length - 100_000);
    expect(agg.edgeObservationsOmitted).toBe(deps.length - 100_000);
    expect(agg.observations.length).toBe(Math.min(deps.length, 250_000));
  });
});

describe('direction, degrees and policies', () => {
  const { index, fid } = build(['a/x.ts', 'a/y.ts', 'a/z.ts', 'b/w.ts'], [
    ['a/x.ts', 'a/y.ts'],
    ['a/x.ts', 'a/y.ts'], // duplicate statement: still one unique target
    ['a/x.ts', 'a/z.ts', 'imports-type'],
    ['a/x.ts', 'b/w.ts', 'imports-dynamic-literal'],
    ['b/w.ts', 'a/y.ts', 'reexports-value'],
  ]);

  it('points importer -> imported', () => {
    expect(index.outgoing(fid('a/x.ts')).map((e) => index.pathOf(e.targetId)).sort()).toEqual(['a/y.ts', 'a/z.ts', 'b/w.ts']);
    expect(index.incoming(fid('a/y.ts')).map((e) => index.pathOf(e.sourceId)).sort()).toEqual(['a/x.ts', 'b/w.ts']);
  });

  it('counts unique files under the degree policy (type-only excluded, dynamic included)', () => {
    expect(index.fileNeighbors(fid('a/x.ts'), 'outgoing').map((id) => index.pathOf(id))).toEqual(['a/y.ts', 'b/w.ts']);
    expect(index.fileNeighbors(fid('a/y.ts'), 'incoming').map((id) => index.pathOf(id))).toEqual(['a/x.ts', 'b/w.ts']);
    expect(index.fileNeighbors(fid('a/x.ts'), 'outgoing', POLICIES.all)).toHaveLength(3);
  });

  it('rolls file edges up to package pairs with pair and observation counts', () => {
    const rollups = index.packageRollups().map((r) => [index.pathOf(r.sourcePackageId), index.pathOf(r.targetPackageId), r.uniqueFilePairs, r.observations]);
    expect(rollups.sort()).toEqual([
      ['a', 'a', 2, 3],
      ['a', 'b', 1, 1],
      ['b', 'a', 1, 1],
    ]);
  });
});

describe('static cycles (plan §10.2)', () => {
  const { snapshot, index, fid } = build(['a/a.ts', 'a/b.ts', 'a/c.ts', 'a/d.ts', 'a/e.ts', 'a/f.ts', 'a/t1.ts', 'a/t2.ts', 'a/lazy.ts'], [
    ['a/a.ts', 'a/b.ts'],
    ['a/b.ts', 'a/a.ts'],
    ['a/c.ts', 'a/c.ts'], // self-edge
    ['a/d.ts', 'a/e.ts'],
    ['a/e.ts', 'a/f.ts'],
    ['a/f.ts', 'a/d.ts'],
    ['a/t1.ts', 'a/t2.ts', 'imports-type'],
    ['a/t2.ts', 'a/t1.ts', 'imports-type'],
    ['a/lazy.ts', 'a/a.ts'],
    ['a/a.ts', 'a/lazy.ts', 'imports-dynamic-literal'],
  ]);

  it('finds value cycles and self-edges, excluding type-only and dynamic edges', () => {
    const cycles = findStaticCycles(snapshot);
    expect(cycles.map((c) => c.members.map((m) => index.pathOf(m)).sort())).toEqual(
      expect.arrayContaining([['a/a.ts', 'a/b.ts'], ['a/c.ts'], ['a/d.ts', 'a/e.ts', 'a/f.ts']]),
    );
    expect(cycles).toHaveLength(3);
    expect(cycles.find((c) => c.selfEdge)!.witness.map((m) => index.pathOf(m))).toEqual(['a/c.ts', 'a/c.ts']);
  });

  it('produces a witness that is a real cycle of policy edges', () => {
    for (const cycle of findStaticCycles(snapshot)) {
      expect(cycle.witness[0]).toBe(cycle.witness.at(-1));
      for (let i = 0; i + 1 < cycle.witness.length; i++) {
        expect(index.outgoing(cycle.witness[i]!, POLICIES.cycle).some((e) => e.targetId === cycle.witness[i + 1])).toBe(true);
      }
    }
  });

  it('sees the type-only cycle under the all-edges policy', () => {
    const typeCycle = findStaticCycles(snapshot, POLICIES.all).find((c) => c.members.includes(fid('a/t1.ts')));
    expect(typeCycle?.members.map((m) => index.pathOf(m)).sort()).toEqual(['a/t1.ts', 'a/t2.ts']);
  });

  it('is deterministic and handles a 20,000-file chain without stack overflow', () => {
    expect(findStaticCycles(snapshot)).toEqual(findStaticCycles(snapshot));
    const files = Array.from({ length: 20_000 }, (_, i) => `c/n${String(i).padStart(5, '0')}.ts`);
    const deps: Dep[] = files.map((f, i) => [f, files[(i + 1) % files.length]!]);
    const ring = build(files, deps);
    const cycles = findStaticCycles(ring.snapshot);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.members).toHaveLength(20_000);
    expect(cycles[0]!.witness.length).toBeLessThanOrEqual(65);
  });
});

describe('bounded reach', () => {
  const chain = ['a/0.ts', 'a/1.ts', 'a/2.ts', 'a/3.ts', 'a/4.ts'];
  const { index, fid } = build(chain, chain.slice(1).map((f, i) => [chain[i]!, f] as Dep));

  it('stops at the depth limit and says more lies beyond', () => {
    const result = index.reach(fid('a/0.ts'), { direction: 'outgoing', depth: 2 });
    expect(result.nodes.map((n) => [index.pathOf(n.id), n.depth])).toEqual([
      ['a/1.ts', 1],
      ['a/2.ts', 2],
    ]);
    expect(result).toMatchObject({ truncated: false, beyondDepth: true });
  });

  it('clamps depth to 5 and caps visited nodes', () => {
    expect(index.reach(fid('a/0.ts'), { direction: 'outgoing', depth: 99 }).depth).toBe(5);
    const capped = index.reach(fid('a/0.ts'), { direction: 'outgoing', depth: 5, maxVisited: 2 });
    expect(capped.nodes).toHaveLength(2);
    expect(capped.truncated).toBe(true);
  });

  it('walks incoming edges for consumers', () => {
    expect(index.reach(fid('a/4.ts'), { direction: 'incoming', depth: 1 }).nodes.map((n) => index.pathOf(n.id))).toEqual(['a/3.ts']);
  });
});

describe('search ranking (plan §12.2)', () => {
  const { snapshot } = build(['app/main.ts', 'app/mainframe.ts', 'lib/domain.ts', 'lib/util.ts', 'app/util.ts'], []);
  const search = new SearchIndex(snapshot);
  it('ranks exact, then prefix, then substring, ties by path', () => {
    expect(search.search('main.ts').map((h) => [h.path, h.tier])).toEqual([
      ['app/main.ts', 0],
      ['lib/domain.ts', 2],
    ]);
    expect(search.search('MAIN').map((h) => h.path)).toEqual(['app/main.ts', 'app/mainframe.ts', 'lib/domain.ts']);
  });
  it('finds files by declaration and packages by name', () => {
    expect(search.search('formatmoney').map((h) => [h.path, h.match.field])).toEqual([
      ['app/util.ts', 'declaration'],
      ['lib/util.ts', 'declaration'],
    ]);
    expect(search.search('@x/lib')[0]).toMatchObject({ kind: 'package', tier: 0 });
  });
});

describe('statistics', () => {
  it('nearest-rank 95th percentile', () => {
    expect(nearestRankPercentile([])).toBeNull();
    expect(nearestRankPercentile([7])).toBe(7);
    expect(nearestRankPercentile(Array.from({ length: 20 }, (_, i) => i + 1))).toBe(19); // ceil(19) - 1 = index 18
    expect(nearestRankPercentile(Array.from({ length: 21 }, (_, i) => i + 1))).toBe(20); // ceil(19.95) - 1 = index 19
  });
  it('midrank percentiles share ties', () => {
    expect(midrankPercentiles([10, 20, 20, 40])).toEqual([0, 0.5, 0.5, 1]); // ranks 1, 2.5, 2.5, 4
    expect(midrankPercentiles([5])).toEqual([0]);
    expect(midrankPercentiles([3, 3, 3])).toEqual([0.5, 0.5, 0.5]);
  });
});
