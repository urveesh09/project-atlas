#!/usr/bin/env node
/**
 * Snapshot-change latency in the production viewer (plan §15.2: "snapshot change after
 * graph cached <= 250 ms p95"; §15.3 bounded adjacent-frame cache; §16.4 no monotonic
 * leak across repeated frame changes). Serves a real history artifact through the
 * loopback server and measures, in the page, from the click on a snapshot until the strip
 * marks it current and the renderer shows that frame's buildings.
 *
 *   node scripts/bench-history.mjs --runs 1 --keep .atlas-tmp/medium-history
 *   node apps/web/scripts/bench-history-viewer.mjs --artifact .atlas-tmp/medium-history [--runs 20]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const { verifyArtifactDirectory } = await load('packages/artifact/dist/node-entry.js');
const { startViewerServer } = await load('packages/cli/dist/server/server.js');
const { SourceAttachment } = await load('packages/cli/dist/server/source.js');
const { viewerDirectory } = await load('packages/cli/dist/commands/serve.js');
const at = process.argv.indexOf('--artifact');
if (at < 0) throw new Error('--artifact <dir> is required');
const dir = path.resolve(process.argv[at + 1]);
const runs = process.argv.includes('--runs') ? Number(process.argv[process.argv.indexOf('--runs') + 1]) : 20;
console.error('Verifying every historical frame before measurement…');

const verified = await verifyArtifactDirectory(dir);
if (!verified.ok) throw new Error(`invalid artifact: ${verified.issues[0]?.code}`);
const manifest = verified.opened.manifest;
const counts = verified.opened.layout.frameState.map((f) => f.files.length);
const server = await startViewerServer({ artifactDir: dir, bundle: verified.opened, viewerDir: viewerDirectory(), source: SourceAttachment.none() });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
// The single-use session link signs this context in; the probe flag goes on the viewer URL.
await page.goto(server.sessionUrl);
const url = new URL(server.url);
url.searchParams.set('atlasBenchmark', '1');
await page.goto(url.href);
await page.waitForSelector('.timeline-strip', { timeout: 120_000 }).catch(async (e) => { console.error((await page.locator('body').innerText()).slice(0, 1500)); throw e; });
await page.waitForFunction(() => !!window.__atlasCity, undefined, { timeout: 120_000 });

/** Click snapshot i (0-based) and resolve with the in-page latency to its first drawn frame. */
const switchTo = (i) =>
  page.evaluate(
    async ({ i, expected }) => {
      const buttons = document.querySelectorAll('.timeline-frame');
      const t0 = performance.now();
      buttons[i].click();
      const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
      for (;;) {
        await frame();
        if (buttons[i].getAttribute('aria-current') === 'step' && window.__atlasCity?.stats().buildings === expected) break;
        if (performance.now() - t0 > 30_000) throw new Error('snapshot change did not complete');
      }
      await frame(); // the frame that shows it
      return performance.now() - t0;
    },
    { i, expected: counts[i] },
  );

async function viewerHeap(context, page, server) {
  const main = await context.newCDPSession(page),
    rootSession = await browser.newBrowserCDPSession();
  const mainBefore = await main.send('Runtime.getHeapUsage');
  await main.send('HeapProfiler.collectGarbage');
  const mainAfter = await main.send('Runtime.getHeapUsage');
  const workers = [];
  try {
    const { targetInfos } = await rootSession.send('Target.getTargets');
    for (const target of targetInfos.filter((t) => t.type === 'worker' && t.url.startsWith(server.url))) {
      const { sessionId } = await rootSession.send('Target.attachToTarget', {
        targetId: target.targetId,
        flatten: false,
      });
      let serial = 0;
      const query = (method) =>
        new Promise((resolve, reject) => {
          const id = ++serial;
          const cleanup = () => {
            clearTimeout(timer);
            rootSession.off('Target.receivedMessageFromTarget', receive);
          };
          const receive = (event) => {
            if (event.sessionId !== sessionId) return;
            const message = JSON.parse(event.message);
            if (message.id !== id) return;
            cleanup();
            if (message.error) reject(new Error(message.error.message));
            else resolve(message.result);
          };
          const timer = setTimeout(() => {
            cleanup();
            reject(new Error('Worker heap measurement timed out'));
          }, 5000);
          rootSession.on('Target.receivedMessageFromTarget', receive);
          rootSession
            .send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params: {} }) })
            .catch((error) => {
              cleanup();
              reject(error);
            });
        });
      try {
        const before = await query('Runtime.getHeapUsage');
        await query('HeapProfiler.collectGarbage');
        const after = await query('Runtime.getHeapUsage');
        workers.push({ beforeBytes: before.usedSize, retainedBytes: after.usedSize });
      } finally {
        await rootSession.send('Target.detachFromTarget', { sessionId });
      }
    }
  } finally {
    await main.detach();
    await rootSession.detach();
  }
  return {
    mainBeforeBytes: mainBefore.usedSize,
    mainRetainedBytes: mainAfter.usedSize,
    workers,
    beforeMiB: +((mainBefore.usedSize + workers.reduce((n, w) => n + w.beforeBytes, 0)) / 2 ** 20).toFixed(2),
    retainedMiB: +((mainAfter.usedSize + workers.reduce((n, w) => n + w.retainedBytes, 0)) / 2 ** 20).toFixed(2),
  };
}

