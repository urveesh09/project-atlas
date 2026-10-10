import { describe, expect, it } from 'vitest';
import {
  encodeCanonical,
  gunzipNode,
  gunzipWithStreams,
  gzipDeterministic,
  loadArtifact,
  packArtifact,
  type ArtifactSource,
  type PackedArtifact,
} from '@atlas/artifact/node';
import {
  canonicalJson,
  decodeIndexedGraph,
  encodeIndexedGraph,
  sha256Hex,
  utf8Bytes,
  validateGraphSnapshot,
  LIMITS,
  type ChunkRef,
} from '@atlas/schema';
import { buildHandcraftedArtifact } from '@atlas/test-fixtures';

function draft() {
  const a = buildHandcraftedArtifact();
  const { historyChunk: _h, layoutChunk: _l, chunks: _c, frames, ...manifest } = a.manifest;
  return {
    manifest: { ...manifest, frames: frames.map(({ graphChunk: _g, ...f }) => f) },
    graphs: [a.graph],
    history: a.history,
    layout: a.layout,
  };
}
function source(packed: PackedArtifact): ArtifactSource {
  return {
    async read(path, max) {
      const bytes = path === 'manifest.json' ? utf8Bytes(JSON.stringify(packed.manifest)) : packed.chunks.get(path);
      return bytes ? bytes.subarray(0, max + 1) : null;
    },
  };
}
const refs = (p: PackedArtifact): ChunkRef[] => [p.manifest.frames[0]!.graphChunk, p.manifest.chunks[0]!];
async function rewrite(p: PackedArtifact, mutate: (wire: ReturnType<typeof encodeIndexedGraph>) => void) {
  const ref = p.manifest.chunks[0]!;
  const bytes = await gunzipNode(p.chunks.get(ref.path)!, ref.uncompressedBytes);
  const wire = JSON.parse(new TextDecoder().decode(bytes)) as ReturnType<typeof encodeIndexedGraph>;
  mutate(wire);
  const encoded = encodeCanonical(wire),
    gz = gzipDeterministic(encoded.bytes);
  p.chunks.set(ref.path, gz);
  for (const r of refs(p))
    Object.assign(r, {
      uncompressedBytes: encoded.bytes.length,
      compressedBytes: gz.length,
      encodedSha256: encoded.sha256,
    });
}
const failures = async (p: PackedArtifact) => {
  const result = await loadArtifact(source(p), gunzipNode);
  return result.ok ? [] : result.issues.map((i) => i.code);
};

