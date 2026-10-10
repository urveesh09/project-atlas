import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeCommit, type AnalysisResult } from '@atlas/analyzer-core';
import { gzipDeterministic, loadArtifact, packArtifact } from '@atlas/artifact/node';
import { gitVersion, openLocalRepository, resolveLocalCommit } from '@atlas/ingest';
import { canonicalJson, localRepositoryId, validateArtifactBundle, type FileNode, type GraphSnapshot } from '@atlas/schema';
import { buildDemoRepository, createGitFixture, runGit, type FixtureCommit, type GitFixture } from '@atlas/test-fixtures';
import { gunzipSync } from 'node:zlib';

/**
 * Git history acceptance (plan §7, §16.1 "History" and "Comparison"): real repositories
 * built with real Git, every expectation written from the authored commits.
 */
const repoId = localRepositoryId('3f2a9c4e-8b1d-4f6a-9c2e-7d5b1a0e4c3f');
let version: string;
const cleanups: (() => void | Promise<void>)[] = [];

beforeAll(async () => {
  version = await gitVersion();
});
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

async function analyze(dir: string, options: Parameters<typeof analyzeCommit>[0]['options'] = {}): Promise<AnalysisResult> {
  const { repo, git } = await openLocalRepository(dir);
  try {
    const head = await resolveLocalCommit(repo, git);
    return await analyzeCommit({
      git,
      commitOid: head,
      gitVersion: version,
      repository: { repoId, displayName: 'fixture', sourceKind: 'local-git', remote: null, objectFormat: repo.objectFormat },
      options,
      now: () => new Date('2026-10-10T00:00:00.000Z'),
    });
  } finally {
    await git.dispose();
  }
}

function fixture(commits: FixtureCommit[]): GitFixture {
  const f = createGitFixture(commits);
  cleanups.push(() => f.dispose());
  return f;
}

const day = (d: string) => `${d}T12:00:00Z`;
const fileAt = (graph: GraphSnapshot, p: string) => graph.nodes.find((n): n is FileNode => n.kind === 'file' && n.path === p);
const metricOf = (graph: GraphSnapshot, p: string) => {
  const node = fileAt(graph, p);
  return node ? graph.metrics.find((m) => m.nodeId === node.id) : undefined;
};
const head = (r: AnalysisResult) => r.draft.graphs.at(-1)!;

/** A bundle must validate, and survive packing and the bounded loader unchanged. */
async function roundTrip(result: AnalysisResult) {
  const packed = packArtifact(result.draft, gzipDeterministic);
  expect(validateArtifactBundle({ manifest: packed.manifest, graphs: result.draft.graphs, history: result.draft.history, layout: result.draft.layout }).ok).toBe(true);
  const files = new Map(packed.chunks);
  files.set('manifest.json', new TextEncoder().encode(canonicalJson(packed.manifest)));
  const loaded = await loadArtifact({ read: async (p) => files.get(p) ?? null }, async (b) => new Uint8Array(gunzipSync(b)));
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues.slice(0, 3)));
  expect(loaded.bundle.graphs.map((g) => canonicalJson(g))).toEqual(result.draft.graphs.map((g) => canonicalJson(g)));
  return packed;
}

