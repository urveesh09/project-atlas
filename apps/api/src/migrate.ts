import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

/** Additive baseline. Database clocks, leases and generations are authoritative. */
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

export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(1096043603,0)');
    await client.query('CREATE TABLE IF NOT EXISTS atlas_migrations (version integer PRIMARY KEY, sha256 text NOT NULL)');
    const digest = createHash('sha256').update(MIGRATION_001).digest('hex');
    const existing = await client.query<{ sha256: string }>('SELECT sha256 FROM atlas_migrations WHERE version=1');
    if (existing.rows[0] && existing.rows[0].sha256 !== digest) throw new Error('Migration checksum mismatch; refuse schema drift');
    if (!existing.rows[0]) {
      await client.query(MIGRATION_001);
      await client.query('INSERT INTO atlas_migrations VALUES(1,$1)', [digest]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
