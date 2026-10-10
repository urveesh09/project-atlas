import {
  ARTIFACT_VERSION,
  GRAPH_SCHEMA_VERSION,
  LIMITS,
  canonicalJson,
  decodeIndexedGraph,
  isCompatibleContractVersion,
  sha256Hex,
  validateArtifactBundle,
  validateManifest,
  utf8ByteLength,
  type ArtifactBundle,
  type ValidationIssue,
} from '@atlas/schema';

/**
 * Bounded artifact import shared by the CLI, the local server and the browser (plan
 * §6.5). It never trusts declared sizes: every read and every decompression is capped,
 * then lengths and hashes are re-checked, then the full bundle invariants run. It knows
 * nothing about rendering.
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

export const MANIFEST_PATH = 'manifest.json';
export const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

export class DecompressionLimitError extends Error {
  constructor(readonly limit: number) {
    super(`Decompressed data exceeds ${limit} bytes`);
    this.name = 'DecompressionLimitError';
  }
}

function fail(code: LoadFailureCode, issueCode: string, path: string, message: string): LoadResult {
  return { ok: false, code, issues: [{ code: issueCode, path, message }] };
}

function parseJson(bytes: Uint8Array, path: string): { ok: true; value: unknown; text: string } | { ok: false; result: LoadResult } {
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

export async function loadArtifact(source: ArtifactSource, decompress: Decompressor): Promise<LoadResult> {
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
    return fail('UNSUPPORTED_SCHEMA', 'VERSION', MANIFEST_PATH, `Unsupported artifact (${artifactVersion || 'unknown'}, ${schemaVersion || 'unknown'}); this build reads ${ARTIFACT_VERSION}`);
  }
  const manifestResult = validateManifest(parsedManifest.value);
  if (!manifestResult.ok) return { ok: false, code: 'ARTIFACT_INVALID', issues: manifestResult.issues.map((i) => ({ ...i, path: `manifest:${i.path}` })) };
  const manifest = manifestResult.value;

  const decoded = new Map<string, unknown>();
  let compressedTotal = 0;
  let uncompressedTotal = 0;
  for (const chunk of manifest.chunks) {
    compressedTotal += chunk.compressedBytes;
    uncompressedTotal += Math.max(chunk.uncompressedBytes, chunk.decodedBytes ?? 0);
    if (compressedTotal > LIMITS.artifactCompressedBytes || uncompressedTotal > LIMITS.artifactUncompressedBytes) {
      return fail('ARTIFACT_INVALID', 'LIMIT', chunk.path, 'Artifact exceeds the cumulative size limits');
    }
    const compressed = await source.read(chunk.path, chunk.compressedBytes);
    if (compressed === null) return fail('ARTIFACT_INVALID', 'CHUNK_MISSING', chunk.path, 'Referenced chunk is missing');
    if (compressed.length !== chunk.compressedBytes) return fail('ARTIFACT_INVALID', 'CHUNK_LENGTH', chunk.path, 'Chunk transport length differs from the manifest');
    let bytes: Uint8Array;
    try {
      bytes = await decompress(compressed, chunk.uncompressedBytes);
    } catch (error) {
      return fail('ARTIFACT_INVALID', error instanceof DecompressionLimitError ? 'DECOMPRESSION_LIMIT' : 'DECOMPRESSION', chunk.path, 'Chunk could not be decompressed within its declared size');
    }
    if (bytes.length !== chunk.uncompressedBytes) return fail('ARTIFACT_INVALID', 'CHUNK_LENGTH', chunk.path, 'Decompressed length differs from the manifest');
    if (sha256Hex(bytes) !== (chunk.encodedSha256 ?? chunk.sha256)) return fail('ARTIFACT_INVALID', 'CHUNK_HASH', chunk.path, 'Chunk content hash differs from the manifest');
    const parsed = parseJson(bytes, chunk.path);
    if (!parsed.ok) return parsed.result;
    if (canonicalJson(parsed.value) !== parsed.text) return fail('ARTIFACT_INVALID', 'NOT_CANONICAL', chunk.path, 'Chunk is not canonical JSON');
    if (chunk.encoding) {
      let graph;
      try {
        graph = decodeIndexedGraph(parsed.value, chunk.decodedBytes);
      } catch (error) {
        return fail('ARTIFACT_INVALID', error instanceof RangeError ? 'DECODED_LIMIT' : 'CHUNK_ENCODING', chunk.path, 'Indexed graph is invalid or exceeds its decoded size limit');
      }
      const canonical = canonicalJson(graph);
      if (utf8ByteLength(canonical) !== chunk.decodedBytes) return fail('ARTIFACT_INVALID', 'CHUNK_LENGTH', chunk.path, 'Decoded canonical length differs from the manifest');
      if (sha256Hex(canonical) !== chunk.sha256) return fail('ARTIFACT_INVALID', 'CHUNK_HASH', chunk.path, 'Decoded canonical hash differs from the manifest');
      decoded.set(chunk.path, graph);
    } else {
      decoded.set(chunk.path, parsed.value);
    }
  }

  const result = validateArtifactBundle({
    manifest,
    graphs: manifest.frames.map((f) => decoded.get(f.graphChunk.path)),
    history: decoded.get(manifest.historyChunk.path),
    layout: decoded.get(manifest.layoutChunk.path),
  });
  if (!result.ok) return { ok: false, code: 'ARTIFACT_INVALID', issues: result.issues };
  return { ok: true, bundle: result.value, stats: { compressedBytes: compressedTotal, uncompressedBytes: uncompressedTotal, chunks: manifest.chunks.length } };
}
