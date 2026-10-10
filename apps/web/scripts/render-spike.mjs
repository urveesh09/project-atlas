#!/usr/bin/env node
/**
 * P0.4 rendering spike harness. Serves the built viewer on loopback, drives Chromium
 * through Playwright and records frame times, draw calls, heap, pick correctness and
 * context-loss fallback. Writes docs/benchmarks/phase0-render-spike.{json,md}.
 *
 * Usage: pnpm spike:render   (builds first)   [--headed] [--runs N]
 */
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../dist');
const outDir = path.resolve(here, '../../../docs/benchmarks');
const args = new Set(process.argv.slice(2));
const runsArg = process.argv.indexOf('--runs');
const RUNS = runsArg > -1 ? Number(process.argv[runsArg + 1]) : 20;

if (!existsSync(path.join(dist, 'spike.html'))) {
  console.error('Build the viewer first: pnpm --filter @atlas/web build');
  process.exit(1);
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' };
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const file = path.resolve(dist, `.${decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
};

const browser = await chromium.launch({
  headless: !args.has('--headed'),
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=default', '--enable-precise-memory-info'],
});
const report = {
  task: 'P0.4',
  recordedAt: new Date().toISOString(),
  environment: {
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    cpuCount: os.cpus().length,
    memoryGiB: +(os.totalmem() / 2 ** 30).toFixed(1),
    node: process.version,
    browser: `chromium ${browser.version()}`,
    headless: !args.has('--headed'),
    viewport: '1920x1080',
    deviceScaleFactor: 1,
  },
  scenarios: [],
};

async function open(query) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/spike.html?${query}`);
  await page.waitForFunction(() => window.__atlasSpike?.ready === true, null, { timeout: 60_000 });
  return { page, errors };
}

for (const n of [3_000, 10_000, 20_000]) {
  const { page, errors } = await open(`n=${n}`);
  await page.evaluate(() => window.__atlasSpike.measureFrames(30)); // warm-up
  const frameTimes = [];
  for (let run = 0; run < RUNS; run++) frameTimes.push(...(await page.evaluate(() => window.__atlasSpike.measureFrames(60))));
  const stats = await page.evaluate(() => window.__atlasSpike.stats());
  report.environment.renderer ??= stats.renderer;
  report.scenarios.push({
    name: `orbit-${n}`,
    files: stats.fileCount,
    districts: stats.districtCount,
    layoutMs: +stats.layoutMs.toFixed(1),
    drawCalls: stats.drawCalls,
    triangles: stats.triangles,
    frameSamples: frameTimes.length,
    frameMsP50: +percentile(frameTimes, 50).toFixed(2),
    frameMsP95: +percentile(frameTimes, 95).toFixed(2),
    heapUsedMiB: stats.heapUsedBytes === null ? null : +(stats.heapUsedBytes / 2 ** 20).toFixed(1),
    pageErrors: errors,
  });
  await page.close();
}

// Pick correctness: top-down orthographic view, every sampled building's roof center
// must pick exactly that building's lineage ID.
{
  const { page, errors } = await open('n=10000&view=top');
  const result = await page.evaluate(() => {
    const spike = window.__atlasSpike;
    const total = spike.stats().fileCount;
    let correct = 0;
    let sampled = 0;
    const failures = [];
    for (let i = 0; i < total; i += 37) {
      const p = spike.screenPointOf(i);
      if (!p || p.x < 0 || p.y < 60 || p.x > innerWidth || p.y > innerHeight) continue;
      sampled++;
      const picked = spike.pickAt(p.x, p.y);
      if (picked === spike.lineageAt(i)) correct++;
      else if (failures.length < 5) failures.push({ index: i, picked });
    }
    return { sampled, correct, failures };
  });
  report.pick = { ...result, pageErrors: errors };
  await page.close();
}

// Fallbacks: WebGL unavailable and context loss both keep the data reachable as HTML.
{
  const { page } = await open('n=2000&nowebgl=1');
  report.fallbackNoWebgl = await page.evaluate(() => window.__atlasSpike.fallbackVisible());
  await page.close();
  const second = await open('n=2000');
  const lost = await second.page.evaluate(() => window.__atlasSpike.loseContext());
  await second.page.waitForSelector('[data-testid="fallback"]', { timeout: 10_000 }).catch(() => null);
  report.fallbackContextLoss = lost && (await second.page.evaluate(() => window.__atlasSpike.fallbackVisible()));
  await second.page.close();
}

await browser.close();
server.close();

mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'phase0-render-spike.json'), `${JSON.stringify(report, null, 2)}\n`);
const lines = [
  '# Phase 0 rendering spike (P0.4)',
  '',
  `Recorded ${report.recordedAt} by \`pnpm spike:render\`. Synthetic city; ${RUNS} runs × 60 orbit frames per scenario after warm-up.`,
  '',
  '## Environment',
  '',
  ...Object.entries(report.environment).map(([k, v]) => `- **${k}:** ${v}`),
  '',
  '## Continuous camera movement',
  '',
  '| Scenario | Files | Districts | Layout ms | Draw calls | Triangles | Frame p50 ms | Frame p95 ms | JS heap MiB |',
  '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
  ...report.scenarios.map((s) => `| ${s.name} | ${s.files} | ${s.districts} | ${s.layoutMs} | ${s.drawCalls} | ${s.triangles} | ${s.frameMsP50} | ${s.frameMsP95} | ${s.heapUsedMiB ?? 'n/a'} |`),
  '',
  '## Picking and fallback',
  '',
  `- Top-down pick correctness: **${report.pick.correct}/${report.pick.sampled}** sampled buildings returned their own lineage ID.`,
  `- WebGL unavailable → HTML fallback shown: **${report.fallbackNoWebgl}**`,
  `- Context loss (WEBGL_lose_context) → HTML fallback shown: **${report.fallbackContextLoss}**`,
  '',
  '## Interpretation',
  '',
  'These are spike measurements, not release benchmarks. Section 15 budgets are validated on the',
  'recorded reference device in P3.6/P6.2. If `renderer` names SwiftShader or another software',
  'rasterizer, frame times reflect CPU rendering and are a pessimistic bound.',
  '',
];
writeFileSync(path.join(outDir, 'phase0-render-spike.md'), lines.join('\n'));
console.log(JSON.stringify({ scenarios: report.scenarios, pick: report.pick, renderer: report.environment.renderer, fallbackNoWebgl: report.fallbackNoWebgl, fallbackContextLoss: report.fallbackContextLoss }, null, 2));
