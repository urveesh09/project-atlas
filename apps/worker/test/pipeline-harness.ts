import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, chmodSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import type { GitFixture } from '@atlas/test-fixtures';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { AdmissionStore } from '@atlas/api';
import { FileObjectStore, FixtureResolver, PublicationStore, S3ObjectStore, migrate, provisionRoles, type FixtureRepository, type ObjectStore } from '@atlas/control';
import { Coordinator, JobQueue, ProcessStageRunners, type AcquireRequest, type AnalyzeRequest, type Logger, type StageRunners } from '../src/index.js';
import type { AnalysisSubmission } from '@atlas/schema';

export const databaseUrl = process.env['ATLAS_TEST_DATABASE_URL'];
if (process.env['ATLAS_REQUIRE_HOSTED_TESTS'] === '1' && !databaseUrl) throw new Error('Hosted pipeline tests require ATLAS_TEST_DATABASE_URL');

export const submission = (repositoryUrl: string, history = true): AnalysisSubmission => ({ repositoryUrl, commitSha: null, profile: 'v0.1-default', history: { enabled: history }, publication: 'public-expiring' });

/** Only generated test fixtures are shared with sandbox UID 10001; never follow links. */
export function shareFixtureWithSandbox(fixture: GitFixture): void {
  assert(path.isAbsolute(fixture.dir) && path.basename(fixture.dir).startsWith('atlas-fixture-'));
  const visit = (dir: string) => {
    chmodSync(dir, 0o755);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(full); else chmodSync(full, 0o644);
    }
  };
  visit(fixture.dir);
}

/** The sandbox entrypoints run from compiled output, exactly as in the image. */
export function requireBuiltSandbox(): void {
  const entry = fileURLToPath(new URL('../dist/sandbox/analyze-main.js', import.meta.url));
  if (!existsSync(entry)) throw new Error('Build first (pnpm build): the pipeline runs the compiled sandbox entrypoints');
}

/** Wraps runners so tests can block, fail or observe a specific stage. */
export class ScriptedRunners implements StageRunners {
  get isolation() {
    return this.inner.isolation;
  }
  acquisitions: number[] = [];
  analyses: { history: boolean; checkpoint: boolean }[] = [];
  constructor(
    readonly inner: StageRunners,
    readonly hooks: {
      acquire?: (request: AcquireRequest, run: () => Promise<Awaited<ReturnType<StageRunners['acquire']>>>) => ReturnType<StageRunners['acquire']>;
      analyze?: (request: AnalyzeRequest, run: () => ReturnType<StageRunners['analyze']>) => ReturnType<StageRunners['analyze']>;
    } = {},
  ) {}
  acquire(request: AcquireRequest) {
    this.acquisitions.push(request.depth);
    const run = () => this.inner.acquire(request);
    return this.hooks.acquire ? this.hooks.acquire(request, run) : run();
  }
  analyze(request: AnalyzeRequest) {
    this.analyses.push({ history: request.spec.history, checkpoint: request.spec.checkpoint });
    const run = () => this.inner.analyze(request);
    return this.hooks.analyze ? this.hooks.analyze(request, run) : run();
  }
}

/** Resolves when the stage's signal aborts (cancellation, lease loss or deadline). */
export const untilAborted = (signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));

