import { randomBytes, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdmissionStore, migrate, startApi, tokenHash, tokenMatches, clientBucket } from '@atlas/api';
import { AnalysisAcceptedSchema, ErrorEnvelopeSchema, JobStatusSchema, SessionStatusSchema, type AnalysisAccepted } from '@atlas/schema';

const url = process.env['ATLAS_TEST_DATABASE_URL'];
if (process.env['ATLAS_REQUIRE_HOSTED_TESTS'] === '1' && !url) throw new Error('Hosted tests require ATLAS_TEST_DATABASE_URL');
const input = { repositoryUrl: 'https://github.com/example/project', commitSha: null, profile: 'v0.1-default', history: { enabled: true }, publication: 'public-expiring' } as const;

describe('management cryptography', () => {
  it('hashes separate domains and compares fixed-size digests', () => {
    const token = randomBytes(32).toString('base64url');
    expect(tokenHash(token, 'session')).not.toBe(tokenHash(token, 'management'));
    expect(tokenMatches(token, tokenHash(token, 'management'))).toBe(true);
    expect(tokenMatches('incorrect', tokenHash(token, 'management'))).toBe(false);
    expect(tokenMatches(token, 'bad')).toBe(false);
  });
  it('rotates salted client buckets without storing addresses', () => {
    const now = new Date('2026-10-10T00:00:00Z');
    const value = clientBucket('127.0.0.1', 'secret', now);
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(value).not.toBe(clientBucket('127.0.0.1', 'other', now));
    expect(value).not.toBe(clientBucket('127.0.0.1', 'secret', new Date('2026-10-11T00:00:00Z')));
  });
});

