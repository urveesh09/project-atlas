#!/usr/bin/env node
/**
 * Offline whole-job capacity: immutable production runtime, 4 CPUs, 2 GiB, no swap.
 * Each run is a fresh analysis process inside the one capped container, as in production.
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, chmod, realpath, readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const value = process.argv[i + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing --${name}`);
  return value;
};
const image = option('image');
if (!/^sha256:[0-9a-f]{64}$/.test(image ?? '')) throw new Error('--image must be a locally built immutable Docker image ID');
const files = Number(option('files', '9740'));
const head = process.argv.includes('--head');
const language = option('language', 'typescript');
if (!['typescript', 'python', 'mixed'].includes(language)) throw new Error('Invalid capacity language');
const runs = Number(option('runs', '20'));
const { PYTHON_CAPACITY_POLICY } = await import('./lib/capacity-language.mjs');
const out = option('out', files > 3000 ? 'phase6-large-history-container' : 'phase6-medium-history-container');
if (!Number.isInteger(files) || files < 1 || files > (head ? 9850 : 9740) || !Number.isInteger(runs) || runs < 1 || runs > 100 || !/^[a-z0-9-]+$/.test(out)) throw new Error('Invalid fixture size, sample count or report name');
const fixtureArg = option('fixture');
if (!fixtureArg) throw new Error('--fixture is required; generate it with scripts/build-history-fixture.mjs');
const fixture = await realpath(fixtureArg);
let fixtureMetadata;
try { fixtureMetadata = JSON.parse(await readFile(path.join(fixture, 'atlas-capacity-fixture.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT' || language !== 'typescript' || head) throw error; }
if (fixtureMetadata && (fixtureMetadata.language !== language || fixtureMetadata.mode !== (head ? 'head' : 'history') || fixtureMetadata.files !== files))
  throw new Error('Prepared fixture does not match the requested language, mode and size');
if (language !== 'typescript' && fixtureMetadata?.policy !== PYTHON_CAPACITY_POLICY)
  throw new Error(`Prepared ${language} fixture was not generated with ${PYTHON_CAPACITY_POLICY}; regenerate it (ADR-067)`);
const parent = await realpath(path.join(root, '.atlas-tmp', 'capacity-fixtures'));
if (!fixture.startsWith(parent + path.sep)) throw new Error('Use a prepared fixture generated under .atlas-tmp/capacity-fixtures');
const inspect = JSON.parse(execFileSync('docker', ['image', 'inspect', image], { encoding: 'utf8', windowsHide: true, timeout: 15_000 }))[0];
const sourceCommit = inspect.Config.Labels?.['org.opencontainers.image.revision'];
if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sourceCommit ?? '') || inspect.Id !== image) throw new Error('Image must identify its committed source revision');
const nonce = randomUUID();
const name = `atlas-phase6-capacity-${nonce}`;
const label = 'org.atlas.capacity.owner';
const benchmarkSourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const benchmarkWorkingTreeDirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0;
const reportParent = path.join(root, '.atlas-tmp', 'capacity-reports');
await mkdir(reportParent, { recursive: true });
const reports = await mkdtemp(path.join(reportParent, 'run-'));
// Only this fresh report directory is writable by the non-root sandbox UID.
// Repository documentation is not exposed as a writable host mount.
await chmod(reports, 0o777);
const mount = (source, target, readonly = false) => {
  if (source.includes(',')) throw new Error('Docker bind mount paths containing commas are unsupported');
  return `type=bind,source=${source},target=${target}${readonly ? ',readonly' : ''}`;
};
const args = ['run', '--rm', '--pull=never', '--name', name, '--label', `${label}=${nonce}`,
  '--network=none', '--read-only', '--user=10001:10001', '--init', '--log-driver=none', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64',
  '--cpus=4', '--memory=2147483648', '--memory-swap=2147483648',
  '--tmpfs', '/tmp:rw,nosuid,nodev,size=268435456,mode=1777',
  '--mount', mount(path.join(root, 'scripts'), '/tools/scripts', true),
  '--mount', mount(fixture, '/fixture', true), '--mount', mount(reports, '/reports'),
  '--env', `ATLAS_CAPACITY_IMAGE=${image}`, '--env', `ATLAS_CAPACITY_SOURCE_COMMIT=${sourceCommit}`,
  '--env', `ATLAS_CAPACITY_BENCHMARK_COMMIT=${benchmarkSourceCommit}`, '--env', `ATLAS_CAPACITY_BENCHMARK_DIRTY=${benchmarkWorkingTreeDirty}`,
  image, 'node', '--max-old-space-size=1536', '/tools/scripts/bench-history.mjs',
  '--fixture', '/fixture', '--runtime-root', '/atlas', '--report-dir', '/reports', '--require-container-limits', '--isolate-runs',
  '--files', String(files), '--runs', String(runs), '--out', out];
if (process.argv.includes('--diagnostic-once')) args.push('--diagnostic-once');
args.push('--language', language);
if (head) args.push('--head');
await writeFile(path.join(root, '.atlas-tmp', 'capacity-session.json'), JSON.stringify({ name, nonce, image, sourceCommit, benchmarkSourceCommit, benchmarkWorkingTreeDirty, fixture, reports, args }, null, 2));
console.error(`Capacity container ${name}; image ${image}; source ${sourceCommit}`);
const child = spawn('docker', args, { stdio: 'inherit', windowsHide: true });
const cancel = () => child.kill('SIGTERM');
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
try {
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (!process.argv.includes('--diagnostic-once')) {
    // Reports are fresh for this session. Publish completed failures as evidence
    // too; a crash before report creation cannot reuse a stale pass from docs/.
    let report;
    try { report = JSON.parse(await readFile(path.join(reports, `${out}.json`), 'utf8')); } catch (error) { if (code === 0) throw error; }
    if (report) {
      if (report.environment.runtimeImage !== image || report.environment.sourceCommit !== sourceCommit) throw new Error('Capacity report runtime identity mismatch');
      if (!process.argv.includes('--retain-only'))
        for (const extension of ['json', 'md']) await copyFile(path.join(reports, `${out}.${extension}`), path.join(root, 'docs', 'benchmarks', `${out}.${extension}`));
    }
  }
  if (code !== 0) throw new Error(`Capacity container failed (exit ${code}); no gate pass is inferred`);
} finally {
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
  // The engine and other agents' containers are shared. Remove only our exact
  // nonce-labelled container, including interrupted/OOM runs. --rm normally did it.
  let owned;
  try {
    owned = JSON.parse(execFileSync('docker', ['inspect', name], { encoding: 'utf8', windowsHide: true, timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }))[0];
  } catch (error) {
    const message = error.stderr?.toString() ?? '';
    if (!new RegExp(`no such (?:object|container): ${name}`, 'i').test(message))
      throw new Error('Capacity cleanup could not be verified; engine reconciliation is required', { cause: error });
  }
  if (owned) {
    if (owned.Config.Labels?.[label] !== nonce) throw new Error('Refusing to remove a container not owned by this capacity session');
    execFileSync('docker', ['rm', '--force', owned.Id], { windowsHide: true, timeout: 15_000, stdio: 'ignore' });
  }
}
