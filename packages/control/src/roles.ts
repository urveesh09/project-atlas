import type { Pool } from 'pg';

/**
 * Least-privilege database roles (P5.6). Migrations run as the schema owner; the API and
 * worker run as separate login roles with row-level DML on exactly the tables they use and
 * no DDL, TRUNCATE or ownership. A compromised API process cannot publish an artifact; a
 * compromised worker cannot mint sessions or admissions.
 */
type Privilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
export const ROLE_GRANTS: Readonly<Record<'api' | 'worker', Readonly<Record<string, readonly Privilege[]>>>> = Object.freeze({
  api: {
    atlas_migrations: ['SELECT'],
    // UPDATE only because admission locks the session row (SELECT ... FOR SHARE).
    sessions: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    admissions: ['SELECT', 'INSERT', 'DELETE'],
    jobs: ['SELECT', 'INSERT', 'UPDATE'],
    job_events: ['SELECT', 'INSERT', 'DELETE'],
    // Visibility refresh and revocation, owner deletion and the purge it triggers.
    repositories: ['SELECT', 'UPDATE'],
    publications: ['SELECT', 'UPDATE'],
    artifact_objects: ['SELECT', 'UPDATE'],
    uploads: ['SELECT', 'UPDATE'],
    upstream_budgets: ['SELECT', 'INSERT', 'UPDATE'],
  },
  worker: {
    atlas_migrations: ['SELECT'],
    jobs: ['SELECT', 'UPDATE'],
    job_events: ['SELECT', 'INSERT', 'DELETE'],
    repositories: ['SELECT', 'INSERT', 'UPDATE'],
    publications: ['SELECT', 'INSERT', 'UPDATE'],
    artifact_objects: ['SELECT', 'INSERT', 'UPDATE'],
    uploads: ['SELECT', 'INSERT', 'UPDATE'],
    job_checkpoints: ['SELECT', 'INSERT', 'UPDATE'],
    upstream_budgets: ['SELECT', 'INSERT', 'UPDATE'],
  },
});

/**
 * Functions a role may execute. The worker's retention sweep runs a schema-owned function
 * (ADR-078) instead of holding DELETE on jobs, publications or admissions.
 */
export const ROLE_FUNCTIONS: Readonly<Record<'api' | 'worker', readonly string[]>> = Object.freeze({
  api: [],
  worker: ['atlas_forget_ended_jobs(integer)'],
});

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const quote = (identifier: string) => {
  if (!IDENTIFIER.test(identifier)) throw new Error('Invalid SQL identifier');
  return `"${identifier}"`;
};

/**
 * Create or update the two login roles and reset their grants on `schema`. Idempotent;
 * rerun after every migration that adds a table. Passwords are passed as parameters to a
 * server-side format() call, never interpolated by this process.
 */
export async function provisionRoles(pool: Pool, input: { schema: string; api: { name: string; password: string }; worker: { name: string; password: string } }): Promise<void> {
  const schema = quote(input.schema);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [kind, role] of [['api', input.api], ['worker', input.worker]] as const) {
      const name = quote(role.name);
      if (role.password.length < 24) throw new Error('Role passwords must have at least 24 characters');
      const exists = (await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role.name])).rowCount;
      const verb = exists ? 'ALTER' : 'CREATE';
      const statement = (await client.query<{ sql: string }>(`SELECT format('${verb} ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 32 PASSWORD %L', $1::text, $2::text) AS sql`, [role.name, role.password])).rows[0]!.sql;
      await client.query(statement);
      await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM ${name}`);
      await client.query(`REVOKE CREATE ON SCHEMA ${schema} FROM ${name}`);
      await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${name}`);
      for (const [table, privileges] of Object.entries(ROLE_GRANTS[kind])) {
        await client.query(`GRANT ${privileges.join(', ')} ON ${schema}.${quote(table)} TO ${name}`);
      }
      await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${schema} FROM ${name}`);
      for (const signature of ROLE_FUNCTIONS[kind]) await client.query(`GRANT EXECUTE ON FUNCTION ${schema}.${signature} TO ${name}`);
      await client.query(`ALTER ROLE ${name} SET search_path TO ${schema}`);
      await client.query(`ALTER ROLE ${name} SET statement_timeout TO '15s'`);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
