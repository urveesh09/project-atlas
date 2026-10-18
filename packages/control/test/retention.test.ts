import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LIMITS } from '@atlas/schema';
import { forgetEndedJobs, migrate, provisionRoles } from '../src/index.js';

const url = process.env['ATLAS_TEST_DATABASE_URL'];
if (process.env['ATLAS_REQUIRE_HOSTED_TESTS'] === '1' && !url) throw new Error('Hosted retention tests require ATLAS_TEST_DATABASE_URL');
const hex = (bytes: number) => randomBytes(bytes).toString('hex');

describe.runIf(!!url)('job-record retention (ADR-078)', () => {
  const schema = `atlas_test_retention_${hex(6)}`;
  let admin: Pool, pool: Pool;
  beforeAll(async () => {
    admin = new Pool({ connectionString: url!, max: 2 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url!, options: `-c search_path=${schema}`, max: 4 });
    await migrate(pool);
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE sessions,jobs,admissions,job_events,publications,artifact_objects,uploads,job_checkpoints,repositories CASCADE');
  });
  afterAll(async () => {
    await pool?.end();
    if (admin && /^atlas_test_retention_[0-9a-f]+$/.test(schema)) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });

  const repository = async (githubId: string, revoked = false) => {
    await pool.query("INSERT INTO repositories(github_id,canonical_name,revoked_at) VALUES($1,$2,CASE WHEN $3 THEN clock_timestamp() END) ON CONFLICT DO NOTHING", [githubId, `owner/repo-${githubId}`, revoked]);
  };
  /** An ended job, `days` ago, with an admission, events and optionally a published artifact. */
  const job = async (o: { days: number; githubId: string; state?: string; published?: 'purged' | 'live'; upload?: string; reuse?: string }) => {
    const id = `job_${hex(16)}`;
    await repository(o.githubId);
    await pool.query(`INSERT INTO jobs(id,input_hash,input,capability_hash,state,github_id,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()-make_interval(days=>$7))`,
    [id, hex(32), { repositoryUrl: `https://github.com/owner/repo-${o.githubId}` }, hex(32), o.state ?? 'READY', o.githubId, o.days]);
    await pool.query("INSERT INTO job_events VALUES($1,1,'state','{}')", [id]);
    const session = hex(32);
    await pool.query("INSERT INTO sessions(hash,client_bucket,expires_at) VALUES($1,'b',clock_timestamp()+interval '1 hour')", [session]);
    await pool.query('INSERT INTO admissions VALUES($1,$2,$3,$4,clock_timestamp()+interval \'1 hour\')', [session, randomUUID(), hex(32), id]);
    let contentKey = o.reuse;
    if (o.published && !contentKey) {
      const upload = `up_${hex(16)}`;
      contentKey = hex(32);
      await pool.query("INSERT INTO uploads(id,job_id,generation,purpose,state) VALUES($1,$2,1,'artifact',$3)", [upload, id, o.upload ?? 'purged']);
      await pool.query(`INSERT INTO artifact_objects(content_key,manifest_key,version,options_digest,boundary_digest,compressed_bytes,expires_at,upload_id,github_id,purged_at)
        VALUES($1,'m','1','o','b',1,clock_timestamp(),$2,$3,CASE WHEN $4 THEN clock_timestamp() END)`, [contentKey, upload, o.githubId, o.published === 'purged']);
    }
    if (o.published) {
      await pool.query(`INSERT INTO publications(analysis_id,job_id,github_id,commit_oid,content_key,expires_at,purged_at)
        VALUES($1,$2,$3,$4,$5,clock_timestamp(),CASE WHEN $6 THEN clock_timestamp() END)`, [`analysis_${hex(32)}`, id, o.githubId, 'a'.repeat(40), contentKey, o.published === 'purged']);
    }
    return { id, contentKey };
  };
  const exists = async (table: string, column: string, value: string) => (await pool.query(`SELECT 1 FROM ${table} WHERE ${column}=$1`, [value])).rowCount === 1;
  const days = LIMITS.jobRecordRetentionDays;

  it('forgets an ended job past retention with everything it owned, and its repository', async () => {
    const old = await job({ days: days + 1, githubId: '101', published: 'purged' });
    expect(await forgetEndedJobs(pool)).toEqual({ jobs: 1, publications: 1, objects: 1, uploads: 1, repositories: 1 });
    for (const table of ['jobs', 'job_events', 'admissions', 'publications', 'uploads']) {
      expect((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, table).toBe(0);
    }
    expect(await exists('artifact_objects', 'content_key', old.contentKey!)).toBe(false);
    expect(await exists('repositories', 'github_id', '101')).toBe(false);
    expect(await forgetEndedJobs(pool)).toEqual({ jobs: 0, publications: 0, objects: 0, uploads: 0, repositories: 0 });
  });

  it('keeps jobs inside retention, unfinished jobs, and anything whose storage is not yet gone', async () => {
    const kept = [
      await job({ days: days - 1, githubId: '201', published: 'purged' }),
      await job({ days: days + 5, githubId: '202', state: 'QUEUED' }),
      await job({ days: days + 5, githubId: '203', published: 'live' }),
      await job({ days: days + 5, githubId: '204', published: 'purged', upload: 'purging' }),
    ];
    const forgettable = await job({ days: days + 5, githubId: '205', state: 'FAILED' });
    expect((await forgetEndedJobs(pool)).jobs).toBe(1);
    for (const { id } of kept) expect(await exists('jobs', 'id', id), id).toBe(true);
    expect(await exists('jobs', 'id', forgettable.id)).toBe(false);
    for (const githubId of ['201', '202', '203', '204']) expect(await exists('repositories', 'github_id', githubId)).toBe(true);
  });

  it('keeps an artifact another publication still reuses until that job is forgotten first', async () => {
    const original = await job({ days: days + 9, githubId: '301', published: 'purged' });
    const reuse = await job({ days: days + 2, githubId: '301', published: 'purged', reuse: original.contentKey! });
    expect(await forgetEndedJobs(pool)).toMatchObject({ jobs: 1, objects: 0, repositories: 0 });
    expect(await exists('jobs', 'id', reuse.id)).toBe(false);
    expect(await exists('jobs', 'id', original.id)).toBe(true);
    expect(await forgetEndedJobs(pool)).toEqual({ jobs: 1, publications: 1, objects: 1, uploads: 1, repositories: 1 });
  });

  it('keeps a taken-down repository so its revocation keeps applying', async () => {
    await repository('401', true);
    const old = await job({ days: days + 1, githubId: '401', published: 'purged' });
    expect(await forgetEndedJobs(pool)).toMatchObject({ jobs: 1, repositories: 0 });
    expect(await exists('jobs', 'id', old.id)).toBe(false);
    expect((await pool.query('SELECT revoked_at IS NOT NULL AS revoked FROM repositories WHERE github_id=$1', ['401'])).rows[0].revoked).toBe(true);
  });

  it('lets the worker run retention without DELETE on jobs; the API cannot run it', async () => {
    await job({ days: days + 1, githubId: '501', published: 'purged' });
    const role = (kind: string) => ({ name: `${schema}_${kind}`.slice(0, 63), password: hex(24) });
    const api = role('api'), worker = role('worker');
    await provisionRoles(pool, { schema, api, worker });
    const as = (r: { name: string; password: string }) => {
      const target = new URL(url!);
      target.username = r.name;
      target.password = r.password;
      return new Pool({ connectionString: target.toString(), max: 1 });
    };
    const apiPool = as(api), workerPool = as(worker);
    try {
      await expect(workerPool.query('DELETE FROM jobs')).rejects.toMatchObject({ code: '42501' });
      await expect(workerPool.query('SELECT * FROM admissions')).rejects.toMatchObject({ code: '42501' });
      await expect(forgetEndedJobs(apiPool)).rejects.toMatchObject({ code: '42501' });
      await expect(forgetEndedJobs(workerPool, 0)).rejects.toThrow('batch must be 1-1000');
      expect((await forgetEndedJobs(workerPool)).jobs).toBe(1);
    } finally {
      await apiPool.end();
      await workerPool.end();
      for (const r of [api, worker]) {
        await admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM "${r.name}"`);
        await admin.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${schema} FROM "${r.name}"`);
        await admin.query(`REVOKE ALL ON SCHEMA ${schema} FROM "${r.name}"`);
        await admin.query(`DROP ROLE "${r.name}"`);
      }
    }
  });
});
