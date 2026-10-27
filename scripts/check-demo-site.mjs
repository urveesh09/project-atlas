#!/usr/bin/env node
/**
 * Checks a built demo site (ADR-044) in Chromium before it is published. The site is served
 * from a sub-folder, as GitHub Pages serves it, and the check requires that:
 * - the page opens the bundled city, and a file from the table opens in the inspector;
 * - every request stays inside the site folder and succeeds;
 * - the page logs no errors.
 *
 *   node scripts/check-demo-site.mjs <site dir>
 *
 * Requires Playwright's Chromium: `pnpm --filter @atlas/web exec playwright install chromium`.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!site) throw new Error('Usage: node scripts/check-demo-site.mjs <site dir>');
const { chromium } = createRequire(path.join(root, 'apps/web/package.json'))('playwright');

/** The site's folder on the host, like https://<owner>.github.io/<repository>/. */
const BASE = '/atlas-demo/';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.woff2': 'font/woff2', '.gz': 'application/gzip' };

const server = createServer(async (request, response) => {
  const { pathname } = new URL(request.url ?? '/', 'http://localhost');
  const relative = pathname.startsWith(BASE) ? decodeURIComponent(pathname.slice(BASE.length)) || 'index.html' : null;
  const file = relative === null ? null : path.resolve(site, relative);
  const inside = file !== null && !path.relative(site, file).startsWith('..') && !path.isAbsolute(path.relative(site, file));
  const found = inside && (await stat(file).then((s) => s.isFile(), () => false));
  if (!found) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(response);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// GPU-less CI runners render with SwiftShader, as in the viewer journeys.
const browser = await chromium.launch({ args: process.env['CI'] ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [] });
const problems = [];
const summary = {};
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('response', (r) => r.status() >= 400 && problems.push(`HTTP ${r.status()} for ${r.url()}`));
  page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()} (${r.failure()?.errorText})`));
  page.on('pageerror', (error) => problems.push(`page error: ${String(error)}`));
  page.on('console', (message) => message.type() === 'error' && problems.push(`console error: ${message.text()}`));
  const started = Date.now();
  await page.goto(`${origin}${BASE}`);
  await page.waitForSelector('#overview-title', { timeout: 90_000 });
  summary.cityMs = Date.now() - started;
  summary.renderer = await page.locator('[data-city-renderer]').first().getAttribute('data-city-renderer');
  await page.getByLabel('View', { exact: true }).selectOption('table');
  const file = page.locator('.city-table tbody th button').first();
  summary.file = await file.innerText();
  await file.click();
  await page.waitForFunction((name) => document.querySelector('.inspector-path')?.textContent === name, summary.file, { timeout: 15_000 });
  summary.requests = requests.length;
  for (const url of new Set(requests)) if (!url.startsWith(`${origin}${BASE}`)) problems.push(`request outside the site folder: ${url}`);
} catch (error) {
  problems.push(`journey: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
} finally {
  await browser.close();
  server.close();
}
console.log(JSON.stringify({ site, ...summary, problems }, null, 1));
if (problems.length) process.exitCode = 1;
