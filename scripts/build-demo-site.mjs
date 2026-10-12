#!/usr/bin/env node
/**
 * Builds the static demo site (ADR-044): the viewer, built to open a bundled artifact from a
 * relative `demo/` folder, plus that artifact after `atlas verify` accepts it. The output is
 * plain files for any static host (GitHub Pages). Nothing is uploaded by this script.
 *
 *   node scripts/build-demo-site.mjs --artifact <artifact dir> --out <site dir>
 *
 * Requires `pnpm build` first (it runs the compiled CLI to verify the artifact).
 */
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`Missing ${name} <dir>`);
  return path.resolve(process.argv[i + 1]);
};
const artifact = arg('--artifact');
const out = arg('--out');
const relative = path.relative(root, out);
const insideRepo = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
if (insideRepo && !relative.startsWith(`.atlas-tmp${path.sep}`))
  throw new Error('Write the demo site outside the source tree or below .atlas-tmp/');

// The artifact must pass full verification before it is published anywhere.
execFileSync(process.execPath, [path.join(root, 'packages/cli/bin/atlas.js'), 'verify', artifact], { cwd: root, stdio: 'inherit' });

await rm(out, { recursive: true, force: true });
// Run the viewer's own pinned Vite directly (no shell), with the demo base set.
const web = path.join(root, 'apps/web');
const vite = path.join(path.dirname(createRequire(path.join(web, 'package.json')).resolve('vite/package.json')), 'bin/vite.js');
execFileSync(process.execPath, [vite, 'build', '--outDir', out, '--emptyOutDir'], {
  cwd: web,
  stdio: 'inherit',
  env: { ...process.env, VITE_ATLAS_DEMO_BASE: 'demo/' },
});
await mkdir(path.join(out, 'demo'), { recursive: true });
await cp(artifact, path.join(out, 'demo'), { recursive: true });
// GitHub Pages: serve files as they are (no Jekyll processing of names).
await writeFile(path.join(out, '.nojekyll'), '');
const files = (await readdir(path.join(out, 'demo'), { recursive: true })).length;
console.log(JSON.stringify({ out, demoFiles: files }));