export interface Harness {
  schema: string;
  admin: Pool;
  pool: Pool;
  store: ObjectStore;
  storageRoot: string;
  workRoot: string;
  admission: AdmissionStore;
  resolver: FixtureResolver;
  publications: PublicationStore;
  queue: JobQueue;
  coordinator(runners: StageRunners, options?: { publishReserveMs?: number; log?: Logger }): Coordinator;
  /**
   * Least-privilege deployment shape: separate API and worker login roles (P5.6). Returns
   * pools and stores bound to those roles; `close` removes the roles.
   */
  restrictedRoles(): Promise<{ api: { pool: Pool; admission: AdmissionStore; publications: PublicationStore }; worker: { pool: Pool; coordinator(runners: StageRunners): Coordinator } }>;
  submit(input: AnalysisSubmission): Promise<{ jobId: string; token: string; sessionHash: string }>;
  job(jobId: string): Promise<Record<string, any>>;
  events(jobId: string): Promise<{ kind: string; state: string }[]>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function createHarness(repositories: FixtureRepository[], options: { store?: (root: string) => ObjectStore } = {}): Promise<Harness> {
  const schema = `atlas_test_pipeline_${randomBytes(8).toString('hex')}`;
  const admin = new Pool({ connectionString: databaseUrl!, max: 2 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}`, max: 12 });
  await migrate(pool);
  const storageRoot = mkdtempSync(path.join(tmpdir(), 'atlas-store-'));
  const workRoot = mkdtempSync(path.join(tmpdir(), 'atlas-work-'));
  // Real S3 protocol when a test server is configured (CI), otherwise the filesystem store.
  const s3 = process.env['ATLAS_TEST_S3_ENDPOINT'];
  const store = options.store
    ? options.store(storageRoot)
    : s3
      ? new S3ObjectStore({ endpoint: s3, region: 'us-east-1', bucket: `atlas-pipeline-${randomBytes(4).toString('hex')}`, accessKeyId: process.env['ATLAS_TEST_S3_ACCESS_KEY'] ?? 'atlas', secretAccessKey: process.env['ATLAS_TEST_S3_SECRET_KEY'] ?? 'atlas-test-secret' })
      : new FileObjectStore(storageRoot);
  if (store instanceof S3ObjectStore) await store.createBucketForDevelopment();
  const resolver = new FixtureResolver(repositories);
  const publications = new PublicationStore(pool, store, resolver);
  const admission = new AdmissionStore(pool, { hourly: 1000, queued: 100 });
  const queue = new JobQueue(pool);
  let serial = 0;
  const roles: { name: string; pool: Pool }[] = [];
  const rolePool = async (kind: 'api' | 'worker') => {
    const name = `${schema}_${kind}`.slice(0, 63);
    const password = randomBytes(24).toString('hex');
    const target = new URL(databaseUrl!);
    target.username = name;
    target.password = password;
    return { name, password, connect: () => new Pool({ connectionString: target.toString(), max: 6 }) };
  };
  return {
    schema, admin, pool, store, storageRoot, workRoot, admission, resolver, publications, queue,
    coordinator: (runners, extra = {}) => new Coordinator({ pool, queue, store, publications, resolver, runners, workRoot, publishReserveMs: extra.publishReserveMs ?? 4000, ...(extra.log ? { log: extra.log } : {}) }),
    async restrictedRoles() {
      const api = await rolePool('api');
      const worker = await rolePool('worker');
      await provisionRoles(pool, { schema, api, worker });
      const apiPool = api.connect();
      const workerPool = worker.connect();
      roles.push({ name: api.name, pool: apiPool }, { name: worker.name, pool: workerPool });
      const workerQueue = new JobQueue(workerPool);
      const workerPublications = new PublicationStore(workerPool, store, resolver);
      return {
        api: { pool: apiPool, admission: new AdmissionStore(apiPool, { hourly: 1000, queued: 100 }), publications: new PublicationStore(apiPool, store, resolver) },
        worker: {
          pool: workerPool,
          coordinator: (runners) => new Coordinator({ pool: workerPool, queue: workerQueue, store, publications: workerPublications, resolver, runners, workRoot, publishReserveMs: 4000 }),
        },
      };
    },
    async submit(input) {
      const bucket = `bucket-${serial++}`;
      const token = await admission.createSession(bucket);
      const sessionHash = (await admission.session(token))!;
      const { accepted } = await admission.admit(input, sessionHash, bucket, randomUUID());
      return { jobId: accepted.jobId, token: accepted.managementToken!, sessionHash };
    },
    job: async (jobId) => (await pool.query('SELECT * FROM jobs WHERE id=$1', [jobId])).rows[0],
    events: async (jobId) => (await pool.query("SELECT kind,payload->>'state' AS state FROM job_events WHERE job_id=$1 ORDER BY revision", [jobId])).rows,
    async reset() {
      await pool.query('TRUNCATE sessions,jobs,admissions,job_events,publications,artifact_objects,repositories,uploads,job_checkpoints,upstream_budgets CASCADE');
      for (let keys = await store.list('uploads/', 1000); keys.length > 0; keys = await store.list('uploads/', 1000)) for (const key of keys) await store.delete(key);
      rmSync(storageRoot, { recursive: true, force: true });
      for (const repo of repositories) resolver.repositories.get(`${repo.owner}/${repo.name}`.toLowerCase())!.visibility = 'public';
      resolver.outage = false;
    },
    async close() {
      for (const role of roles) {
        await role.pool.end();
        await admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM "${role.name}"`);
        await admin.query(`REVOKE ALL ON SCHEMA ${schema} FROM "${role.name}"`);
        await admin.query(`DROP ROLE IF EXISTS "${role.name}"`);
      }
      await pool.end();
      if (/^atlas_test_pipeline_[0-9a-f]+$/.test(schema)) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      rmSync(storageRoot, { recursive: true, force: true });
      rmSync(workRoot, { recursive: true, force: true });
    },
  };
}

export const processRunners = (remote: string) => new ProcessStageRunners({ kind: 'fixture', remoteFor: () => remote });
