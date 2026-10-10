import {
  ARTIFACT_VERSION,
  FrameValidationContext,
  GRAPH_SCHEMA_VERSION,
  GraphNaturalsCache,
  LIMITS,
  canonicalJson,
  decodeCompactHistory,
  decodeCompactLayout,
  decodeDeltaGraph,
  decodeIndexedGraph,
  isCompatibleContractVersion,
  sha256Hex,
  validateArtifactCore,
  validateFrameAgainstCore,
  validateGraphSnapshot,
  validateManifest,
  type ArtifactBundle,
  type ArtifactManifest,
  type ChunkRef,
  type GraphSnapshot,
  type HistoryArtifact,
  type LayoutArtifact,
  type ValidationIssue,
} from '@atlas/schema';

/**
 * Bounded artifact import shared by the CLI, the local server and the browser (plan
 * §6.5). It never trusts declared sizes: every read and every decompression is capped,
 * then lengths and hashes are re-checked, then the full invariants run. It knows nothing
 * about rendering.
 */
export interface ArtifactSource {
  /** Read a published path. Return null when absent. Must not read more than `maxBytes`+1. */
  read(path: string, maxBytes: number): Promise<Uint8Array | null>;
}

/** Decompress gzip, failing once output would exceed `maxBytes` (decompression bombs). */
export type Decompressor = (compressed: Uint8Array, maxBytes: number) => Promise<Uint8Array>;

export type LoadFailureCode = 'ARTIFACT_INVALID' | 'UNSUPPORTED_SCHEMA';

export type LoadResult =
  | { ok: true; bundle: ArtifactBundle; stats: { compressedBytes: number; uncompressedBytes: number; chunks: number } }
  | { ok: false; code: LoadFailureCode; issues: ValidationIssue[] };

type Failure = Extract<LoadResult, { ok: false }>;
export type FrameResult = { ok: true; graph: GraphSnapshot } | Failure;

/**
 * A validated artifact whose selected (HEAD) frame is decoded and whose other frames are
 * decoded on demand (plan §11.7: manifest/layout first, HEAD graph, then adjacent frames).
 * Every frame passes the same chunk, decode, graph and cross-reference checks as an eager
 * load; the caller owns caching.
 */
export interface OpenedArtifact {
  manifest: ArtifactManifest;
  history: HistoryArtifact;
  layout: LayoutArtifact;
  head: GraphSnapshot;
  /** Decode and validate frame `index` (manifest order). The selected frame resolves at once. */
  frame(index: number, signal?: AbortSignal): Promise<FrameResult>;
  stats: { compressedBytes: number; uncompressedBytes: number; chunks: number };
}

export type OpenResult = { ok: true; artifact: OpenedArtifact } | Failure;

export const MANIFEST_PATH = 'manifest.json';
export const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

async function artifactHash(data: Uint8Array | string): Promise<string> {
  if (!globalThis.crypto?.subtle) return sha256Hex(data);
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export class DecompressionLimitError extends Error {
  constructor(readonly limit: number) {
    super(`Decompressed data exceeds ${limit} bytes`);
    this.name = 'DecompressionLimitError';
  }
}

function fail(code: LoadFailureCode, issueCode: string, path: string, message: string): Failure {
  return { ok: false, code, issues: [{ code: issueCode, path, message }] };
}

function parseJson(bytes: Uint8Array, path: string): { ok: true; value: unknown; text: string } | { ok: false; result: Failure } {
  let text: string;
  try {
    text = strictUtf8.decode(bytes);
  } catch {
    return { ok: false, result: fail('ARTIFACT_INVALID', 'ENCODING', path, 'Not valid UTF-8') };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown, text };
  } catch {
    return { ok: false, result: fail('ARTIFACT_INVALID', 'JSON', path, 'Not valid JSON') };
  }
}

type Step<T> = { ok: true; value: T } | { ok: false; result: Failure };

