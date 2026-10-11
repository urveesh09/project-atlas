import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConfigError,
  FileObjectStore,
  S3ObjectStore,
  UpstreamGate,
  cacheKey,
  chunkIdOf,
  chunkPath,
  deleteUpload,
  migrate,
  newUploadId,
  provisionRoles,
  objectKey,
  resolverFromEnv,
  storageFromEnv,
  type ObjectStore,
} from '../src/index.js';

describe('object keys are fixed shapes, never caller paths', () => {
  it('builds keys only for manifests and contract chunk paths', () => {
    const id = newUploadId();
    expect(objectKey(id, 'manifest.json')).toBe(`uploads/${id}/manifest.json`);
    expect(objectKey(id, `graphs/snap_${'a'.repeat(64)}.json.gz`)).toBe(`uploads/${id}/graphs/snap_${'a'.repeat(64)}.json.gz`);
    for (const bad of ['../manifest.json', 'graphs/../../x', '/etc/passwd', 'manifest.json/..', 'history/history.json', 'layout\\layout.json.gz', '']) {
      expect(() => objectKey(id, bad), bad).toThrow();
    }
    expect(() => objectKey('up_../../x', 'manifest.json')).toThrow('Invalid upload ID');
  });
  it('maps public chunk IDs to manifest paths and back', () => {
    for (const p of ['history/history.json.gz', 'layout/layout.json.gz', `graphs/snap_${'b'.repeat(64)}.json.gz`]) expect(chunkPath(chunkIdOf(p))).toBe(p);
    for (const bad of ['manifest', '../history', 'snap_x', `snap_${'B'.repeat(64)}`, 'history.json']) expect(chunkPath(bad)).toBeNull();
  });
  it('derives cache identity from immutable inputs only', () => {
    const base = { githubId: '42', commitOid: 'a'.repeat(40), profile: 'v0.1-default', historyEnabled: true, analyzerVersion: '0.1.0-dev.5' };
    expect(cacheKey(base)).toBe(cacheKey({ ...base }));
    for (const change of [{ githubId: '43' }, { commitOid: 'b'.repeat(40) }, { historyEnabled: false }, { analyzerVersion: '0.1.0-dev.6' }]) expect(cacheKey({ ...base, ...change })).not.toBe(cacheKey(base));
  });
});

async function exerciseStore(store: ObjectStore) {
  expect(await store.ready()).toBe(true);
  const id = newUploadId();
  const key = objectKey(id, 'layout/layout.json.gz');
  const bytes = randomBytes(70_000);
  await store.put(key, bytes);
  expect(Buffer.from((await store.get(key, bytes.length))!).equals(bytes)).toBe(true);
  await expect(store.get(key, bytes.length - 1)).rejects.toThrow('exceeds');
  expect(await store.get(objectKey(id, 'manifest.json'), 100)).toBeNull();
  await store.put(objectKey(id, 'manifest.json'), Buffer.from('{}'));
  expect((await store.list(`uploads/${id}/`)).sort()).toEqual([objectKey(id, 'layout/layout.json.gz'), objectKey(id, 'manifest.json')].sort());
  await expect(store.list('uploads/../')).rejects.toThrow();
  expect(await deleteUpload(store, id)).toBe(2);
  expect(await store.list(`uploads/${id}/`)).toEqual([]);
  await store.delete(key); // idempotent
}

describe('filesystem object store', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'atlas-objects-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  it('stores atomically with bounded reads and leaves no temporary files', async () => {
    const store = new FileObjectStore(root);
    await exerciseStore(store);
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [e.name]));
    expect(walk(root).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });
});

/**
 * Real S3 protocol (SigV4, path style) against an S3-compatible server. CI runs the pinned
 * Versity gateway; locally: docker run -p 127.0.0.1:7070:7070 versity/versitygw ...
 */
const s3 = process.env['ATLAS_TEST_S3_ENDPOINT'];
describe.runIf(!!s3)('S3-compatible object store (real server)', () => {
  it('signs, stores, lists, bounds reads and deletes', async () => {
    const store = new S3ObjectStore({ endpoint: s3!, region: 'us-east-1', bucket: `atlas-test-${randomBytes(4).toString('hex')}`, accessKeyId: process.env['ATLAS_TEST_S3_ACCESS_KEY'] ?? 'atlas', secretAccessKey: process.env['ATLAS_TEST_S3_SECRET_KEY'] ?? 'atlas-test-secret' });
    await store.createBucketForDevelopment();
    await exerciseStore(store);
    const wrong = new S3ObjectStore({ endpoint: s3!, region: 'us-east-1', bucket: 'atlas-nope', accessKeyId: 'atlas', secretAccessKey: 'wrong-secret' });
    await expect(wrong.put(objectKey(newUploadId(), 'manifest.json'), Buffer.from('{}'))).rejects.toThrow('rejected');
  });
  it('refuses non-HTTPS endpoints outside loopback and malformed buckets', () => {
    const base = { region: 'us-east-1', bucket: 'atlas', accessKeyId: 'a', secretAccessKey: 'b' };
    expect(() => new S3ObjectStore({ ...base, endpoint: 'http://storage.example' })).toThrow('HTTPS');
    expect(() => new S3ObjectStore({ ...base, endpoint: 'https://storage.example/path' })).toThrow('HTTPS');
    expect(() => new S3ObjectStore({ ...base, endpoint: 'https://storage.example', bucket: '../x' })).toThrow('bucket');
  });
});

