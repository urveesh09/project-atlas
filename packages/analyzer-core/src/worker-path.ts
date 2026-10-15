import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Absolute path of the compiled multi-language parser worker (ADR-060). When this module
 * runs from source (tests), the worker still executes from `dist/`, which the build
 * produces; it is never executed through a TypeScript loader.
 */
export function parserWorkerPath(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const base = path.basename(dir) === 'src' ? path.join(dir, '..', 'dist') : dir;
  return path.join(base, 'parse-worker.js');
}