/** Read, decompress, length/hash-check and parse one canonical chunk. */
async function readChunk(source: ArtifactSource, decompress: Decompressor, chunk: ChunkRef, mark: (stage: string) => void): Promise<Step<unknown>> {
  const compressed = await source.read(chunk.path, chunk.compressedBytes);
  if (compressed === null) return { ok: false, result: fail('ARTIFACT_INVALID', 'CHUNK_MISSING', chunk.path, 'Referenced chunk is missing') };
  if (compressed.length !== chunk.compressedBytes)
    return { ok: false, result: fail('ARTIFACT_INVALID', 'CHUNK_LENGTH', chunk.path, 'Chunk transport length differs from the manifest') };
  let bytes: Uint8Array;
  try {
    bytes = await decompress(compressed, chunk.uncompressedBytes);
  } catch (error) {
    return {
      ok: false,
      result: fail(
        'ARTIFACT_INVALID',
        error instanceof DecompressionLimitError ? 'DECOMPRESSION_LIMIT' : 'DECOMPRESSION',
        chunk.path,
        'Chunk could not be decompressed within its declared size',
      ),
    };
  }
  if (bytes.length !== chunk.uncompressedBytes)
    return { ok: false, result: fail('ARTIFACT_INVALID', 'CHUNK_LENGTH', chunk.path, 'Decompressed length differs from the manifest') };
  mark(`read:${chunk.path}`);
  if ((await artifactHash(bytes)) !== (chunk.encodedSha256 ?? chunk.sha256))
    return { ok: false, result: fail('ARTIFACT_INVALID', 'CHUNK_HASH', chunk.path, 'Chunk content hash differs from the manifest') };
  const parsed = parseJson(bytes, chunk.path);
  if (!parsed.ok) return parsed;
  if (canonicalJson(parsed.value) !== parsed.text)
    return { ok: false, result: fail('ARTIFACT_INVALID', 'NOT_CANONICAL', chunk.path, 'Chunk is not canonical JSON') };
  mark(`wire:${chunk.path}`);
  return { ok: true, value: parsed.value };
}

/** Decode an encoded graph chunk and prove it reproduces the manifest's canonical bytes. */
async function decodeGraphChunk(
  chunk: ChunkRef,
  wire: unknown,
  head: GraphSnapshot | null,
  naturals: GraphNaturalsCache,
  mark: (stage: string) => void,
): Promise<Step<unknown>> {
  if (!chunk.encoding) return { ok: true, value: wire };
  let graph: GraphSnapshot;
  try {
    if (chunk.encoding === 'atlas.graph.delta/1') {
      if (!head) throw new TypeError('A frame delta needs its decoded base');
      graph = decodeDeltaGraph(wire, head, naturals);
    } else graph = decodeIndexedGraph(wire, chunk.decodedBytes);
  } catch (error) {
    return {
      ok: false,
      result: fail(
        'ARTIFACT_INVALID',
        error instanceof RangeError ? 'DECODED_LIMIT' : 'CHUNK_ENCODING',
        chunk.path,
        'Encoded graph is invalid or exceeds its decoded size limit',
      ),
    };
  }
  mark('encoded-shape-and-identities');
  const canonicalBytes = new TextEncoder().encode(canonicalJson(graph));
  mark('canonical-decoded-json');
  if (canonicalBytes.length !== chunk.decodedBytes)
    return { ok: false, result: fail('ARTIFACT_INVALID', 'CHUNK_LENGTH', chunk.path, 'Decoded canonical length differs from the manifest') };
  if ((await artifactHash(canonicalBytes)) !== chunk.sha256)
    return { ok: false, result: fail('ARTIFACT_INVALID', 'CHUNK_HASH', chunk.path, 'Decoded canonical hash differs from the manifest') };
  mark(`decode:${chunk.path}`);
  return { ok: true, value: graph };
}

/** Decode a compact history/layout chunk and prove it reproduces the manifest's canonical bytes. */
async function decodeCompactChunk(chunk: ChunkRef, wire: unknown, decode: (wire: unknown) => unknown, mark: (stage: string) => void): Promise<Step<unknown>> {
  if (!chunk.encoding) return { ok: true, value: wire };
  let value: unknown;
  try {
    // The schema and the history validator run on the decoded value; a bad history makes
    // the layout decode fail here rather than silently pairing wrong occurrences.
    value = decode(wire);
  } catch {
    return { ok: false, result: fail('ARTIFACT_INVALID', 'CHUNK_ENCODING', chunk.path, 'Compact chunk is invalid') };
  }
  const bytes = new TextEncoder().encode(canonicalJson(value));
  if (bytes.length !== chunk.decodedBytes) return { ok: false, result: fail('ARTIFACT_INVALID', 'CHUNK_LENGTH', chunk.path, 'Decoded canonical length differs from the manifest') };
  if ((await artifactHash(bytes)) !== chunk.sha256) return { ok: false, result: fail('ARTIFACT_INVALID', 'CHUNK_HASH', chunk.path, 'Decoded canonical hash differs from the manifest') };
  mark(`decode:${chunk.path}`);
  return { ok: true, value };
}

