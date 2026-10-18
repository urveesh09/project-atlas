#!/usr/bin/env node
/**
 * Operator rehearsal for the hosted service (P5.6 completion evidence). In a fresh
 * database it runs the real migration job (with least-privilege role provisioning), then
 * the real API and worker processes under those roles, and rehearses, in order:
 *
 *   1. readiness and operator metrics            6. worker crash: SIGKILL, lease expiry, reap, retry
 *   2. a full public journey with validation     7. operator purge of a publication
 *   3. cached reuse                              8. backup and restore preserving revocation
 *   4. a medium-repository hosted analysis       9. rollback guard (newer schema refuses start)
 *      (and, in step 6, recovery from its durable HEAD checkpoint)
 *   5. operator cancellation mid-analysis
 *
 * It writes docs/benchmarks/phase5-rehearsal.{json,md}. Use a disposable PostgreSQL server
 * (it creates and drops atlas_rehearsal_* databases) and, for container isolation, the
 * sandbox image ID:
 *
 *   node scripts/hosted-rehearsal.mjs --admin-url postgres://postgres:...@127.0.0.1:55432/postgres \
 *     --postgres-container atlas-phase5-postgres [--docker sha256:...] [--s3 http://127.0.0.1:7070]
 */
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Production transport/config rehearsal is separate from authored fixture acquisition:
// it never enables ATLAS_DEVELOPMENT on the production API profile.
if (process.argv.includes('--production-profile')) {
  await import('./production-rehearsal.mjs');
  process.exit(process.exitCode ?? 0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const { createGitFixture, buildDemoRepository } = await imp('packages/test-fixtures/dist/index.js');
const { openArtifact } = await imp('packages/artifact/dist/index.js');
const { gunzipNode } = await imp('packages/artifact/dist/node-entry.js');
const { buildMediumHistoryCommits } = await imp('scripts/lib/medium-history.mjs');
const pg = createRequire(path.join(root, 'apps/api/package.json'))('pg');

const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const adminUrl = opt('--admin-url');
const pgContainer = opt('--postgres-container');
const image = opt('--docker');
const s3 = opt('--s3');
const port = Number(opt('--port') ?? 18480);
if (!adminUrl) {
  console.error('Usage: node scripts/hosted-rehearsal.mjs --admin-url postgres://... [--postgres-container name] [--docker sha256:...] [--s3 http://...]');
  process.exit(2);
}

const report = { started: new Date().toISOString(), environment: {}, steps: [] };
const step = async (name, work) => {
  const started = performance.now();
  try {
    const detail = await work();
    report.steps.push({ name, ok: true, ms: Math.round(performance.now() - started), detail: detail ?? {} });
    console.error(`✓ ${name} (${((performance.now() - started) / 1000).toFixed(1)} s)`);
    return detail;
  } catch (error) {
    report.steps.push({ name, ok: false, ms: Math.round(performance.now() - started), detail: { error: String(error?.message ?? error) } });
    console.error(`✗ ${name}: ${error?.message ?? error}`);
    throw error;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, check, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(500);
  }
};

// --- Fresh environment ---------------------------------------------------------------------
const suffix = randomBytes(4).toString('hex');
const dbName = `atlas_rehearsal_${suffix}`;
const restoreName = `${dbName}_restored`;
const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
const dbUrl = (name, user, password) => {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  if (user) {
    u.username = user;
    u.password = password;
  }
  return u.toString();
};
const work = mkdtempSync(path.join(os.tmpdir(), 'atlas-rehearsal-'));
const passwords = { api: randomBytes(24).toString('hex'), worker: randomBytes(24).toString('hex') };
const roles = { api: `atlas_api_${suffix}`, worker: `atlas_worker_${suffix}` };
const children = new Set();

const fixturesDir = path.join(work, 'fixtures');
mkdirSync(fixturesDir, { recursive: true });
const demo = buildDemoRepository({ parent: fixturesDir });
console.error('Building the medium history fixture…');
const { commits } = buildMediumHistoryCommits();
const medium = createGitFixture(commits, { parent: fixturesDir });
// The previous medium commit is a separate identity (no cache) for the crash rehearsal.
execFileSync('git', ['-C', medium.dir, 'config', 'uploadpack.allowReachableSHA1InWant', 'true']);
const fixtures = [
  { numericId: '200003', owner: 'atlas-bench', name: 'medium-previous', defaultBranch: 'main', headOid: medium.commits.at(-2), remotePath: medium.dir, visibility: 'public' },
  { numericId: '200001', owner: 'atlas-demo', name: 'harbor', defaultBranch: 'main', headOid: demo.commits.at(-1), remotePath: demo.dir, visibility: 'public' },
  { numericId: '200002', owner: 'atlas-bench', name: 'medium', defaultBranch: 'main', headOid: medium.commits.at(-1), remotePath: medium.dir, visibility: 'public' },
];
writeFileSync(path.join(work, 'fixtures.json'), JSON.stringify(fixtures));
// Sandboxes run as uid 10001 and mount fixtures read-only: make them readable on Linux hosts.
const shareReadOnly = (dir) => {
  chmodSync(dir, 0o755);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) shareReadOnly(full);
    else chmodSync(full, 0o644);
  }
};
for (const dir of [work, fixturesDir, demo.dir, medium.dir]) shareReadOnly(dir);

