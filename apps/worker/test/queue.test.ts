import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdmissionStore, migrate } from '@atlas/api';
import { JobQueue, LeaseLostError, type Lease } from '../src/queue.js';
import { acquireEngineOwnership } from '../src/engine-ownership.js';

const url = process.env['ATLAS_TEST_DATABASE_URL'];
if (process.env['ATLAS_REQUIRE_HOSTED_TESTS'] === '1' && !url) throw new Error('Hosted queue tests require ATLAS_TEST_DATABASE_URL');
const input = { repositoryUrl: 'https://github.com/example/project', commitSha: null, profile: 'v0.1-default', history: { enabled: true }, publication: 'public-expiring' } as const;
describe.runIf(!!url)('PostgreSQL worker fencing and recovery', () => {
  const schema = `atlas_test_queue_${randomBytes(8).toString('hex')}`;
  let admin: Pool, pool: Pool, store: AdmissionStore, queue: JobQueue;
  let serial = 0;
  beforeAll(async () => {
    admin = new Pool({ connectionString: url!, max: 2 }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url!, options: `-c search_path=${schema}`, max: 12 });
    await migrate(pool); store = new AdmissionStore(pool); queue = new JobQueue(pool);
  });
  beforeEach(async () => { await pool.query('TRUNCATE sessions,jobs,admissions,job_events,publications,artifact_objects,repositories CASCADE'); });
  afterAll(async () => { await pool?.end(); if (admin && /^atlas_test_queue_[0-9a-f]+$/.test(schema)) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } });
  const enqueue = async () => {
    const bucket = `bucket-${serial++}`, token = await store.createSession(bucket);
    const sessionHash = (await store.session(token))!;
    const { accepted } = await store.admit(input, sessionHash, bucket, randomUUID());
    return { jobId: accepted.jobId, credentials: { sessionHash, bearer: null } };
  };
  const claim = async (): Promise<Lease> => { await enqueue(); return (await queue.claim())!; };
  const expire = (lease: Lease) => pool.query("UPDATE jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [lease.jobId]);
  const progress = (lease: Lease) => queue.progress(lease, { state: 'ANALYZING', stage: 'analyze', counts: { files: 3 }, warnings: [] });

  it('excludes a second coordinator on the same engine before reconciliation and releases on stop', async () => {
    const engine = `test-${randomUUID()}`;
    const release = await acquireEngineOwnership(pool, engine, () => {});
    let other: (() => Promise<void>) | undefined;
    try {
      await expect(acquireEngineOwnership(pool, engine, () => {})).rejects.toThrow('already owns');
      other = await acquireEngineOwnership(pool, `${engine}-other`, () => {});
      await release();
      const restart = await acquireEngineOwnership(pool, engine, () => {});
      await restart();
      await restart();
    } finally { await release(); await other?.(); }
  });

  it('fences the coordinator when the database session holding engine ownership dies', async () => {
    const engine = `test-${randomUUID()}`;
    let notify!: () => void;
    const lost = new Promise<void>((resolve) => { notify = resolve; });
    const release = await acquireEngineOwnership(pool, engine, notify);
    try {
      // Find only this test's advisory-lock session; terminating it proves crash cleanup.
      const { rows } = await pool.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity
        WHERE datname=current_database() AND query='SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired'
          AND pid IN (SELECT pid FROM pg_locks WHERE locktype='advisory' AND granted)`);
      // This suite owns one lock here; use the engine-specific hash to avoid other suites.
      const hash = (await pool.query<{ value: string }>('SELECT hashtextextended($1,0)::text AS value', [`atlas.engine/1:${engine}`])).rows[0]!.value;
      const target = (await pool.query<{ pid: number }>(`SELECT pid FROM pg_locks WHERE locktype='advisory'
        AND classid=(($1::bigint >> 32) & 4294967295)::oid AND objid=($1::bigint & 4294967295)::oid AND objsubid=1`, [hash])).rows[0]!.pid;
      expect(rows.some((r) => r.pid === target)).toBe(true);
      await pool.query('SELECT pg_terminate_backend($1)', [target]);
      await lost;
      const restart = await acquireEngineOwnership(pool, engine, () => {});
      await restart();
    } finally { await release().catch(() => undefined); }
  });

  it('claims each job once with concurrent workers and never shares a live lease', async () => {
    await Promise.all(Array.from({ length: 10 }, enqueue));
    const leases = await Promise.all(Array.from({ length: 12 }, () => new JobQueue(pool).claim()));
    expect(leases.filter(Boolean)).toHaveLength(10);
    expect(new Set(leases.filter(Boolean).map((l) => l!.jobId)).size).toBe(10);
    expect(leases.filter(Boolean).every((l) => l!.attempt === 1 && l!.generation === 1)).toBe(true);
  });
  it('heartbeats only unexpired current leases and refuses forged ownership', async () => {
    const lease = await claim(); expect(await queue.heartbeat(lease)).toBe(true);
    expect(await queue.heartbeat({ ...lease, owner: `worker_${'f'.repeat(32)}` })).toBe(false);
    await expire(lease); expect(await queue.heartbeat(lease)).toBe(false);
    await expect(progress(lease)).rejects.toBeInstanceOf(LeaseLostError);
  });
  it('fences a crashed attempt before a single retry and rejects stale publication work', async () => {
    const lease = await claim(); const deadline = lease.deadline.getTime();
    await expire(lease); expect(await queue.reap()).toBe(1);
    const next = (await new JobQueue(pool).claim())!;
    expect(next.attempt).toBe(2); expect(next.generation).toBeGreaterThan(lease.generation);
    expect(next.deadline.getTime()).toBe(deadline);
    let published = false;
    await expect(queue.withLease(lease, async () => { published = true; })).rejects.toBeInstanceOf(LeaseLostError);
    expect(published).toBe(false);
    await expire(next); expect(await queue.reap()).toBe(1); expect(await queue.claim()).toBeNull();
    expect((await pool.query('SELECT state FROM jobs')).rows[0].state).toBe('FAILED');
  });
  it('cancellation prevents a live worker from committing or advancing stages', async () => {
    const job = await enqueue(), lease = (await queue.claim())!;
    expect(await store.cancel(job.jobId, job.credentials)).toBe(false);
    expect(await queue.heartbeat(lease)).toBe(false);
    await expect(progress(lease)).rejects.toBeInstanceOf(LeaseLostError);
    await expect(queue.withLease(lease, async () => true)).rejects.toBeInstanceOf(LeaseLostError);
    await queue.cancelled(lease);
    expect((await store.status(job.jobId, job.credentials)).state).toBe('CANCELLED');
  });
  it('reaps a cancelled crashed worker without retrying it', async () => {
    const job = await enqueue(), lease = (await queue.claim())!;
    await store.cancel(job.jobId, job.credentials); await expire(lease); await queue.reap();
    expect((await store.status(job.jobId, job.credentials)).state).toBe('CANCELLED');
    expect(await queue.claim()).toBeNull();
  });
  it('keeps exactly a bounded monotonic replay history and returns authoritative state for old sequences', async () => {
    const job = await enqueue(), lease = (await queue.claim())!;
    for (let i = 0; i < 115; i++) await progress(lease);
    const events = (await pool.query('SELECT revision FROM job_events ORDER BY revision')).rows;
    expect(events).toHaveLength(100); expect(events.at(-1).revision).toBe(117);
    const replay = await store.events(job.jobId, job.credentials, 0);
    expect(replay).toHaveLength(1); expect(replay[0]).toMatchObject({ revision: 117, kind: 'state', payload: { state: 'ANALYZING' } });
    await expect(queue.progress(lease, { state: 'ACQUIRING', stage: 'acquire', counts: {}, warnings: [] })).rejects.toThrow('backwards');
  });
  it('rolls back failed fenced transactions completely', async () => {
    const lease = await claim();
    await expect(queue.withLease(lease, async (client) => {
      await client.query('UPDATE jobs SET counts=$2 WHERE id=$1', [lease.jobId, { files: 99 }]);
      throw new Error('Storage failed');
    })).rejects.toThrow('Storage failed');
    expect((await pool.query('SELECT counts FROM jobs')).rows[0].counts).toEqual({});
  });
  it('does not retry expired overall deadlines, including queued retries', async () => {
    const lease = await claim();
    await pool.query("UPDATE jobs SET deadline=clock_timestamp()-interval '1 second' WHERE id=$1", [lease.jobId]);
    expect(await queue.heartbeat(lease)).toBe(false); await queue.reap();
    expect((await pool.query('SELECT state FROM jobs')).rows[0].state).toBe('FAILED');
    const next = await claim(); await expire(next); await queue.reap();
    await pool.query("UPDATE jobs SET deadline=clock_timestamp()-interval '1 second' WHERE id=$1", [next.jobId]);
    expect(await queue.claim()).toBeNull(); await queue.reap();
    expect((await pool.query('SELECT state FROM jobs WHERE id=$1', [next.jobId])).rows[0].state).toBe('FAILED');
  });
  it('rechecks lease time before committing delayed work and rolls it back', async () => {
    const lease = await claim();
    await expect(queue.withLease(lease, async (client) => {
      await client.query("UPDATE jobs SET counts=$2,lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [lease.jobId, { files: 99 }]);
    })).rejects.toBeInstanceOf(LeaseLostError);
    const row = (await pool.query('SELECT counts,lease_expires_at>clock_timestamp() AS live FROM jobs WHERE id=$1', [lease.jobId])).rows[0];
    expect(row.counts).toEqual({}); expect(row.live).toBe(true);
  });
  it('serializes reapers so only one fences an expired lease', async () => {
    const lease = await claim(); await expire(lease);
    const counts = await Promise.all(Array.from({ length: 8 }, () => new JobQueue(pool).reap()));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
  });
});
