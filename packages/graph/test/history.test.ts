import { describe, expect, it } from 'vitest';
import { GraphIndex, aggregateEdges, baselinePercentile, changeBriefMarkdown, compareFrames, comparedDependencyEvidence, hotspotBaseline, hotspotFactors, metricDeltas, percentileBaseline } from '@atlas/graph';
import { edgeId, emptySnapshotCoverage, localRepositoryId, nodeId, type FileNode, type FileRole, type GraphEdge, type GraphNode, type GraphSnapshot, type ImportObservation, type NodeMetrics } from '@atlas/schema';
import { buildHandcraftedArtifact } from '@atlas/test-fixtures';

/** Hotspot and comparison semantics with hand-computed expectations (plan §7.4, §10.3). */
const REPO = localRepositoryId('3f2a9c4e-8b1d-4f6a-9c2e-7d5b1a0e4c3f');
const lin = (name: string) => `lin_${Buffer.from(name).toString('hex').padEnd(64, '0').slice(0, 64)}`;

interface FileSpec {
  path: string;
  lineage?: string;
  role?: FileRole;
  blob?: string;
  metric?: Partial<NodeMetrics>;
}

function snapshot(tag: string, files: FileSpec[], imports: [from: string, to: string, kind?: GraphEdge['kind']][] = []): GraphSnapshot {
  const snap = `snap_${tag.repeat(64).slice(0, 64)}`;
  const root: GraphNode = { id: nodeId(snap, 'repository', ''), kind: 'repository', label: 'r', parentId: null, lineageId: null };
  const nodes: GraphNode[] = [root];
  const metrics: NodeMetrics[] = [];
  for (const f of files) {
    const id = nodeId(snap, 'file', f.path);
    nodes.push({
      id,
      kind: 'file',
      label: f.path,
      parentId: root.id,
      lineageId: f.lineage ?? lin(f.path),
      path: f.path,
      blobOid: (f.blob ?? '1').repeat(40).slice(0, 40),
      blobSha256: null,
      language: 'typescript',
      role: f.role ?? 'source',
      byteSize: 1,
      parseStatus: 'parsed',
      declarations: [],
      declarationsOmitted: 0,
    });
    metrics.push({
      nodeId: id,
      physicalLines: 10,
      codeLines: 10,
      declarationCount: 0,
      maxCyclomatic: 1,
      sumCyclomatic: 1,
      callableCount: 1,
      fanIn: 0,
      fanOut: 0,
      sccId: null,
      changedCommits: 0,
      linesAdded: 0,
      linesDeleted: 0,
      hotspotScore: null,
      availability: { syntax: 'complete', dependencies: 'complete', history: 'complete' },
      ...f.metric,
    });
  }
  const edges: GraphEdge[] = imports.map(([from, to, kind = 'imports-value']) => {
    const s = nodeId(snap, 'file', from);
    const t = nodeId(snap, 'file', to);
    return { id: edgeId(snap, s, t, kind, 'exact'), sourceId: s, targetId: t, kind, confidence: 'exact', observationCount: 1, evidenceIds: [], evidenceOmitted: 0 };
  });
  return { snapshotId: snap, repoId: REPO, commitOid: '2'.repeat(40), nodes, edges, importObservations: [], diagnostics: [], metrics, coverage: emptySnapshotCoverage() };
}

describe('percentile baselines (plan §10.3)', () => {
  const baseline = percentileBaseline([20, 5, 1, 5])!;

  it('uses midranks: ties share their midpoint rank', () => {
    expect(baseline.values).toEqual([1, 5, 20]);
    expect(baseline.percentiles).toEqual([0, 0.5, 1]);
    expect(baseline.allIdentical).toBe(false);
  });

  it('interpolates linearly between distinct values and clamps outside the range', () => {
    expect(baselinePercentile(baseline, 5)).toBe(0.5);
    expect(baselinePercentile(baseline, 3)).toBe(0.25);
    expect(baselinePercentile(baseline, 10)).toBeCloseTo(0.5 + (5 / 15) * 0.5, 12);
    expect(baselinePercentile(baseline, -4)).toBe(0);
    expect(baselinePercentile(baseline, 99)).toBe(1);
  });

  it('an all-identical baseline grades every value at its single shared percentile', () => {
    const flat = percentileBaseline([4, 4, 4])!;
    expect(flat.allIdentical).toBe(true);
    for (const v of [0, 4, 9]) expect(baselinePercentile(flat, v)).toBe(0.5);
    expect(baselinePercentile(percentileBaseline([7])!, 7)).toBe(0);
    expect(percentileBaseline([])).toBeNull();
  });
});

