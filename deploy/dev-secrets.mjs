#!/usr/bin/env node
/**
 * Generate development secrets for deploy/compose.yaml: random values written to
 * deploy/secrets/* (mode 0600) and deploy/.env, both gitignored. Never reuse them outside
 * a loopback development stack. Existing files are kept unless --force is given.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, 'secrets');
const force = process.argv.includes('--force');
if (existsSync(path.join(here, '.env')) && !force) {
  console.error('deploy/.env exists; pass --force to regenerate (this invalidates the database volume).');
  process.exit(1);
}
mkdirSync(dir, { recursive: true, mode: 0o700 });
const value = () => randomBytes(24).toString('hex');
const owner = value();
const api = value();
const worker = value();
const storage = value();
const files = {
  postgres_password: owner,
  migration_url: `postgres://atlas_owner:${owner}@postgres:5432/atlas`,
  api_database_url: `postgres://atlas_api:${api}@postgres:5432/atlas`,
  api_role_password: api,
  worker_role_password: worker,
  quota_secret: randomBytes(32).toString('hex'),
  storage_secret: storage,
};
for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content, { mode: 0o600 });
writeFileSync(path.join(here, '.env'), `ATLAS_STORAGE_SECRET=${storage}\n`, { mode: 0o600 });
// The host worker connects through the published loopback port with its own role.
writeFileSync(path.join(dir, 'worker.env'), [
  `ATLAS_DATABASE_URL=postgres://atlas_worker:${worker}@127.0.0.1:55433/atlas`,
  'ATLAS_STORAGE=s3',
  'ATLAS_S3_ENDPOINT=http://127.0.0.1:7071',
  'ATLAS_S3_BUCKET=atlas-artifacts',
  'ATLAS_S3_ACCESS_KEY_ID=atlas',
  `ATLAS_S3_SECRET_ACCESS_KEY=${storage}`,
  'ATLAS_DEVELOPMENT=1',
  '',
].join('\n'), { mode: 0o600 });
console.log('Wrote deploy/secrets/* and deploy/.env. Worker settings: deploy/secrets/worker.env (add ATLAS_SANDBOX_IMAGE and ATLAS_WORK_ROOT).');
