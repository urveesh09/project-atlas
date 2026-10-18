import { ConfigError, PublicationStore, S3ObjectStore, databasePool, isDevelopment, migrate, migrationsCurrent, provisionRoles, required, resolverFromEnv, secret, storageFromEnv, type Env } from '@atlas/control';
import { startApi, startOperatorServer } from './server.js';
import { AdmissionStore } from './store.js';

/**
 * API process entrypoint (P5.6). The API admits jobs and serves verified publications; it
 * never acquires or analyzes repositories. Production requires an HTTPS public origin, a
 * quota secret of at least 32 bytes and current migrations (run `migrate` as a separate,
 * privileged release step: the runtime role cannot alter the schema).
 */
export const log = (event: string, fields: Record<string, string | number | boolean | null>) => {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), service: 'api', event, ...fields })}\n`);
};

export async function startApiFromEnv(env: Env) {
  const development = isDevelopment(env);
  const pool = databasePool({ ...env, ATLAS_PROCESS_NAME: 'atlas-api' }, 10);
  if (!(await migrationsCurrent(pool))) throw new ConfigError('Database migrations are not current; run the migration job first');
  const storage = storageFromEnv(env);
  // Development stores are created on demand; production buckets are provisioned by operators.
  if (development && storage instanceof S3ObjectStore && !(await storage.ready())) await storage.createBucketForDevelopment();
  const resolver = resolverFromEnv(env, pool);
  const publications = new PublicationStore(pool, storage, resolver);
  const store = new AdmissionStore(pool, { hourly: Number(env['ATLAS_HOURLY_JOBS'] ?? 5), queued: Number(env['ATLAS_QUEUED_JOBS'] ?? 20) });
  const origin = env['ATLAS_PUBLIC_ORIGIN'];
  if (!origin && !development) throw new ConfigError('ATLAS_PUBLIC_ORIGIN (https://...) is required outside development');
  const proxies = (env['ATLAS_TRUSTED_PROXIES'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const api = await startApi({
    store,
    quotaSecret: required(env, 'ATLAS_QUOTA_SECRET'),
    ...(origin ? { origin } : { developmentLoopback: true }),
    port: Number(env['ATLAS_PORT'] ?? 8080),
    host: env['ATLAS_LISTEN_HOST'] ?? '127.0.0.1',
    publications,
    storage,
    ...(env['ATLAS_WEB_ROOT'] ? { webRoot: env['ATLAS_WEB_ROOT'] } : {}),
    ...(proxies.length > 0 ? { trustedProxy: { addresses: proxies } } : {}),
    ...(env['ATLAS_DEMO_ANALYSIS_ID'] ? { demoAnalysisId: env['ATLAS_DEMO_ANALYSIS_ID'] } : {}),
  });
  const operator = env['ATLAS_OPERATOR_PORT'] ? await startOperatorServer({ pool, port: Number(env['ATLAS_OPERATOR_PORT']), publicationReads: api.publicationReads }) : null;
  // Hourly privacy sweep of sessions, admissions and client buckets (ADR-029).
  const sweep = setInterval(() => void store.sweepAdmissions().catch(() => log('api.sweep-failed', {})), 3_600_000);
  log('api.started', { origin: api.origin, development, operatorPort: operator?.port ?? null });
  return {
    api,
    close: async () => {
      clearInterval(sweep);
      await api.close();
      await operator?.close();
      await pool.end();
    },
  };
}

/** Release step: apply migrations with the schema-owner role (`ATLAS_MIGRATION_DATABASE_URL`). */
export async function migrateFromEnv(env: Env): Promise<void> {
  const url = secret(env, 'ATLAS_MIGRATION_DATABASE_URL') ?? required(env, 'ATLAS_DATABASE_URL');
  const pool = databasePool({ ...env, ATLAS_DATABASE_URL: url, ATLAS_PROCESS_NAME: 'atlas-migrate' }, 1);
  try {
    await migrate(pool);
    log('migrations.current', {});
    // Optional: (re)provision the least-privilege API and worker login roles (P5.6).
    const apiPassword = secret(env, 'ATLAS_API_ROLE_PASSWORD');
    const workerPassword = secret(env, 'ATLAS_WORKER_ROLE_PASSWORD');
    if (apiPassword || workerPassword) {
      if (!apiPassword || !workerPassword) throw new ConfigError('Provide both ATLAS_API_ROLE_PASSWORD and ATLAS_WORKER_ROLE_PASSWORD');
      await provisionRoles(pool, {
        schema: env['ATLAS_DATABASE_SCHEMA'] ?? 'public',
        api: { name: env['ATLAS_API_ROLE'] ?? 'atlas_api', password: apiPassword },
        worker: { name: env['ATLAS_WORKER_ROLE'] ?? 'atlas_worker', password: workerPassword },
      });
      log('roles.provisioned', {});
    }
  } finally {
    await pool.end();
  }
}
