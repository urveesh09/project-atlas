import {
  canonicalJson,
  sha256Hex,
  utf8Bytes,
  validateArtifactBundle,
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

export function packArtifact(
  input: { manifest: ManifestDraft; graphs: GraphSnapshot[]; history: HistoryArtifact; layout: LayoutArtifact },
  compress: Compressor,
): PackedArtifact {
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
    return { ...frame, graphChunk: ref(`graphs/${graph.snapshotId}.json.gz`, graph) };
  });
  const historyChunk = ref('history/history.json.gz', input.history);
  const layoutChunk = ref('layout/layout.json.gz', input.layout);
  const manifest: ArtifactManifest = {
    ...input.manifest,
    frames,
    historyChunk,
    layoutChunk,
    chunks: [...frames.map((f) => f.graphChunk), historyChunk, layoutChunk],
  };
  const result = validateArtifactBundle({ manifest, graphs: input.graphs, history: input.history, layout: input.layout });
  if (!result.ok) throw new ArtifactPackError(result.issues);
  return { manifest, bundle: result.value, chunks };
}
