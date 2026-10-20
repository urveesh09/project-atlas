import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnalysisError, analyzeCommit, type AnalysisResult } from '@atlas/analyzer-core';
import { gzipDeterministic, type ExportLimits } from '@atlas/artifact/node';
import { gitVersion, openLocalRepository, resolveLocalCommit, type SafeGit } from '@atlas/ingest';
import { canonicalJson, localRepositoryId, validateArtifactBundle } from '@atlas/schema';
import { buildDemoRepository, type GitFixture } from '@atlas/test-fixtures';

// ADR-083: the export fits its limits by keeping the newest frames that fit and, for the
// selected frame alone, fewer evidence rows. Lowered limits exercise it on Harbor.
const repoId = localRepositoryId('3f2a9c4e-8b1d-4f6a-9c2e-7d5b1a0e4c3f');
let demo: GitFixture;
let git: SafeGit;
let head: string;
let version: string;

const run = (exportLimits?: Partial<ExportLimits>): Promise<AnalysisResult> =>
  analyzeCommit({
    git,
    commitOid: head,
    gitVersion: version,
    repository: { repoId, displayName: 'harbor', sourceKind: 'local-git', remote: null, objectFormat: 'sha1' },
    now: () => new Date('2026-10-10T00:00:00.000Z'),
    transport: gzipDeterministic,
    ...(exportLimits ? { exportLimits } : {}),
  });
const stored = (result: AnalysisResult) => result.packed!.manifest.chunks.reduce((total, c) => total + c.uncompressedBytes, 0);
const valid = (result: AnalysisResult) =>
  validateArtifactBundle({ manifest: result.packed!.manifest, graphs: result.draft.graphs, history: result.draft.history, layout: result.draft.layout }).ok;

let full: AnalysisResult;
beforeAll(async () => {
  demo = buildDemoRepository();
  const opened = await openLocalRepository(demo.dir);
  git = opened.git;
  head = await resolveLocalCommit(opened.repo, git);
  version = await gitVersion();
  full = await run();
}, 120_000);
afterAll(async () => {
  await git?.dispose();
  demo?.dispose();
});

describe('fitting the export limits (ADR-083)', () => {
  it('keeps the newest frames that fit, each identical to the unlimited analysis', async () => {
    const frames = full.draft.graphs.length;
    expect(frames).toBeGreaterThan(3);
    // Room for about half the history beside the selected frame.
    const limit = Math.floor(stored(full) * 0.75);
    const fitted = await run({ storedBytes: limit });
    expect(valid(fitted)).toBe(true);
    expect(stored(fitted)).toBeLessThanOrEqual(limit);
    const kept = fitted.draft.graphs.length;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(frames);
    // The kept frames are the newest ones, unchanged by the frames dropped before them.
    const newest = full.draft.graphs.slice(frames - kept);
    fitted.draft.graphs.forEach((graph, i) => expect(canonicalJson(graph)).toBe(canonicalJson(newest[i])));
    const dropped = fitted.summary.history.frames.unavailable;
    expect(dropped).toHaveLength(frames - kept);
    expect(new Set(dropped.map((d) => d.reason))).toEqual(new Set(['ARTIFACT_SIZE']));
    expect(fitted.status).toBe('partial');
  }, 120_000);

  it('packs exactly the unlimited artifact when everything fits', async () => {
    const fitted = await run({ storedBytes: stored(full) });
    expect(fitted.packed!.manifest.chunks).toEqual(full.packed!.manifest.chunks);
  }, 120_000);

  it('keeps fewer evidence rows when the selected graph alone exceeds the decoded ceiling', async () => {
    const headChunk = full.packed!.manifest.frames.at(-1)!.graphChunk;
    const ceiling = Math.floor(headChunk.decodedBytes! * 0.9);
    const fitted = await run({ decodedChunkBytes: ceiling });
    expect(valid(fitted)).toBe(true);
    const selected = fitted.draft.graphs.at(-1)!;
    const unlimited = full.draft.graphs.at(-1)!;
    expect(fitted.packed!.manifest.frames.at(-1)!.graphChunk.decodedBytes).toBeLessThanOrEqual(ceiling);
    // Evidence rows are fewer, lowest IDs kept; every relationship is still there.
    expect(selected.importObservations.length).toBeLessThan(unlimited.importObservations.length);
    expect(selected.importObservations.map((o) => o.id)).toEqual(unlimited.importObservations.slice(0, selected.importObservations.length).map((o) => o.id));
    expect(selected.edges.map((e) => [e.id, e.observationCount])).toEqual(unlimited.edges.map((e) => [e.id, e.observationCount]));
    expect(selected.coverage.limitsHit).toContain('EVIDENCE_LIMIT');
    expect(selected.coverage.reasons.find((r) => r.code === 'EVIDENCE_LIMIT')?.count).toBe(unlimited.importObservations.length - selected.importObservations.length);
    expect(fitted.status).toBe('partial');
  }, 120_000);

  it('fails with ARTIFACT_SIZE when the selected frame cannot fit at all', async () => {
    const error = await run({ storedBytes: 1024 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AnalysisError);
    expect((error as AnalysisError).details).toMatchObject({ limit: 'ARTIFACT_SIZE' });
  }, 120_000);
});