describe('hotspot score and Structure attention', () => {
  const head = snapshot('a', [
    { path: 'a.ts', metric: { maxCyclomatic: 1, fanIn: 0, changedCommits: 1 } },
    { path: 'b.ts', metric: { maxCyclomatic: 5, fanIn: 2, changedCommits: 3 } },
    { path: 'c.ts', metric: { maxCyclomatic: 5, fanIn: 2, changedCommits: 3 } },
    { path: 'd.ts', metric: { maxCyclomatic: 20, fanIn: 8, changedCommits: 9 } },
    { path: 'spec.test.ts', role: 'test', metric: { maxCyclomatic: 50, fanIn: 0, changedCommits: 40 } },
  ]);
  const baseline = hotspotBaseline(head);
  const factors = (graph: GraphSnapshot, path: string) => {
    const node = graph.nodes.find((n): n is FileNode => n.kind === 'file' && n.path === path)!;
    return hotspotFactors(baseline, node, graph.metrics.find((m) => m.nodeId === node.id));
  };

  it('ranks only production source; tests form their own cohort', () => {
    expect(baseline.cohortSize).toBe(4);
    expect(factors(head, 'spec.test.ts')).toBeNull();
  });

  it('score = round(100 * (0.40 pC + 0.25 pF + 0.35 pH))', () => {
    // d.ts tops every factor: 100. b.ts: 0.5 in each factor: 50.
    expect(factors(head, 'd.ts')).toMatchObject({ pComplexity: 1, pFanIn: 1, pChangedCommits: 1, score: 100, structureAttention: 100 });
    expect(factors(head, 'b.ts')).toMatchObject({ pComplexity: 0.5, pFanIn: 0.5, pChangedCommits: 0.5, score: 50, structureAttention: 50 });
    expect(factors(head, 'a.ts')).toMatchObject({ score: 0, structureAttention: 0 });
  });

  it('grades an older frame against the fixed HEAD baseline, interpolating between values', () => {
    const older = snapshot('b', [{ path: 'b.ts', metric: { maxCyclomatic: 20, fanIn: 5, changedCommits: 2 } }]);
    // Baselines: complexity [1, 5, 20], fan-in [0, 2, 8], changed commits [1, 3, 9], each at
    // percentiles [0, 0.5, 1]. pC(20) = 1; pF(5) = 0.5 + (5-2)/(8-2) * 0.5 = 0.75;
    // pH(2) = 0 + (2-1)/(3-1) * 0.5 = 0.25.
    const f = factors(older, 'b.ts')!;
    expect(f.pComplexity).toBe(1);
    expect(f.pFanIn).toBe(0.75);
    expect(f.pChangedCommits).toBe(0.25);
    expect(f.score).toBe(Math.round(100 * (0.4 * 1 + 0.25 * 0.75 + 0.35 * 0.25)));
    expect(f.structureAttention).toBe(Math.round(100 * (0.6 * 1 + 0.4 * 0.75)));
  });

  it('without usable history the full score is null; Structure attention remains, separately named', () => {
    const noHistory = snapshot('c', [
      { path: 'a.ts', metric: { maxCyclomatic: 1, fanIn: 0, changedCommits: null, availability: { syntax: 'complete', dependencies: 'complete', history: 'unavailable' } } },
      { path: 'b.ts', metric: { maxCyclomatic: 9, fanIn: 3, changedCommits: null, availability: { syntax: 'complete', dependencies: 'complete', history: 'unavailable' } } },
    ]);
    const b = hotspotBaseline(noHistory);
    expect(b.changedCommits).toBeNull();
    const node = noHistory.nodes.find((n): n is FileNode => n.kind === 'file' && n.path === 'b.ts')!;
    expect(hotspotFactors(b, node, noHistory.metrics.find((m) => m.nodeId === node.id))).toMatchObject({ score: null, pChangedCommits: null, structureAttention: 100 });
  });
});