export async function openArtifact(
  source: ArtifactSource,
  decompress: Decompressor,
  measure?: (stage: string, ms: number) => void,
): Promise<OpenResult> {
  let checkpoint = performance.now();
  const mark = (stage: string) => {
    const now = performance.now();
    measure?.(stage, now - checkpoint);
    checkpoint = now;
  };
  const manifestBytes = await source.read(MANIFEST_PATH, MANIFEST_MAX_BYTES);
  if (manifestBytes === null) return fail('ARTIFACT_INVALID', 'MANIFEST_MISSING', MANIFEST_PATH, 'No manifest.json in the artifact');
  if (manifestBytes.length > MANIFEST_MAX_BYTES) return fail('ARTIFACT_INVALID', 'LIMIT', MANIFEST_PATH, 'Manifest exceeds its size limit');
  const parsedManifest = parseJson(manifestBytes, MANIFEST_PATH);
  if (!parsedManifest.ok) return parsedManifest.result;

  // Foreign major versions are reported as such before any shape validation.
  const raw = parsedManifest.value as Record<string, unknown> | null;
  const artifactVersion = typeof raw?.['artifactVersion'] === 'string' ? raw['artifactVersion'] : '';
  const schemaVersion = typeof raw?.['schemaVersion'] === 'string' ? raw['schemaVersion'] : '';
  if (!isCompatibleContractVersion(artifactVersion, ARTIFACT_VERSION) || !isCompatibleContractVersion(schemaVersion, GRAPH_SCHEMA_VERSION)) {
    return fail(
      'UNSUPPORTED_SCHEMA',
      'VERSION',
      MANIFEST_PATH,
      `Unsupported artifact (${artifactVersion || 'unknown'}, ${schemaVersion || 'unknown'}); this build reads ${ARTIFACT_VERSION}`,
    );
  }
  const manifestResult = validateManifest(parsedManifest.value);
  if (!manifestResult.ok) return { ok: false, code: 'ARTIFACT_INVALID', issues: manifestResult.issues.map((i) => ({ ...i, path: `manifest:${i.path}` })) };
  const manifest = manifestResult.value;
  // Cumulative declared sizes are bounded before any chunk is read; each read is then
  // bounded by its own declaration and re-checked after decompression and decoding.
  let compressedTotal = 0;
  let uncompressedTotal = 0;
  for (const chunk of manifest.chunks) {
    compressedTotal += chunk.compressedBytes;
    uncompressedTotal += chunk.uncompressedBytes;
    if (compressedTotal > LIMITS.artifactCompressedBytes || uncompressedTotal > LIMITS.artifactUncompressedBytes)
      return fail('ARTIFACT_INVALID', 'LIMIT', chunk.path, 'Artifact exceeds the cumulative size limits');
  }

  const historyWire = await readChunk(source, decompress, manifest.historyChunk, mark);
  if (!historyWire.ok) return historyWire.result;
  const layoutWire = await readChunk(source, decompress, manifest.layoutChunk, mark);
  if (!layoutWire.ok) return layoutWire.result;
  const history = await decodeCompactChunk(manifest.historyChunk, historyWire.value, (wire) => decodeCompactHistory(wire), mark);
  if (!history.ok) return history.result;
  const layout = await decodeCompactChunk(manifest.layoutChunk, layoutWire.value, (wire) => decodeCompactLayout(wire, history.value as HistoryArtifact), mark);
  if (!layout.ok) return layout.result;
  const core = validateArtifactCore({ manifest, history: history.value, layout: layout.value });
  if (!core.ok) return { ok: false, code: 'ARTIFACT_INVALID', issues: core.issues };
  mark('core-validation');
  const context = new FrameValidationContext(core.value);
  const naturals = new GraphNaturalsCache();
  const headIndex = manifest.frames.length - 1;

  const frameOf = new Map(manifest.frames.map((f, i) => [f.snapshotId, i]));
  let head: GraphSnapshot | null = null;
  // Decode-chain reuse is scoped to a single request. The caller owns the historical
  // LRU; an invisible second cache here would retain evicted evidence graphs.
  const loadFrame = async (index: number, depth = 0, recent = new Map<number, GraphSnapshot>()): Promise<FrameResult> => {
    if (index === headIndex && head) return { ok: true, graph: head };
    const cached = recent.get(index);
    if (cached) return { ok: true, graph: cached };
    const frame = manifest.frames[index];
    if (!frame) return fail('ARTIFACT_INVALID', 'FRAME_COUNT', `frames[${index}]`, 'No such frame');
    const wire = await readChunk(source, decompress, frame.graphChunk, mark);
    if (!wire.ok) return wire.result;
    let base: GraphSnapshot | null = null;
    if (frame.graphChunk.encoding === 'atlas.graph.delta/1') {
      const baseId = (wire.value as { baseSnapshotId?: unknown } | null)?.baseSnapshotId;
      const baseIndex = typeof baseId === 'string' ? frameOf.get(baseId) : undefined;
      // Bases are strictly newer frames of this artifact, so every chain ends at HEAD.
      if (baseIndex === undefined || baseIndex <= index || depth >= 3)
        return fail('ARTIFACT_INVALID', 'CHUNK_ENCODING', frame.graphChunk.path, 'A frame delta must name a newer frame of this artifact and use at most three delta links');
      const resolved = await loadFrame(baseIndex, depth + 1, recent);
      if (!resolved.ok) return resolved;
      base = resolved.graph;
    }
    const decoded = await decodeGraphChunk(frame.graphChunk, wire.value, base, naturals, mark);
    if (!decoded.ok) return decoded.result;
    // Encoded chunks just derived every ID from validated fields; plain graphs re-derive them.
    const graph = validateGraphSnapshot(decoded.value, { objectFormat: manifest.repo.objectFormat, verifyIds: frame.graphChunk.encoding === undefined });
    if (!graph.ok) return { ok: false, code: 'ARTIFACT_INVALID', issues: graph.issues.map((i) => ({ ...i, path: `graph[${index}]:${i.path}` })) };
    const cross = validateFrameAgainstCore(context, index, graph.value);
    if (cross.length > 0) return { ok: false, code: 'ARTIFACT_INVALID', issues: cross };
    mark(`frame-validation:${index}`);
    if (index !== headIndex) {
      recent.delete(index);
      recent.set(index, graph.value);
    }
    return { ok: true, graph: graph.value };
  };

  const headResult = await loadFrame(headIndex);
  if (!headResult.ok) return headResult;
  head = headResult.graph;
  const selected = head;
  return {
    ok: true,
    artifact: {
      ...core.value,
      head: selected,
      frame: async (index, signal) => {
        if (index === headIndex) return { ok: true, graph: selected };
        if (signal?.aborted) return fail('ARTIFACT_INVALID', 'CANCELLED', `frames[${index}]`, 'Frame load was cancelled');
        return loadFrame(index);
      },
      stats: { compressedBytes: compressedTotal, uncompressedBytes: uncompressedTotal, chunks: manifest.chunks.length },
    },
  };
}

/** Load and validate every chunk of an artifact (CLI verify/inspect, tests, small artifacts). */
export async function loadArtifact(source: ArtifactSource, decompress: Decompressor, measure?: (stage: string, ms: number) => void): Promise<LoadResult> {
  const opened = await openArtifact(source, decompress, measure);
  if (!opened.ok) return opened;
  const { artifact } = opened;
  const graphs: GraphSnapshot[] = [];
  for (let i = 0; i < artifact.manifest.frames.length; i++) {
    const frame = await artifact.frame(i);
    if (!frame.ok) return frame;
    graphs.push(frame.graph);
  }
  return { ok: true, bundle: { manifest: artifact.manifest, graphs, history: artifact.history, layout: artifact.layout }, stats: artifact.stats };
}
