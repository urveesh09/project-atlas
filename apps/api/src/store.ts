import type { Pool, PoolClient } from 'pg';
import { canonicalJson, JobStatusSchema, type AnalysisAccepted, type AnalysisSubmission, type JobStatus } from '@atlas/schema';
import { createHash } from 'node:crypto';
import { newToken, opaqueId, ServiceError, terminal, tokenHash, tokenMatches } from './security.js';

export interface Credentials { sessionHash: string | null; bearer: string | null }
interface JobRow {
  id: string; state: string; revision: number; stage: string | null;
  session_hash: string | null; capability_hash: string;
  counts: JobStatus['counts']; warnings: JobStatus['warnings'];
  analysis_id: string | null; error: JobStatus['error']; updated_at: Date;
}

/** Postgres admission and management. No source acquisition runs in the API. */
export class AdmissionStore {
  constructor(readonly pool: Pool, readonly limits = { hourly: 5, queued: 20 }) {
    if (!Number.isInteger(limits.hourly) || limits.hourly < 1 || !Number.isInteger(limits.queued) || limits.queued < 1) throw new Error('Invalid admission limits');
  }
  async createSession(bucket: string): Promise<string> {
    const token = newToken();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(1096043603,1)');
      const counts = (await client.query<{ total: string; client: string }>("SELECT count(*) AS total,count(*) FILTER (WHERE client_bucket=$1) AS client FROM sessions WHERE expires_at>clock_timestamp()", [bucket])).rows[0]!;
      if (+counts.total >= 10_000 || +counts.client >= 30) throw new ServiceError('QUOTA_EXCEEDED', 429, 'Session admission capacity is exhausted.', 60);
      await client.query("INSERT INTO sessions(hash,client_bucket,expires_at) VALUES($1,$2,clock_timestamp()+interval '24 hours')", [tokenHash(token, 'session'), bucket]);
      await client.query('COMMIT');
      return token;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async session(token: string | null): Promise<string | null> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const hash = tokenHash(token, 'session');
    const result = await this.pool.query("SELECT hash FROM sessions WHERE hash=$1 AND expires_at>clock_timestamp()", [hash]);
    return result.rowCount ? hash : null;
  }
  async admit(input: AnalysisSubmission, sessionHash: string, bucket: string, key: string): Promise<{ accepted: AnalysisAccepted; repeated: boolean }> {
    const hash = createHash('sha256').update(canonicalJson(input)).digest('hex');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Short admission transaction serializes global queue capacity and client quotas.
      // Worker claims remain row-level SKIP LOCKED and never take this lock.
      await client.query('SELECT pg_advisory_xact_lock(1096043603,1)');
      const session = await client.query('SELECT hash FROM sessions WHERE hash=$1 AND expires_at>clock_timestamp() FOR SHARE', [sessionHash]);
      if (!session.rowCount) throw new ServiceError('FORBIDDEN', 403, 'A valid same-origin session is required.');
      const repeated = await client.query<{ input_hash: string; job_id: string }>('SELECT input_hash,job_id FROM admissions WHERE session_hash=$1 AND idempotency_key=$2 AND expires_at>clock_timestamp()', [sessionHash, key]);
      if (repeated.rows[0]) {
        if (repeated.rows[0].input_hash !== hash) throw new ServiceError('IDEMPOTENCY_CONFLICT', 409, 'This idempotency key was already used for a different request.');
        const job = (await client.query<JobRow>('SELECT * FROM jobs WHERE id=$1', [repeated.rows[0].job_id])).rows[0]!;
        await client.query('COMMIT');
        return { accepted: this.accepted(job.id, job.state, null, job.analysis_id), repeated: true };
      }
      const counts = (await client.query<{ active: string; hourly: string; queued: string }>(`
        SELECT count(*) FILTER (WHERE state NOT IN ('READY','PARTIAL','FAILED','CANCELLED') AND (client_bucket=$1 OR session_hash=$2)) AS active,
          count(*) FILTER (WHERE client_bucket=$1 AND created_at>clock_timestamp()-interval '1 hour') AS hourly,
          count(*) FILTER (WHERE state='QUEUED') AS queued FROM jobs`, [bucket, sessionHash])).rows[0]!;
      if (+counts.active >= 1 || +counts.hourly >= this.limits.hourly || +counts.queued >= this.limits.queued)
        throw new ServiceError('QUOTA_EXCEEDED', 429, 'Admission capacity is temporarily exhausted.', 60);
      const id = opaqueId('job'), token = newToken();
      await client.query("DELETE FROM admissions WHERE session_hash=$1 AND idempotency_key=$2", [sessionHash, key]);
      await client.query("INSERT INTO jobs(id,session_hash,client_bucket,input_hash,input,capability_hash,state) VALUES($1,$2,$3,$4,$5,$6,'QUEUED')", [id, sessionHash, bucket, hash, input, tokenHash(token, 'management')]);
      await client.query("INSERT INTO admissions VALUES($1,$2,$3,$4,clock_timestamp()+interval '24 hours')", [sessionHash, key, hash, id]);
      await client.query("INSERT INTO job_events VALUES($1,1,'state',$2)", [id, { jobId: id, revision: 1, state: 'QUEUED' }]);
      await client.query('COMMIT');
      return { accepted: this.accepted(id, 'QUEUED', token, null), repeated: false };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  private accepted(jobId: string, state: string, managementToken: string | null, analysisId: string | null): AnalysisAccepted {
    return { jobId, state: state as AnalysisAccepted['state'], managementToken, analysisId, statusUrl: `/api/v1/jobs/${jobId}`, eventsUrl: `/api/v1/jobs/${jobId}/events` };
  }
  private async authorized(db: Pool | PoolClient, id: string, credentials: Credentials, lock = false): Promise<JobRow> {
    const job = (await db.query<JobRow>(`SELECT * FROM jobs WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
    const bearerOK = job && credentials.bearer !== null && tokenMatches(credentials.bearer, job.capability_hash);
    const sessionOK = job && credentials.sessionHash !== null && job.session_hash === credentials.sessionHash;
    if (!job || (!bearerOK && !sessionOK)) throw new ServiceError('FORBIDDEN', 403, 'Job access is not authorized.');
    return job;
  }
  async status(id: string, credentials: Credentials): Promise<JobStatus> {
    const row = await this.authorized(this.pool, id, credentials);
    return JobStatusSchema.parse({ jobId: row.id, revision: row.revision, state: row.state, stage: row.stage, queuePosition: null, counts: row.counts, warnings: row.warnings, analysisId: row.analysis_id, error: row.error, updatedAt: row.updated_at.toISOString() });
  }
  async cancel(id: string, credentials: Credentials): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const job = await this.authorized(client, id, credentials, true);
      if (!terminal(job.state) && job.state !== 'CANCEL_REQUESTED') {
        await client.query("UPDATE jobs SET state=CASE WHEN state='QUEUED' THEN 'CANCELLED' ELSE 'CANCEL_REQUESTED' END,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1", [id]);
        await client.query("INSERT INTO job_events SELECT id,revision,CASE WHEN state='CANCELLED' THEN 'terminal' ELSE 'state' END,jsonb_build_object('jobId',id,'revision',revision,'state',state) FROM jobs WHERE id=$1", [id]);
        await client.query('DELETE FROM job_events WHERE job_id=$1 AND revision< (SELECT revision-99 FROM jobs WHERE id=$1)', [id]);
      }
      await client.query('COMMIT');
      return terminal(job.state) || job.state === 'QUEUED';
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async events(id: string, credentials: Credentials, after: number) {
    const state = await this.status(id, credentials);
    const rows = (await this.pool.query<{ revision: number; kind: string; payload: unknown }>('SELECT revision,kind,payload FROM job_events WHERE job_id=$1 AND revision>$2 ORDER BY revision LIMIT 100', [id, after])).rows;
    if (!rows.length || rows[0]!.revision > after + 1) return [{ revision: state.revision, kind: terminal(state.state) ? 'terminal' : 'state', payload: state }];
    return rows;
  }
  /** Daily privacy cleanup; durable jobs retain only token hashes and immutable input. */
  async sweepAdmissions(): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE expires_at<=clock_timestamp()');
    await this.pool.query('DELETE FROM admissions WHERE expires_at<=clock_timestamp()');
    await this.pool.query("UPDATE jobs SET client_bucket=NULL WHERE created_at<=clock_timestamp()-interval '24 hours' AND client_bucket IS NOT NULL");
  }
}
