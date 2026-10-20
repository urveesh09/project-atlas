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
  canonicalJsonChunks,
  canonicalJsonDigest,
  canonicalJsonDigestIfEqual,
  decodeDeltaGraph,
  encodeDeltaGraph,
  encodeIndexedGraph,
  sha256Hex,
  utf8Bytes,
  FrameValidationContext,
  LIMITS,
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
  /**
   * @param fit set when the artifact exceeds an export limit: how many of the newest frames
   *   fit together with the history and layout chunks (0: not even the selected frame).
   */
  constructor(readonly issues: ValidationIssue[], readonly fit?: { frames: number }) {
    super(`Artifact failed validation before export: ${issues.slice(0, 3).map((i) => `${i.code} ${i.path} ${i.message}`).join('; ')}`);
    this.name = 'ArtifactPackError';
  }
}

/**
 * Export ceilings (plan §4.2, ADR-024): stored and compressed bytes of all chunks, and the
 * decoded bytes of any one chunk. Callers may lower them (tests, operators), never raise them.
 */
export interface ExportLimits {
  storedBytes: number;
  compressedBytes: number;
  decodedChunkBytes: number;
}
export function exportLimits(lowered: Partial<ExportLimits> = {}): ExportLimits {
  const at = (value: number | undefined, ceiling: number) => {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) throw new RangeError('Export limits are positive integers');
    return Math.min(value ?? ceiling, ceiling);
  };
  return {
    storedBytes: at(lowered.storedBytes, LIMITS.artifactUncompressedBytes),
    compressedBytes: at(lowered.compressedBytes, LIMITS.artifactCompressedBytes),
    decodedChunkBytes: at(lowered.decodedChunkBytes, LIMITS.artifactUncompressedBytes),
  };
}

