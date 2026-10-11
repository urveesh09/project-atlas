import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { MANIFEST_MAX_BYTES } from '@atlas/artifact';
import { ArtifactManifestSchema, LIMITS, randomId, type ArtifactManifest } from '@atlas/schema';
import { ServiceError, toServiceError } from './errors.js';
import type { RepositoryResolver } from './github.js';
import { deleteUpload, objectKey, StorageError, type ObjectStore } from './storage.js';

/** Plan §8.6: publications live 7 days; visibility answers are trusted for at most 5 minutes. */
export const PUBLICATION_TTL_SECONDS = LIMITS.publicationTtlDays * 24 * 3600;
export const VISIBILITY_CACHE_SECONDS = 300;
export const REVALIDATION_INTERVAL_SECONDS = 24 * 3600;
/** Abandoned (never published) uploads are collected after this grace period. */
export const UPLOAD_GRACE_SECONDS = 3600;

export const CHUNK_ID_PATTERN = /^(?:snap_[0-9a-f]{64}|history|layout)$/;
/** Map an API chunk ID onto the manifest's fixed chunk path. */
export function chunkPath(chunkId: string): string | null {
  if (!CHUNK_ID_PATTERN.test(chunkId)) return null;
  return chunkId === 'history' ? 'history/history.json.gz' : chunkId === 'layout' ? 'layout/layout.json.gz' : `graphs/${chunkId}.json.gz`;
}
export function chunkIdOf(path: string): string {
  return path === 'history/history.json.gz' ? 'history' : path === 'layout/layout.json.gz' ? 'layout' : path.slice('graphs/'.length, -'.json.gz'.length);
}

/**
 * Content identity: the analysis key plus every chunk hash. Two runs that produced the
 * same canonical chunks share stored bytes; a different boundary or analyzer never does.
 */
export function contentKey(manifest: ArtifactManifest): string {
  const chunks = manifest.chunks.map((c) => `${c.path}:${c.sha256}:${c.compressedBytes}`).sort();
  return createHash('sha256').update(`atlas.content/1\0${manifest.analysisKey}\0${chunks.join('\0')}`).digest('hex');
}

/**
 * Cache identity for *complete* results only (plan §13.4, §16.2.3): repository numeric
 * ID, commit, profile/history choice and analyzer version. Partial results never get a
 * cache key, so they can never stand in for a complete analysis.
 */
export function cacheKey(input: { githubId: string; commitOid: string; profile: string; historyEnabled: boolean; analyzerVersion: string }): string {
  return createHash('sha256')
    .update(['atlas.cache/1', input.githubId, input.commitOid, input.profile, input.historyEnabled ? 'history' : 'head', input.analyzerVersion].join('\0'))
    .digest('hex');
}

interface AccessRow {
  analysis_id: string;
  job_id: string;
  github_id: string;
  content_key: string;
  created_at: Date;
  expires_at: Date;
  deleted_at: Date | null;
  revoked_at: Date | null;
  purged_at: Date | null;
  repository_revoked: Date | null;
  visibility: 'public' | 'unavailable';
  checked_age: number | null;
  expired: boolean;
  upload_id: string | null;
  object_purged: Date | null;
}

export interface PublishInput {
  jobId: string;
  uploadId: string;
  manifest: ArtifactManifest;
  githubId: string;
  commitOid: string;
  status: 'complete' | 'partial';
  /** Present only for complete results. */
  cacheKey: string | null;
  compressedBytes: number;
}

/**
 * Publication lifecycle shared by the API (reads, deletion) and workers (publication,
 * revalidation, purge). Every chunk read repeats the manifest's checks, so no chunk
 * outlives its publication, expiry, deletion or the repository's public visibility.
 */
export class PublicationStore {
  private readonly manifests = new Map<string, ArtifactManifest>();
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(
    readonly pool: Pool,
    readonly store: ObjectStore,
    readonly resolver: RepositoryResolver,
  ) {}

  private async row(analysisId: string): Promise<AccessRow> {
    if (!/^analysis_[0-9a-f]{64}$/.test(analysisId)) throw new ServiceError('ARTIFACT_NOT_FOUND', 404, 'This analysis does not exist.');
    const row = (await this.pool.query<AccessRow>(
      `SELECT p.analysis_id,p.job_id,p.github_id,p.content_key,p.created_at,p.expires_at,p.deleted_at,p.revoked_at,p.purged_at,
         r.revoked_at AS repository_revoked,r.visibility,
         extract(epoch FROM clock_timestamp()-r.visibility_checked_at)::float8 AS checked_age,
         p.expires_at<=clock_timestamp() AS expired,a.upload_id,a.purged_at AS object_purged
       FROM publications p JOIN repositories r ON r.github_id=p.github_id JOIN artifact_objects a ON a.content_key=p.content_key
       WHERE p.analysis_id=$1`,
      [analysisId],
    )).rows[0];
    if (!row) throw new ServiceError('ARTIFACT_NOT_FOUND', 404, 'This analysis does not exist.');
    return row;
  }