describe('frame comparison (plan §7.4)', () => {
  const A = snapshot(
    'a',
    [
      { path: 'keep.ts', metric: { codeLines: 10 } },
      { path: 'gone.ts' },
      { path: 'old-name.ts', lineage: lin('moved'), blob: '3' },
      { path: 'edit.ts', blob: '4', metric: { maxCyclomatic: 2, changedCommits: null } },
      { path: 'role.ts', role: 'source' },
    ],
    [['keep.ts', 'gone.ts'], ['edit.ts', 'keep.ts']],
  );
  const B = snapshot(
    'b',
    [
      { path: 'keep.ts', metric: { codeLines: 10 } },
      { path: 'lib/new-name.ts', lineage: lin('moved'), blob: '3' },
      { path: 'edit.ts', blob: '5', metric: { maxCyclomatic: 7, changedCommits: 2 } },
      { path: 'role.ts', role: 'test' },
      { path: 'fresh.ts' },
    ],
    [['edit.ts', 'keep.ts'], ['fresh.ts', 'edit.ts', 'imports-type']],
  );
  const result = compareFrames(A, B);

  it('matches files by lineage and lists additions, deletions, renames, modifications and role changes', () => {
    expect(result.added.map((f) => f.path)).toEqual(['fresh.ts']);
    expect(result.deleted.map((f) => f.path)).toEqual(['gone.ts']);
    expect(result.renamed).toEqual([{ lineageId: lin('moved'), fromPath: 'old-name.ts', toPath: 'lib/new-name.ts' }]);
    expect(result.modified.map((f) => f.path)).toEqual(['edit.ts']);
    expect(result.roleChanged).toEqual([{ lineageId: lin('role.ts'), path: 'role.ts', from: 'source', to: 'test' }]);
    expect(result.unchangedFiles).toBe(1);
  });

  it('keeps unknown metric deltas null with the unavailable side named', () => {
    const edit = result.metricChanges.find((m) => m.path === 'edit.ts')!.deltas;
    expect(edit).toContainEqual({ metric: 'maxCyclomatic', from: 2, to: 7, delta: 5, unavailable: null });
    expect(edit).toContainEqual({ metric: 'changedCommits', from: null, to: 2, delta: null, unavailable: 'from' });
    expect(metricDeltas(undefined, undefined)).toEqual([]);
  });

  it('projects dependency edges onto lineages, keeping kind as identity', () => {
    expect(result.edgesRemoved.map((e) => `${e.sourcePath}->${e.targetLabel}`)).toEqual(['keep.ts->gone.ts']);
    expect(result.edgesAdded.map((e) => `${e.sourcePath}->${e.targetLabel}:${e.kind}`)).toEqual(['fresh.ts->edit.ts:imports-type']);
  });

  it('compares in the order given, even when B is older', () => {
    const reverse = compareFrames(B, A);
    expect(reverse.added.map((f) => f.path)).toEqual(['gone.ts']);
    expect(reverse.deleted.map((f) => f.path)).toEqual(['fresh.ts']);
    expect(reverse.renamed[0]).toMatchObject({ fromPath: 'lib/new-name.ts', toPath: 'old-name.ts' });
  });

  it('uses the original edge buckets for exact evidence, including confidence and capped positions', () => {
    const from = snapshot('a', [{ path: 'use.ts' }, { path: 'old.ts', lineage: lin('target') }]);
    const to = snapshot('b', [{ path: 'use.ts' }, { path: 'new.ts', lineage: lin('target') }]);
    const source = nodeId(to.snapshotId, 'file', 'use.ts');
    const target = nodeId(to.snapshotId, 'file', 'new.ts');
    const builtin = nodeId(to.snapshotId, 'builtin', 'path');
    to.nodes.push({ id: builtin, parentId: null, lineageId: null, label: 'path', kind: 'builtin', moduleName: 'path' });
    const observe = (line: number, overrides: Partial<ImportObservation> = {}): ImportObservation => ({
      id: `obs_${line.toString(16).padStart(64, '0')}`,
      sourceId: source, targetId: target, kind: 'imports-value', specifier: './new',
      range: { startOffset: line, endOffset: line + 1, startLine: line, startColumn: 1, endLine: line, endColumn: 2 },
      status: 'resolved-internal', confidence: line % 2 ? 'exact' : 'inferred', reasonCode: null, resolverMode: 'test',
      ...overrides,
    });
    const aggregated = aggregateEdges(to.snapshotId, [
      ...Array.from({ length: 10 }, (_, i) => observe(i + 1)),
      observe(11, { targetId: builtin, specifier: 'node:path', status: 'builtin' }),
      observe(12),
      observe(13, { kind: 'imports-type' }),
    ], { edges: 100, evidenceRows: 11 });
    to.edges = aggregated.edges;
    to.importObservations = aggregated.observations;
    const changes = compareFrames(from, to).edgesAdded;
    const internal = changes.find((change) => change.target === lin('target') && change.kind === 'imports-value')!;
    const external = changes.find((change) => change.targetLabel === 'builtin:path')!;
    const index = new GraphIndex(to);
    const evidence = comparedDependencyEvidence(index, internal);
    expect(evidence).toMatchObject({ sourceId: source, statements: 11, omittedByArtifact: 1 });
    expect(evidence?.locations).toHaveLength(8);
    expect(new Set(evidence?.locations.map((location) => location.confidence))).toEqual(new Set(['exact', 'inferred']));
    expect(evidence?.locations.every((location) => location.kind === 'imports-value')).toBe(true);
    expect(comparedDependencyEvidence(index, external)?.locations[0]?.specifier).toBe('node:path');
    expect(comparedDependencyEvidence(new GraphIndex(from), internal)).toBeNull();
    expect(comparedDependencyEvidence(index, { ...internal, sourceLineageId: lin('unrelated') })).toBeNull();
    expect(comparedDependencyEvidence(index, compareFrames(to, from).edgesRemoved.find((change) =>
      change.target === lin('target') && change.kind === 'imports-value')!)).toEqual(evidence);
  });
});