const baseEnv = {
  PATH: process.env.PATH ?? '',
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  ...(process.env.USERPROFILE ? { USERPROFILE: process.env.USERPROFILE } : {}),
  ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
  ATLAS_DEVELOPMENT: '1',
  ATLAS_ACQUISITION: 'fixture',
  ATLAS_FIXTURES: path.join(work, 'fixtures.json'),
  ...(s3
    ? { ATLAS_STORAGE: 's3', ATLAS_S3_ENDPOINT: s3, ATLAS_S3_BUCKET: `atlas-rehearsal-${suffix}`, ATLAS_S3_ACCESS_KEY_ID: 'atlas', ATLAS_S3_SECRET_ACCESS_KEY: process.env.ATLAS_TEST_S3_SECRET_KEY ?? 'atlas-test-secret' }
    : { ATLAS_STORAGE: `file:${path.join(work, 'storage')}` }),
};
const apiEnv = (database = dbUrl(dbName, roles.api, passwords.api)) => ({ ...baseEnv, ATLAS_DATABASE_URL: database, ATLAS_QUOTA_SECRET: randomBytes(32).toString('hex'), ATLAS_PORT: String(port), ATLAS_OPERATOR_PORT: String(port + 1), ATLAS_WEB_ROOT: path.join(root, 'apps/web/dist'), ATLAS_HOURLY_JOBS: '100' });
const workerEnv = {
  ...baseEnv,
  ATLAS_DATABASE_URL: dbUrl(dbName, roles.worker, passwords.worker),
  ATLAS_WORK_ROOT: path.join(work, 'jobs'),
  ...(image ? { ATLAS_SANDBOX: 'docker', ATLAS_SANDBOX_IMAGE: image, ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}) } : { ATLAS_SANDBOX: 'process' }),
};
const startProcess = (name, script, env, extra = []) => {
  const child = spawn(process.execPath, [path.join(root, script), ...extra], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  child.stdout.on('data', (d) => lines.push(...d.toString().split('\n').filter(Boolean)));
  child.stderr.on('data', (d) => lines.push(...d.toString().split('\n').filter(Boolean)));
  children.add(child);
  child.on('exit', () => children.delete(child));
  return { child, lines, exited: new Promise((r) => child.on('exit', (code) => r(code))) };
};
const runProcess = async (name, script, env, extra) => {
  const p = startProcess(name, script, env, extra);
  const code = await p.exited;
  return { code, lines: p.lines };
};

const origin = `http://127.0.0.1:${port}`;
const api = async (pathname, init = {}, cookie = null) => {
  const response = await fetch(`${origin}${pathname}`, { ...init, headers: { ...(init.headers ?? {}), ...(cookie ? { Cookie: cookie } : {}), ...(init.method && init.method !== 'GET' ? { Origin: origin } : {}) } });
  return response;
};
const session = async () => (await api('/api/v1/session', { method: 'POST' })).headers.get('set-cookie').split(';')[0];
const submit = async (cookie, repository, history = true) => {
  const response = await api('/api/v1/analyses', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ repositoryUrl: repository, commitSha: null, profile: 'v0.1-default', history: { enabled: history }, publication: 'public-expiring' }) }, cookie);
  if (response.status !== 202) throw new Error(`Submission answered ${response.status}: ${await response.text()}`);
  return response.json();
};
const status = async (cookie, jobId) => (await api(`/api/v1/jobs/${jobId}`, {}, cookie)).json();
const waitTerminal = (cookie, jobId, timeoutMs) => until(`job ${jobId}`, async () => {
  const s = await status(cookie, jobId);
  return ['READY', 'PARTIAL', 'FAILED', 'CANCELLED'].includes(s.state) ? s : null;
}, timeoutMs);
const validatePublication = async (analysisId) => {
  const opened = await openArtifact({
    async read(p) {
      const id = p === 'manifest.json' ? null : p === 'history/history.json.gz' ? 'history' : p === 'layout/layout.json.gz' ? 'layout' : p.slice(7, -8);
      const r = await api(id ? `/api/v1/analyses/${analysisId}/chunks/${id}` : `/api/v1/analyses/${analysisId}`);
      if (!r.ok) throw new Error(`${p}: ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    },
  }, gunzipNode);
  if (!opened.ok) throw new Error(`Publication failed validation: ${opened.issues[0]?.code}`);
  for (let i = 0; i < opened.artifact.manifest.frames.length; i++) if (!(await opened.artifact.frame(i)).ok) throw new Error(`frame ${i} invalid`);
  return { frames: opened.artifact.manifest.frames.length, files: opened.artifact.head.coverage.includedFiles, compressedBytes: opened.artifact.stats.compressedBytes };
};
const ops = async (...command) => {
  const result = await runProcess('ops', 'apps/worker/dist/ops-bin.js', workerEnv, command);
  if (result.code !== 0) throw new Error(`atlas-ops ${command.join(' ')} exited ${result.code}: ${result.lines.join(' ')}`);
  return JSON.parse(result.lines.at(-1));
};
const sandboxes = () => {
  if (!image) return [];
  return execFileSync('docker', ['ps', '--all', '--filter', 'label=atlas.sandbox', '--format', '{{.Names}}']).toString().split('\n').filter(Boolean);
};

let apiProcess;
let workerProcess;
try {
  report.environment = {
    os: `${os.type()} ${os.release()}`,
    cpus: os.cpus().length,
    memoryGiB: Math.round(os.totalmem() / 2 ** 30),
    node: process.version,
    git: execFileSync('git', ['--version']).toString().trim(),
    docker: image ? execFileSync('docker', ['version', '--format', '{{.Server.Version}}']).toString().trim() : null,
    isolation: image ? 'container' : 'process (development)',
    storage: s3 ? 'S3-compatible (Versity gateway)' : 'filesystem',
    sandboxImage: image,
  };

  await step('fresh database, migrations and least-privilege roles', async () => {
    await admin.query(`CREATE DATABASE ${dbName}`);
    const migrated = await runProcess('migrate', 'apps/api/dist/bin.js', { ...baseEnv, ATLAS_DATABASE_URL: dbUrl(dbName), ATLAS_API_ROLE: roles.api, ATLAS_WORKER_ROLE: roles.worker, ATLAS_API_ROLE_PASSWORD: passwords.api, ATLAS_WORKER_ROLE_PASSWORD: passwords.worker }, ['migrate']);
    if (migrated.code !== 0) throw new Error(migrated.lines.join('\n'));
    return { database: 'fresh', roles: ['api', 'worker'] };
  });

  await step('API and worker start under their own roles; ready and metrics answer', async () => {
    apiProcess = startProcess('api', 'apps/api/dist/bin.js', apiEnv(), ['serve']);
    workerProcess = startProcess('worker', 'apps/worker/dist/bin.js', workerEnv);
    await until('readiness', async () => (await api('/api/v1/health/ready').catch(() => ({ status: 0 }))).status === 200, 30_000);
    const metrics = await (await fetch(`http://127.0.0.1:${port + 1}/metrics`)).json();
    return { ready: true, queued: metrics.queue.queued };
  });

  const cookie = await session();
  const journey = await step('public journey: Harbor demo with history, verified through the public routes', async () => {
    const started = Date.now();
    const accepted = await submit(cookie, 'https://github.com/atlas-demo/harbor');
    const final = await waitTerminal(cookie, accepted.jobId, 240_000);
    if (final.state !== 'READY') throw new Error(`ended ${final.state} ${JSON.stringify(final.error)}`);
    return { jobId: accepted.jobId, analysisId: final.analysisId, seconds: (Date.now() - started) / 1000, ...(await validatePublication(final.analysisId)) };
  });

  await step('cached reuse: identical submission becomes a new publication without analysis', async () => {
    const started = Date.now();
    const accepted = await submit(cookie, 'https://github.com/atlas-demo/harbor');
    const final = await waitTerminal(cookie, accepted.jobId, 60_000);
    if (final.state !== 'READY' || !final.counts.cached || final.analysisId === journey.analysisId) throw new Error('cache not reused');
    return { seconds: (Date.now() - started) / 1000 };
  });

  await step('medium repository end to end (3,252 files at HEAD, 40 commits, history)', async () => {
    const started = Date.now();
    const accepted = await submit(cookie, 'https://github.com/atlas-bench/medium');
    const final = await waitTerminal(cookie, accepted.jobId, 320_000);
    if (final.state !== 'READY' && final.state !== 'PARTIAL') throw new Error(`ended ${final.state} ${JSON.stringify(final.error)}`);
    const verified = await validatePublication(final.analysisId);
    return { state: final.state, endToEndSeconds: (Date.now() - started) / 1000, warnings: final.warnings, ...verified };
  });

  await step('operator cancellation during analysis stops the sandbox; nothing is published', async () => {
    const accepted = await submit(cookie, 'https://github.com/atlas-bench/medium', false);
    await until('analysis to start', async () => ['ANALYZING', 'LAYOUT', 'VALIDATING'].includes((await status(cookie, accepted.jobId)).state), 120_000);
    const cancelled = await ops('cancel', accepted.jobId);
    const final = await waitTerminal(cookie, accepted.jobId, 60_000);
    if (final.state !== 'CANCELLED') throw new Error(`ended ${final.state}`);
    await sleep(1000);
    return { requested: cancelled.state, final: final.state, analysisId: final.analysisId, sandboxesLeft: sandboxes().length };
  });

  await step('worker crash after the HEAD checkpoint: SIGKILL, lease expiry, reap, retry from the checkpoint', async () => {
    // A commit identity not analyzed before, so nothing is served from cache.
    const crashCookie = await session();
    const accepted = await submit(crashCookie, 'https://github.com/atlas-bench/medium-previous');
    await until('history stage', async () => (await status(crashCookie, accepted.jobId)).state === 'HISTORY', 200_000);
    const before = await status(crashCookie, accepted.jobId);
    workerProcess.child.kill('SIGKILL');
    await workerProcess.exited;
    const killedAt = Date.now();
    workerProcess = startProcess('worker', 'apps/worker/dist/bin.js', workerEnv);
    const final = await waitTerminal(crashCookie, accepted.jobId, 320_000);
    if (final.state !== 'READY' && final.state !== 'PARTIAL') throw new Error(`ended ${final.state} ${JSON.stringify(final.error)}`);
    if (!final.warnings.some((w) => w.code === 'CHECKPOINT_RECOVERED')) throw new Error('the retry did not reuse the checkpoint');
    await sleep(1000);
    return { stateAtCrash: before.state, final: final.state, recoverySeconds: (Date.now() - killedAt) / 1000, warnings: final.warnings, sandboxesLeft: sandboxes().length };
  });

  await step('operator purge revokes one publication and its storage', async () => {
    const result = await ops('purge-analysis', journey.analysisId);
    const after = await api(`/api/v1/analyses/${journey.analysisId}`);
    const body = await after.json();
    if (after.status !== 410 || body.error.code !== 'ARTIFACT_REVOKED') throw new Error(`answered ${after.status}`);
    return { purged: result.purged, status: after.status, code: body.error.code };
  });

  await step('backup and restore preserve publication lifecycle state', async () => {
    if (!pgContainer) return { skipped: 'no --postgres-container for pg_dump' };
    const dump = execFileSync('docker', ['exec', pgContainer, 'pg_dump', '-U', new URL(adminUrl).username, '-d', dbName, '-Fc', '--no-owner', '--no-privileges'], { maxBuffer: 512 * 1024 * 1024 });
    await admin.query(`CREATE DATABASE ${restoreName}`);
    execFileSync('docker', ['exec', '-i', pgContainer, 'pg_restore', '-U', new URL(adminUrl).username, '-d', restoreName, '--no-owner', '--no-privileges'], { input: dump, maxBuffer: 64 * 1024 * 1024 });
    const restored = new pg.Pool({ connectionString: dbUrl(restoreName), max: 1 });
    const rows = (await restored.query("SELECT count(*) FILTER (WHERE revoked_at IS NOT NULL)::int AS revoked, count(*)::int AS total FROM publications")).rows[0];
    const migrations = (await restored.query('SELECT count(*)::int AS n FROM atlas_migrations')).rows[0].n;
    await restored.end();
    return { dumpBytes: dump.length, publications: rows.total, revokedPreserved: rows.revoked, migrations };
  });

  await step('rollback guard: a database newer than the binary refuses to serve', async () => {
    const owner = new pg.Pool({ connectionString: dbUrl(dbName), max: 1 });
    await owner.query("INSERT INTO atlas_migrations VALUES(999,'from-a-newer-release')");
    const refused = await runProcess('api', 'apps/api/dist/bin.js', { ...apiEnv(), ATLAS_PORT: String(port + 2), ATLAS_OPERATOR_PORT: '' }, ['serve']);
    const migrate = await runProcess('migrate', 'apps/api/dist/bin.js', { ...baseEnv, ATLAS_DATABASE_URL: dbUrl(dbName) }, ['migrate']);
    await owner.query('DELETE FROM atlas_migrations WHERE version=999');
    await owner.end();
    if (refused.code === 0 || migrate.code === 0) throw new Error('an older binary accepted a newer schema');
    return { apiExit: refused.code, migrateExit: migrate.code, reason: refused.lines.find((l) => l.includes('fatal'))?.slice(0, 160) ?? null };
  });

  await step('final operator metrics', async () => {
    const metrics = await ops('metrics');
    return { outcomes24h: metrics.outcomes24h, stageMsP95: metrics.stageMsP95_24h, publications: metrics.publications, storage: metrics.storage, leases: metrics.leases };
  });
} catch {
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill('SIGTERM');
  await sleep(1500);
  for (const child of children) child.kill('SIGKILL');
  report.finished = new Date().toISOString();
  report.ok = report.steps.every((s) => s.ok);
  for (const name of [restoreName, dbName]) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
  for (const role of Object.values(roles)) await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
  await admin.end();
  demo.dispose();
  medium.dispose();
  rmSync(work, { recursive: true, force: true, maxRetries: 5 });
  const out = path.join(root, 'docs/benchmarks/phase5-rehearsal');
  writeFileSync(`${out}.json`, `${JSON.stringify(report, null, 2)}\n`);
  const md = [
    '# Phase 5 hosted operator rehearsal',
    '',
    `Run ${report.started} → ${report.finished}: **${report.ok ? 'all steps passed' : 'FAILED'}**.`,
    '',
    `Environment: ${report.environment.os}, ${report.environment.cpus} CPUs, ${report.environment.memoryGiB} GiB, Node ${report.environment.node}, ${report.environment.git}, Docker ${report.environment.docker ?? 'n/a'}. Isolation: ${report.environment.isolation}. Storage: ${report.environment.storage}.`,
    '',
    'Fresh database; the real migration job provisions least-privilege API and worker roles; the real API and worker processes run under those roles. Repositories come from authored fixtures served to the acquisition sandbox (no GitHub traffic).',
    '',
    '| Step | Result | Time | Evidence |',
    '|---|---|---:|---|',
    ...report.steps.map((s) => `| ${s.name} | ${s.ok ? 'pass' : '**fail**'} | ${(s.ms / 1000).toFixed(1)} s | ${Object.entries(s.detail).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('; ').replaceAll('|', '/')} |`),
    '',
    'Reproduce: see the header of `scripts/hosted-rehearsal.mjs` and docs/hosted-operations.md.',
    '',
  ].join('\n');
  writeFileSync(`${out}.md`, md);
  console.error(`Wrote ${path.relative(root, out)}.{json,md}`);
}