  private static lifecycle(row: AccessRow): void {
    if (row.deleted_at) throw new ServiceError('ARTIFACT_DELETED', 410, 'This analysis was deleted by its owner.');
    if (row.revoked_at || row.repository_revoked || row.visibility !== 'public') throw new ServiceError('ARTIFACT_REVOKED', 410, 'This analysis is no longer available because the repository is not public.');
    if (row.expired) throw new ServiceError('ARTIFACT_EXPIRED', 410, 'This analysis has expired.');
    if (row.purged_at || row.object_purged || !row.upload_id) throw new ServiceError('ARTIFACT_EXPIRED', 410, 'This analysis is no longer stored.');
  }

  /**
   * Full access check (plan §8.6): lifecycle state, then a visibility answer at most five
   * minutes old. A stale answer is refreshed from GitHub; an outage fails closed (503) and
   * never serves a graph on an unverified visibility.
   */
  async authorize(analysisId: string): Promise<AccessRow> {
    let row = await this.row(analysisId);
    PublicationStore.lifecycle(row);
    if (row.checked_age === null || row.checked_age > VISIBILITY_CACHE_SECONDS) {
      await this.refreshVisibility(row.github_id);
      row = await this.row(analysisId);
      PublicationStore.lifecycle(row);
      if (row.checked_age === null || row.checked_age > VISIBILITY_CACHE_SECONDS) throw new ServiceError('UPSTREAM_UNAVAILABLE', 503, 'Repository visibility could not be verified; try again later.', 30);
    }
    return row;
  }

  /** One refresh per repository at a time in this process. */
  private refreshVisibility(githubId: string): Promise<void> {
    const pending = this.inflight.get(githubId);
    if (pending) return pending;
    const work = (async () => {
      let answer;
      try {
        answer = await this.resolver.visibility(githubId, AbortSignal.timeout(10_000));
      } catch (error) {
        const failure = toServiceError(error);
        throw failure.code === 'UPSTREAM_RATE_LIMITED' ? failure : new ServiceError('UPSTREAM_UNAVAILABLE', 503, 'Repository visibility could not be verified; try again later.', 30);
      }
      if (answer.state === 'public') {
        await this.pool.query("UPDATE repositories SET visibility='public',visibility_checked_at=clock_timestamp(),canonical_name=$2 WHERE github_id=$1 AND revoked_at IS NULL", [githubId, `${answer.owner}/${answer.name}`]);
      } else {
        await this.revokeRepository(githubId);
      }
    })().finally(() => this.inflight.delete(githubId));
    this.inflight.set(githubId, work);
    return work;
  }

  private async contentManifest(uploadId: string): Promise<ArtifactManifest> {
    const cached = this.manifests.get(uploadId);
    if (cached) return cached;
    const bytes = await this.store.get(objectKey(uploadId, 'manifest.json'), MANIFEST_MAX_BYTES).catch(() => {
      throw new ServiceError('INTERNAL_ERROR', 503, 'Stored analyses are temporarily unavailable.', 30);
    });
    if (!bytes) throw new ServiceError('ARTIFACT_EXPIRED', 410, 'This analysis is no longer stored.');
    let manifest: ArtifactManifest;
    try {
      manifest = ArtifactManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    } catch {
      throw new ServiceError('ARTIFACT_INVALID', 503, 'The stored analysis failed validation.');
    }
    if (this.manifests.size >= 64) this.manifests.delete(this.manifests.keys().next().value!);
    this.manifests.set(uploadId, manifest);
    return manifest;
  }

  /** The publication's manifest: shared content with this publication's own ID and expiry. */
  async manifest(analysisId: string): Promise<ArtifactManifest> {
    const row = await this.authorize(analysisId);
    const content = await this.contentManifest(row.upload_id!);
    return ArtifactManifestSchema.parse({ ...content, analysisId: row.analysis_id, expiresAt: row.expires_at.toISOString() });
  }

