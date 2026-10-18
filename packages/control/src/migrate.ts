import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { LIMITS } from '@atlas/schema';

/**
 * Additive, checksummed migrations (ADR-029). Database clocks, leases and generations
 * are authoritative. An applied migration is never rewritten: a changed checksum stops
 * the rollout, and a correction ships as a new additive migration.
 */
export const MIGRATION_001 = `
CREATE TABLE sessions (
  hash text PRIMARY KEY CHECK (hash ~ '^[0-9a-f]{64}$'),
  client_bucket text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL
);
CREATE TABLE repositories (
  github_id text PRIMARY KEY, canonical_name text NOT NULL,
  visibility_checked_at timestamptz, revoked_at timestamptz
);
CREATE TABLE jobs (
  id text PRIMARY KEY CHECK (id ~ '^job_[0-9a-f]{32}$'),
  session_hash text REFERENCES sessions(hash) ON DELETE SET NULL,
  client_bucket text, input_hash text NOT NULL, input jsonb NOT NULL,
  capability_hash text NOT NULL CHECK (capability_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('QUEUED','ACQUIRING','ANALYZING','HISTORY','LAYOUT','VALIDATING','READY','PARTIAL','CANCEL_REQUESTED','CANCELLED','FAILED')),
  stage text, revision integer NOT NULL DEFAULT 1, generation integer NOT NULL DEFAULT 0,
  attempt integer NOT NULL DEFAULT 0, lease_owner text, lease_expires_at timestamptz,
  deadline timestamptz, counts jsonb NOT NULL DEFAULT '{}', warnings jsonb NOT NULL DEFAULT '[]',
  error jsonb, analysis_id text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX jobs_claim ON jobs(created_at,id) WHERE state='QUEUED';
CREATE INDEX jobs_lease ON jobs(lease_expires_at) WHERE lease_owner IS NOT NULL;
CREATE INDEX jobs_bucket ON jobs(client_bucket,created_at);
CREATE TABLE admissions (
  session_hash text REFERENCES sessions(hash) ON DELETE CASCADE,
  idempotency_key uuid NOT NULL, input_hash text NOT NULL,
  job_id text NOT NULL REFERENCES jobs(id), expires_at timestamptz NOT NULL,
  PRIMARY KEY(session_hash,idempotency_key)
);
CREATE TABLE job_events (
  job_id text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  revision integer NOT NULL, kind text NOT NULL, payload jsonb NOT NULL,
  PRIMARY KEY(job_id,revision)
);
CREATE TABLE artifact_objects (
  content_key text PRIMARY KEY, manifest_key text NOT NULL,
  version text NOT NULL, options_digest text NOT NULL, boundary_digest text NOT NULL,
  compressed_bytes bigint NOT NULL CHECK(compressed_bytes>=0),
  verified boolean NOT NULL DEFAULT false, expires_at timestamptz NOT NULL
);
CREATE TABLE publications (
  analysis_id text PRIMARY KEY, job_id text NOT NULL UNIQUE REFERENCES jobs(id),
  github_id text NOT NULL REFERENCES repositories(github_id), commit_oid text NOT NULL,
  content_key text NOT NULL REFERENCES artifact_objects(content_key),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
  deleted_at timestamptz, revoked_at timestamptz
);
`;

/**
 * Phase 5 pipeline, storage and publication lifecycle (ADR-031, ADR-032): repository
 * visibility state, upload prefixes for garbage collection, content-addressed artifact
 * objects with a cache key for complete results only, HEAD checkpoints and a shared
 * upstream (GitHub API) budget.
 */
