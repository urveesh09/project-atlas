import { readObjects, type ObjectType, type SafeGit } from '@atlas/ingest';
import { AnalysisError } from './errors.js';

/**
 * Blob reads shared by every analyzed frame. Historical frames mostly repeat the selected
 * commit's blobs, so each distinct blob is read from Git once. The cache also is the
 * history source budget (plan §4.2: 256 MiB of distinct source bytes across all analyzed
 * history): once `enforce` is on, a read that would exceed it fails with
 * `HISTORY_SOURCE_BUDGET` instead of expanding more history.
 */
export interface BlobReader {
  read(git: SafeGit, objects: readonly { oid: string; size: number }[], signal?: AbortSignal): Promise<Map<string, { type: ObjectType; bytes: Buffer }>>;
}

export class BlobCache implements BlobReader {
  private readonly blobs = new Map<string, { type: ObjectType; bytes: Buffer }>();
  private distinct = 0;
  /** Apply the budget to new reads (on for historical frames, off for the selected commit). */
  enforce = false;

  constructor(readonly limitBytes: number) {}

  get distinctBytes(): number {
    return this.distinct;
  }

  async read(git: SafeGit, objects: readonly { oid: string; size: number }[], signal?: AbortSignal): Promise<Map<string, { type: ObjectType; bytes: Buffer }>> {
    const missing = [...new Map(objects.filter((o) => !this.blobs.has(o.oid)).map((o) => [o.oid, o])).values()];
    const missingBytes = missing.reduce((sum, o) => sum + o.size, 0);
    if (this.enforce && this.distinct + missingBytes > this.limitBytes) {
      throw new AnalysisError('ANALYSIS_RESOURCE_LIMIT', 'Historical frames exceeded the distinct source byte budget', { limit: 'HISTORY_SOURCE_BUDGET' });
    }
    const fetched = await readObjects(git, missing, signal);
    for (const [oid, object] of fetched) {
      this.blobs.set(oid, object);
      this.distinct += object.bytes.length;
    }
    const out = new Map<string, { type: ObjectType; bytes: Buffer }>();
    for (const o of objects) out.set(o.oid, this.blobs.get(o.oid)!);
    return out;
  }
}