describe('indexed graph transport (ADR-018)', () => {
  it('retains the exact full-ID graph, independent fixture facts and canonical hash', () => {
    const graph = buildHandcraftedArtifact().graph;
    const wire = encodeIndexedGraph(graph);
    expect(wire.nodes.every((n) => !('id' in n))).toBe(true);
    expect(wire.edges.every((e) => !('id' in e))).toBe(true);
    expect(wire.importObservations.every((o) => !('id' in o))).toBe(true);
    const decoded = decodeIndexedGraph(wire);
    expect(decoded).toEqual(graph);
    expect(sha256Hex(canonicalJson(decoded))).toBe(sha256Hex(canonicalJson(graph)));
    expect(validateGraphSnapshot(decoded).ok).toBe(true);
  });

  it.each([
    ['Node', gunzipNode],
    ['browser', gunzipWithStreams],
  ] as const)(
    'round trips through %s with identical evidence, metrics, history and layout',
    async (_name, decompress) => {
      const packed = packArtifact(draft(), gzipDeterministic);
      expect(packed.manifest.artifactVersion).toBe('atlas.artifact/1.2.0');
      const result = await loadArtifact(source(packed), decompress);
      expect(result.ok ? result.bundle : result).toEqual(packed.bundle);
    },
  );

  it('reads legacy 1.0 plain graph artifacts', async () => {
    const input = draft();
    input.manifest.artifactVersion = 'atlas.artifact/1.0.0';
    const packed = packArtifact(input, gzipDeterministic, { graphEncoding: 'plain' });
    expect(packed.manifest.artifactVersion).toBe('atlas.artifact/1.0.0');
    expect(packed.manifest.frames[0]!.graphChunk.encoding).toBeUndefined();
    const result = await loadArtifact(source(packed), gunzipNode);
    expect(result.ok ? result.bundle : result).toEqual(packed.bundle);
  });

  it('retains compatibility with 1.1 indexed exports', async () => {
    const packed = packArtifact(draft(), gzipDeterministic);
    packed.manifest.artifactVersion = 'atlas.artifact/1.1.0';
    const result = await loadArtifact(source(packed), gunzipWithStreams);
    expect(result.ok ? result.bundle : result).toEqual({ ...packed.bundle, manifest: packed.manifest });
  });

  it('rejects cumulative decoded overflow before reading or allocating any chunk', async () => {
    const packed = packArtifact(draft(), gzipDeterministic);
    for (const r of refs(packed)) r.decodedBytes = LIMITS.artifactUncompressedBytes;
    const reads: string[] = [],
      original = source(packed);
    const result = await loadArtifact(
      {
        read(path, max) {
          reads.push(path);
          return original.read(path, max);
        },
      },
      gunzipWithStreams,
    );
    expect(result.ok ? [] : result.issues.map((i) => i.code)).toContain('LIMIT');
    expect(reads).toEqual(['manifest.json']);
  });

  it('rejects a tampered canonical ID instead of silently deriving a replacement', () => {
    const input = draft();
    input.graphs[0]!.nodes[0]!.id = `node_${'a'.repeat(64)}`;
    expect(() => packArtifact(input, gzipDeterministic)).toThrow(/ID_MISMATCH/);
  });

  it('checks exact expansion before deriving identifiers', () => {
    const graph = buildHandcraftedArtifact().graph;
    const size = utf8Bytes(canonicalJson(graph)).length;
    expect(decodeIndexedGraph(encodeIndexedGraph(graph), size)).toEqual(graph);
    expect(() => decodeIndexedGraph(encodeIndexedGraph(graph), size - 1)).toThrow(/decoded size limit/);
  });

  it.each([-1, 0.5, 99_999])('rejects invalid/dangling node index %s', async (position) => {
    const packed = packArtifact(draft(), gzipDeterministic);
    await rewrite(packed, (wire) => {
      wire.edges[0]!.sourceId = position;
    });
    expect(await failures(packed)).toContain('CHUNK_ENCODING');
  });

  it('rejects dangling evidence indices', async () => {
    const packed = packArtifact(draft(), gzipDeterministic);
    await rewrite(packed, (wire) => {
      wire.edges[0]!.evidenceIds = [249_999];
    });
    expect(await failures(packed)).toContain('CHUNK_ENCODING');
  });

  it('rejects a forged smaller decoded budget before expansion', async () => {
    const packed = packArtifact(draft(), gzipDeterministic);
    for (const r of refs(packed)) r.decodedBytes = 1;
    expect(await failures(packed)).toContain('DECODED_LIMIT');
  });

  it('rejects a duplicate derived entity rather than deduplicating it', async () => {
    const packed = packArtifact(draft(), gzipDeterministic);
    await rewrite(packed, (wire) => {
      wire.nodes.push(wire.nodes[0]!);
    });
    // Reconstructed content cannot match the original canonical graph hash/length.
    expect((await failures(packed)).length).toBeGreaterThan(0);
  });

  it('checks both wire and canonical hashes', async () => {
    for (const field of ['encodedSha256', 'sha256'] as const) {
      const packed = packArtifact(draft(), gzipDeterministic);
      for (const r of refs(packed)) r[field] = '0'.repeat(64);
      expect(await failures(packed)).toContain('CHUNK_HASH');
    }
  });

  it('rejects incomplete and inconsistent codec metadata', async () => {
    const missing = packArtifact(draft(), gzipDeterministic);
    for (const r of refs(missing)) delete r.encodedSha256;
    expect(await failures(missing)).toContain('CHUNK_ENCODING');
    const inconsistent = packArtifact(draft(), gzipDeterministic);
    inconsistent.manifest.frames[0]!.graphChunk = {
      ...inconsistent.manifest.frames[0]!.graphChunk,
      decodedBytes: inconsistent.manifest.frames[0]!.graphChunk.decodedBytes! + 1,
    };
    expect(await failures(inconsistent)).toContain('CHUNK_REFERENCE');
  });

  it('does not permit indexed metadata on history or on legacy manifests', async () => {
    const legacy = packArtifact(draft(), gzipDeterministic);
    legacy.manifest.artifactVersion = 'atlas.artifact/1.0.0';
    expect(await failures(legacy)).toContain('CHUNK_ENCODING');
    const history = packArtifact(draft(), gzipDeterministic);
    const r = history.manifest.historyChunk;
    Object.assign(r, { encoding: 'atlas.graph.indexed/1', encodedSha256: r.sha256, decodedBytes: r.uncompressedBytes });
    Object.assign(history.manifest.chunks[1]!, r);
    expect(await failures(history)).toContain('CHUNK_ENCODING');
  });
});