export const MIGRATION_002 = `
ALTER TABLE repositories
  ADD COLUMN visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','unavailable')),
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD CONSTRAINT repositories_numeric_id CHECK (github_id ~ '^[1-9][0-9]{0,19}$');
ALTER TABLE jobs
  ADD COLUMN github_id text REFERENCES repositories(github_id),
  ADD COLUMN commit_oid text CHECK (commit_oid ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  ADD COLUMN metrics jsonb NOT NULL DEFAULT '{}';
CREATE INDEX jobs_repository ON jobs(github_id) WHERE github_id IS NOT NULL;
CREATE TABLE uploads (
  id text PRIMARY KEY CHECK (id ~ '^up_[0-9a-f]{32}$'),
  job_id text NOT NULL REFERENCES jobs(id),
  generation integer NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('artifact','checkpoint')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','live','purging','purged')),
  bytes bigint NOT NULL DEFAULT 0 CHECK (bytes>=0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX uploads_collectable ON uploads(updated_at) WHERE state IN ('pending','purging');
ALTER TABLE artifact_objects
  ADD COLUMN upload_id text UNIQUE REFERENCES uploads(id),
  ADD COLUMN github_id text REFERENCES repositories(github_id),
  ADD COLUMN commit_oid text,
  ADD COLUMN status text CHECK (status IN ('complete','partial')),
  ADD COLUMN cache_key text CHECK (cache_key ~ '^[0-9a-f]{64}$'),
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN purged_at timestamptz;
CREATE UNIQUE INDEX artifact_objects_cache ON artifact_objects(cache_key) WHERE cache_key IS NOT NULL AND purged_at IS NULL;
CREATE INDEX artifact_objects_repository ON artifact_objects(github_id);
ALTER TABLE publications
  ADD COLUMN purged_at timestamptz,
  ADD CONSTRAINT publications_id CHECK (analysis_id ~ '^analysis_[0-9a-f]{64}$');
CREATE INDEX publications_repository ON publications(github_id);
CREATE INDEX publications_lifecycle ON publications(expires_at) WHERE purged_at IS NULL;
CREATE TABLE job_checkpoints (
  job_id text PRIMARY KEY REFERENCES jobs(id),
  upload_id text NOT NULL UNIQUE REFERENCES uploads(id),
  content_key text NOT NULL CHECK (content_key ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE upstream_budgets (
  name text PRIMARY KEY CHECK (name ~ '^[a-z][a-z0-9-]{0,31}$'),
  blocked_until timestamptz,
  remaining integer,
  reset_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
`;

/**
 * Job-record retention (ADR-078). The worker may run exactly this deletion and nothing
 * else: it still has no DELETE on jobs, publications or admissions. The function runs
 * with the schema owner's rights, a fixed search path and a fixed retention period. It
 * forgets a job only when it ended that long ago, its publication is purged, its
 * uploads are deleted from storage, and no other publication shares an artifact it
 * stored. Repositories go with their last record, except taken-down ones, whose
 * revocation must keep applying.
 */
