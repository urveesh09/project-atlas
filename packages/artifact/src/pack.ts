import {
  ARTIFACT_VERSION,
  COMPACT_HISTORY_ENCODING,
  COMPACT_LAYOUT_ENCODING,
  DELTA_GRAPH_ENCODING,
  encodeCompactHistory,
  encodeCompactLayout,
  verifyCompactRoundTrip,
  GraphNaturalsCache,
  INDEXED_GRAPH_ENCODING,
  canonicalJson,
  decodeDeltaGraph,
  encodeDeltaGraph,
  encodeIndexedGraph,
  sha256Hex,
  utf8Bytes,
  FrameValidationContext,
  validateArtifactCore,
  validateFrameAgainstCore,
  validateGraphSnapshot,
  type ArtifactBundle,
  type ArtifactManifest,
  type ChunkRef,
  type FrameDescriptor,
  type GraphSnapshot,
  type HistoryArtifact,
  type LayoutArtifact,
  type ValidationIssue,
} from '@atlas/schema';

/**
 * Turn an analysis result into artifact chunks (plan §6.5). Chunk hashes are over the
 * uncompressed canonical JSON, so they are reproducible regardless of compressor; the
 * transport (gzip) bytes are hashed only for integrity of the copy.
 */
export type FrameDraft = Omit<FrameDescriptor, 'graphChunk'>;
export type ManifestDraft = Omit<ArtifactManifest, 'frames' | 'historyChunk' | 'layoutChunk' | 'chunks'> & { frames: FrameDraft[] };

export type Compressor = (bytes: Uint8Array) => Uint8Array;

export interface PackedArtifact {
  manifest: ArtifactManifest;
  bundle: ArtifactBundle;
  /** Published path -> compressed bytes. */
  chunks: Map<string, Uint8Array>;
}

export class ArtifactPackError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super(`Artifact failed validation before export: ${issues.slice(0, 3).map((i) => `${i.code} ${i.path} ${i.message}`).join('; ')}`);
    this.name = 'ArtifactPackError';
  }
}

export function encodeCanonical(value: unknown): { bytes: Uint8Array; sha256: string } {
  const bytes = utf8Bytes(canonicalJson(value));
  return { bytes, sha256: sha256Hex(bytes) };
}

/**
 * Graph encodings: `delta` (default) stores the selected frame indexed (ADR-018) and every
 * historical frame as a lossless delta against it (ADR-026); `indexed` indexes every
 * frame; `plain` writes canonical graph JSON (artifact 1.0 shape, for tests and tools).
 */
/**
 * Frame-delta bases (ADR-026): counting back from the selected frame, every third frame is
 * a keyframe encoded against the selected graph; the others are encoded against their
 * next newer frame. Each interval's changes are stored about once, and decoding any frame
 * needs at most `KEYFRAME_INTERVAL` deltas. A base is always newer, so chains are acyclic.
 */
export const KEYFRAME_INTERVAL = 3;
export function deltaBaseIndex(index: number, frames: number): number {
  const distance = frames - 1 - index;
  return distance % KEYFRAME_INTERVAL === 0 ? frames - 1 : index + 1;
}

