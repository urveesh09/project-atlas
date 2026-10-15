import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startApi } from '@atlas/api';
import { IngestError } from '@atlas/ingest';
import { buildDemoRepository, type GitFixture } from '@atlas/test-fixtures';
import { audit } from '../../web/test/audit.js';
import { ScriptedRunners, createHarness, databaseUrl, processRunners, requireBuiltSandbox, untilAborted, type Harness } from './pipeline-harness.js';
import type { StageRunners } from '../src/index.js';

/**
 * Hosted journeys in a real browser (P5.5, plan §3.1): success, partial, failure,
 * cancellation, SSE loss with polling recovery, expired/deleted screens and an owner
 * deletion, through the same validating viewer as local artifacts. Every request URL is
 * recorded to prove no token or session value ever appears in one.
 */
const webRoot = fileURLToPath(new URL('../../web/dist/', import.meta.url));
const browserAvailable = existsSync(chromium.executablePath());
const viewerBuilt = existsSync(path.join(webRoot, 'index.html'));
if (process.env['ATLAS_REQUIRE_BROWSER_TESTS'] === '1' && databaseUrl && (!browserAvailable || !viewerBuilt)) {
  throw new Error('Hosted browser journeys need installed Chromium and a built viewer (pnpm build:web).');
}
const HARBOR = 'https://github.com/atlas-demo/harbor';

async function capture(page: Page, name: string) {
  if (process.env['ATLAS_CAPTURE_VIEWER'] !== '1') return;
  const dir = path.resolve('docs/images');
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `phase5-${name}.png`) });
}

