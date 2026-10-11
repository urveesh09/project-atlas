#!/usr/bin/env node
/**
 * Development hosted environment (P5.6): the real API and worker processes, configured
 * only through their documented environment variables, over a PostgreSQL database and
 * private storage you provide. Repositories come from authored fixtures (the Harbor demo)
 * unless --github is given; analysis runs in containers with --docker, otherwise in
 * development processes (clearly labelled in every job and refused for public origins).
 *
 *   ATLAS_DATABASE_URL=postgres://... node scripts/hosted-dev.mjs [--docker <sandbox-image-id>] [--github] [--port 8080]
 *
 * Build first: pnpm build && pnpm build:web.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDemoRepository } from '../packages/test-fixtures/dist/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? null);
};
const docker = option('--docker');
const github = args.includes('--github');
const port = Number(option('--port') ?? 8080);
const database = process.env.ATLAS_DATABASE_URL;
if (!database) {
  console.error('Set ATLAS_DATABASE_URL to a disposable development database (see docs/hosted-development.md).');
  process.exit(2);
}
for (const required of ['apps/api/dist/bin.js', 'apps/worker/dist/bin.js', 'apps/web/dist/index.html']) {
  if (!existsSync(path.join(root, required))) {
    console.error(`Missing ${required}: run pnpm build && pnpm build:web first.`);
    process.exit(2);
  }
}

const state = path.join(root, '.atlas-tmp', 'hosted-dev');
mkdirSync(state, { recursive: true });
const env = {
  PATH: process.env.PATH ?? '',
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
  ...(process.env.USERPROFILE ? { USERPROFILE: process.env.USERPROFILE } : {}),
  ATLAS_DATABASE_URL: database,
  ATLAS_STORAGE: process.env.ATLAS_STORAGE ?? `file:${path.join(state, 'storage')}`,
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('ATLAS_S3_') || k === 'ATLAS_GITHUB_TOKEN')),
  ATLAS_DEVELOPMENT: '1',
  ATLAS_QUOTA_SECRET: randomBytes(32).toString('hex'),
  ATLAS_PORT: String(port),
  ATLAS_WEB_ROOT: path.join(root, 'apps', 'web', 'dist'),
  ATLAS_OPERATOR_PORT: String(port + 1),
  ATLAS_WORK_ROOT: path.join(state, 'work'),
  ATLAS_HOURLY_JOBS: '50',
};
if (!github) {
  const fixtures = path.join(state, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  const demo = buildDemoRepository({ parent: fixtures });
  const file = path.join(state, 'fixtures.json');
  writeFileSync(file, JSON.stringify([{ numericId: '100001', owner: 'atlas-demo', name: 'harbor', defaultBranch: 'main', headOid: demo.commits.at(-1), remotePath: demo.dir, visibility: 'public' }], null, 2));
  Object.assign(env, { ATLAS_ACQUISITION: 'fixture', ATLAS_FIXTURES: file });
  console.log('Fixture repository: https://github.com/atlas-demo/harbor (the authored Harbor demo, served locally)');
}
if (docker) Object.assign(env, { ATLAS_SANDBOX: 'docker', ATLAS_SANDBOX_IMAGE: docker, ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}) });
else if (github) {
  console.error('--github requires --docker: real repositories are only analyzed inside containers.');
  process.exit(2);
} else Object.assign(env, { ATLAS_SANDBOX: 'process' });

const run = (name, script, extra = []) =>
  spawn(process.execPath, [path.join(root, script), ...extra], { env, stdio: ['ignore', 'inherit', 'inherit'] }).on('exit', (code) => {
    if (code !== 0 && code !== null) console.error(`${name} exited with ${code}`);
  });

const migrate = run('migrate', 'apps/api/dist/bin.js', ['migrate']);
migrate.on('exit', (code) => {
  if (code !== 0) process.exit(code ?? 1);
  const api = run('api', 'apps/api/dist/bin.js', ['serve']);
  const worker = run('worker', 'apps/worker/dist/bin.js');
  console.log(`ATLAS hosted (development): http://127.0.0.1:${port}/  operator metrics: http://127.0.0.1:${port + 1}/metrics`);
  const stop = () => {
    api.kill('SIGTERM');
    worker.kill('SIGTERM');
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
});