describe('change brief', () => {
  const scc = (tag: string) => `scc_${tag.repeat(64)}`;
  const manifestFor = (a: GraphSnapshot, b: GraphSnapshot) => {
    const { manifest } = buildHandcraftedArtifact();
    const frames = [a, b].map((graph, ordinal) => ({
      ...manifest.frames[0]!,
      ordinal,
      snapshotId: graph.snapshotId,
      commit: { ...manifest.selectedCommit, oid: (ordinal + 1).toString().repeat(40) },
      coverage: graph.coverage,
    }));
    return { ...manifest, frames, selectedCommit: frames[1]!.commit };
  };

  it('matches cycle membership through renames and reports directional score movement', () => {
    const a = snapshot('a', [
      { path: 'a.ts', lineage: lin('a'), metric: { sccId: scc('a'), hotspotScore: 10 } },
      { path: 'b.ts', metric: { sccId: scc('a'), hotspotScore: null } },
      { path: 'changed.ts', metric: { sccId: scc('c'), hotspotScore: 80 } },
      { path: 'other.ts', metric: { hotspotScore: 40 } },
      { path: 'same.ts', metric: { hotspotScore: 25 } },
    ], [['a.ts', 'b.ts']]);
    const b = snapshot('b', [
      { path: 'renamed.ts', lineage: lin('a'), metric: { sccId: scc('b'), hotspotScore: 40 } },
      { path: 'b.ts', metric: { sccId: scc('b'), hotspotScore: 98 } },
      { path: 'changed.ts', metric: { sccId: scc('d'), hotspotScore: 60 } },
      { path: 'other.ts', metric: { sccId: scc('d'), hotspotScore: 50 } },
      { path: 'same.ts', metric: { hotspotScore: 25 } },
    ], [['renamed.ts', 'b.ts'], ['changed.ts', 'other.ts']]);
    const comparison = compareFrames(a, b);
    expect(comparison.cycles).toEqual({
      aOnly: { count: 1, examples: [{ memberCount: 1, paths: ['changed.ts'] }] },
      bOnly: { count: 1, examples: [{ memberCount: 2, paths: ['changed.ts', 'other.ts'] }] },
      unidentifiedA: 0, unidentifiedB: 0,
    });
    expect(comparison.hotspotComparable).toBe(4);
    const manifest = manifestFor(a, b);
    const brief = changeBriefMarkdown(comparison, manifest)!;
    expect(brief).toContain('“changed&#46;ts” → “other&#46;ts” (imports-value)');
    expect(brief).toContain('Shared files with scores in both snapshots (4).');
    expect(brief).toContain('Shared files that gained or lost score availability (1).');
    expect(brief).toContain('“renamed&#46;ts” · 10 → 40 (+30)');
    expect(brief.indexOf('10 → 40 (+30)')).toBeLessThan(brief.indexOf('80 → 60 (-20)'));
    const reverse = compareFrames(b, a);
    expect(reverse.cycles.aOnly).toEqual(comparison.cycles.bOnly);
    expect(changeBriefMarkdown(reverse, manifest)).toContain('“a&#46;ts” · 40 → 10 (-30)');
    expect(changeBriefMarkdown(reverse, manifest)).toContain('Direction A → B, from newer to older.');
    expect(changeBriefMarkdown(comparison, { ...manifest, frames: manifest.frames.slice(1) })).toBeNull();
  });

  it('discloses missing identity, preserves coverage, and bounds and escapes evidence', () => {
    const hostile = '- <img src=www.bad.test> [x](https://bad.test)\n\u202e.ts';
    const long = '📌'.repeat(1000);
    const a = snapshot('a', [{ path: hostile, metric: { hotspotScore: 1 } }]);
    const b = snapshot('b', [
      { path: hostile, metric: { sccId: scc('b'), hotspotScore: 50 } },
      { path: 'unknown.ts', metric: { sccId: scc('b') } },
      ...Array.from({ length: 6 }, (_, i) => ({ path: `${i}/${long}.ts` })),
    ], Array.from({ length: 6 }, (_, i) => [hostile, `${i}/${long}.ts`]));
    const unknown = b.nodes.find((node) => node.kind === 'file' && node.path === 'unknown.ts')!;
    unknown.lineageId = null;
    b.coverage.unresolved = 2;
    b.coverage.observedImports = 8;
    b.coverage.limitsHit = ['EDGE_LIMIT'];
    const comparison = compareFrames(a, b);
    expect(comparison.cycles.bOnly.count).toBe(0);
    const brief = changeBriefMarkdown(comparison, manifestFor(a, b))!;
    expect(brief).toContain('1 in B).');
    expect(brief).toContain('8 import observations, 2 unresolved');
    expect(brief).toContain('Additional entries omitted from the brief (1).');
    expect(brief).toContain('&#8230;');
    expect(brief).toContain('&#92;u202e');
    expect(brief).not.toMatch(/<img|www\.bad\.test|https:\/\/|\[x\]\(|\u202e/u);
    expect(Buffer.byteLength(brief)).toBeLessThan(128 * 1024);
    b.nodes.reverse();
    b.edges.reverse();
    expect(changeBriefMarkdown(compareFrames(a, b), manifestFor(a, b))).toBe(brief);
  });
});