const n = manifest.frames.length;
console.error(`Measuring ${n} snapshots in the production viewer…`);
// Stepping back with 1.5 s to look at each snapshot: the idle prefetch has decoded it.
const stepped = [];
for (let i = n - 2; i >= 0; i--) {
  await page.evaluate(() => new Promise((r) => setTimeout(r, 1500)));
  stepped.push(await switchTo(i));
}
// Worst case: jumping straight to snapshots never visited, with no pause (fresh page).
await page.reload();
await page.waitForSelector('.timeline-strip', { timeout: 120_000 });
await page.waitForFunction(() => !!window.__atlasCity, undefined, { timeout: 120_000 });
const cold = [];
for (let i = 0; i < n - 1; i++) cold.push(await switchTo(i));
// Cached: alternate between the selected commit and its neighbour (both kept decoded).
const cached = [];
await switchTo(n - 1);
await switchTo(n - 2);
for (let r = 0; r < runs; r++) cached.push(await switchTo(r % 2 === 0 ? n - 1 : n - 2));
// Repeated full sweeps: retained heap must stabilise (bounded LRU, no leak).
const sweepHeap = [];
for (let s = 0; s < 4; s++) {
  for (let i = 0; i < n; i++) await switchTo(i);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 200)));
  sweepHeap.push(await viewerHeap(page.context(), page, server));
  console.error(`Heap sweep ${s + 1}: ${sweepHeap.at(-1).retainedMiB} MiB retained (main + worker)`);
}
const stats = await page.evaluate(() => window.__atlasCity.stats());
console.error(JSON.stringify({ cached, stepped, cold, sweepHeap }));
await switchTo(n - 1);
await page.getByRole('button', { name: 'Compare snapshots…' }).click();
await page.waitForFunction(() => document.querySelector('.compare-summary') !== null);
await page.locator('.compare-pick select').first().selectOption('0');
await page.waitForFunction(() => document.querySelector('.compare-pick select')?.value === '0' && document.querySelector('.compare-summary') !== null, undefined, { timeout: 120_000 });
await page.locator('.compare-pick select').last().selectOption(String(n - 2));
await page.waitForFunction(({ n }) => document.querySelectorAll('.compare-pick select')[1]?.value === String(n - 2) && document.querySelector('.compare-summary') !== null, { n }, { timeout: 120_000 }).catch(async (error) => {
  console.error((await page.locator('body').innerText()).slice(-4000));
  throw error;
});
const comparisonHeap = await viewerHeap(page.context(), page, server);
await page.screenshot({ path: path.join(root, 'docs/images/phase4-compare.png'), fullPage: true });
await page.getByRole('button', { name: 'Close comparison' }).first().click();
for (const lens of ['churn', 'hotspot']) {
  await page.getByLabel('Lens', { exact: true }).selectOption(lens);
  await page.screenshot({ path: path.join(root, `docs/images/phase4-${lens}.png`), fullPage: true });
}
await browser.close();
await server.close();

