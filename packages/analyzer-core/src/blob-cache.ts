import { readObjects, type ObjectType, type SafeGit } from '@atlas/ingest';
import { AnalysisError } from './errors.js';

/**
 * Blob reads shared by every analyzed frame. Historical frames mostly repeat the selected
 * commit's blobs, so each distinct blob is read from Git once. The cache also is the
 * history source budget (plan §4.2: 256 MiB of distinct source bytes across all analyzed
 * history): once `enforce` is on, a read that would exceed it fails with
 * `HISTORY_SOURCE_BUDGET` instead of expanding more history.
 *
 * Bytes are held for two frames (ADR-084): frames are analyzed newest first and share their
 * blobs with the frame before, so `advance()` releases the bytes neither of the last two
 * frames read. Every blob ever read stays counted, so a released blob read again costs a
 * Git read but never counts twice against the budget.
 */
export interface BlobReader {
  read(git: SafeGit, objects: readonly { oid: string; size: number }[], signal?: AbortSignal): Promise<Map<string, { type: ObjectType; bytes: Buffer }>>;
}

type Blob = { type: ObjectType; bytes: Buffer };

export class BlobCache implements BlobReader {
  private previous = new Map<string, Blob>();
  private current = new Map<string, Blob>();
  /** Every blob read in this analysis, for the distinct-byte budget. */
  private readonly seen = new Set<string>();
  private distinct = 0;
  /** Apply the budget to new reads (on for historical frames, off for the selected commit). */
  enforce = false;

  constructor(readonly limitBytes: number) {}

  get distinctBytes(): number {
    return this.distinct;
  }

  async read(git: SafeGit, objects: readonly { oid: string; size: number }[], signal?: AbortSignal): Promise<Map<string, Blob>> {
    for (const o of objects) {
      const held = this.previous.get(o.oid);
      if (held && !this.current.has(o.oid)) this.current.set(o.oid, held);
    }
    const missing = [...new Map(objects.filter((o) => !this.current.has(o.oid)).map((o) => [o.oid, o])).values()];
    const missingBytes = missing.reduce((sum, o) => sum + (this.seen.has(o.oid) ? 0 : o.size), 0);
    if (this.enforce && this.distinct + missingBytes > this.limitBytes) {
      throw new AnalysisError('ANALYSIS_RESOURCE_LIMIT', 'Historical frames exceeded the distinct source byte budget', { limit: 'HISTORY_SOURCE_BUDGET' });
    }
    const fetched = await readObjects(git, missing, signal);
    for (const [oid, object] of fetched) {
      this.current.set(oid, object);
      if (this.seen.has(oid)) continue;
      this.seen.add(oid);
      this.distinct += object.bytes.length;
    }
    const out = new Map<string, Blob>();
    for (const o of objects) out.set(o.oid, this.current.get(o.oid)!);
    return out;
  }

  /** A frame is finished: keep the bytes it read, release what only older generations read. */
  advance(): void {
    this.previous = this.current;
    this.current = new Map();
  }
}
