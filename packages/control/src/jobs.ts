import type { Pool } from 'pg';

/**
 * A job's whole budget, counted from its first claim. The claim sets `deadline` once to
 * claim time plus this, so `deadline - JOB_DEADLINE_SECONDS` is when the job left the
 * queue; operator metrics derive queue wait from it (ADR-076).
 */
export const JOB_DEADLINE_SECONDS = 300;

/**
 * Operator cancellation (runbook "malicious or resource-heavy input"): the same state
 * transition a capability holder triggers, without a capability. Queued jobs end at once;
 * running jobs move to CANCEL_REQUESTED and their coordinator removes the sandboxes before
 * acknowledging. Returns the resulting state, or null for an unknown job.
 */
export async function operatorCancel(pool: Pool, jobId: string): Promise<string | null> {
  if (!/^job_[0-9a-f]{32}$/.test(jobId)) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const job = (await client.query<{ state: string }>('SELECT state FROM jobs WHERE id=$1 FOR UPDATE', [jobId])).rows[0];
    if (!job) {
      await client.query('ROLLBACK');
      return null;
    }
    if (!['READY', 'PARTIAL', 'FAILED', 'CANCELLED', 'CANCEL_REQUESTED'].includes(job.state)) {
      await client.query("UPDATE jobs SET state=CASE WHEN state='QUEUED' THEN 'CANCELLED' ELSE 'CANCEL_REQUESTED' END,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1", [jobId]);
      await client.query("INSERT INTO job_events SELECT id,revision,CASE WHEN state='CANCELLED' THEN 'terminal' ELSE 'state' END,jsonb_build_object('jobId',id,'revision',revision,'state',state) FROM jobs WHERE id=$1", [jobId]);
    }
    const state = (await client.query<{ state: string }>('SELECT state FROM jobs WHERE id=$1', [jobId])).rows[0]!.state;
    await client.query('COMMIT');
    return state;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
