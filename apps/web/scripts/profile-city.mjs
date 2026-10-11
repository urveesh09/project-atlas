#!/usr/bin/env node
/** Follow-up attribution of interaction long tasks; requires the benchmark's dense artifact. */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const { readArtifactDirectory } = await load('packages/artifact/dist/node-entry.js');
const { startViewerServer } = await load('packages/cli/dist/server/server.js');
const { SourceAttachment } = await load('packages/cli/dist/server/source.js');
const dir = path.join(root, '.atlas-tmp/phase3/10000');
const artifact = await readArtifactDirectory(dir);
if (!artifact.ok) throw new Error('Run the full city benchmark first');
const server = await startViewerServer({ artifactDir: dir, bundle: artifact.bundle,
  viewerDir: path.join(root, 'apps/web/dist'), source: SourceAttachment.none() });
let browser, context;
const records = [];
try {
  browser = await chromium.launch({ headless: true,
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=default'] });
  context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await context.request.get(server.sessionUrl);
  for (let run = 0; run < 20; run++) {
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.__atlasProfileTasks = [];
      new PerformanceObserver((list) => {
        window.__atlasProfileTasks.push(...list.getEntries().map((e) => ({ start: e.startTime, duration: e.duration })));
      }).observe({ type: 'longtask', buffered: true });
    });
    const url = new URL(server.url); url.searchParams.set('atlasBenchmark', '1');
    await page.goto(url.href);
    await page.waitForFunction(() => window.__atlasCity?.stats().drawCalls > 0, null, { timeout: 60000 });
    await page.evaluate(() => { window.__atlasProfileTasks.length = 0; });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
    await cdp.send('Profiler.start');
    const search = page.getByRole('combobox', { name: 'Search files, packages and declarations' });
    const query = `f${run % 20}.ts`;
    await search.fill(query);
    await page.waitForFunction((query) => document.querySelector('[role="option"][aria-selected="true"]')?.textContent.includes(query), query);
    await page.keyboard.press('Enter');
    await page.waitForFunction((query) => document.getElementById('inspector-title')?.textContent === query &&
      document.querySelector('[data-overlay-count]')?.getAttribute('data-overlay-ready') === 'true', query);
    await page.getByRole('button', { name: 'Reset city' }).click();
    await page.waitForFunction(() => !window.__atlasCity.stats().cameraMoving);
    await page.evaluate(() => window.__atlasCity.measureFrames(60));
    const { profile } = await cdp.send('Profiler.stop');
    const tasks = await page.evaluate(() => window.__atlasProfileTasks);
    const nodes = new Map(profile.nodes.map((n) => [n.id, n.callFrame]));
    const self = new Map();
    for (let i = 0; i < (profile.samples?.length ?? 0); i++) {
      const id = profile.samples[i]; self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0));
    }
    const top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([id, us]) => ({
      ...nodes.get(id), selfMs: +(us / 1000).toFixed(2),
    }));
    records.push({ run, query, tasks, top });
    // Preserve CPU samples only for a reproduced long task; sample times are relative to profile.startTime.
    if (tasks.length) writeFileSync(path.join(root, `docs/benchmarks/phase3-cpu-${run}.json`), JSON.stringify(profile));
    await cdp.detach(); await page.close();
  }
  writeFileSync(path.join(root, 'docs/benchmarks/phase3-interaction-profile.json'), JSON.stringify({
    recordedAt: new Date().toISOString(), chromium: browser.version(), runs: 20,
    fixtureCommit: artifact.bundle.graphs.at(-1).commitOid,
    note: 'CPU sampling adds overhead. These attribution traces supplement, not replace, the unprofiled 20-run latency report. Startup/import is excluded.', records,
  }, null, 2) + '\n');
  console.log(JSON.stringify({ runs: records.length, longTasks: records.flatMap((r) => r.tasks) }));

} finally {
  await context?.close(); await browser?.close(); await server.close();
}
