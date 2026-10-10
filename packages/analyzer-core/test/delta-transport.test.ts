import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeCommit } from '@atlas/analyzer-core';
import { encodeCanonical, gunzipNode, gunzipWithStreams, gzipDeterministic, loadArtifact, openArtifact, packArtifact, type ArtifactSource, type PackedArtifact } from '@atlas/artifact/node';
import { gitVersion, openLocalRepository, resolveLocalCommit } from '@atlas/ingest';
import { canonicalJson, localRepositoryId, utf8Bytes, type ChunkRef, type DeltaGraph } from '@atlas/schema';
import { buildDemoRepository, type GitFixture } from '@atlas/test-fixtures';

/**
 * Frame-delta transport (ADR-026) under hostile input: every malformed delta fails in
 * the bounded loader before any graph reaches a renderer, and lazy frame loading applies
 * exactly the checks of an eager load.
 */
let demo: GitFixture;
let draft: Parameters<typeof packArtifact>[0];

beforeAll(async () => {
  demo = buildDemoRepository();
  const { repo, git } = await openLocalRepository(demo.dir);
  try {
    const head = await resolveLocalCommit(repo, git);
    const result = await analyzeCommit({
      git,
      commitOid: head,
      gitVersion: await gitVersion(),
      repository: { repoId: localRepositoryId('3f2a9c4e-8b1d-4f6a-9c2e-7d5b1a0e4c3f'), displayName: 'harbor', sourceKind: 'local-git', remote: null, objectFormat: 'sha1' },
      now: () => new Date('2026-10-10T00:00:00.000Z'),
    });
    draft = result.draft;
  } finally {
    await git.dispose();
  }
});
afterAll(() => demo?.dispose());

const pack = () => packArtifact(draft, gzipDeterministic);
function source(packed: PackedArtifact, reads?: string[]): ArtifactSource {
  return {
    async read(path, max) {
      reads?.push(path);
      const bytes = path === 'manifest.json' ? utf8Bytes(canonicalJson(packed.manifest)) : packed.chunks.get(path);
      return bytes ? bytes.subarray(0, max + 1) : null;
    },
  };
}
const codes = async (packed: PackedArtifact) => {
  const result = await loadArtifact(source(packed), gunzipNode);
  return result.ok ? [] : result.issues.map((i) => i.code);
};

/** Rewrite one delta chunk and keep every manifest reference to it consistent. */
async function mutateDelta(packed: PackedArtifact, frame: number, mutate: (wire: DeltaGraph) => void) {
  const ref = packed.manifest.frames[frame]!.graphChunk;
  const wire = JSON.parse(new TextDecoder().decode(await gunzipNode(packed.chunks.get(ref.path)!, ref.uncompressedBytes))) as DeltaGraph;
  mutate(wire);
  const encoded = encodeCanonical(wire);
  const gz = gzipDeterministic(encoded.bytes);
  packed.chunks.set(ref.path, gz);
  const refs: ChunkRef[] = [ref, packed.manifest.chunks.find((c) => c.path === ref.path)!];
  for (const r of refs) Object.assign(r, { uncompressedBytes: encoded.bytes.length, compressedBytes: gz.length, encodedSha256: encoded.sha256 });
}

