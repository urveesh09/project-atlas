#!/usr/bin/env node
/** Production Phase 3 gate: real committed repositories → analyzer → validated viewer. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, firefox } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const { createGitFixture } = await load('packages/test-fixtures/dist/index.js');
const { openLocalRepository, resolveLocalCommit, gitVersion } = await load('packages/ingest/dist/index.js');
const { analyzeCommit, ParserPool } = await load('packages/analyzer-core/dist/index.js');
const { packArtifact, gzipDeterministic, writeArtifactDirectory } = await load('packages/artifact/dist/node-entry.js');
const { localRepositoryId, lineageId, validateLayoutArtifact } = await load('packages/schema/dist/index.js');
const { computeLayout } = await load('packages/layout/dist/index.js');
const { startViewerServer } = await load('packages/cli/dist/server/server.js');
const { SourceAttachment } = await load('packages/cli/dist/server/source.js');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : Number(process.argv[i + 1]);
};
const runs = arg('runs', 20),
  coldRuns = arg('cold-runs', 20);
if (!Number.isInteger(runs) || runs < 1 || runs > 100 || !Number.isInteger(coldRuns) || coldRuns < 1 || coldRuns > 100)
  throw new Error('Runs must be between 1 and 100');
const sizes = process.argv.includes('--files') ? [arg('files', 300)] : [300, 3000, 10000];
const out = path.join(root, 'docs/benchmarks'),
  images = path.join(root, 'docs/images');
mkdirSync(out, { recursive: true });
mkdirSync(images, { recursive: true });
const p95 = (a) => [...a].sort((a, b) => a - b)[Math.ceil(a.length * 0.95) - 1];
const summary = (a) => ({
  samples: a.length,
  p50: +[...a].sort((a, b) => a - b)[Math.floor(a.length / 2)].toFixed(2),
  p95: +p95(a).toFixed(2),
  max: +Math.max(...a).toFixed(2),
});
const reportOnly = process.argv.includes('--report-only');
const report = reportOnly ? JSON.parse(readFileSync(path.join(out, 'phase3-city.json'), 'utf8')) : {
  task: 'P3.1–P3.6',
  recordedAt: new Date().toISOString(),
  environment: {
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0].model,
    logicalCpus: os.cpus().length,
    memoryGiB: +(os.totalmem() / 2 ** 30).toFixed(1),
    node: process.version,
    viewport: '1920x1080',
    dpr: 1,
    parserWorkers: 2,
  },
  layout: null,
  scenarios: [],
  coldRoute: null,
  firefox: null,
  limitations: [
    "Recorded actual GPU is not asserted to be the plan's exact integrated-GPU reference device.",
    'Heap measurements include the main realm and the owned dedicated worker. Both pre-GC and retained post-GC heap are reported; the 300 MiB active-data gate uses retained heap. Native GPU memory and process RSS are outside JS heap.',
    'Automated AA and keyboard/touch checks do not replace a human screen-reader audit.',
  ],
};
if (reportOnly) {
  writeReport();
  process.exit(report.pass ? 0 : 1);
}

// Same production packer; 20 independent repetitions of a 20k temporal-union geometry.
const repoId = localRepositoryId('3f2a9c4e-8b1d-4f6a-9c2e-7d5b1a0e4c3f');
const layoutInput = {
  repoId,
  frameKey: 'phase3-union',
  externals: [],
  root: {
    kind: 'repository',
    path: '',
    files: [],
    children: Array.from({ length: 20 }, (_, p) => ({
      kind: 'package',
      path: `packages/p${p}`,
      files: [],
      children: Array.from({ length: 20 }, (_, d) => ({
        kind: 'directory',
        path: `packages/p${p}/d${d}`,
        children: [],
        files: Array.from({ length: 50 }, (_, f) =>
          lineageId(repoId, '0'.repeat(40), '0'.repeat(40), `packages/p${p}/d${d}/f${f}.ts`),
        ),
      })),
    })),
  },
};
computeLayout(layoutInput);
const layoutTimes = [];
let geometry;
for (let i = 0; i < runs; i++) {
  const start = performance.now();
  geometry = computeLayout(layoutInput);
  layoutTimes.push(performance.now() - start);
}
if (!validateLayoutArtifact({ ...geometry, frameState: [] }).ok || geometry.plots.length !== 20000)
  throw new Error('Union geometry failed validation');
report.layout = { plots: 20000, ms: summary(layoutTimes), measurementsMs: layoutTimes, pass: p95(layoutTimes) <= 2000 };

const browser = await chromium.launch({
  headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=default', '--enable-precise-memory-info'],
});
report.environment.chromium = browser.version();
function fixtureFiles(total) {
  const counts = Array.from({ length: 5 }, (_, p) => Math.floor((total - 12) / 5) + (p < (total - 12) % 5 ? 1 : 0));
  const files = {
    'package.json': JSON.stringify({ name: `atlas-city-${total}`, private: true, workspaces: ['packages/*'] }),
    'tsconfig.json': JSON.stringify({
      compilerOptions: { module: 'esnext', moduleResolution: 'bundler', strict: true },
      include: ['packages'],
    }),
  };
  let trim = total === 10000 ? 110 : 0;
  for (let p = 0; p < 5; p++) {
    files[`packages/p${p}/package.json`] = JSON.stringify({ name: `@city/p${p}`, exports: { '.': './src/index.ts' } });
    files[`packages/p${p}/src/index.ts`] = "export { run } from './d0/f0';\n";
    for (let i = 0; i < counts[p]; i++) {
      const lines = [],
        count = p === 0 && i === 0 ? Math.min(210, counts[p] - 1) : trim > 0 ? (trim--, 9) : 10;
      for (let k = 0; k < count; k++) {
        let j = p === 0 && i === 0 ? k + 1 : (i + 13 + k * 97) % counts[p];
        const targetPackage = k === 1 && count <= 10 ? (p + 1) % 5 : p;
        j %= counts[targetPackage];
        const specifier =
          targetPackage === p ? `../d${j % 12}/f${j}` : `../../../p${targetPackage}/src/d${j % 12}/f${j}`;
        if (k === 2 && count <= 10) lines.push(`import type { Value as V${k} } from '${specifier}';`);
        else if (k === 3 && count <= 10) lines.push(`const lazy${k} = () => import('${specifier}');`);
        else lines.push(total === 10000 ? `import '${specifier}';` : `import { run as r${k} } from '${specifier}';`);
      }
      lines.push('export interface Value { count: number }', 'export function run(x: number): number {');
      // Keep the normal large fixture inside the 100 MiB decoded-chunk cap while retaining a measured complexity distribution.
      const branchCount = total === 10000 ? (i % 100 === 0 ? 24 : i % 7) : i % 25;
      for (let branch = 0; branch < branchCount; branch++)
        lines.push(`  if (x > ${branch} && x < ${branch + 50}) return ${branch};`);
      lines.push('  return x;', '}');
      files[`packages/p${p}/src/d${i % 12}/f${i}.ts`] = `${lines.join('\n')}\n`;
    }
  }
  if (Object.keys(files).length !== total) throw new Error('Fixture file count mismatch');
  return files;
}

async function open(context, server, mode = '3d', errors = []) {
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.__atlasLongTasks = [];
    new PerformanceObserver((list) =>
      window.__atlasLongTasks.push(...list.getEntries().map((e) => e.duration)),
    ).observe({ type: 'longtask', buffered: true });
  });
  const url = new URL(server.url);
  url.searchParams.set('atlasBenchmark', '1');
  url.hash = `v=1&mode=${mode}`;
  const start = performance.now();
  await page.goto(url.href);
  if (mode === '3d')
    await page.waitForFunction(() => window.__atlasCity?.stats().drawCalls > 0, null, { timeout: 60_000 });
  else await page.waitForSelector('#city-title');
  const afterChunksMs =
    mode === '3d'
      ? await page.evaluate(() => performance.timeOrigin + performance.now() - window.__atlasChunksAvailableAt)
      : null;
  return { page, loadMs: performance.now() - start, afterChunksMs };
}
async function signedContext(server, engine = browser, options = {}) {
  const context = await engine.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    ...options,
  });
  await context.request.get(server.sessionUrl);
  return context;
}

async function armInteraction(page, kind, query) {
  await page.evaluate(
    ({ kind, query }) => {
      window.__atlasInteraction = new Promise((resolve, reject) => {
        let start = 0;
        const eventName = kind === 'search' ? 'input' : 'keydown';
        const cleanup = () => {
          observer.disconnect();
          document.removeEventListener(eventName, begin, true);
          clearTimeout(timer);
        };
        const observer = new MutationObserver(() => {
          if (!start) return;
          const overlay = document.querySelector('[data-overlay-count]');
          const ready =
            kind === 'search'
              ? document.querySelector('[role="option"][aria-selected="true"]')?.textContent?.includes(query)
              : document.getElementById('inspector-title')?.textContent === query &&
                overlay?.getAttribute('data-overlay-ready') === 'true' &&
                /^Overlay: [1-9]/.test(overlay.textContent ?? '');
          if (ready) {
            cleanup();
            requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start)));
          }
        });
        const begin = (event) => {
          if (kind === 'search' || event.key === 'Enter') start = performance.now();
        };
        document.addEventListener(eventName, begin, true);
        observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error('Interaction did not settle'));
        }, 5000);
      });
    },
    { kind, query },
  );
}

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

try {
  for (const total of sizes) {
    console.error(`Generating and analyzing ${total} committed files…`);
    const fixture = createGitFixture([
      { date: '2026-10-01T00:00:00Z', message: 'production city fixture', files: fixtureFiles(total) },
    ]);
    const { git, repo } = await openLocalRepository(fixture.dir),
      pool = new ParserPool({ workers: 2 });
    let server, context;
    try {
      const commitOid = await resolveLocalCommit(repo, git),
        started = performance.now();
      const result = await analyzeCommit({
        git,
        commitOid,
        gitVersion: await gitVersion(),
        repository: {
          repoId,
          displayName: `ATLAS · ${total.toLocaleString()} files`,
          sourceKind: 'local-git',
          remote: null,
          objectFormat: repo.objectFormat,
        },
        pool,
      });
      const packed = packArtifact(result.draft, gzipDeterministic),
        analysisMs = performance.now() - started;
      if (result.status !== 'complete')
        throw new Error(`Normal ${total}-file fixture hit a limit: ${result.draft.manifest.coverage.head.limitsHit}`);
      const dir = path.join(root, '.atlas-tmp/phase3', String(total));
      await writeArtifactDirectory(packed, dir, { replace: true });
      server = await startViewerServer({
        artifactDir: dir,
        bundle: packed.bundle,
        viewerDir: path.join(root, 'apps/web/dist'),
        source: SourceAttachment.none(),
      });
      context = await signedContext(server);
      const loads = [],
        afterChunkLoads = [],
        longTasks = [],
        searchTimes = [],
        selectionTimes = [],
        frameP95s = [],
        errors = [];
      let page;
      for (let run = 0; run < runs; run++) {
        const opened = await open(context, server, '3d', errors);
        page = opened.page;
        loads.push(opened.loadMs);
        afterChunkLoads.push(opened.afterChunksMs);
        if (run === 0) {
          for (const lens of ['structure', 'complexity', 'fan-in']) {
            await page.getByLabel('Lens', { exact: true }).selectOption(lens);
            await page.waitForFunction((lens) => window.__atlasCity.stats().lens === lens, lens);
            await page.locator('.city').screenshot({ path: path.join(images, `phase3-${total}-${lens}.png`) });
          }
          if (total === 300) {
            const downloads = [], capture = (d) => downloads.push(d); page.on('download', capture);
            try {
              await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
              await page.waitForFunction(() => document.querySelector('.city-message')?.textContent.includes('Exported PNG'));
              if (downloads.length !== 2) throw new Error('Export must deliver PNG and metadata');
              await downloads.find((d) => d.suggestedFilename().endsWith('.png')).saveAs(path.join(images, 'phase3-city-export.png'));
              await downloads.find((d) => d.suggestedFilename().endsWith('.json')).saveAs(path.join(out, 'phase3-image-metadata.json'));
            } finally { page.off('download', capture); }
          }
        }
        await page.evaluate(() => {
          window.__atlasLongTasks.length = 0;
        });
        const q = `f${run % 20}.ts`,
          search = page.getByRole('combobox', { name: 'Search files, packages and declarations' });
        await armInteraction(page, 'search', q);
        await search.fill(q);
        searchTimes.push(await page.evaluate(() => window.__atlasInteraction));
        await armInteraction(page, 'selection', q);
        await page.keyboard.press('Enter');
        selectionTimes.push(await page.evaluate(() => window.__atlasInteraction));
        await page.getByRole('button', { name: 'Reset city' }).click();
        const frames = await page.evaluate(() => window.__atlasCity.measureFrames(60));
        frameP95s.push(p95(frames));
        longTasks.push(...(await page.evaluate(() => window.__atlasLongTasks)));
        if (run + 1 < runs) await page.close();
      }
      const stats = await page.evaluate(() => window.__atlasCity.stats());
      await page.getByRole('button', { name: 'Focus selection' }).click();
      await page.locator('.city').screenshot({ path: path.join(images, `phase3-${total}-detail.png`) });
      const focusedFrames = await page.evaluate(() => window.__atlasCity.measureFrames(60));
      const focusedFrameP95Ms = p95(focusedFrames);
      await page.getByRole('button', { name: 'Reset city' }).click();
      const combinedHeap = await viewerHeap(context, page, server);
      report.environment.gpu ??= stats.renderer;
      const baseline = await page.evaluate(() => window.__atlasCity.stats());
      const cdp = await context.newCDPSession(page);
      await cdp.send('HeapProfiler.collectGarbage');
      const heapBefore = (await page.evaluate(() => window.__atlasCity.stats())).heapBytes;
      for (let cycle = 0; cycle < 20; cycle++) {
        await page.getByLabel('View', { exact: true }).selectOption('map');
        await page.waitForFunction(() => !window.__atlasCity);
        await page.getByLabel('View', { exact: true }).selectOption('3d');
        await page.waitForFunction(() => window.__atlasCity?.stats().drawCalls > 0);
      }
      await cdp.send('HeapProfiler.collectGarbage');
      const after = await page.evaluate(() => window.__atlasCity.stats());
      const violations = (
        await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()
      ).violations;
      const row = {
        files: total,
        included: packed.bundle.graphs[0].coverage.includedFiles,
        edges: packed.bundle.graphs[0].edges.length,
        commit: commitOid,
        layoutId: packed.bundle.layout.layoutId,
        analysisMs: +analysisMs.toFixed(2),
        cacheCondition:
          'new page and retained validating/query worker each run; browser code cache warm after first run',
        interactionClock:
          'browser input/Enter event to committed matching results and two animation-frame boundaries; controller round trips excluded',
        usefulLoadMs: summary(loads),
        usefulAfterChunksMs: summary(afterChunkLoads),
        searchMs: summary(searchTimes),
        selectionOverlayMs: summary(selectionTimes),
        cameraFrameP95Ms: summary(frameP95s),
        ...stats,
        measurements: { loadTotalMs: loads, usefulAfterChunksMs: afterChunkLoads, searchMs: searchTimes, selectionOverlayMs: selectionTimes, cameraFrameP95Ms: frameP95s },
        artifact: { version: packed.manifest.artifactVersion, compressedBytes: packed.manifest.chunks.reduce((n, c) => n + c.compressedBytes, 0), decodedBytes: packed.manifest.chunks.reduce((n, c) => n + Math.max(c.uncompressedBytes, c.decodedBytes ?? 0), 0) },
        combinedHeap,
        focusedFrameP95Ms,
        heapMiB: stats.heapBytes === null ? null : +(stats.heapBytes / 2 ** 20).toFixed(2),
        interactionLongTasksMs: longTasks,
        cycles: 20,
        geometryBefore: baseline.geometries,
        geometryAfter: after.geometries,
        texturesAfter: after.textures,
        heapGrowthMiB: heapBefore === null ? null : +((after.heapBytes - heapBefore) / 2 ** 20).toFixed(2),
        automatedAAViolations: violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          targets: v.nodes.map((n) => n.target),
        })),
        errors,
        pass:
          (total !== 3000 || p95(afterChunkLoads) <= 3000) &&
          p95(searchTimes) <= (total === 10000 ? 200 : 100) &&
          p95(selectionTimes) <= 100 &&
          p95(frameP95s) <= (total === 10000 ? 50 : 33) &&
          focusedFrameP95Ms <= (total === 10000 ? 50 : 33) &&
          stats.drawCalls <= (total === 10000 ? 250 : 150) &&
          combinedHeap.workers.length === 1 &&
          combinedHeap.retainedMiB <= 300 &&
          stats.heapBytes !== null &&
          stats.heapBytes < 300 * 2 ** 20 &&
          after.geometries <= baseline.geometries + 2 &&
          after.heapBytes - heapBefore <= 8 * 2 ** 20 &&
          violations.length === 0 &&
          errors.length === 0,
      };
      report.scenarios.push(row);
      console.error(
        `${total}: load p95 ${row.usefulLoadMs.p95}ms, search ${row.searchMs.p95}ms, select ${row.selectionOverlayMs.p95}ms, frame ${row.cameraFrameP95Ms.p95}ms; ${row.pass ? 'pass' : 'FAIL'}`,
      );
      if (total === 3000) {
        const coldTimes = [];
        for (let run = 0; run < coldRuns; run++) {
          const coldContext = await browser.newContext({
            viewport: { width: 1920, height: 1080 },
            storageState: await context.storageState(),
          });
          const coldPage = await coldContext.newPage(),
            session = await coldContext.newCDPSession(coldPage);
          await session.send('Network.enable');
          await session.send('Network.setCacheDisabled', { cacheDisabled: true });
          await session.send('Network.emulateNetworkConditions', {
            offline: false,
            latency: 100,
            downloadThroughput: 1_250_000,
            uploadThroughput: 1_250_000,
          });
          const url = new URL(server.url);
          url.searchParams.set('atlasBenchmark', '1');
          const start = performance.now();
          await coldPage.goto(url.href);
          await coldPage.waitForFunction(() => window.__atlasCity?.stats().drawCalls > 0, null, { timeout: 60_000 });
          coldTimes.push(performance.now() - start);
          await coldContext.close();
        }
        report.coldRoute = {
          files: total,
          profile: '10 Mbps download/upload, 100 ms emulated latency, disabled HTTP cache, existing local session',
          ms: summary(coldTimes),
          measurementsMs: coldTimes,
          pass: p95(coldTimes) <= 8000,
        };
        console.error(`Cold route p95: ${report.coldRoute.ms.p95}ms`);
      }
      if (total === 300 && process.argv.includes('--firefox')) {
        const ff = await firefox.launch();
        const ffContext = await ff.newContext({
          viewport: { width: 1280, height: 900 },
          storageState: await context.storageState(),
          reducedMotion: 'reduce',
        });
        try {
          const opened = await open(ffContext, server, 'table'),
            fp = opened.page;
          await fp.getByRole('combobox', { name: 'Search files, packages and declarations' }).fill('f0.ts');
          await fp.waitForSelector('[role="option"][aria-selected="true"]');
          await fp.keyboard.press('Enter');
          await fp.waitForSelector('#inspector-title');
          await fp.getByLabel('View', { exact: true }).selectOption('map');
          await fp.waitForSelector('[data-city-renderer="map"]');
          const failures = (
            await new AxeBuilder({ page: fp }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()
          ).violations;
          await fp.locator('.city').screenshot({ path: path.join(images, 'phase3-firefox-map.png') });
          report.firefox = {
            version: ff.version(),
            tasks: [
              'worker artifact import',
              'search and inspector',
              'table and map',
              'reduced motion',
              'automated AA',
            ],
            violations: failures.map((v) => v.id),
            pass: failures.length === 0,
          };
        } finally {
          await ffContext.close();
          await ff.close();
        }
      }
      await page.close();
    } finally {
      await context?.close();
      await server?.close();
      await pool.close();
      await git.dispose();
      fixture.dispose();
    }
    writeReport();
  }
} finally {
  await browser.close();
  writeReport();
}

function writeReport() {
  if (!reportOnly) {
  report.complete =
    sizes.every((size) => report.scenarios.some((s) => s.files === size)) &&
    (!sizes.includes(3000) || report.coldRoute !== null) &&
    (!process.argv.includes('--firefox') || !sizes.includes(300) || report.firefox !== null);
  report.acceptanceRun =
    runs >= 20 &&
    coldRuns >= 20 &&
    [300, 3000, 10000].every((size) => sizes.includes(size)) &&
    process.argv.includes('--firefox');
  report.pass =
    report.complete &&
    report.layout.pass &&
    report.scenarios.every((s) => s.pass) &&
    (report.coldRoute?.pass ?? true) &&
    (report.firefox?.pass ?? true);
  }
  const profilePath = path.join(out, 'phase3-interaction-profile.json');
  delete report.profileFollowup;
  if (existsSync(profilePath)) {
    const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
    const dense = report.scenarios.find((s) => s.files === 10000);
    if (dense && profile.fixtureCommit === dense.commit && profile.recordedAt >= report.recordedAt) {
      report.profileFollowup = {
        recordedAt: profile.recordedAt, runs: profile.runs,
        longTaskCount: profile.records.reduce((n, r) => n + r.tasks.length, 0),
      };
    }
  }
  writeFileSync(path.join(out, 'phase3-city.json'), `${JSON.stringify(report, null, 2)}\n`);
  const md = [
    `# Phase 3 production city acceptance measurements`,
    ``,
    `Recorded ${report.recordedAt}. Runs: ${report.layout.ms.samples}; cold-route runs: ${report.coldRoute?.ms.samples ?? 0}. Fixtures are committed repositories passed through the real analyzer and artifact validator.`,
    `Complete: ${report.complete}; full acceptance invocation: ${report.acceptanceRun}; measured local gates: ${report.pass ? 'pass' : 'fail'}. Manual/device gates below remain separate.`,
    ``,
    `## Environment`,
    ``,
    ...Object.entries(report.environment).map(([k, v]) => `- **${k}:** ${v}`),
    ``,
    `## Measurements`,
    ``,
    `20k union layout p95: ${report.layout.ms.p95} ms (budget 2,000 ms).`,
    ``,
    `Load total includes navigation, scripts, transport and validation. Post-chunks starts when the final required chunk has been read into the validating worker and includes remaining validation, index preparation, main-thread transfer and first 3D frame. The loader processes chunks sequentially, so earlier validation overlaps acquisition of later chunks. The plan's 3-second budget applies to post-chunks; the 8-second cold-route gate covers the entire route. Both are reported.`,
    ``,
    `Search/selection use the browser's input/Enter clock through matching committed results and two animation-frame boundaries, excluding automation transport. Long tasks include all measured interaction/camera traces.`,
    ``,
    `| Files | Edges | Load total p95 | Post-chunks p95 | Search p95 | Selection/overlay p95 | Camera frame p95 | Draw calls | Main + worker retained heap | Result |`,
    `|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|`,
    ...report.scenarios.map(
      (s) =>
        `| ${s.files} | ${s.edges} | ${s.usefulLoadMs.p95} ms | ${s.usefulAfterChunksMs.p95} ms | ${s.searchMs.p95} ms | ${s.selectionOverlayMs.p95} ms | ${s.cameraFrameP95Ms.p95} ms | ${s.drawCalls} | ${s.combinedHeap.retainedMiB} MiB | ${s.pass ? 'Pass' : 'Fail'} |`,
    ),
    ``,
    report.coldRoute
      ? `Medium cold route (${report.coldRoute.profile}): p95 ${report.coldRoute.ms.p95} ms, ${report.coldRoute.ms.samples} runs, ${report.coldRoute.pass ? 'pass' : 'fail'} against 8,000 ms.`
      : 'Cold-route measurement not present in this invocation.',
    ``,
    `## Resource and accessibility evidence`,
    ``,
    ...report.scenarios.map(
      (s) =>
        `- ${s.files} files: artifact ${s.artifact.version}, ${s.artifact.compressedBytes} compressed / ${s.artifact.decodedBytes} decoded bytes. Main + worker heap before forced collection: ${s.combinedHeap.beforeMiB} MiB; retained: ${s.combinedHeap.retainedMiB} MiB. Focused close-up frame p95: ${s.focusedFrameP95Ms.toFixed(2)} ms. Twenty map/3D replacement cycles: active geometries ${s.geometryBefore} → ${s.geometryAfter}, textures ${s.texturesAfter}, post-GC main heap growth ${s.heapGrowthMiB} MiB; ${s.automatedAAViolations.length} automated AA violations. Long tasks across all measured interaction/camera traces: ${s.interactionLongTasksMs.map((n) => n.toFixed(1)).join(', ') || 'none'} ms.`,
    ),
    ``,
    report.firefox
      ? `Firefox ${report.firefox.version}: ${report.firefox.tasks.join(', ')}; ${report.firefox.violations.length} automated violations.`
      : 'Firefox was not requested in this invocation.',
    ``,
    report.profileFollowup
      ? `Follow-up [CPU attribution report](phase3-interaction-profile.json): ${report.profileFollowup.runs} fresh dense imports and interaction/camera traces, ${report.profileFollowup.longTaskCount} observed long tasks. Profiling adds overhead and does not replace the unprofiled latency samples. Original task durations above remain recorded; an isolated unreproduced outlier does not establish its cause or certify another device. Review traces again on the reference device.`
      : 'No matching follow-up CPU attribution report is available for this invocation.',
    ``,
    `## Interpretation and remaining manual gates`,
    ``,
    ...report.limitations.map((l) => `- ${l}`),
    ``,
    `Detailed samples, immutable fixture commits, layout IDs and errors are in the adjacent JSON. Synthetic fixtures measure performance, not empirical language coverage. History/compare references are Phase 4.`,
    ``,
  ];
  writeFileSync(path.join(out, 'phase3-city.md'), md.join('\n'));
}
if (!report.pass) process.exitCode = 1;