describe('Harbor history (12 authored commits, 73 days)', () => {
  let demo: GitFixture;
  let result: AnalysisResult;
  beforeAll(async () => {
    demo = buildDemoRepository();
    cleanups.push(() => demo.dispose());
    result = await analyze(demo.dir);
  });

  it('walks the whole first-parent chain to the root and analyzes all 12 frames', async () => {
    const c = result.draft.manifest.coverage.history;
    expect(c).toMatchObject({ status: 'complete', boundary: 'root', commitsTraversed: 12, framesRequested: 12, framesCompleted: 12, renameDetection: 'complete', lineDiffs: 'complete', coChange: 'complete', requestedDays: 90, requestedCommitCap: 200 });
    expect(c.oldestOid).toBe(demo.commits[0]);
    expect(result.draft.manifest.frames.map((f) => f.commit.oid)).toEqual(demo.commits);
    expect(result.draft.history.commits.map((h) => h.oid)).toEqual([...demo.commits].reverse());
    expect(result.status).toBe('complete');
    await roundTrip(result);
  });

  it('records each mainline change with numstat lines; binary content has no line count', () => {
    const changes = [...result.draft.history.commits].reverse().map((c) => c.changes.map((x) => `${x.kind} ${x.oldPath ?? '-'} ${x.newPath ?? '-'} ${x.added ?? 'n/a'} ${x.deleted ?? 'n/a'}`));
    expect(changes[3]).toEqual(['add - src/server/handlers.ts 17 0', 'add - src/server/pricing.ts 10 0', 'add - src/server/router.ts 4 0']);
    expect(changes[4]).toEqual(['modify src/server/pricing.ts src/server/pricing.ts 2 0']);
    expect(changes[5]).toEqual(['add - assets/harbor.png n/a n/a', 'add - assets/logo.svg 1 0', 'add - tests/pricing.test.ts 6 0']);
    // Sorted by new path in UTF-8 byte order: 'M' (0x4d) precedes 'i' (0x69).
    expect(changes[6]).toEqual(['rename src/ui/Cargo.tsx src/ui/Manifest.tsx 0 0', 'modify src/ui/index.ts src/ui/index.ts 1 1']);
    expect(changes[11]).toEqual(['modify src/server/pricing.ts src/server/pricing.ts 16 0', 'delete src/ui/legacy.ts - 0 1']);
    expect(result.draft.history.commits.every((c) => c.changesAvailability === 'complete')).toBe(true);
  });

  it('keeps the renamed cargo row on one lineage and one fixed plot', () => {
    const graphs = result.draft.graphs;
    const before = fileAt(graphs[5]!, 'src/ui/Cargo.tsx')!;
    const after = fileAt(graphs[6]!, 'src/ui/Manifest.tsx')!;
    expect(after.lineageId).toBe(before.lineageId);
    const lineage = result.draft.history.lineages.find((l) => l.id === before.lineageId)!;
    expect(lineage).toMatchObject({ continuity: 'git-rename', anchorPath: 'src/ui/Cargo.tsx', anchorCommitOid: demo.commits[2] });
    expect(lineage.occurrences.map((o) => o.path)).toEqual([...Array(4).fill('src/ui/Cargo.tsx'), ...Array(6).fill('src/ui/Manifest.tsx')]);
    expect(result.draft.layout.plots.filter((p) => p.lineageId === before.lineageId)).toHaveLength(1);
  });

  it('counts churn only up to each frame (no later-commit leakage)', () => {
    // pricing.ts: added in commit 4, modified in commits 5, 9 and 12.
    const counts = result.draft.graphs.map((g) => metricOf(g, 'src/server/pricing.ts')?.changedCommits ?? null);
    expect(counts).toEqual([null, null, null, 1, 2, 2, 2, 2, 3, 3, 3, 4]);
    // Every pricing version only inserts lines, so the added total is the final length.
    const final = metricOf(head(result), 'src/server/pricing.ts')!;
    expect(final).toMatchObject({ linesAdded: 33, linesDeleted: 0, physicalLines: 33 });
    expect(final.availability.history).toBe('complete');
    // Binary: the commit counts, the lines do not apply.
    expect(metricOf(head(result), 'assets/harbor.png')).toMatchObject({ changedCommits: 1, linesAdded: null, linesDeleted: null });
    expect(metricOf(head(result), 'assets/harbor.png')!.availability.history).toBe('complete');
  });

  it('keeps a deleted file in history and on its plot, but absent from the selected frame', () => {
    const graphs = result.draft.graphs;
    expect(graphs.map((g) => Boolean(fileAt(g, 'src/ui/legacy.ts')))).toEqual([false, false, true, true, true, true, true, true, true, true, true, false]);
    const lineage = fileAt(graphs[10]!, 'src/ui/legacy.ts')!.lineageId!;
    expect(result.draft.layout.plots.some((p) => p.lineageId === lineage)).toBe(true);
    expect(result.draft.layout.frameState.at(-1)!.files.some((f) => f.lineageId === lineage)).toBe(false);
  });

  it('keeps every plot coordinate identical across frames (one plot plan)', () => {
    const plots = new Map(result.draft.layout.plots.map((p) => [p.lineageId, p.rect]));
    expect(plots.size).toBe(27);
    for (const state of result.draft.layout.frameState) for (const file of state.files) expect(plots.has(file.lineageId)).toBe(true);
  });

  it('scores hotspots for production source only, against the fixed HEAD baseline', () => {
    const graph = head(result);
    for (const node of graph.nodes) {
      const metric = graph.metrics.find((m) => m.nodeId === node.id);
      if (!metric) continue;
      const eligible = node.kind === 'file' && node.role === 'source' && node.parseStatus === 'parsed';
      if (eligible) expect(metric.hotspotScore).not.toBeNull();
      else expect(metric.hotspotScore).toBeNull();
    }
    // pricing.ts has the cohort's highest complexity (19) and change count (4).
    expect(metricOf(graph, 'src/server/pricing.ts')!.hotspotScore).toBeGreaterThanOrEqual(90);
    // No file reaches the 10-commit change-concentration minimum in 12 commits.
    expect(graph.diagnostics.filter((d) => d.ruleId === 'ATLAS_CHANGE_CONCENTRATION')).toEqual([]);
  });

  it('is reproducible: identical chunk hashes across runs', async () => {
    const again = await analyze(demo.dir);
    const a = packArtifact(result.draft, gzipDeterministic).manifest.chunks.map((c) => [c.path, c.sha256]);
    const b = packArtifact(again.draft, gzipDeterministic).manifest.chunks.map((c) => [c.path, c.sha256]);
    expect(b).toEqual(a);
  });

  it('frame deltas reproduce exactly the graphs a plain export writes', async () => {
    const delta = await roundTrip(result);
    const plain = packArtifact(result.draft, gzipDeterministic, { graphEncoding: 'plain' });
    expect(delta.manifest.frames.map((f) => f.graphChunk.sha256)).toEqual(plain.manifest.frames.map((f) => f.graphChunk.sha256));
    expect(delta.manifest.frames.slice(0, -1).every((f) => f.graphChunk.encoding === 'atlas.graph.delta/1')).toBe(true);
    expect(delta.manifest.frames.at(-1)!.graphChunk.encoding).toBe('atlas.graph.indexed/1');
    const sizes = (m: typeof delta.manifest) => m.chunks.reduce((s, c) => s + c.compressedBytes, 0);
    expect(sizes(delta.manifest)).toBeLessThan(sizes(plain.manifest) / 2);
  });

  it('--snapshots 3 samples frames floor(i(n-1)/(k-1)) = commits 1, 6 and 12', async () => {
    const sampled = await analyze(demo.dir, { history: { enabled: true, snapshots: 3 } });
    expect(sampled.draft.manifest.frames.map((f) => f.commit.oid)).toEqual([demo.commits[0], demo.commits[5], demo.commits[11]]);
    expect(sampled.draft.history.frameSelection!.commits.map((c) => c.chainIndex)).toEqual([0, 5, 11]);
    // Churn still uses every commit in the window, not just the sampled ones.
    expect(metricOf(head(sampled), 'src/server/pricing.ts')!.changedCommits).toBe(4);
    await roundTrip(sampled);
  });

  it('--no-history keeps every other pillar and never invents history or hotspot scores', async () => {
    const plain = await analyze(demo.dir, { history: { enabled: false } });
    expect(plain.draft.graphs).toHaveLength(1);
    expect(plain.draft.manifest.coverage.history).toMatchObject({ status: 'unavailable', boundary: 'none', commitsTraversed: 0 });
    expect(plain.draft.history.commits).toEqual([]);
    for (const m of head(plain).metrics) {
      expect(m).toMatchObject({ changedCommits: null, linesAdded: null, linesDeleted: null, hotspotScore: null });
      expect(m.availability.history).toBe('unavailable');
    }
    expect(plain.status).toBe('complete');
    await roundTrip(plain);
  });
});