describe('environment configuration fails closed', () => {
  it('rejects unsafe or incomplete settings before starting', () => {
    expect(() => storageFromEnv({})).toThrow(ConfigError);
    expect(() => storageFromEnv({ ATLAS_STORAGE: 'file:relative/dir' })).toThrow('absolute');
    expect(() => storageFromEnv({ ATLAS_STORAGE: 's3' })).toThrow('ATLAS_S3_ENDPOINT');
    const pool = {} as Pool;
    expect(() => resolverFromEnv({ ATLAS_ACQUISITION: 'fixture' }, pool)).toThrow('ATLAS_DEVELOPMENT=1');
    expect(() => resolverFromEnv({ ATLAS_ACQUISITION: 'ftp' }, pool)).toThrow(ConfigError);
    expect(() => resolverFromEnv({ ATLAS_GITHUB_TOKEN: 'not a token!' }, pool)).toThrow('token');
    const dir = mkdtempSync(path.join(tmpdir(), 'atlas-fixtures-'));
    const file = path.join(dir, 'fixtures.json');
    writeFileSync(file, JSON.stringify([{ numericId: '1', owner: 'o', name: 'n', defaultBranch: 'main', headOid: 'a'.repeat(40), remotePath: 'relative', visibility: 'public' }]));
    expect(() => resolverFromEnv({ ATLAS_ACQUISITION: 'fixture', ATLAS_DEVELOPMENT: '1', ATLAS_FIXTURES: file }, pool)).toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
});

const url = process.env['ATLAS_TEST_DATABASE_URL'];
describe.runIf(!!url)('shared GitHub budget on real PostgreSQL', () => {
  const schema = `atlas_test_control_${randomBytes(8).toString('hex')}`;
  let admin: Pool, pool: Pool;
  beforeAll(async () => {
    admin = new Pool({ connectionString: url!, max: 2 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url!, options: `-c search_path=${schema}`, max: 4 });
    await migrate(pool);
  });
  afterAll(async () => {
    await pool?.end();
    if (admin && /^atlas_test_control_[0-9a-f]+$/.test(schema)) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.end();
  });
  const headers = (values: Record<string, string>) => ({ get: (name: string) => values[name.toLowerCase()] ?? null });

  it('blocks every caller after a throttled answer until the reset, and stops before exhaustion', async () => {
    const a = new UpstreamGate(pool);
    const b = new UpstreamGate(pool);
    await a.before();
    await a.observe(200, headers({ 'x-ratelimit-remaining': '40', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) }));
    await b.before();
    await a.observe(403, headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 120) }));
    await expect(b.before()).rejects.toMatchObject({ code: 'UPSTREAM_RATE_LIMITED', status: 503 });
    const error = await b.before().catch((e: { retryAfter: number }) => e);
    expect((error as { retryAfter: number }).retryAfter).toBeGreaterThan(100);
    await pool.query('DELETE FROM upstream_budgets');
    // Retry-After without quota headers (secondary limits) blocks too.
    await a.observe(429, headers({ 'retry-after': '30' }));
    await expect(b.before()).rejects.toMatchObject({ code: 'UPSTREAM_RATE_LIMITED' });
    await pool.query('DELETE FROM upstream_budgets');
    // Within the reserve, callers stop voluntarily until the window resets.
    await a.observe(200, headers({ 'x-ratelimit-remaining': '1', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60) }));
    await expect(b.before()).rejects.toMatchObject({ code: 'UPSTREAM_RATE_LIMITED' });
  });

  it('provisions least-privilege API and worker roles: DML on their tables only, never DDL', async () => {
    const suffix = randomBytes(4).toString('hex');
    const api = { name: `atlas_test_api_${suffix}`, password: randomBytes(24).toString('hex') };
    const worker = { name: `atlas_test_worker_${suffix}`, password: randomBytes(24).toString('hex') };
    await provisionRoles(pool, { schema, api, worker });
    await provisionRoles(pool, { schema, api, worker }); // idempotent
    const as = (role: { name: string; password: string }) => {
      const target = new URL(url!);
      target.username = role.name;
      target.password = role.password;
      return new Pool({ connectionString: target.toString(), max: 1 });
    };
    const apiPool = as(api);
    const workerPool = as(worker);
    try {
      const denied = async (pool: Pool, sql: string) => expect(pool.query(sql), sql).rejects.toMatchObject({ code: '42501' });
      expect((await apiPool.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n).toBe(0);
      await apiPool.query("INSERT INTO sessions(hash,client_bucket,expires_at) VALUES($1,'b',clock_timestamp()+interval '1 hour')", ['a'.repeat(64)]);
      await denied(apiPool, `CREATE TABLE ${schema}.evil(x int)`);
      await denied(apiPool, 'DROP TABLE jobs');
      await denied(apiPool, 'TRUNCATE jobs');
      await denied(apiPool, "INSERT INTO publications(analysis_id,job_id,github_id,commit_oid,content_key,expires_at) VALUES('x','y','1','c','k',now())");
      await denied(apiPool, 'SELECT * FROM job_checkpoints');
      await denied(workerPool, "INSERT INTO sessions(hash,client_bucket,expires_at) VALUES('b','b',now())");
      await denied(workerPool, 'SELECT * FROM admissions');
      await denied(workerPool, 'DELETE FROM jobs');
      await denied(workerPool, 'ALTER TABLE jobs ADD COLUMN evil int');
      expect((await workerPool.query('SELECT count(*)::int AS n FROM jobs')).rows[0].n).toBe(0);
    } finally {
      await apiPool.end();
      await workerPool.end();
      await pool.query(`DELETE FROM sessions`);
      for (const role of [api, worker]) {
        await admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM "${role.name}"`);
        await admin.query(`REVOKE ALL ON SCHEMA ${schema} FROM "${role.name}"`);
        await admin.query(`DROP ROLE "${role.name}"`);
      }
    }
  });
});