  /** One compressed chunk, only if the publication's manifest lists it; length re-checked. */
  async chunk(analysisId: string, chunkId: string): Promise<Uint8Array> {
    const path = chunkPath(chunkId);
    if (!path) throw new ServiceError('ARTIFACT_NOT_FOUND', 404, 'This chunk does not exist.');
    const row = await this.authorize(analysisId);
    const content = await this.contentManifest(row.upload_id!);
    const ref = content.chunks.find((c) => c.path === path);
    if (!ref) throw new ServiceError('ARTIFACT_NOT_FOUND', 404, 'This chunk does not exist.');
    const bytes = await this.store.get(objectKey(row.upload_id!, path), ref.compressedBytes).catch((error: unknown) => {
      // An oversized object is corruption; anything else is a (retryable) storage outage.
      throw error instanceof StorageError ? new ServiceError('ARTIFACT_INVALID', 503, 'The stored analysis failed validation.') : new ServiceError('INTERNAL_ERROR', 503, 'Stored analyses are temporarily unavailable.', 30);
    });
    if (!bytes) throw new ServiceError('ARTIFACT_EXPIRED', 410, 'This analysis is no longer stored.');
    if (bytes.length !== ref.compressedBytes) throw new ServiceError('ARTIFACT_INVALID', 503, 'The stored analysis failed validation.');
    return bytes;
  }

