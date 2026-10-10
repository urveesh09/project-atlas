import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { JobStatusSchema, type AnalysisSubmission, type JobStatus } from '@atlas/schema';

export interface Lease { jobId: string; owner: string; generation: number; attempt: number; deadline: Date; input: AnalysisSubmission }
const stages = ['ACQUIRING', 'ANALYZING', 'HISTORY', 'LAYOUT', 'VALIDATING'] as const;
export class LeaseLostError extends Error { constructor() { super('Job lease is no longer current'); } }
/** Leases use DB time and a fencing generation, never process-local timer authority. */
export class JobQueue {
  constructor(readonly pool: Pool, readonly owner = `worker_${randomBytes(16).toString('hex')}`) {
    if (!/^worker_[0-9a-f]{32}$/.test(owner)) throw new Error('Invalid worker owner');
  }
  async claim(): Promise<Lease | null> {
    const row = (await this.pool.query<{
      id: string; generation: number; attempt: number; deadline: Date; input: AnalysisSubmission;
    }>(`WITH next AS (
      SELECT id FROM jobs WHERE state='QUEUED' AND (deadline IS NULL OR deadline>clock_timestamp())
      ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1
    ), claimed AS (
      UPDATE jobs SET state='ACQUIRING',stage='acquire',attempt=attempt+1,generation=generation+1,
        lease_owner=$1,lease_expires_at=clock_timestamp()+interval '30 seconds',
        deadline=COALESCE(deadline,clock_timestamp()+interval '300 seconds'),
        revision=revision+1,updated_at=clock_timestamp()
      FROM next WHERE jobs.id=next.id RETURNING jobs.*
    ), event AS (
      INSERT INTO job_events SELECT id,revision,'state',jsonb_build_object('jobId',id,'revision',revision,'state',state) FROM claimed
    ) SELECT id,generation,attempt,deadline,input FROM claimed`, [this.owner])).rows[0];
    return row ? { jobId: row.id, owner: this.owner, generation: row.generation, attempt: row.attempt, deadline: row.deadline, input: row.input } : null;
  }
  async heartbeat(lease: Lease): Promise<boolean> {
    const result = await this.pool.query(`UPDATE jobs SET lease_expires_at=clock_timestamp()+interval '30 seconds'
      WHERE id=$1 AND lease_owner=$2 AND generation=$3 AND lease_expires_at>clock_timestamp()
        AND deadline>clock_timestamp() AND state IN ('ACQUIRING','ANALYZING','HISTORY','LAYOUT','VALIDATING')`, [lease.jobId, lease.owner, lease.generation]);
    return result.rowCount === 1;
  }
  /** Transactional guard shared by stage updates and eventual publication (P5.4). */
  async withLease<T>(lease: Lease, work: (client: PoolClient, state: string) => Promise<T>, allowCancel = false): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = (await client.query<{ state: string; lease_expires_at: Date }>(`SELECT state,lease_expires_at FROM jobs WHERE id=$1 AND lease_owner=$2 AND generation=$3
        AND lease_expires_at>clock_timestamp() AND deadline>clock_timestamp()
        AND state IN ('ACQUIRING','ANALYZING','HISTORY','LAYOUT','VALIDATING'${allowCancel ? ",'CANCEL_REQUESTED'" : ''}) FOR UPDATE`, [lease.jobId, lease.owner, lease.generation])).rows[0];
      if (!row) throw new LeaseLostError();
      const result = await work(client, row.state);
      // A transaction can outlive the lease while holding its row lock. Recheck
      // database time before commit so a delayed publication cannot win by stalling.
      const current = await client.query(`SELECT id FROM jobs WHERE id=$1 AND lease_owner=$2 AND generation=$3
        AND lease_expires_at>clock_timestamp() AND deadline>clock_timestamp()
        AND state IN ('ACQUIRING','ANALYZING','HISTORY','LAYOUT','VALIDATING','READY','PARTIAL'${allowCancel ? ",'CANCELLED','CANCEL_REQUESTED'" : ''})`,
      [lease.jobId, lease.owner, lease.generation]);
      if (!current.rowCount) {
        // Explicit terminal methods clear and fence ownership inside this same
        // transaction; their authority was checked before making that transition.
        const fenced = await client.query(`SELECT id FROM jobs WHERE id=$1 AND lease_owner IS NULL
          AND generation=$2 AND state IN ('FAILED'${allowCancel ? ",'CANCELLED'" : ''})
          AND deadline>clock_timestamp() AND clock_timestamp()<$3`, [lease.jobId, lease.generation + 1, row.lease_expires_at]);
        if (!fenced.rowCount) throw new LeaseLostError();
      }
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async progress(lease: Lease, update: Pick<JobStatus, 'state' | 'stage' | 'counts' | 'warnings'>): Promise<void> {
    const parsed = JobStatusSchema.pick({ state: true, stage: true, counts: true, warnings: true }).parse(update);
    if (!stages.includes(parsed.state as typeof stages[number])) throw new Error('Invalid progress state');
    const allowedStage: Record<string, readonly (string | null)[]> = {
      ACQUIRING: ['validate', 'acquire'], ANALYZING: ['index', 'analyze'], HISTORY: ['history'],
      LAYOUT: ['layout'], VALIDATING: ['validate', 'publish'],
    };
    if (!allowedStage[parsed.state]?.includes(parsed.stage)) throw new Error('Progress stage does not match the job state');
    if (Object.keys(parsed.counts).length > 32) throw new Error('Too many progress counts');
    await this.withLease(lease, async (client, state) => {
      if (stages.indexOf(parsed.state as typeof stages[number]) < stages.indexOf(state as typeof stages[number])) throw new Error('Job stages cannot move backwards');
      await client.query('UPDATE jobs SET state=$2,stage=$3,counts=$4,warnings=$5,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1', [lease.jobId, parsed.state, parsed.stage, parsed.counts, JSON.stringify(parsed.warnings)]);
      await recordEvent(client, lease.jobId, 'progress');
    });
  }
  async cancelled(lease: Lease): Promise<void> {
    await this.withLease(lease, async (client, state) => {
      if (state !== 'CANCEL_REQUESTED') throw new Error('Cancellation was not requested');
      await client.query("UPDATE jobs SET state='CANCELLED',stage=NULL,lease_owner=NULL,lease_expires_at=NULL,generation=generation+1,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1", [lease.jobId]);
      await recordEvent(client, lease.jobId, 'terminal');
    }, true);
  }
  async fail(lease: Lease, error: NonNullable<JobStatus['error']>): Promise<void> {
    JobStatusSchema.shape.error.parse(error);
    await this.withLease(lease, async (client) => {
      await client.query("UPDATE jobs SET state='FAILED',stage=NULL,error=$2,lease_owner=NULL,lease_expires_at=NULL,generation=generation+1,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1", [lease.jobId, error]);
      await recordEvent(client, lease.jobId, 'terminal');
    });
  }
  /** Expired leases fenced before retry; at most two attempts in the original deadline. */
  async reap(): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const rows = (await client.query<{ id: string }>(`UPDATE jobs SET
        state=CASE WHEN state='CANCEL_REQUESTED' THEN 'CANCELLED'
          WHEN attempt<2 AND deadline>clock_timestamp() THEN 'QUEUED' ELSE 'FAILED' END,
        error=CASE WHEN state='CANCEL_REQUESTED' OR (attempt<2 AND deadline>clock_timestamp()) THEN NULL ELSE $1::jsonb END,
        lease_owner=NULL,lease_expires_at=NULL,stage=NULL,generation=generation+1,revision=revision+1,updated_at=clock_timestamp()
        WHERE id IN (SELECT id FROM jobs WHERE lease_owner IS NOT NULL AND (lease_expires_at<=clock_timestamp() OR deadline<=clock_timestamp()) FOR UPDATE SKIP LOCKED)
        RETURNING id`, [{ code: 'ANALYSIS_RESOURCE_LIMIT', message: 'The job lease or deadline expired.', retryable: false, details: {}, requestId: `req_${randomBytes(16).toString('hex')}` }])).rows;
      // Also terminalize a queued retry whose original deadline elapsed before claim.
      const expired = (await client.query<{ id: string }>(`UPDATE jobs SET state='FAILED',revision=revision+1,generation=generation+1,updated_at=clock_timestamp(),error=$1
        WHERE state='QUEUED' AND deadline<=clock_timestamp() RETURNING id`, [{ code: 'ANALYSIS_RESOURCE_LIMIT', message: 'The job deadline expired.', retryable: false, details: {}, requestId: `req_${randomBytes(16).toString('hex')}` }])).rows;
      for (const row of [...rows, ...expired]) await recordEvent(client, row.id, 'state');
      await client.query('COMMIT');
      return rows.length + expired.length;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}
async function recordEvent(client: PoolClient, id: string, kind: 'progress' | 'terminal' | 'state') {
  await client.query("INSERT INTO job_events SELECT id,revision,$2,jsonb_build_object('jobId',id,'revision',revision,'state',state,'stage',stage,'counts',counts,'warnings',warnings) FROM jobs WHERE id=$1", [id, kind]);
  await client.query('DELETE FROM job_events WHERE job_id=$1 AND revision<(SELECT revision-99 FROM jobs WHERE id=$1)', [id]);
}