export function encodeCanonical(value: unknown): { bytes: Uint8Array; sha256: string } {
  const blocks = Array.from(canonicalJsonChunks(value), utf8Bytes);
  const bytes = new Uint8Array(blocks.reduce((total, block) => total + block.length, 0));
  let offset = 0;
  for (const block of blocks) {
    bytes.set(block, offset);
    offset += block.length;
  }
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

/**
 * Chunks over the per-chunk byte ceiling (ADR-024), stored or decoded, as `LIMIT` issues.
 * The manifest schema rejects them too, but as `SCHEMA`; analysis degrades history or
 * bounds evidence only for limits (ADR-082, ADR-083).
 */
export function chunkLimitIssues(chunks: readonly Pick<ChunkRef, 'path' | 'uncompressedBytes' | 'decodedBytes'>[], ceiling: number = LIMITS.artifactUncompressedBytes): ValidationIssue[] {
  return chunks
    .filter((c) => Math.max(c.uncompressedBytes, c.decodedBytes ?? 0) > ceiling)
    .map((c) => ({ code: 'LIMIT', path: c.path, message: 'Chunk exceeds the uncompressed size limit' }));
}

/** Do not retain the validator's deep copy across encoding/decoding allocations. */
function checkGraphForExport(graph: GraphSnapshot, objectFormat: 'sha1' | 'sha256', verifyIds: boolean): void {
  const valid = validateGraphSnapshot(graph, { objectFormat, verifyIds });
  if (!valid.ok) throw new ArtifactPackError(valid.issues);
}

/** One encoded chunk and its compressed bytes. */
export interface EncodedChunk {
  ref: ChunkRef;
  bytes: Uint8Array;
}

function jsonChunk(path: string, value: unknown, compress: Compressor): EncodedChunk {
  const { bytes, sha256 } = encodeCanonical(value);
  const gz = compress(bytes);
  return { ref: { path, sha256, uncompressedBytes: bytes.length, compressedBytes: gz.length, mediaType: 'application/json' }, bytes: gz };
}

export type GraphEncoding = 'delta' | 'indexed' | 'plain';

/**
 * Encoded frame chunks by graph and delta base object (ADR-083). A frame chunk is a pure
 * function of exactly those two graphs, its encoding and the compressor, so packing the
 * same objects again (after older frames were dropped) reuses the proven bytes. Use one
 * cache per analysis and compressor.
 */
export class FrameChunkCache {
  readonly naturals = new GraphNaturalsCache();
  private readonly entries = new WeakMap<GraphSnapshot, Map<GraphSnapshot | null, { encoding: GraphEncoding; chunk: EncodedChunk }>>();

  /** `base` is null for an indexed or plain frame, else the newer frame it is a delta of. */
  encode(graph: GraphSnapshot, base: GraphSnapshot | null, objectFormat: 'sha1' | 'sha256', compress: Compressor, encoding: GraphEncoding): EncodedChunk {
    const cached = this.entries.get(graph)?.get(base);
    if (cached && cached.encoding === encoding) return { ref: { ...cached.chunk.ref }, bytes: cached.chunk.bytes };
    const delta = encoding === 'delta' && base !== null;
    // A delta frame's IDs are re-derived by the round trip below and compared byte for
    // byte, which proves them; every other graph has its IDs re-derived here.
    checkGraphForExport(graph, objectFormat, !delta);
    let canonical: { sha256: string; byteLength: number } | null = null;
    let wire: unknown = graph;
    if (encoding !== 'plain' && !delta) {
      canonical = canonicalJsonDigest(graph);
      wire = encodeIndexedGraph(graph);
    } else if (delta) {
      // The full indexed working graph is only an encoder input. Keep it out of
      // this scope so it is collectible before the mandatory decoder round trip.
      wire = encodeDeltaGraph(graph, base, () => encodeIndexedGraph(graph), this.naturals);
      // Lossless by construction, and proven here: a codec defect fails the export.
      // One exact (collision-free) comparison of canonical text also yields the digest.
      canonical = canonicalJsonDigestIfEqual(graph, decodeDeltaGraph(wire, base, this.naturals));
      if (canonical === null)
        throw new ArtifactPackError([{ code: 'CHUNK_ENCODING', path: `graphs/${graph.snapshotId}`, message: 'Frame delta did not reproduce its graph' }]);
    }
    const chunk = jsonChunk(`graphs/${graph.snapshotId}.json.gz`, wire, compress);
    if (encoding !== 'plain') {
      chunk.ref.encoding = delta ? DELTA_GRAPH_ENCODING : INDEXED_GRAPH_ENCODING;
      chunk.ref.encodedSha256 = chunk.ref.sha256;
      chunk.ref.sha256 = canonical!.sha256;
      chunk.ref.decodedBytes = canonical!.byteLength;
    }
    let byBase = this.entries.get(graph);
    if (!byBase) this.entries.set(graph, (byBase = new Map()));
    byBase.set(base, { encoding, chunk });
    return { ref: { ...chunk.ref }, bytes: chunk.bytes };
  }
}

/**
 * Pack an analysis result within the export limits. History and layout are encoded first,
 * then frames newest first: a delta's base is always newer, and the frames that fit are
 * the newest ones. The first frame that would exceed a limit stops packing with an
 * `ArtifactPackError` whose `fit` says how many newer frames fit (ADR-083); older frames
 * are never encoded. Within the limits, the artifact is the same as packing in chain order.
 */
export function packArtifact(
  input: { manifest: ManifestDraft; graphs: GraphSnapshot[]; history: HistoryArtifact; layout: LayoutArtifact },
  compress: Compressor,
  options: { graphEncoding?: GraphEncoding; frames?: FrameChunkCache; limits?: Partial<ExportLimits> } = {},
): PackedArtifact {
  const encoding = options.graphEncoding ?? 'delta';
  const limits = exportLimits(options.limits);
  const cache = options.frames ?? new FrameChunkCache();
  const count = input.manifest.frames.length;
  const head = input.graphs.at(-1);
  let history: EncodedChunk;
  let layout: EncodedChunk;
  if (encoding !== 'delta') {
    history = jsonChunk('history/history.json.gz', input.history, compress);
    layout = jsonChunk('layout/layout.json.gz', input.layout, compress);
  } else {
    // Compact history/layout (ADR-026): derivable IDs omitted, proven lossless here.
    const wire = { history: encodeCompactHistory(input.history), layout: encodeCompactLayout(input.layout) };
    if (!verifyCompactRoundTrip(input.history, input.layout, wire))
      throw new ArtifactPackError([{ code: 'CHUNK_ENCODING', path: 'history/layout', message: 'Compact history/layout did not reproduce the canonical chunks' }]);
    const encoded = (path: string, value: unknown, canonicalValue: unknown, kind: typeof COMPACT_HISTORY_ENCODING | typeof COMPACT_LAYOUT_ENCODING): EncodedChunk => {
      const chunk = jsonChunk(path, value, compress);
      const canonical = encodeCanonical(canonicalValue);
      chunk.ref.encoding = kind;
      chunk.ref.encodedSha256 = chunk.ref.sha256;
      chunk.ref.sha256 = canonical.sha256;
      chunk.ref.decodedBytes = canonical.bytes.length;
      return chunk;
    };
    history = encoded('history/history.json.gz', wire.history, input.history, COMPACT_HISTORY_ENCODING);
    layout = wire.layout ? encoded('layout/layout.json.gz', wire.layout, input.layout, COMPACT_LAYOUT_ENCODING) : jsonChunk('layout/layout.json.gz', input.layout, compress);
  }
  let stored = history.ref.uncompressedBytes + layout.ref.uncompressedBytes;
  let compressed = history.ref.compressedBytes + layout.ref.compressedBytes;
  const encodedFrames: EncodedChunk[] = new Array(count);
  for (let i = count - 1; i >= 0; i--) {
    const graph = input.graphs[i];
    if (!graph) throw new ArtifactPackError([{ code: 'FRAME_COUNT', path: 'graphs', message: 'Missing graph for frame' }]);
    const base = encoding === 'delta' && i !== count - 1 ? input.graphs[deltaBaseIndex(i, count)]! : null;
    const frame = cache.encode(graph, base, input.manifest.repo.objectFormat, compress, encoding);
    // Adjacent bases are used once. Release their decoder-key projections while
    // input graphs stay alive in the bundle; only HEAD keys are reused later.
    if (base !== null && base !== head) cache.naturals.forget(base);
    stored += frame.ref.uncompressedBytes;
    compressed += frame.ref.compressedBytes;
    const issues = chunkLimitIssues([frame.ref], limits.decodedChunkBytes);
    if (stored > limits.storedBytes) issues.push({ code: 'LIMIT', path: 'chunks', message: 'Artifact exceeds the uncompressed size limit' });
    if (compressed > limits.compressedBytes) issues.push({ code: 'LIMIT', path: 'chunks', message: 'Artifact exceeds the compressed transport limit' });
    if (issues.length > 0) throw new ArtifactPackError(issues, { frames: count - 1 - i });
    encodedFrames[i] = frame;
  }
  const frames: FrameDescriptor[] = input.manifest.frames.map((frame, i) => ({ ...frame, graphChunk: encodedFrames[i]!.ref }));
  const chunks = new Map<string, Uint8Array>();
  for (const chunk of [...encodedFrames, history, layout]) chunks.set(chunk.ref.path, chunk.bytes);
  const manifest: ArtifactManifest = {
    ...input.manifest,
    artifactVersion: encoding === 'plain' ? input.manifest.artifactVersion : ARTIFACT_VERSION,
    frames,
    historyChunk: history.ref,
    layoutChunk: layout.ref,
    chunks: [...frames.map((f) => f.graphChunk), history.ref, layout.ref],
  };
  // Graphs were validated as they were encoded; check the manifest, history, layout and every reference.
  const core = validateArtifactCore({ manifest, history: input.history, layout: input.layout });
  if (!core.ok) throw new ArtifactPackError(core.issues);
  const context = new FrameValidationContext(core.value);
  const issues = input.graphs.flatMap((graph, i) => validateFrameAgainstCore(context, i, graph));
  if (issues.length > 0) throw new ArtifactPackError(issues);
  return { manifest, bundle: { ...core.value, graphs: input.graphs }, chunks };
}