describe.runIf(!!url)('hosted admission on real PostgreSQL', () => {
  const schema = `atlas_test_api_${randomBytes(8).toString('hex')}`;
  let admin: Pool, pool: Pool, store: AdmissionStore, api: Awaited<ReturnType<typeof startApi>>;
  let sessionCookie: string;
  beforeAll(async () => {
    admin = new Pool({ connectionString: url!, max: 2 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url!, options: `-c search_path=${schema}`, max: 8 });
    await Promise.all([migrate(pool), migrate(pool)]);
    store = new AdmissionStore(pool);
    api = await startApi({ store, quotaSecret: 'a'.repeat(32), developmentLoopback: true });
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE sessions,jobs,admissions,job_events,publications,artifact_objects,repositories CASCADE');
    const response = await fetch(`${api.origin}/api/v1/session`, { method: 'POST', headers: { Origin: api.origin } });
    expect(response.status).toBe(201);
    expect(SessionStatusSchema.parse(await response.json())).toEqual({ session: 'active' });
    sessionCookie = response.headers.get('set-cookie')!.split(';')[0]!;
  });
  afterAll(async () => {
    await api?.close(); await pool?.end();
    if (admin && /^atlas_test_api_[0-9a-f]+$/.test(schema)) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
  });
  const submit = async (value: unknown = input, key: string = randomUUID(), cookieValue = sessionCookie) => fetch(`${api.origin}/api/v1/analyses`, {
    method: 'POST', headers: { Origin: api.origin, Cookie: cookieValue, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(value),
  });
  const accepted = async () => {
    const response = await submit(); expect(response.status).toBe(202);
    return AnalysisAcceptedSchema.parse(await response.json());
  };
  it('applies every migration once, in order, and rejects checksum drift or unknown versions', async () => {
    const { MIGRATIONS, migrationDigest } = await import('@atlas/control');
    expect((await pool.query('SELECT version,sha256 FROM atlas_migrations ORDER BY version')).rows).toEqual(MIGRATIONS.map((m) => ({ version: m.version, sha256: migrationDigest(m.sql) })));
    await pool.query("UPDATE atlas_migrations SET sha256='bad' WHERE version=1");
    await expect(migrate(pool)).rejects.toThrow('checksum');
    await pool.query('UPDATE atlas_migrations SET sha256=$1 WHERE version=1', [migrationDigest(MIGRATIONS[0]!.sql)]);
    await pool.query("INSERT INTO atlas_migrations VALUES(999,'future')");
    await expect(migrate(pool)).rejects.toThrow('newer migration');
    await pool.query('DELETE FROM atlas_migrations WHERE version=999');
    await migrate(pool);
  });
  it('returns a capability once, persists hashes only, and exposes schema-valid status', async () => {
    const a = await accepted();
    expect(a.managementToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = (await pool.query('SELECT * FROM jobs WHERE id=$1', [a.jobId])).rows[0];
    expect(JSON.stringify(row)).not.toContain(a.managementToken!);
    expect(row.capability_hash).toBe(tokenHash(a.managementToken!, 'management'));
    const response = await fetch(`${api.origin}${a.statusUrl}`, { headers: { Authorization: `Bearer ${a.managementToken}` } });
    expect(response.status).toBe(200);
    expect(JobStatusSchema.parse(await response.json())).toMatchObject({ state: 'QUEUED', jobId: a.jobId });
  });
  it('atomically deduplicates parallel submissions and returns no token on replay', async () => {
    const key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 8 }, () => submit(input, key)));
    expect(responses.map((r) => r.status)).toEqual(Array(8).fill(202));
    const results = await Promise.all(responses.map(async (r) => AnalysisAcceptedSchema.parse(await r.json())));
    expect(new Set(results.map((r) => r.jobId)).size).toBe(1);
    expect(results.filter((r) => r.managementToken !== null)).toHaveLength(1);
    expect((await pool.query('SELECT * FROM jobs')).rows).toHaveLength(1);
    const conflict = await submit({ ...input, history: { enabled: false } }, key);
    expect(conflict.status).toBe(409);
    expect(ErrorEnvelopeSchema.parse(await conflict.json()).error.code).toBe('IDEMPOTENCY_CONFLICT');
  });
  it('normalizes equivalent repository roots before idempotency hashing', async () => {
    const key = randomUUID();
    const a = await submit({ ...input, repositoryUrl: 'https://github.com/Example/Project.git/' }, key);
    const b = await submit(input, key);
    expect(a.status).toBe(202); expect(b.status).toBe(202);
    expect((await a.json() as AnalysisAccepted).jobId).toBe((await b.json() as AnalysisAccepted).jobId);
  });
  it('admits UUIDv7 keys and replays their case-equivalent form without another token', async () => {
    const key = '019cefa0-1000-7000-8000-000000000001';
    const first = await submit(input, key); expect(first.status).toBe(202);
    const a = AnalysisAcceptedSchema.parse(await first.json());
    const again = await submit(input, key.toUpperCase()); expect(again.status).toBe(202);
    expect(AnalysisAcceptedSchema.parse(await again.json())).toMatchObject({ jobId: a.jobId, managementToken: null });
    expect((await pool.query('SELECT id FROM jobs')).rowCount).toBe(1);
  });
  it('blocks session and token cross-job access and does not reveal unknown job existence', async () => {
    const a = await accepted();
    const other = await store.createSession('other');
    const otherSession = await store.session(other);
    const b = (await store.admit(input, otherSession!, 'other', randomUUID())).accepted;
    for (const id of [b.jobId, `job_${'f'.repeat(32)}`]) {
      const response = await fetch(`${api.origin}/api/v1/jobs/${id}`, { headers: { Authorization: `Bearer ${a.managementToken}` } });
      expect(response.status).toBe(403);
      expect(ErrorEnvelopeSchema.parse(await response.json()).error.message).toBe('Job access is not authorized.');
    }
    await expect(store.cancel(b.jobId, { sessionHash: await store.session(sessionCookie.split('=')[1]!), bearer: a.managementToken })).rejects.toThrow('authorized');
  });
  it('cancels queued jobs once and replays terminal SSE without tokens', async () => {
    const a = await accepted();
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${api.origin}/api/v1/jobs/${a.jobId}/cancel`, { method: 'POST', headers: { Origin: api.origin, Cookie: sessionCookie } });
      expect(response.status).toBe(200);
    }
    const response = await fetch(`${api.origin}${a.eventsUrl}`, { headers: { Cookie: sessionCookie, 'Last-Event-ID': '0' } });
    const events = await response.text();
    expect(events).toContain('event: terminal'); expect(events).toContain('CANCELLED');
    expect(events).not.toContain(a.managementToken!); expect(events).not.toContain(sessionCookie.split('=')[1]!);
    expect((await pool.query('SELECT revision FROM jobs')).rows[0].revision).toBe(2);
  });
  it('bounds concurrent SSE per job and releases streams when the job becomes terminal', async () => {
    const a = await accepted();
    const headers = { Cookie: sessionCookie };
    const first = await fetch(`${api.origin}${a.eventsUrl}`, { headers });
    const second = await fetch(`${api.origin}${a.eventsUrl}`, { headers });
    expect(first.status).toBe(200); expect(second.status).toBe(200);
    const rejected = await fetch(`${api.origin}${a.eventsUrl}`, { headers });
    expect(rejected.status).toBe(429);
    await fetch(`${api.origin}/api/v1/jobs/${a.jobId}/cancel`, { method: 'POST', headers: { ...headers, Origin: api.origin } });
    const bodies = await Promise.all([first.text(), second.text()]);
    expect(bodies.every((b) => b.includes('CANCELLED'))).toBe(true);
    const reopened = await fetch(`${api.origin}${a.eventsUrl}`, { headers });
    expect(reopened.status).toBe(200); await reopened.text();
  });
  it('enforces one active job per client and hourly quotas across sessions', async () => {
    const a = await accepted();
    const response = await submit(); expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBe('60');
    await pool.query("UPDATE jobs SET state='CANCELLED' WHERE id=$1", [a.jobId]);
    for (let i = 1; i < 5; i++) { const r = await accepted(); await pool.query("UPDATE jobs SET state='CANCELLED' WHERE id=$1", [r.jobId]); }
    expect((await submit()).status).toBe(429);
  });
  it('serializes service queue capacity across independent clients', async () => {
    const bounded = new AdmissionStore(pool, { queued: 2, hourly: 5 });
    const submissions = await Promise.all(Array.from({ length: 6 }, async (_, i) => {
      const token = await bounded.createSession(`client-${i}`);
      return { sessionHash: (await bounded.session(token))!, bucket: `client-${i}` };
    }));
    const results = await Promise.allSettled(submissions.map((c) => bounded.admit(input, c.sessionHash, c.bucket, randomUUID())));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
  });
  it.each(['http://github.com/a/b','https://github.com/a/b/tree/main','https://github.com@127.0.0.1/a/b','https://github.com/a/%2e%2e','https://github.com/a/b?token=secret'])('rejects unsafe URL %s without creating a job', async (repositoryUrl) => {
    const response = await submit({ ...input, repositoryUrl }); expect(response.status).toBe(400);
    expect((await pool.query('SELECT * FROM jobs')).rows).toEqual([]);
  });
  it('rejects foreign origins, forged Host, query tokens and compressed bodies', async () => {
    const foreign = await fetch(`${api.origin}/api/v1/session`, { method: 'POST', headers: { Origin: 'https://evil.invalid' } }); expect(foreign.status).toBe(403);
    const host = await new Promise<number>((resolve, reject) => {
      const req = request(`${api.origin}/api/v1/health/live`, { headers: { Host: 'evil.invalid' } }, (response) => { response.resume(); resolve(response.statusCode!); }); req.on('error', reject); req.end();
    });
    expect(host).toBe(403);
    expect((await fetch(`${api.origin}/api/v1/capabilities?token=secret`)).status).toBe(400);
    const compressed = await fetch(`${api.origin}/api/v1/analyses`, { method: 'POST', headers: { Origin: api.origin, Cookie: sessionCookie, 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Idempotency-Key': randomUUID() }, body: '{}' });
    expect(compressed.status).toBe(400);
  });
  it('rejects oversized and invalid request bodies and unsupported options', async () => {
    expect((await submit({ ...input, ignored: 'a'.repeat(17_000) })).status).toBe(413);
    expect((await submit({ ...input, limits: { includedFiles: 100_000 } })).status).toBe(400);
    expect((await submit({ ...input, publication: 'private' })).status).toBe(400);
    expect((await fetch(`${api.origin}/api/v1/session`, { method: 'POST', headers: { Origin: api.origin }, body: 'unexpected' })).status).toBe(400);
  });
  it('expires sessions and scrubs client admission state after a simulated day', async () => {
    const a = await accepted();
    await pool.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second'");
    await pool.query("UPDATE jobs SET created_at=clock_timestamp()-interval '25 hours'");
    await store.sweepAdmissions();
    expect((await pool.query('SELECT * FROM sessions')).rows).toEqual([]);
    expect((await pool.query('SELECT * FROM admissions')).rows).toEqual([]);
    const row = (await pool.query('SELECT session_hash,client_bucket FROM jobs WHERE id=$1', [a.jobId])).rows[0];
    expect(row).toEqual({ session_hash: null, client_bucket: null });
    expect((await fetch(`${api.origin}${a.statusUrl}`, { headers: { Cookie: sessionCookie } })).status).toBe(403);
    expect((await fetch(`${api.origin}${a.statusUrl}`, { headers: { Authorization: `Bearer ${a.managementToken}` } })).status).toBe(200);
  });
  it('fails closed for public artifact delivery when publication is not configured', async () => {
    expect((await fetch(`${api.origin}/api/v1/analyses/analysis_${'0'.repeat(64)}`)).status).toBe(503);
  });
});
