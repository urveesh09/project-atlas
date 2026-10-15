#!/usr/bin/env node
/**
 * Builds the static demo site (ADR-044): the viewer, built to open a bundled artifact from a
 * relative `demo/` folder, plus that artifact after `atlas verify` accepts it. The output is
 * plain files for any static host (GitHub Pages). Nothing is uploaded by this script.
 *
 *   node scripts/build-demo-site.mjs --artifact <artifact dir> --out <site dir> [--site-url <https url>]
 *
 * With --site-url, the page also names its public address (ADR-058): a canonical link, an
 * absolute social card for link previews, and SoftwareApplication structured data.
 *
 * Requires `pnpm build` first (it runs the compiled CLI to verify the artifact).
 */
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
const siteUrlIndex = process.argv.indexOf('--site-url');
const siteUrl = siteUrlIndex < 0 ? null : new URL(process.argv[siteUrlIndex + 1] ?? '');
if (siteUrl && (siteUrl.protocol !== 'https:' || !siteUrl.pathname.endsWith('/') || siteUrl.search || siteUrl.hash))
  throw new Error('--site-url must be an https URL of the site folder, ending in /');
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
if (siteUrl) {
  // The social card is the viewer's own render of the demo city (apps/web/src/assets).
  await cp(path.join(web, 'src/assets/social-card.jpg'), path.join(out, 'social-card.jpg'));
  const escape = (text) => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  const page = siteUrl.href;
  const card = new URL('social-card.jpg', siteUrl).href;
  const description = 'See a Git repository as a 3D city: one building per file, with dependencies, history and the evidence behind every number. Analyzed code is never run.';
  const data = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'ATLAS',
    description,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Windows, macOS, Linux',
    isAccessibleForFree: true,
    license: 'https://opensource.org/licenses/MIT',
    url: page,
    image: card,
  };
  const head = [
    `<link rel="canonical" href="${escape(page)}" />`,
    `<meta property="og:url" content="${escape(page)}" />`,
    `<meta property="og:image" content="${escape(card)}" />`,
    '<meta property="og:image:width" content="1200" />',
    '<meta property="og:image:height" content="630" />',
    '<meta property="og:image:alt" content="The vuejs/core repository drawn as an ATLAS city." />',
    `<meta name="twitter:image" content="${escape(card)}" />`,
    `<script type="application/ld+json">${JSON.stringify(data).replaceAll('<', '\\u003c')}</script>`,
  ].join('\n    ');
  const index = path.join(out, 'index.html');
  const html = await readFile(index, 'utf8');
  if (!html.includes('</head>')) throw new Error('index.html has no </head>');
  await writeFile(index, html.replace('</head>', `  ${head}\n  </head>`));
}
const files = (await readdir(path.join(out, 'demo'), { recursive: true })).length;
console.log(JSON.stringify({ out, demoFiles: files }));