  /**
   * Owner deletion (plan §8.6): the caller proved management access to the creating job.
   * Access ends at commit; storage is purged when no other live publication shares it.
   */
  async remove(analysisId: string, authorizeJob: (jobId: string) => Promise<void>): Promise<void> {
    const row = await this.row(analysisId);
    await authorizeJob(row.job_id);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = (await client.query<{ deleted_at: Date | null }>('SELECT deleted_at FROM publications WHERE analysis_id=$1 FOR UPDATE', [analysisId])).rows[0];
      if (!locked || locked.deleted_at) throw new ServiceError('ARTIFACT_DELETED', 410, 'This analysis was already deleted.');
      await client.query('UPDATE publications SET deleted_at=clock_timestamp() WHERE analysis_id=$1', [analysisId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await this.purge().catch(() => undefined);
  }

  /**
   * Operator purge (plan §8.6: "service administrators have an operational purge path"):
   * revoke one publication without its capability, then purge its storage unless another
   * live publication shares the content. Returns false for an unknown ID.
   */
  async operatorPurge(analysisId: string): Promise<boolean> {
    if (!/^analysis_[0-9a-f]{64}$/.test(analysisId)) return false;
    const updated = await this.pool.query('UPDATE publications SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE analysis_id=$1', [analysisId]);
    if (!updated.rowCount) return false;
    await this.purge();
    return true;
  }

  /** Revoke every publication of a repository that is no longer public (plan §8.6). */
  async revokeRepository(githubId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE repositories SET visibility='unavailable',revoked_at=COALESCE(revoked_at,clock_timestamp()),visibility_checked_at=clock_timestamp() WHERE github_id=$1", [githubId]);
      await client.query('UPDATE publications SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE github_id=$1', [githubId]);
      // Content of a revoked repository is never reused and is purged at the next sweep,
      // even if the repository later becomes public again.
      await client.query('UPDATE artifact_objects SET cache_key=NULL,expires_at=least(expires_at,clock_timestamp()) WHERE github_id=$1', [githubId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Daily revalidation (plan §8.6) of repositories that still have live publications.
   * Throttling and outages leave state unchanged; access already fails closed after five
   * minutes without a fresh answer.
   */
  async revalidate(limit = 50): Promise<{ checked: number; revoked: number; failed: number }> {
    const rows = (await this.pool.query<{ github_id: string }>(
      `SELECT DISTINCT r.github_id FROM repositories r JOIN publications p ON p.github_id=r.github_id
       WHERE r.revoked_at IS NULL AND p.purged_at IS NULL AND p.deleted_at IS NULL AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp()
         AND (r.visibility_checked_at IS NULL OR r.visibility_checked_at<clock_timestamp()-make_interval(secs=>$1))
       LIMIT $2`,
      [REVALIDATION_INTERVAL_SECONDS, limit],
    )).rows;
    let revoked = 0;
    let failed = 0;
    for (const { github_id } of rows) {
      try {
        await this.refreshVisibility(github_id);
        const state = (await this.pool.query<{ revoked_at: Date | null }>('SELECT revoked_at FROM repositories WHERE github_id=$1', [github_id])).rows[0];
        if (state?.revoked_at) revoked++;
      } catch {
        failed++;
      }
    }
    return { checked: rows.length, revoked, failed };
  }

  /**
   * Purge (plan §8.6, §13.4): end every expired, deleted or revoked publication, then
   * delete stored content that no live publication needs (immediately for a revoked
   * repository, otherwise after its cache expiry). Idempotent and safe to rerun after a
   * crash: rows move to `purging` before storage deletion and to `purged` after it.
   */
  async purge(limit = 100): Promise<{ publications: number; objects: number; uploads: number }> {
    const publications = (await this.pool.query(
      `UPDATE publications SET purged_at=clock_timestamp() WHERE analysis_id IN (
         SELECT analysis_id FROM publications WHERE purged_at IS NULL
           AND (deleted_at IS NOT NULL OR revoked_at IS NOT NULL OR expires_at<=clock_timestamp()) LIMIT $1)`,
      [limit],
    )).rowCount ?? 0;
    const client = await this.pool.connect();
    let objects = 0;
    try {
      await client.query('BEGIN');
      const doomed = (await client.query<{ content_key: string; upload_id: string }>(
        `SELECT a.content_key,a.upload_id FROM artifact_objects a JOIN repositories r ON r.github_id=a.github_id
         WHERE a.purged_at IS NULL AND (r.revoked_at IS NOT NULL OR a.expires_at<=clock_timestamp())
           AND NOT EXISTS (SELECT 1 FROM publications p WHERE p.content_key=a.content_key AND p.purged_at IS NULL)
         LIMIT $1 FOR UPDATE OF a SKIP LOCKED`,
        [limit],
      )).rows;
      for (const row of doomed) {
        await client.query('UPDATE artifact_objects SET purged_at=clock_timestamp(),cache_key=NULL WHERE content_key=$1', [row.content_key]);
        await client.query("UPDATE uploads SET state='purging',updated_at=clock_timestamp() WHERE id=$1", [row.upload_id]);
        this.manifests.delete(row.upload_id);
      }
      await client.query('COMMIT');
      objects = doomed.length;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return { publications, objects, uploads: await this.collectUploads(limit) };
  }

  /**
   * Garbage-collect uploads that never became live: interrupted, fenced, cancelled or
   * superseded attempts, and checkpoints whose job ended without publishing them. Then
   * delete storage for everything in `purging`.
   */
  async collectUploads(limit = 100): Promise<number> {
    await this.pool.query(
      `UPDATE uploads u SET state='purging',updated_at=clock_timestamp() WHERE u.id IN (
         SELECT u2.id FROM uploads u2 JOIN jobs j ON j.id=u2.job_id
         WHERE u2.state='pending' AND NOT EXISTS (SELECT 1 FROM artifact_objects a WHERE a.upload_id=u2.id)
           AND u2.created_at<clock_timestamp()-make_interval(secs=>$2)
           AND (j.state IN ('READY','PARTIAL','FAILED','CANCELLED')
             -- A fenced attempt's artifact upload is dead; its checkpoint stays usable by the retry.
             OR (u2.purpose='artifact' AND j.generation<>u2.generation)
             OR u2.created_at<clock_timestamp()-make_interval(secs=>$1))
         LIMIT $3)`,
      [LIMITS.workerDeadlineMs / 1000 + UPLOAD_GRACE_SECONDS, 60, limit],
    );
    const purging = (await this.pool.query<{ id: string }>("SELECT id FROM uploads WHERE state='purging' ORDER BY updated_at LIMIT $1", [limit])).rows;
    let done = 0;
    for (const { id } of purging) {
      try {
        await deleteUpload(this.store, id);
        await this.pool.query("UPDATE uploads SET state='purged',updated_at=clock_timestamp() WHERE id=$1 AND state='purging'", [id]);
        this.manifests.delete(id);
        done++;
      } catch {
        // Storage outage: the row stays `purging` and the next sweep retries.
      }
    }
    return done;
  }

  /**
   * Storage reconciliation (runbook): any stored upload prefix without a live or pending
   * database row is an orphan and is deleted. Listing is bounded; rerun until it reports 0.
   */
  async reconcileStorage(limit = 1000): Promise<{ scanned: number; orphans: number }> {
    const keys = await this.store.list('uploads/', limit);
    const ids = [...new Set(keys.map((k) => k.split('/')[1]!))];
    if (ids.length === 0) return { scanned: 0, orphans: 0 };
    const known = new Set((await this.pool.query<{ id: string }>("SELECT id FROM uploads WHERE id=ANY($1) AND state IN ('pending','live')", [ids])).rows.map((r) => r.id));
    let orphans = 0;
    for (const id of ids) {
      if (known.has(id)) continue;
      await deleteUpload(this.store, id);
      orphans++;
    }
    return { scanned: ids.length, orphans };
  }
}

/**
 * Create the publication inside the worker's lease-fenced transaction (plan §13.3). The
 * content object is created, reused or resurrected under its row lock, so purge and
 * concurrent publication of identical content serialize. Returns the new analysis ID.
 */
export async function publishInTransaction(client: PoolClient, input: PublishInput): Promise<string> {
  const key = contentKey(input.manifest);
  const existing = (await client.query<{ upload_id: string; purged_at: Date | null }>('SELECT upload_id,purged_at FROM artifact_objects WHERE content_key=$1 FOR UPDATE', [key])).rows[0];
  if (existing && !existing.purged_at) {
    // Identical content is already live: share it and retire this attempt's copy.
    if (existing.upload_id !== input.uploadId) await client.query("UPDATE uploads SET state='purging',updated_at=clock_timestamp() WHERE id=$1 AND state='pending'", [input.uploadId]);
    if (input.cacheKey) await client.query('UPDATE artifact_objects SET cache_key=COALESCE(cache_key,$2) WHERE content_key=$1 AND NOT EXISTS (SELECT 1 FROM artifact_objects WHERE cache_key=$2)', [key, input.cacheKey]);
  } else {
    // Never take a cache key another live object already holds.
    const taken = input.cacheKey !== null && ((await client.query('SELECT 1 FROM artifact_objects WHERE cache_key=$1 AND purged_at IS NULL', [input.cacheKey])).rowCount ?? 0) > 0;
    const effectiveCacheKey = taken ? null : input.cacheKey;
    const fields = [key, `uploads/${input.uploadId}/manifest.json`, input.manifest.artifactVersion, input.manifest.optionsDigest,
      createHash('sha256').update(JSON.stringify(input.manifest.coverage.history)).digest('hex'), input.compressedBytes, input.uploadId, input.githubId, input.commitOid, input.status, effectiveCacheKey];
    if (existing) {
      await client.query(
        `UPDATE artifact_objects SET manifest_key=$2,version=$3,options_digest=$4,boundary_digest=$5,compressed_bytes=$6,verified=true,
           expires_at=clock_timestamp()+make_interval(secs=>$12),upload_id=$7,github_id=$8,commit_oid=$9,status=$10,cache_key=$11,purged_at=NULL WHERE content_key=$1`,
        [...fields, PUBLICATION_TTL_SECONDS],
      );
    } else {
      await client.query(
        `INSERT INTO artifact_objects(content_key,manifest_key,version,options_digest,boundary_digest,compressed_bytes,verified,expires_at,upload_id,github_id,commit_oid,status,cache_key)
         VALUES($1,$2,$3,$4,$5,$6,true,clock_timestamp()+make_interval(secs=>$12),$7,$8,$9,$10,$11)`,
        [...fields, PUBLICATION_TTL_SECONDS],
      );
    }
    await client.query("UPDATE uploads SET state='live',updated_at=clock_timestamp() WHERE id=$1", [input.uploadId]);
  }
  return insertPublication(client, { jobId: input.jobId, githubId: input.githubId, commitOid: input.commitOid, contentKey: key });
}

/** Reuse a complete cached artifact for a new submission: its own ID, expiry and capability. */
export async function publishCachedInTransaction(client: PoolClient, input: { jobId: string; cacheKey: string }): Promise<{ analysisId: string; status: 'complete' } | null> {
  const row = (await client.query<{ content_key: string; github_id: string; commit_oid: string }>(
    `SELECT a.content_key,a.github_id,a.commit_oid FROM artifact_objects a JOIN repositories r ON r.github_id=a.github_id
     WHERE a.cache_key=$1 AND a.purged_at IS NULL AND a.status='complete' AND r.revoked_at IS NULL FOR UPDATE OF a`,
    [input.cacheKey],
  )).rows[0];
  if (!row) return null;
  const analysisId = await insertPublication(client, { jobId: input.jobId, githubId: row.github_id, commitOid: row.commit_oid, contentKey: row.content_key });
  return { analysisId, status: 'complete' };
}

async function insertPublication(client: PoolClient, input: { jobId: string; githubId: string; commitOid: string; contentKey: string }): Promise<string> {
  const analysisId = randomId('analysis');
  await client.query(
    'INSERT INTO publications(analysis_id,job_id,github_id,commit_oid,content_key,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+make_interval(secs=>$6))',
    [analysisId, input.jobId, input.githubId, input.commitOid, input.contentKey, PUBLICATION_TTL_SECONDS],
  );
  await client.query('UPDATE artifact_objects SET expires_at=greatest(expires_at,clock_timestamp()+make_interval(secs=>$2)) WHERE content_key=$1', [input.contentKey, PUBLICATION_TTL_SECONDS]);
  return analysisId;
}
