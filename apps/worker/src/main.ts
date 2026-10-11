import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ConfigError, PublicationStore, databasePool, isDevelopment, loadFixtures, migrationsCurrent, required, resolverFromEnv, storageFromEnv, type Env } from '@atlas/control';
import { Coordinator, type Logger } from './coordinator.js';
import { reconcileSandboxes, type SandboxRuntime } from './containers.js';
import { JobQueue } from './queue.js';
import { DockerStageRunners, ProcessStageRunners, type AcquisitionSource, type StageRunners } from './runners.js';
import { WorkerService } from './service.js';

/**
 * Worker process entrypoint (P5.6). Configuration is environment-only and validated
 * before any job is claimed. The coordinator runs on a host with a Docker engine; it never
 * shares a process with the API. Development switches are refused unless explicit.
 */
export const log: Logger = (event, fields) => {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), service: 'worker', event, ...fields })}\n`);
};

export function runnersFromEnv(env: Env): StageRunners {
  const development = isDevelopment(env);
  const fixtures = env['ATLAS_ACQUISITION'] === 'fixture' ? loadFixtures(required(env, 'ATLAS_FIXTURES')) : null;
  const source: AcquisitionSource = fixtures
    ? { kind: 'fixture', remoteFor: (id) => fixtures.find((f) => f.numericId === id)?.remotePath ?? '/nonexistent' }
    : { kind: 'github' };
  const sandbox = env['ATLAS_SANDBOX'] ?? 'docker';
  if (sandbox === 'process') {
    if (!development || source.kind !== 'fixture') throw new ConfigError('ATLAS_SANDBOX=process is a development mode for fixture repositories only');
    return new ProcessStageRunners(source);
  }
  if (sandbox !== 'docker') throw new ConfigError('ATLAS_SANDBOX must be "docker" or "process"');
  const image = required(env, 'ATLAS_SANDBOX_IMAGE');
  if (!/^sha256:[0-9a-f]{64}$/.test(image)) throw new ConfigError('ATLAS_SANDBOX_IMAGE must be an immutable image ID (sha256:...)');
  const docker = env['ATLAS_DOCKER_EXECUTABLE'] ?? 'docker';
  // Only what the Docker CLI needs; no service secret reaches it or any sandbox.
  const dockerEnv: Record<string, string> = {};
  for (const name of ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'SystemRoot', 'USERPROFILE', 'APPDATA', 'ProgramData', 'ProgramFiles']) {
    const value = env[name];
    if (value) dockerEnv[name] = value;
  }
  const runtime: SandboxRuntime = { docker, image, cwd: process.cwd(), env: dockerEnv };
  return new DockerStageRunners(runtime, source);
}

export async function startWorker(env: Env): Promise<void> {
  const pool = databasePool({ ...env, ATLAS_PROCESS_NAME: 'atlas-worker' }, 6);
  if (!(await migrationsCurrent(pool))) throw new ConfigError('Database migrations are not current; run the migration job first');
  const store = storageFromEnv(env);
  if (!(await store.ready())) throw new ConfigError('Object storage is not reachable');
  const resolver = resolverFromEnv(env, pool);
  const runners = runnersFromEnv(env);
  if (runners instanceof DockerStageRunners) log('sandbox.reconciled', await reconcileSandboxes(runners.runtime));
  const workRoot = path.resolve(required(env, 'ATLAS_WORK_ROOT'));
  await mkdir(workRoot, { recursive: true, mode: 0o700 });
  const publications = new PublicationStore(pool, store, resolver);
  const queue = new JobQueue(pool);
  const coordinator = new Coordinator({ pool, queue, store, publications, resolver, runners, workRoot, log });
  const service = new WorkerService({ queue, coordinator, publications, slots: Number(env['ATLAS_WORKER_SLOTS'] ?? 1), log });
  service.start();
  log('worker.started', { isolation: runners.isolation, slots: Number(env['ATLAS_WORKER_SLOTS'] ?? 1), owner: queue.owner });
  const shutdown = async () => {
    log('worker.stopping', {});
    await service.stop();
    await pool.end();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}