describe('history boundaries and lineage edge cases', () => {
  it('rename between sampled frames keeps one lineage, and historical membership is exact', async () => {
    const f = fixture([
      { date: day('2026-09-01'), message: 'a', files: { 'a.ts': 'export const a = 1;\n', 'keep.ts': 'export const k = 1;\n' } },
      { date: day('2026-09-02'), message: 'move', renames: [['a.ts', 'src/b.ts']] },
      { date: day('2026-09-03'), message: 'move again', renames: [['src/b.ts', 'lib/c.ts']] },
      { date: day('2026-09-04'), message: 'edit', files: { 'keep.ts': 'export const k = 2;\n' } },
    ]);
    const result = await analyze(f.dir, { history: { enabled: true, snapshots: 2 } });
    const [first, last] = result.draft.graphs as [GraphSnapshot, GraphSnapshot];
    expect(fileAt(last, 'lib/c.ts')!.lineageId).toBe(fileAt(first, 'a.ts')!.lineageId);
    const lineageId = fileAt(first, 'a.ts')!.lineageId!;
    const plot = result.draft.layout.plots.find((p) => p.lineageId === lineageId)!;
    // The plot is anchored to the latest path (lib/), while frame 0 records the file's
    // actual historical parent, which has no anchored district of its own.
    const anchorDistrict = result.draft.layout.districts.find((d) => d.id === plot.districtId)!;
    expect(anchorDistrict.anchorPath).toBe('lib');
    const frame0 = result.draft.layout.frameState[0]!;
    expect(frame0.files.find((x) => x.lineageId === lineageId)!.currentParentId).toBe(fileAt(first, 'a.ts')!.parentId);
    expect(result.draft.history.commits.flatMap((c) => c.changes).filter((c) => c.kind === 'rename').map((c) => `${c.oldPath}>${c.newPath}`)).toEqual(['src/b.ts>lib/c.ts', 'a.ts>src/b.ts']);
    await roundTrip(result);
  });

  it('frame deltas survive kept edges whose evidence row changed (same offset, new line)', async () => {
    // Ten bytes either way before the import: offsets stay, the start line moves 2 -> 3.
    const f = fixture([
      { date: day('2026-09-01'), message: '1', files: { 'a.ts': "//abcdefg\nimport { b } from './b';\nexport const a = b;\n", 'b.ts': 'export const b = 1;\n' } },
      { date: day('2026-09-02'), message: '2', files: { 'a.ts': "//ab\n//cd\nimport { b } from './b';\nexport const a = b;\n" } },
    ]);
    const result = await analyze(f.dir);
    const [old, now] = result.draft.graphs as [GraphSnapshot, GraphSnapshot];
    expect(old.importObservations[0]!.range.startOffset).toBe(now.importObservations[0]!.range.startOffset);
    expect(old.importObservations[0]!.range.startLine).not.toBe(now.importObservations[0]!.range.startLine);
    await roundTrip(result);
  });

  it('delete and re-create of a path are two lineages with two plots', async () => {
    const f = fixture([
      { date: day('2026-09-01'), message: 'a', files: { 'x.ts': 'export const x = 1;\n', 'y.ts': 'export const y = 1;\n' } },
      { date: day('2026-09-02'), message: 'rm', files: { 'x.ts': null } },
      { date: day('2026-09-03'), message: 'again', files: { 'x.ts': 'export const x = 2;\nexport const z = 3;\n' } },
    ]);
    const result = await analyze(f.dir);
    const [g0, , g2] = result.draft.graphs as [GraphSnapshot, GraphSnapshot, GraphSnapshot];
    expect(fileAt(g2, 'x.ts')!.lineageId).not.toBe(fileAt(g0, 'x.ts')!.lineageId);
    expect(result.draft.layout.plots).toHaveLength(3);
    expect(metricOf(g2, 'x.ts')!.changedCommits).toBe(1);
  });

  it('merge commits contribute their first-parent change only; side-branch commits are not in the window', async () => {
    const f = fixture([{ date: day('2026-09-01'), message: 'base', files: { 'a.ts': 'export const a = 1;\n' } }]);
    const commit = (message: string, date: string, files: Record<string, string>) => {
      for (const [file, content] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(f.dir, file)), { recursive: true });
        writeFileSync(path.join(f.dir, file), content);
      }
      runGit(f.dir, ['add', '-A']);
      runGit(f.dir, ['commit', '-q', '-m', message], { date });
    };
    runGit(f.dir, ['checkout', '-q', '-b', 'side']);
    commit('side 1', day('2026-09-02'), { 'side.ts': 'export const s = 1;\n' });
    commit('side 2', day('2026-09-03'), { 'side.ts': 'export const s = 2;\n' });
    runGit(f.dir, ['checkout', '-q', 'main']);
    commit('main', day('2026-09-04'), { 'a.ts': 'export const a = 2;\n' });
    runGit(f.dir, ['merge', '-q', '--no-ff', '-m', 'merge side', 'side'], { date: day('2026-09-05') });
    const result = await analyze(f.dir);
    const history = result.draft.history;
    expect(history.commits).toHaveLength(3); // merge, main, base: never the side commits
    const merge = history.commits[0]!;
    expect(merge.changes.map((c) => `${c.kind} ${c.newPath}`)).toEqual(['add side.ts']);
    expect(metricOf(head(result), 'side.ts')!.changedCommits).toBe(1);
    expect(result.draft.manifest.coverage.history.boundary).toBe('root');
  });

  it('a shallow clone stops at the missing parent: oldest change unavailable, history partial', async () => {
    const f = fixture([
      { date: day('2026-09-01'), message: '1', files: { 'a.ts': 'export const a = 1;\n' } },
      { date: day('2026-09-02'), message: '2', files: { 'b.ts': 'export const b = 1;\n' } },
      { date: day('2026-09-03'), message: '3', files: { 'a.ts': 'export const a = 3;\n' } },
      { date: day('2026-09-04'), message: '4', files: { 'b.ts': 'export const b = 4;\n' } },
    ]);
    const parent = mkdtempSync(path.join(tmpdir(), 'atlas-shallow-'));
    cleanups.push(() => rmSync(parent, { recursive: true, force: true, maxRetries: 5 }));
    const clone = path.join(parent, 'clone');
    runGit(parent, ['clone', '-q', '--depth', '2', '--no-local', pathToFileURL(f.dir).href, clone]);
    const result = await analyze(clone);
    const c = result.draft.manifest.coverage.history;
    expect(c).toMatchObject({ status: 'partial', boundary: 'shallow', commitsTraversed: 2, lineDiffs: 'partial', renameDetection: 'partial' });
    expect(c.oldestOid).toBe(f.commits[2]);
    expect(result.draft.history.commits.at(-1)!.changesAvailability).toBe('unavailable');
    expect(result.status).toBe('partial');
    // Unknown earlier changes make every file's history partial, never a confident zero.
    expect(metricOf(head(result), 'a.ts')!.availability.history).toBe('partial');
    expect(metricOf(head(result), 'b.ts')!.changedCommits).toBe(1);
    await roundTrip(result);
  });

  it('date skew: the window stops at the first older commit; the selected commit is always included', async () => {
    const skewed = fixture([
      { date: day('2026-09-01'), message: '1', files: { 'a.ts': '1\n' } },
      { date: day('2019-01-01'), message: 'rebased long ago', files: { 'a.ts': '2\n' } },
      { date: day('2026-09-03'), message: '3', files: { 'a.ts': '3\n' } },
    ]);
    const stopped = await analyze(skewed.dir);
    expect(stopped.draft.manifest.coverage.history).toMatchObject({ boundary: 'days', commitsTraversed: 1, status: 'complete' });
    // The boundary parent exists, so the oldest included change is still computed.
    expect(stopped.draft.history.commits[0]!.changesAvailability).toBe('complete');

    const anomalousHead = fixture([
      { date: day('2026-09-01'), message: '1', files: { 'a.ts': '1\n' } },
      { date: day('2026-09-02'), message: '2', files: { 'a.ts': '2\n' } },
      { date: day('2020-01-01'), message: 'clock was wrong', files: { 'a.ts': '3\n' } },
    ]);
    const included = await analyze(anomalousHead.dir);
    // Parents newer than the anomalous HEAD are inside "HEAD - 90 days", in chain order.
    expect(included.draft.manifest.coverage.history).toMatchObject({ boundary: 'root', commitsTraversed: 3 });
  });

  it('--history-commits caps the window; base files anchor at the boundary parent', async () => {
    const f = fixture(
      Array.from({ length: 6 }, (_, i) => ({ date: day(`2026-09-0${i + 1}`), message: `${i}`, files: { 'a.ts': `export const v = ${i};\n`, ...(i === 0 ? { 'b.ts': 'export const b = 0;\n' } : {}) } })),
    );
    const result = await analyze(f.dir, { history: { enabled: true, commits: 3 } });
    const c = result.draft.manifest.coverage.history;
    expect(c).toMatchObject({ boundary: 'commit-cap', commitsTraversed: 3, status: 'complete', requestedCommitCap: 3 });
    expect(result.draft.history.commits.at(-1)!.changesAvailability).toBe('complete');
    const b = result.draft.history.lineages.find((l) => l.anchorPath === 'b.ts')!;
    expect(b.anchorCommitOid).toBe(f.commits[2]); // the boundary parent, below the window
    expect(metricOf(head(result), 'a.ts')!.changedCommits).toBe(3);
    expect(metricOf(head(result), 'b.ts')!.changedCommits).toBe(0);
    await roundTrip(result);
  });

  it('reports change concentration only at >= 10 commits and the 95th percentile', async () => {
    const commits: FixtureCommit[] = [{ date: day('2026-08-01'), message: 'init', files: { 'hot.ts': 'export const v = 0;\n', 'cold.ts': 'export const c = 0;\n' } }];
    for (let i = 1; i <= 10; i++) commits.push({ date: `2026-08-${String(i + 1).padStart(2, '0')}T12:00:00Z`, message: `${i}`, files: { 'hot.ts': `export const v = ${i};\n` } });
    const result = await analyze(fixture(commits).dir);
    const graph = head(result);
    const findings = graph.diagnostics.filter((d) => d.ruleId === 'ATLAS_CHANGE_CONCENTRATION');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.subjectIds).toEqual([fileAt(graph, 'hot.ts')!.id]);
    expect(findings[0]!.parameters).toMatchObject({ changedCommits: 11, windowCommits: 11, threshold: 10 });
    // An earlier frame counts fewer commits and does not qualify yet.
    const earlier = result.draft.graphs.find((g) => (metricOf(g, 'hot.ts')?.changedCommits ?? 0) === 9)!;
    expect(earlier.diagnostics.filter((d) => d.ruleId === 'ATLAS_CHANGE_CONCENTRATION')).toEqual([]);
  });
  it('drops an over-cap historical frame and preserves the complete selected commit', async () => {
    const f = fixture([
      { date: day('2026-09-01'), message: 'larger past', files: { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 2;\n' } },
      { date: day('2026-09-02'), message: 'smaller head', files: { 'b.ts': null } },
    ]);
    const result = await analyze(f.dir, { limits: { includedFiles: 1 } });
    expect(result.status).toBe('partial');
    expect(result.draft.graphs).toHaveLength(1);
    expect(head(result).commitOid).toBe(f.commits[1]);
    expect(head(result).coverage.limitsHit).toEqual([]);
    expect(result.draft.history.frameSelection?.commits[0]).toMatchObject({ commitOid: f.commits[0], status: 'unavailable', reason: 'FRAME_RESOURCE_LIMIT' });
    expect(result.draft.manifest.coverage.history).toMatchObject({ status: 'partial', framesRequested: 2, framesCompleted: 1 });
    await roundTrip(result);
  });
});