describe('frame-delta transport', () => {
  it('round-trips every frame exactly through Node and browser decompressors', async () => {
    const packed = pack();
    for (const gunzip of [gunzipNode, gunzipWithStreams]) {
      const loaded = await loadArtifact(source(packed), gunzip);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) expect(loaded.bundle.graphs.map((g) => canonicalJson(g))).toEqual(draft.graphs.map((g) => canonicalJson(g)));
    }
  });

  it('opens with manifest, history, layout and HEAD only; other frames load on demand', async () => {
    const packed = pack();
    const reads: string[] = [];
    const opened = await openArtifact(source(packed, reads), gunzipNode);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const headPath = packed.manifest.frames.at(-1)!.graphChunk.path;
    expect(reads.sort()).toEqual(['history/history.json.gz', 'layout/layout.json.gz', 'manifest.json', headPath].sort());
    const frame3 = await opened.artifact.frame(3);
    expect(frame3.ok && canonicalJson(frame3.graph)).toBe(canonicalJson(draft.graphs[3]));
    expect(reads.filter((r) => r === packed.manifest.frames[3]!.graphChunk.path)).toHaveLength(1);
  });

  const hostile: [string, (w: DeltaGraph) => void, string][] = [
    ['runs beyond the base', (w) => w.nodes.keep.push(10_000, 5), 'CHUNK_ENCODING'],
    ['overlapping runs', (w) => w.nodes.keep.splice(0, 0, w.nodes.keep[0]!, 1), 'CHUNK_ENCODING'],
    ['odd-length runs', (w) => w.edges.keep.push(0), 'CHUNK_ENCODING'],
    ['a foreign base', (w) => (w.baseSnapshotId = `snap_${'0'.repeat(64)}`), 'CHUNK_ENCODING'],
    ['an out-of-range added reference', (w) => (w.diagnostics.add.length > 0 ? (w.diagnostics.add[0]!.subjectIds = [99_999]) : w.metrics.add.length > 0 ? (w.metrics.add[0]!.nodeId = 99_999) : null), 'CHUNK_ENCODING'],
    ['silently dropped rows', (w) => (w.metrics.keep = w.metrics.keep.slice(2)), 'CHUNK_LENGTH'],
    ['an extra field', (w) => Object.assign(w, { script: 'x' }), 'CHUNK_ENCODING'],
  ];
  for (const [name, mutate, code] of hostile) {
    it(`rejects ${name} before rendering`, async () => {
      const packed = pack();
      await mutateDelta(packed, 4, mutate);
      const found = await codes(packed);
      expect(found.length).toBeGreaterThan(0);
      expect(found).toContain(code);
    });
  }

  it('rejects a tampered row whose re-encoded chunk is self-consistent (decoded hash check)', async () => {
    const packed = pack();
    await mutateDelta(packed, 4, (w) => {
      const metric = w.metrics.add.find((m) => m.codeLines !== null);
      if (metric) metric.codeLines = metric.codeLines! + 1;
      else w.coverage.observedImports += 1;
    });
    expect(await codes(packed)).toEqual(expect.arrayContaining([expect.stringMatching(/CHUNK_HASH|CHUNK_LENGTH/)]));
  });

  it('refuses a delta for the selected frame and deltas in pre-1.3 artifacts', async () => {
    const asHead = pack();
    asHead.manifest.frames.at(-1)!.graphChunk.encoding = 'atlas.graph.delta/1';
    asHead.manifest.chunks.find((c) => c.path === asHead.manifest.frames.at(-1)!.graphChunk.path)!.encoding = 'atlas.graph.delta/1';
    expect(await codes(asHead)).toContain('CHUNK_ENCODING');
    const old = pack();
    old.manifest.artifactVersion = 'atlas.artifact/1.2.0';
    expect(await codes(old)).toContain('CHUNK_ENCODING');
  });

  /** Rewrite any encoded chunk (manifest references kept consistent). */
  async function mutateChunk(packed: PackedArtifact, chunkPath: string, mutate: (wire: Record<string, unknown>) => void) {
    const ref = packed.manifest.chunks.find((c) => c.path === chunkPath)!;
    const wire = JSON.parse(new TextDecoder().decode(await gunzipNode(packed.chunks.get(ref.path)!, ref.uncompressedBytes))) as Record<string, unknown>;
    mutate(wire);
    const encoded = encodeCanonical(wire);
    const gz = gzipDeterministic(encoded.bytes);
    packed.chunks.set(ref.path, gz);
    const refs = [ref, packed.manifest.historyChunk, packed.manifest.layoutChunk, ...packed.manifest.frames.map((f) => f.graphChunk)].filter((r) => r.path === chunkPath);
    for (const r of refs) Object.assign(r, { uncompressedBytes: encoded.bytes.length, compressedBytes: gz.length, encodedSha256: encoded.sha256 });
  }

  it('stores history and layout compactly and rejects forged compact rows', async () => {
    const packed = pack();
    expect(packed.manifest.historyChunk.encoding).toBe('atlas.history.compact/1');
    expect(packed.manifest.layoutChunk.encoding).toBe('atlas.layout.compact/1');
    const badFrame = pack();
    await mutateChunk(badFrame, 'history/history.json.gz', (w) => {
      ((w['lineages'] as { occurrences: [number, string | null][] }[])[0]!.occurrences[0]![0] = 11);
    });
    expect(await codes(badFrame)).toEqual(expect.arrayContaining([expect.stringMatching(/CHUNK_HASH|CHUNK_LENGTH|CHUNK_ENCODING|LINEAGE/)]));
    const badRuns = pack();
    await mutateChunk(badRuns, 'layout/layout.json.gz', (w) => {
      (w['frameState'] as { plots: number[] }[])[0]!.plots.push(50_000, 1);
    });
    expect(await codes(badRuns)).toContain('CHUNK_ENCODING');
  });

  it('chains deltas through keyframes and refuses a base that is not newer', async () => {
    const packed = pack();
    const bases = await Promise.all(
      packed.manifest.frames.slice(0, -1).map(async (f) => {
        const wire = JSON.parse(new TextDecoder().decode(await gunzipNode(packed.chunks.get(f.graphChunk.path)!, f.graphChunk.uncompressedBytes))) as DeltaGraph;
        return packed.manifest.frames.findIndex((x) => x.snapshotId === wire.baseSnapshotId);
      }),
    );
    // 12 frames: 11 is HEAD; 8, 5 and 2 are keyframes on HEAD; the rest use their newer neighbour.
    expect(bases).toEqual([1, 2, 11, 4, 5, 11, 7, 8, 11, 10, 11]);
    const cyclic = pack();
    await mutateDelta(cyclic, 4, (w) => (w.baseSnapshotId = cyclic.manifest.frames[3]!.snapshotId));
    expect(await codes(cyclic)).toContain('CHUNK_ENCODING');
    const overlong = pack();
    // Turn a keyframe into a newer-neighbour delta: the loader must reject the
    // fourth link before reconstructing the deliberately re-based row data.
    await mutateDelta(overlong, 8, (w) => (w.baseSnapshotId = overlong.manifest.frames[9]!.snapshotId));
    expect(await codes(overlong)).toContain('CHUNK_ENCODING');
  });

  it('keeps historical frames small: deltas cost a fraction of the selected graph', () => {
    const packed = pack();
    const headBytes = packed.manifest.frames.at(-1)!.graphChunk.compressedBytes;
    for (const frame of packed.manifest.frames.slice(0, -1)) expect(frame.graphChunk.compressedBytes).toBeLessThan(headBytes / 2);
    expect(packed.manifest.frames.slice(0, -1).reduce((sum, f) => sum + f.graphChunk.compressedBytes, 0)).toBeLessThan(headBytes * 3);
  });
});
