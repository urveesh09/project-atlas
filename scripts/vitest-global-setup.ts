import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * Tests import package sources, but some behavior is only real in compiled form: parser
 * child processes and the atlas binary run from dist/. Build once (incrementally) so those
 * tests always exercise current code.
 */
export default function setup(): void {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  execFileSync(process.execPath, [tsc, '-b', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' });
}
