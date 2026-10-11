import { ConfigError } from '@atlas/control';
import { log, startWorker } from './main.js';

startWorker(process.env).catch((error: unknown) => {
  log('worker.fatal', { error: error instanceof ConfigError ? error.message : error instanceof Error ? error.name : 'unknown' });
  process.exit(1);
});