const sorted = (a) => [...a].sort((x, y) => x - y);
const summary = (a) => ({ samples: a.length, p50: +sorted(a)[Math.floor(a.length / 2)].toFixed(1), p95: +sorted(a)[Math.ceil(a.length * 0.95) - 1].toFixed(1), max: +Math.max(...a).toFixed(1) });
const report = {
  task: 'Gate G4 — snapshot change in the production viewer',
  recordedAt: new Date().toISOString(),
  environment: { os: `${os.type()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model, node: process.version, browser: 'Chromium (Playwright)', viewport: '1920x1080', renderer: stats.renderer },
  artifact: { frames: n, filesAtHead: counts.at(-1), edgesAtHead: manifest.frames.at(-1).edgeCount, compressedBytes: verified.summary.stats.compressedBytes, analyzer: manifest.analyzer, selectedCommit: manifest.selectedCommit.oid, analysisId: manifest.analysisId, layoutSha256: manifest.layoutChunk.sha256 },
  cachedChangeMs: summary(cached),
  steppedChangeMs: summary(stepped),
  coldChangeMs: summary(cold),
  budgetCachedP95Ms: 250,
  drawCallsAfter: stats.drawCalls,
  heapAfterSweeps: sweepHeap,
  comparisonHeap,
  errors,
  rawSamples: { cached, stepped, cold },
};
report.pass = report.cachedChangeMs.p95 <= report.budgetCachedP95Ms && [...sweepHeap, comparisonHeap].every((h) => h.workers.length === 1 && h.retainedMiB <= 300) && errors.length === 0;
const out = path.join(root, 'docs/benchmarks');
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, 'phase4-history-viewer.json'), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(
  path.join(out, 'phase4-history-viewer.md'),
  [
    '# Phase 4 snapshot-change benchmark (Gate G4)',
    '',
    `Recorded ${report.recordedAt} by \`node apps/web/scripts/bench-history-viewer.mjs\` against the medium history artifact from \`scripts/bench-history.mjs --keep\` (${n} frames, ${report.artifact.filesAtHead.toLocaleString('en-US')} files and ${report.artifact.edgesAtHead.toLocaleString('en-US')} edges at the selected commit). Latency is measured in the page from the click on a snapshot to the drawn frame showing its buildings.`,
    '',
    `Environment: ${report.environment.os}; ${report.environment.cpu}; ${report.environment.browser} at ${report.environment.viewport}; GPU ${report.environment.renderer}.`,
    '',
    '| Measure | p50 | p95 | max | Budget |',
    '|---|---:|---:|---:|---:|',
    `| Snapshot change, frame cached (${report.cachedChangeMs.samples}) | ${report.cachedChangeMs.p50} ms | ${report.cachedChangeMs.p95} ms | ${report.cachedChangeMs.max} ms | ≤ 250 ms p95 |`,
    `| Stepping back with 1.5 s per snapshot, idle prefetch (${report.steppedChangeMs.samples}) | ${report.steppedChangeMs.p50} ms | ${report.steppedChangeMs.p95} ms | ${report.steppedChangeMs.max} ms | (reported) |`,
    `| Worst case: jump to unvisited snapshots, no pause — worker decode + validate (${report.coldChangeMs.samples}) | ${report.coldChangeMs.p50} ms | ${report.coldChangeMs.p95} ms | ${report.coldChangeMs.max} ms | (reported) |`,
    '',
    `Combined main + owned worker retained JS heap after collection after each of four full sweeps over all snapshots: ${sweepHeap.map((h) => `${h.retainedMiB} MiB`).join(' → ')} (bounded LRU: the selected commit plus at most two other frames per realm). Draw calls after the sweeps: ${stats.drawCalls}.`,
    '',
    `Pre-collection combined JS allocations: ${sweepHeap.map((h) => `${h.beforeMiB} MiB`).join(' → ')}. Not a startup/RSS peak guarantee. The decode-chain cache is request-scoped; the caller owns retained frames.`,
    `Comparison of two non-HEAD snapshots: ${comparisonHeap.retainedMiB} MiB retained main + owned worker (${comparisonHeap.beforeMiB} MiB before collection).`,
    `**${report.pass ? 'Pass' : 'Fail'}.** Page errors: ${errors.length}. This machine is not the plan's reference integrated-GPU laptop; the reference-device repeat remains a release audit.`,
    '',
  ].join('\n'),
);
console.log(JSON.stringify(report, null, 2));
if (!report.pass) process.exitCode = 1;
