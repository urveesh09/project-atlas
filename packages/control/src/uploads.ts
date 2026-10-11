import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { MANIFEST_PATH, type ArtifactSource } from '@atlas/artifact';
import { LIMITS, type ArtifactManifest } from '@atlas/schema';
import { newUploadId, objectKey, StorageError, type ObjectStore } from './storage.js';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/**
 * Copy an already-verified artifact into private storage under a fresh upload prefix
 * (plan §13.3). The upload row exists before the first byte is stored, so every stored
 * prefix is collectable; each object is read back and compared byte for byte. The
 * prefix stays `pending` until the lease-fenced publication transaction marks it live.
 */
export async function uploadVerifiedArtifact(
  pool: Pool,
  store: ObjectStore,
  input: { jobId: string; generation: number; purpose: 'artifact' | 'checkpoint'; source: ArtifactSource; manifest: ArtifactManifest; signal?: AbortSignal },
): Promise<{ uploadId: string; bytes: number }> {
  const uploadId = newUploadId();
  await pool.query('INSERT INTO uploads(id,job_id,generation,purpose) VALUES($1,$2,$3,$4)', [uploadId, input.jobId, input.generation, input.purpose]);
  const files: [string, number][] = [[MANIFEST_PATH, 4 * 1024 * 1024], ...input.manifest.chunks.map((c): [string, number] => [c.path, c.compressedBytes])];
  let bytes = 0;
  for (const [relative, max] of files) {
    if (input.signal?.aborted) throw new StorageError('put', 'Upload cancelled');
    const data = await input.source.read(relative, Math.min(max, LIMITS.artifactCompressedBytes));
    if (!data || data.length > max) throw new StorageError('put', 'The verified artifact changed before upload');
    const key = objectKey(uploadId, relative);
    await store.put(key, data);
    const stored = await store.get(key, data.length);
    if (!stored || digest(stored) !== digest(data)) throw new StorageError('put', 'Stored bytes differ from the verified artifact');
    bytes += data.length;
  }
  await pool.query('UPDATE uploads SET bytes=$2,updated_at=clock_timestamp() WHERE id=$1', [uploadId, bytes]);
  return { uploadId, bytes };
}

/** An artifact source over one stored upload (checkpoint republication, tests). */
export function uploadSource(store: ObjectStore, uploadId: string): ArtifactSource {
  return {
    read: (relative, maxBytes) => store.get(objectKey(uploadId, relative), maxBytes + 1).catch((error: unknown) => {
      if (error instanceof StorageError) return null;
      throw error;
    }),
  };
}