describe.runIf(!!databaseUrl && browserAvailable && viewerBuilt)('hosted journeys in Chromium', () => {
  let demo: GitFixture;
  let h: Harness;
  let api: Awaited<ReturnType<typeof startApi>>;
  let browser: Browser;
  let runners: StageRunners;
  let worker: Promise<void> | null = null;
  const urls: string[] = [];
  const secrets: string[] = [];

  beforeAll(async () => {
    requireBuiltSandbox();
    demo = buildDemoRepository();
    h = await createHarness([{ numericId: '838383', owner: 'atlas-demo', name: 'harbor', defaultBranch: 'main', headOid: demo.commits.at(-1)!, remotePath: demo.dir, visibility: 'public' }]);
    api = await startApi({ store: h.admission, quotaSecret: 'e'.repeat(32), developmentLoopback: true, publications: h.publications, storage: h.store, webRoot });
    browser = await chromium.launch();
  });
  beforeEach(async () => {
    await h.reset();
    runners = new ScriptedRunners(processRunners(demo.dir));
  });
  afterAll(async () => {
    await browser?.close();
    await api?.close();
    await h?.close();
    demo?.dispose();
    // No URL ever carried a session or management secret (plan §3.1, §13.1).
    expect(secrets.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).not.toMatch(/token|session=/i);
      for (const secret of secrets) expect(url).not.toContain(secret);
    }
  });

  /** Run queued jobs in the background, the way the worker service would. */
  const startWorker = () => {
    worker = (async () => {
      for (let i = 0; i < 200 && !(await h.coordinator(runners).runOnce()); i++) await new Promise((r) => setTimeout(r, 100));
    })();
  };
  const open = async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on('request', (r) => urls.push(r.url()));
    // The admission response carries the management token once; record it to prove the
    // client never puts it anywhere a URL could carry it.
    page.on('response', async (r) => {
      if (r.request().method() === 'POST' && r.url().endsWith('/api/v1/analyses')) {
        const token = ((await r.json().catch(() => null)) as { managementToken?: string } | null)?.managementToken;
        if (token) secrets.push(token);
      }
    });
    return { context, page };
  };
  const submit = async (page: Page, history = true) => {
    await page.goto(`${api.origin}/`);
    await page.getByLabel('Repository URL').fill(HARBOR);
    if (!history) await page.getByLabel(/Include mainline history/).uncheck();
    const analyze = page.getByRole('button', { name: 'Analyze repository' });
    await expect(analyze.isDisabled()).resolves.toBe(true);
    await page.getByLabel('I understand the result will be public').check();
    await analyze.click();
    await page.waitForURL(/\/jobs\/job_[0-9a-f]{32}$/);
    for (const cookie of await page.context().cookies()) secrets.push(cookie.value);
    return page.url().split('/').at(-1)!;
  };

  it('submits, follows stages, opens the city and deletes it (success journey, keyboard reachable)', async () => {
    const { context, page } = await open();
    await page.goto(`${api.origin}/`);
    expect(await audit(page)).toEqual([]);
    await capture(page, 'landing');
    await submit(page);
    startWorker();
    const openCity = page.getByRole('link', { name: 'Open the city' });
    await openCity.waitFor({ timeout: 90_000 });
    await worker;
    expect(await page.locator('.stage-done').count()).toBe(7);
    await expect(page.getByText('files discovered').isVisible()).resolves.toBe(true);
    expect(await audit(page)).toEqual([]);
    await capture(page, 'job-ready');
    await openCity.focus();
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/a\/analysis_[0-9a-f]{64}$/);
    await page.locator('.topbar .repo-name').waitFor({ timeout: 60_000 });
    expect(await page.locator('.topbar .repo-name').innerText()).toBe('atlas-demo/harbor');
    expect(await page.getByText(/^Public until/).isVisible()).toBe(true);
    await capture(page, 'result');
    // A delayed home-page capability probe must not replace a newer analysis route.
    const resultPath = new URL(page.url()).pathname;
    let releaseProbe!: () => Promise<void>;
    let probeReady!: () => void;
    const ready = new Promise<void>((resolve) => { probeReady = resolve; });
    await page.route('**/api/v1/capabilities', async (route) => {
      const response = await route.fetch();
      releaseProbe = () => route.fulfill({ response });
      probeReady();
    });
    await page.evaluate(() => {
      history.pushState(null, '', '/');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await ready;
    await page.evaluate((path) => {
      history.pushState(null, '', path);
      dispatchEvent(new PopStateEvent('popstate'));
    }, resultPath);
    await page.locator('.topbar .repo-name').waitFor({ timeout: 60_000 });
    const probeFinished = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/capabilities');
    await releaseProbe();
    await probeFinished;
    // Wait for the browser to process the response and React to commit any stale state.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.locator('.topbar .repo-name').innerText()).toBe('atlas-demo/harbor');
    await page.unroute('**/api/v1/capabilities');
    // Reload: the immutable URL reopens the same validated analysis.
    await page.reload();
    await page.locator('.topbar .repo-name').waitFor({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Delete…' }).click();
    await page.getByRole('button', { name: 'Delete permanently' }).click();
    await page.getByRole('heading', { name: 'This analysis was deleted' }).waitFor();
    expect(await audit(page)).toEqual([]);
    await capture(page, 'deleted');
    await context.close();
  }, 180_000);

  it('shows a PARTIAL result with its warnings when history could not be acquired', async () => {
    runners = new ScriptedRunners(processRunners(demo.dir), {
      acquire: (request, run) => (request.depth > 1 ? Promise.reject(new IngestError('REPOSITORY_TOO_LARGE', 'over')) : run()),
    });
    const { context, page } = await open();
    await submit(page);
    startWorker();
    await page.getByRole('heading', { name: 'Ready with partial coverage' }).waitFor({ timeout: 90_000 });
    await worker;
    expect(await page.getByText('256 MiB transfer limit').isVisible()).toBe(true);
    await capture(page, 'job-partial');
    await page.getByRole('link', { name: 'Open the city' }).click();
    await page.locator('.topbar .repo-name').waitFor({ timeout: 60_000 });
    expect(await page.locator('.timeline-summary').innerText()).toContain('Requested but unavailable: stopped by a resource limit');
    await context.close();
  }, 180_000);

  it('explains a failure with its code and guidance, and offers a retry for retryable failures', async () => {
    h.resolver.outage = true;
    const { context, page } = await open();
    await submit(page);
    startWorker();
    await page.getByRole('heading', { name: 'Failed' }).waitFor({ timeout: 60_000 });
    await worker;
    expect(await page.getByRole('alert').innerText()).toContain('UPSTREAM_UNAVAILABLE');
    // A failed job reports no stage; the page must not tick every stage as done (ADR-059).
    expect(await page.locator('.stage-done').count()).toBe(0);
    expect(await page.locator('.stage-unknown').innerText()).toBe('It stopped before a result was published.');
    expect(await page.getByRole('link', { name: 'Try again' }).isVisible()).toBe(true);
    await capture(page, 'job-failed');
    await context.close();
  }, 120_000);

  it('cancels a running analysis from the page; the sandbox stops and nothing is published', async () => {
    runners = new ScriptedRunners(processRunners(demo.dir), {
      analyze: (request) => untilAborted(request.signal),
    });
    const { context, page } = await open();
    await submit(page);
    startWorker();
    const cancel = page.getByRole('button', { name: 'Cancel analysis' });
    await page.locator('.stage-active').waitFor({ timeout: 60_000 });
    await page.getByRole('heading', { name: 'Analyzing the selected commit' }).waitFor({ timeout: 60_000 });
    await cancel.click();
    await page.getByRole('heading', { name: 'Cancelled' }).waitFor({ timeout: 60_000 });
    await worker;
    expect(await page.locator('.stage-done').count()).toBe(0);
    expect(await page.locator('.stage-unknown').innerText()).toBe('It was cancelled before a result was published.');
    expect((await h.pool.query('SELECT count(*)::int AS n FROM publications')).rows[0].n).toBe(0);
    await context.close();
  }, 120_000);

  it('recovers progress by polling when server-sent events are unavailable', async () => {
    const { context, page } = await open();
    // Simulate a proxy that blocks event streams: every SSE request fails.
    await page.route('**/events', (route) => route.abort());
    await submit(page, false);
    startWorker();
    await page.getByRole('link', { name: 'Open the city' }).waitFor({ timeout: 90_000 });
    await worker;
    await context.close();
  }, 120_000);

  it('never shows a stale graph for expired, unknown or foreign analyses', async () => {
    const { context, page } = await open();
    await submit(page, false);
    startWorker();
    await page.getByRole('link', { name: 'Open the city' }).waitFor({ timeout: 90_000 });
    await worker;
    const analysisUrl = await page.getByRole('link', { name: 'Open the city' }).getAttribute('href');
    await h.pool.query("UPDATE publications SET expires_at=clock_timestamp()-interval '1 second'");
    await page.goto(`${api.origin}${analysisUrl}`);
    await page.getByRole('heading', { name: 'This analysis has expired' }).waitFor();
    expect(await page.locator('.topbar').count()).toBe(0);
    await capture(page, 'expired');
    await page.goto(`${api.origin}/a/analysis_${'9'.repeat(64)}`);
    await page.getByRole('heading', { name: 'This analysis does not exist' }).waitFor();
    // Another browser cannot follow or cancel this job.
    const jobUrl = (await h.pool.query('SELECT id FROM jobs LIMIT 1')).rows[0].id;
    const other = await browser.newContext();
    const foreign = await other.newPage();
    await foreign.goto(`${api.origin}/jobs/${jobUrl}`);
    await foreign.getByRole('heading', { name: 'This analysis belongs to another browser session' }).waitFor();
    await other.close();
    await context.close();
  }, 120_000);
});
