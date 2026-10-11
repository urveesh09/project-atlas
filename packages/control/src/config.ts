import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { z } from 'zod';
import { FixtureResolver, GithubResolver, UpstreamGate, type FixtureRepository, type RepositoryResolver } from './github.js';
import { FileObjectStore, S3ObjectStore, type ObjectStore } from './storage.js';

/**
 * Environment configuration shared by the API and worker processes (P5.6). Every value is
 * validated at startup; a missing secret or an unsafe development switch in a public
 * deployment stops the process instead of degrading silently. Secrets are read from the
 * environment (or a file path ending in `_FILE`) and never logged.
 */
export type Env = Readonly<Record<string, string | undefined>>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** `NAME` or the contents of the file named by `NAME_FILE` (container secrets). */
export function secret(env: Env, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  if (file) {
    if (!path.isAbsolute(file)) throw new ConfigError(`${name}_FILE must be an absolute path`);
    return readFileSync(file, 'utf8').trim();
  }
  return env[name];
}

export function required(env: Env, name: string): string {
  const value = secret(env, name);
  if (!value) throw new ConfigError(`${name} is required`);
  return value;
}

export const isDevelopment = (env: Env) => env['ATLAS_DEVELOPMENT'] === '1';

/** Bounded pool with connection and statement timeouts (ADR-029 deployment rule). */
export function databasePool(env: Env, max = 10): pg.Pool {
  const url = required(env, 'ATLAS_DATABASE_URL');
  if (!/^postgres(?:ql)?:\/\//.test(url)) throw new ConfigError('ATLAS_DATABASE_URL must be a postgres:// URL');
  return new pg.Pool({
    connectionString: url,
    max: Number(env['ATLAS_DATABASE_POOL'] ?? max),
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 15_000,
    query_timeout: 20_000,
    application_name: env['ATLAS_PROCESS_NAME'] ?? 'atlas',
  });
}

export function storageFromEnv(env: Env): ObjectStore {
  const kind = env['ATLAS_STORAGE'] ?? '';
  if (kind === 's3') {
    return new S3ObjectStore({
      endpoint: required(env, 'ATLAS_S3_ENDPOINT'),
      region: env['ATLAS_S3_REGION'] ?? 'us-east-1',
      bucket: required(env, 'ATLAS_S3_BUCKET'),
      accessKeyId: required(env, 'ATLAS_S3_ACCESS_KEY_ID'),
      secretAccessKey: required(env, 'ATLAS_S3_SECRET_ACCESS_KEY'),
      allowHttp: isDevelopment(env),
    });
  }
  if (kind.startsWith('file:')) {
    const root = kind.slice('file:'.length);
    if (!path.isAbsolute(root)) throw new ConfigError('ATLAS_STORAGE=file:<absolute directory>');
    return new FileObjectStore(root);
  }
  throw new ConfigError('ATLAS_STORAGE must be "s3" or "file:<absolute directory>"');
}

const FixtureSchema = z.array(
  z.strictObject({
    numericId: z.string().regex(/^[1-9]\d{0,19}$/),
    owner: z.string().regex(/^[A-Za-z0-9-]{1,39}$/),
    name: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
    defaultBranch: z.string().min(1).max(255),
    headOid: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    remotePath: z.string().refine((p) => path.isAbsolute(p), 'absolute path'),
    visibility: z.enum(['public', 'unavailable']),
  }),
).max(100);

/** Fixture repositories for authored demos and rehearsals (development only). */
export function loadFixtures(file: string): FixtureRepository[] {
  return FixtureSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

/**
 * GitHub (pinned, budgeted) in every deployment; the fixture resolver only with
 * ATLAS_DEVELOPMENT=1, so a misconfigured public service can never serve fixtures.
 */
export function resolverFromEnv(env: Env, pool: pg.Pool): RepositoryResolver {
  if (env['ATLAS_ACQUISITION'] === 'fixture') {
    if (!isDevelopment(env)) throw new ConfigError('ATLAS_ACQUISITION=fixture requires ATLAS_DEVELOPMENT=1');
    return new FixtureResolver(loadFixtures(required(env, 'ATLAS_FIXTURES')));
  }
  if (env['ATLAS_ACQUISITION'] !== undefined && env['ATLAS_ACQUISITION'] !== 'github') throw new ConfigError('ATLAS_ACQUISITION must be "github" or "fixture"');
  const token = secret(env, 'ATLAS_GITHUB_TOKEN');
  return new GithubResolver({ gate: new UpstreamGate(pool), ...(token ? { token } : {}) });
}
