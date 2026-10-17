import fc from 'fast-check';
import { expect, it } from 'vitest';
import { gunzipNode, gzipDeterministic, loadArtifact, packArtifact, type PackedArtifact } from '@atlas/artifact/node';
import { LIMITS, canonicalJson, decodeDeltaGraph, decodeIndexedGraph, encodeDeltaGraph, encodeIndexedGraph, utf8Bytes } from '@atlas/schema';
import { buildHandcraftedArtifact } from '@atlas/test-fixtures';
import { boundedJson } from '../../../scripts/lib/property-arbitraries.js';

const parameters = { seed: 0x43484e4b, numRuns: 80 };
const json = boundedJson(3);
function pack(): PackedArtifact {
  const a = buildHandcraftedArtifact();
  const { historyChunk: _h, layoutChunk: _l, chunks: _c, frames, ...manifest } = a.manifest;
  return packArtifact({ manifest: { ...manifest, frames: frames.map(({ graphChunk: _g, ...frame }) => frame) }, graphs: [a.graph], history: a.history, layout: a.layout }, gzipDeterministic);
}

it('artifact loading rejects arbitrary manifest bytes before reading any chunk', async () => {
  await fc.assert(fc.asyncProperty(fc.uint8Array({ maxLength: 4096 }), async (bytes) => {
    const reads: string[] = [];
    const loaded = await loadArtifact({ read: async (path, max) => {
      reads.push(path);
      expect(path).toBe('manifest.json');
      expect(max).toBeGreaterThanOrEqual(bytes.length);
      return bytes;
    } }, gunzipNode);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(['ARTIFACT_INVALID', 'UNSUPPORTED_SCHEMA']).toContain(loaded.code);
      expect(loaded.issues.length).toBeGreaterThan(0);
      for (const issue of loaded.issues) expect(typeof issue.code).toBe('string');
    }
    expect(reads).toEqual(['manifest.json']);
  }), parameters);
});

it('any single-byte payload corruption is rejected, with every source read bounded and allowlisted', async () => {
  const packed = pack();
  const paths = [...packed.chunks.keys()];
  const contents = await Promise.all(paths.map((path) => gunzipNode(packed.chunks.get(path)!, LIMITS.artifactUncompressedBytes)));
  await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: paths.length - 1 }), fc.nat(), fc.integer({ min: 1, max: 255 }), async (chunk, position, xor) => {
    const target = paths[chunk]!;
    // Mutate content, not gzip metadata (mtime/OS do not alter the verified payload).
    const payload = contents[chunk]!.slice();
    payload[position % payload.length]! ^= xor;
    const corrupt = gzipDeterministic(payload);
    const loaded = await loadArtifact({ read: async (path, max) => {
      expect(path === 'manifest.json' || packed.chunks.has(path)).toBe(true);
      expect(max).toBeGreaterThan(0);
      expect(max).toBeLessThanOrEqual(LIMITS.artifactUncompressedBytes);
      const bytes = path === 'manifest.json' ? utf8Bytes(JSON.stringify(packed.manifest)) : path === target ? corrupt : packed.chunks.get(path)!;
      return bytes.subarray(0, max + 1);
    } }, gunzipNode);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.code).toBe('ARTIFACT_INVALID');
  }), { ...parameters, numRuns: 40 });
});

it('indexed and delta encodings round-trip generated extension data exactly', () => {
  const base = buildHandcraftedArtifact().graph;
  fc.assert(fc.property(json, (value) => {
    const graph = { ...base, extensions: { 'atlas.property': value } };
    const indexed = encodeIndexedGraph(graph);
    expect(canonicalJson(decodeIndexedGraph(indexed))).toBe(canonicalJson(graph));
    const delta = encodeDeltaGraph(graph, base, indexed);
    expect(canonicalJson(decodeDeltaGraph(delta, base))).toBe(canonicalJson(graph));
  }), parameters);
});

/** Decoders have a synchronous named-error contract, not a generic catch-all. */
function decodeOrReject(run: () => unknown): unknown {
  try { return run(); }
  catch (error) {
    expect(error instanceof TypeError || error instanceof RangeError || (error instanceof Error && error.name === 'ZodError')).toBe(true);
    return undefined;
  }
}

it('arbitrary JSON at both graph decoders produces only named failures', () => {
  const base = buildHandcraftedArtifact().graph;
  fc.assert(fc.property(json, (value) => {
    // Generated JSON is bounded by depth/size; decoder row limits stay the production limits.
    decodeOrReject(() => decodeIndexedGraph(value, 8192));
    decodeOrReject(() => decodeDeltaGraph(value, base));
  }), parameters);
});

it('indexed reference mutations cannot allocate a graph beyond the requested decoded bound', () => {
  const wire = encodeIndexedGraph(buildHandcraftedArtifact().graph);
  fc.assert(fc.property(fc.integer({ min: -10, max: 1_000_000 }), fc.integer({ min: 1, max: 100_000 }), (reference, maxBytes) => {
    const input = structuredClone(wire);
    input.nodes[0]!.parentId = reference;
    const decoded = decodeOrReject(() => decodeIndexedGraph(input, maxBytes));
    if (decoded !== undefined) expect(Buffer.byteLength(canonicalJson(decoded))).toBeLessThanOrEqual(maxBytes);
  }), parameters);
});

it('delta keep-run mutations cannot expand beyond the production node limit', () => {
  const base = buildHandcraftedArtifact().graph;
  const wire = encodeDeltaGraph(base, base, encodeIndexedGraph(base));
  const runs = fc.array(fc.integer({ min: -10, max: LIMITS.treeEntriesPerSnapshot + 1 }), { maxLength: 12 });
  fc.assert(fc.property(runs, (keep) => {
    const input = structuredClone(wire);
    input.nodes.keep = keep;
    const decoded = decodeOrReject(() => decodeDeltaGraph(input, base));
    if (decoded !== undefined) expect((decoded as typeof base).nodes.length).toBeLessThanOrEqual(LIMITS.treeEntriesPerSnapshot);
  }), parameters);
});