export function packArtifact(
  input: { manifest: ManifestDraft; graphs: GraphSnapshot[]; history: HistoryArtifact; layout: LayoutArtifact },
  compress: Compressor,
  options: { graphEncoding?: 'delta' | 'indexed' | 'plain' } = {},
): PackedArtifact {
  const encoding = options.graphEncoding ?? 'delta';
  const head = input.graphs.at(-1);
  const naturals = new GraphNaturalsCache();
  const chunks = new Map<string, Uint8Array>();
  const ref = (path: string, value: unknown): ChunkRef => {
    const { bytes, sha256 } = encodeCanonical(value);
    const gz = compress(bytes);
    chunks.set(path, gz);
    return { path, sha256, uncompressedBytes: bytes.length, compressedBytes: gz.length, mediaType: 'application/json' };
  };
  const frames: FrameDescriptor[] = input.manifest.frames.map((frame, i) => {
    const graph = input.graphs[i];
    if (!graph) throw new ArtifactPackError([{ code: 'FRAME_COUNT', path: 'graphs', message: 'Missing graph for frame' }]);
    const isHead = i === input.manifest.frames.length - 1;
    const delta = encoding === 'delta' && !isHead && head !== undefined;
    // A delta frame's IDs are re-derived by the round trip below and compared byte for
    // byte, which proves them; every other graph has its IDs re-derived here.
    const valid = validateGraphSnapshot(graph, { objectFormat: input.manifest.repo.objectFormat, verifyIds: !delta });
    if (!valid.ok) throw new ArtifactPackError(valid.issues);
    const text = encoding === 'plain' ? '' : canonicalJson(graph);
    let wire: unknown = graph;
    if (encoding !== 'plain') {
      const indexed = encodeIndexedGraph(graph);
      const base = (delta ? input.graphs[deltaBaseIndex(i, input.manifest.frames.length)] : head)!;
      wire = delta ? encodeDeltaGraph(graph, base, indexed, naturals) : indexed;
      if (delta && canonicalJson(decodeDeltaGraph(wire, base, naturals)) !== text) {
        // Lossless by construction, and proven here: a codec defect fails the export.
        throw new ArtifactPackError([{ code: 'CHUNK_ENCODING', path: `graphs/${graph.snapshotId}`, message: 'Frame delta did not reproduce its graph' }]);
      }
      // Adjacent historical bases are used once in this packing order. Input graphs
      // stay alive in the bundle, so WeakMap keys alone cannot release their large
      // derived row strings. Only HEAD is reused by later keyframe intervals.
      if (delta && base !== head) naturals.forget(base);
    }
    const graphChunk = ref(`graphs/${graph.snapshotId}.json.gz`, wire);
    if (encoding !== 'plain') {
      const bytes = utf8Bytes(text);
      const canonical = { bytes, sha256: sha256Hex(bytes) };
      graphChunk.encoding = delta ? DELTA_GRAPH_ENCODING : INDEXED_GRAPH_ENCODING;
      graphChunk.encodedSha256 = graphChunk.sha256;
      graphChunk.sha256 = canonical.sha256;
      graphChunk.decodedBytes = canonical.bytes.length;
    }
    return { ...frame, graphChunk };
  });
  let historyChunk: ChunkRef;
  let layoutChunk: ChunkRef;
  if (encoding !== 'delta') {
    historyChunk = ref('history/history.json.gz', input.history);
    layoutChunk = ref('layout/layout.json.gz', input.layout);
  } else {
    // Compact history/layout (ADR-026): derivable IDs omitted, proven lossless here.
    const wire = { history: encodeCompactHistory(input.history), layout: encodeCompactLayout(input.layout) };
    if (!verifyCompactRoundTrip(input.history, input.layout, wire))
      throw new ArtifactPackError([{ code: 'CHUNK_ENCODING', path: 'history/layout', message: 'Compact history/layout did not reproduce the canonical chunks' }]);
    const encoded = (path: string, value: unknown, canonicalValue: unknown, kind: typeof COMPACT_HISTORY_ENCODING | typeof COMPACT_LAYOUT_ENCODING): ChunkRef => {
      const chunk = ref(path, value);
      const canonical = encodeCanonical(canonicalValue);
      chunk.encoding = kind;
      chunk.encodedSha256 = chunk.sha256;
      chunk.sha256 = canonical.sha256;
      chunk.decodedBytes = canonical.bytes.length;
      return chunk;
    };
    historyChunk = encoded('history/history.json.gz', wire.history, input.history, COMPACT_HISTORY_ENCODING);
    layoutChunk = wire.layout ? encoded('layout/layout.json.gz', wire.layout, input.layout, COMPACT_LAYOUT_ENCODING) : ref('layout/layout.json.gz', input.layout);
  }
  const manifest: ArtifactManifest = {
    ...input.manifest,
    artifactVersion: encoding === 'plain' ? input.manifest.artifactVersion : ARTIFACT_VERSION,
    frames,
    historyChunk,
    layoutChunk,
    chunks: [...frames.map((f) => f.graphChunk), historyChunk, layoutChunk],
  };
  // Graphs were validated above; check the manifest, history, layout and every reference.
  const core = validateArtifactCore({ manifest, history: input.history, layout: input.layout });
  if (!core.ok) throw new ArtifactPackError(core.issues);
  const context = new FrameValidationContext(core.value);
  const issues = input.graphs.flatMap((graph, i) => validateFrameAgainstCore(context, i, graph));
  if (issues.length > 0) throw new ArtifactPackError(issues);
  return { manifest, bundle: { ...core.value, graphs: input.graphs }, chunks };
}
