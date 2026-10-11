import { ConfigError } from '@atlas/control';
import { log, migrateFromEnv, startApiFromEnv } from './main.js';

const command = process.argv[2] ?? 'serve';
const run = command === 'migrate' ? migrateFromEnv(process.env) : command === 'serve' ? startApiFromEnv(process.env).then((running) => {
  const stop = () => void running.close().then(() => process.exit(0));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}) : Promise.reject(new ConfigError('Usage: atlas-api [serve|migrate]'));

run.catch((error: unknown) => {
  log('api.fatal', { error: error instanceof ConfigError ? error.message : error instanceof Error ? error.name : 'unknown' });
  process.exit(1);
});