export const MIGRATION_003 = `
DO $do$ BEGIN EXECUTE format($sql$
CREATE FUNCTION atlas_forget_ended_jobs(batch integer)
RETURNS TABLE(forgotten_jobs integer, forgotten_publications integer, forgotten_objects integer, forgotten_uploads integer, forgotten_repositories integer)
-- The owning schema first and pg_temp last, so no temporary table can stand in for a real one.
LANGUAGE plpgsql SECURITY DEFINER SET search_path = %I, pg_temp AS $fn$
DECLARE
  ids text[];
  repos text[];
BEGIN
  IF batch IS NULL OR batch < 1 OR batch > 1000 THEN RAISE EXCEPTION 'batch must be 1-1000'; END IF;
  SELECT coalesce(array_agg(f.id), '{}'), coalesce(array_agg(DISTINCT f.github_id) FILTER (WHERE f.github_id IS NOT NULL), '{}')
    INTO ids, repos
    FROM (SELECT j.id, j.github_id FROM jobs j
      WHERE j.state IN ('READY','PARTIAL','FAILED','CANCELLED')
        AND j.updated_at < clock_timestamp() - make_interval(days => ${LIMITS.jobRecordRetentionDays})
        AND NOT EXISTS (SELECT 1 FROM publications p WHERE p.job_id = j.id AND p.purged_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM uploads u WHERE u.job_id = j.id AND u.state <> 'purged')
        AND NOT EXISTS (SELECT 1 FROM uploads u JOIN artifact_objects a ON a.upload_id = u.id
          JOIN publications p ON p.content_key = a.content_key WHERE u.job_id = j.id AND p.job_id <> j.id)
      ORDER BY j.updated_at, j.id LIMIT batch FOR UPDATE OF j SKIP LOCKED) f;
  DELETE FROM admissions WHERE job_id = ANY(ids);
  DELETE FROM job_checkpoints WHERE job_id = ANY(ids);
  DELETE FROM publications WHERE job_id = ANY(ids);
  GET DIAGNOSTICS forgotten_publications = ROW_COUNT;
  DELETE FROM artifact_objects WHERE upload_id IN (SELECT id FROM uploads WHERE job_id = ANY(ids));
  GET DIAGNOSTICS forgotten_objects = ROW_COUNT;
  DELETE FROM uploads WHERE job_id = ANY(ids);
  GET DIAGNOSTICS forgotten_uploads = ROW_COUNT;
  DELETE FROM jobs WHERE id = ANY(ids);
  GET DIAGNOSTICS forgotten_jobs = ROW_COUNT;
  DELETE FROM repositories r WHERE r.github_id = ANY(repos) AND r.revoked_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.github_id = r.github_id)
    AND NOT EXISTS (SELECT 1 FROM publications p WHERE p.github_id = r.github_id)
    AND NOT EXISTS (SELECT 1 FROM artifact_objects a WHERE a.github_id = r.github_id);
  GET DIAGNOSTICS forgotten_repositories = ROW_COUNT;
  RETURN NEXT;
END
$fn$
$sql$, current_schema()); END $do$;
REVOKE ALL ON FUNCTION atlas_forget_ended_jobs(integer) FROM PUBLIC;
`;

export const MIGRATIONS: readonly { version: number; sql: string }[] = Object.freeze([
  { version: 1, sql: MIGRATION_001 },
  { version: 2, sql: MIGRATION_002 },
  { version: 3, sql: MIGRATION_003 },
]);

export const migrationDigest = (sql: string) => createHash('sha256').update(sql).digest('hex');

/** Apply missing migrations in order under one advisory lock; verify every applied checksum. */
export async function migrate(pool: Pool, migrations: readonly { version: number; sql: string }[] = MIGRATIONS): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(1096043603,0)');
    await client.query('CREATE TABLE IF NOT EXISTS atlas_migrations (version integer PRIMARY KEY, sha256 text NOT NULL)');
    const applied = new Map((await client.query<{ version: number; sha256: string }>('SELECT version,sha256 FROM atlas_migrations')).rows.map((r) => [r.version, r.sha256]));
    const known = new Set(migrations.map((m) => m.version));
    for (const version of applied.keys()) if (!known.has(version)) throw new Error('Database has a newer migration than this release; refuse schema drift');
    for (const migration of migrations) {
      const digest = migrationDigest(migration.sql);
      const existing = applied.get(migration.version);
      if (existing !== undefined && existing !== digest) throw new Error('Migration checksum mismatch; refuse schema drift');
      if (existing === undefined) {
        await client.query(migration.sql);
        await client.query('INSERT INTO atlas_migrations VALUES($1,$2)', [migration.version, digest]);
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Readiness: every migration this release knows is applied with its exact checksum. */
export async function migrationsCurrent(pool: Pool): Promise<boolean> {
  const rows = (await pool.query<{ version: number; sha256: string }>('SELECT version,sha256 FROM atlas_migrations')).rows;
  const applied = new Map(rows.map((r) => [r.version, r.sha256]));
  return rows.length === MIGRATIONS.length && MIGRATIONS.every((m) => applied.get(m.version) === migrationDigest(m.sql));
}
