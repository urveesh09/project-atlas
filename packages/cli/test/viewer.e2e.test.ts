import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readArtifactDirectory } from '@atlas/artifact/node';
import { run, type CliIO } from '@atlas/cli';
import { viewerDirectory } from '../src/commands/serve.js';
import { SourceAttachment } from '../src/server/source.js';
import { startViewerServer, type RunningViewerServer } from '../src/server/server.js';
import { buildDemoRepository, type GitFixture } from '@atlas/test-fixtures';

/**
 * Gate G2 journeys in a real browser, keyboard only (plan §17 P2.6): find a file, inspect
 * its static dependencies and limitations, and explain a diagnostic. Every request is
 * recorded to prove nothing leaves the loopback origin, and a browser-only artifact open
 * proves picked files are not uploaded.
 */
const browserAvailable = existsSync(chromium.executablePath());
let viewerBuilt = true;
try {
  viewerDirectory();
} catch {
  viewerBuilt = false;
}
if (process.env['ATLAS_REQUIRE_BROWSER_TESTS'] === '1' && (!browserAvailable || !viewerBuilt)) {
  throw new Error('Required browser tests need installed Chromium and a built viewer. Run playwright install chromium and pnpm build:web.');
}

async function capture(page: Page, name: string): Promise<void> {
  if (process.env['ATLAS_CAPTURE_VIEWER'] !== '1') return;
  const dir = path.resolve('docs/images');
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `phase2-${name}.png`), fullPage: true });
}

let work: string;
let demo: GitFixture;
let server: RunningViewerServer;
let browser: Browser;
let context: BrowserContext;
let signedIn = false;

beforeAll(async () => {
  if (!browserAvailable || !viewerBuilt) return;
  work = mkdtempSync(path.join(tmpdir(), 'atlas-e2e-'));
  demo = buildDemoRepository();
  const io: CliIO = { stdout: { write: () => true }, stderr: { write: () => true }, env: { NO_COLOR: '1' }, cwd: work, signal: new AbortController().signal };
  expect(await run(['analyze', demo.dir, '--out', 'harbor-out'], io)).toBe(0);
  const loaded = await readArtifactDirectory(path.join(work, 'harbor-out'));
  if (!loaded.ok) throw new Error('invalid artifact');
  server = await startViewerServer({ artifactDir: path.join(work, 'harbor-out'), bundle: loaded.bundle, viewerDir: viewerDirectory(), source: await SourceAttachment.attach(demo.dir, loaded.bundle) });
  browser = await chromium.launch();
  context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  demo?.dispose();
  if (work) rmSync(work, { recursive: true, force: true });
});

async function openViewer(): Promise<{ page: Page; requests: string[]; errors: string[] }> {
  const page = await context.newPage();
  const requests: string[] = [];
  const errors: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  // The session link is single-use: the first page signs this context in, later pages reuse the cookie.
  await page.goto(signedIn ? server.url : server.sessionUrl);
  signedIn = true;
  return { page, requests, errors };
}

const focusedText = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.innerText ?? '');

/** Tab to the inspector's tab list (roving focus: only the selected tab is reachable). */
async function tabToTabList(page: Page, max = 60): Promise<void> {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if ((await page.evaluate(() => document.activeElement?.getAttribute('role'))) === 'tab') return;
  }
  throw new Error('Never reached the tab list');
}

async function tabUntil(page: Page, matcher: RegExp, max = 60): Promise<void> {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if (matcher.test(await focusedText(page))) return;
  }
  throw new Error(`Never focused ${matcher}`);
}

describe.runIf(browserAvailable && viewerBuilt)('viewer journeys (keyboard only)', () => {
  let page: Page;
  let requests: string[];
  let errors: string[];
  let findingSourcePath: string;

  beforeAll(async () => {
    ({ page, requests, errors } = await openViewer());
    await page.waitForSelector('#overview-title');
    await capture(page, 'overview');
  });

  it('J1: finds a named file by search', async () => {
    await page.keyboard.press('/');
    await page.keyboard.type('pricing');
    expect(await page.locator('[role="option"][aria-selected="true"]').innerText()).toContain('src/server/pricing.ts');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('#inspector-title').innerText()).toBe('pricing.ts');
    // Focus moves deliberately to the inspector heading; the live region announces it.
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('inspector-title');
    await expect.poll(() => page.locator('[role="status"][aria-live="polite"]').innerText()).toContain('src/server/pricing.ts');
  });

  it('J2: inspects static dependencies and their evidence, then follows one', async () => {
    await tabToTabList(page);
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    expect(await page.locator('[role="tab"][aria-selected="true"]').innerText()).toBe('Dependencies');
    const panel = page.locator('[role="tabpanel"]');
    await expect.poll(() => panel.innerText()).toContain('packages/ledger/src/index.ts');
    const text = await panel.innerText();
    expect(text).toMatch(/CONSUMERS\s*3/i);
    expect(text).toContain('tests/pricing.test.ts');
    expect(text).toContain('dynamic import');
    expect(text).toMatch(/TYPE-ONLY\s*1/i);
    expect(text).toContain('inferred');
    await capture(page, 'dependencies');
    await tabUntil(page, /^src\/server\/handlers\.ts$/);
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('#inspector-title').innerText()).toBe('handlers.ts');
  });

  it('J3: explains a diagnostic with policy, evidence and limits', async () => {
    await page.keyboard.press('/');
    await page.keyboard.press('Control+A');
    await page.keyboard.type('router.ts');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('#inspector-title').innerText()).toBe('router.ts');
    await tabToTabList(page);
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowLeft');
    expect(await page.locator('[role="tab"][aria-selected="true"]').innerText()).toMatch(/^Findings/);
    const panel = await page.locator('[role="tabpanel"]').innerText();
    expect(panel).toContain('Static value dependency cycle detected');
    // Witnesses are ordered by canonical IDs, which include the local repo UUID.
    // Either rotation of these same two independently known edges is valid.
    const witnesses = [
      'src/server/router.ts → src/server/handlers.ts → src/server/router.ts',
      'src/server/handlers.ts → src/server/router.ts → src/server/handlers.ts',
    ];
    expect(witnesses.some((w) => panel.includes(w))).toBe(true);
    const sourceMatch = panel.match(/In (src\/server\/(?:router|handlers)\.ts)/);
    expect(sourceMatch).not.toBeNull();
    findingSourcePath = sourceMatch![1]!;
    expect(panel).toContain('not a runtime deadlock');
    expect(panel).toMatch(/WARNING/);
    await capture(page, 'findings');
  });

  it('opens verified source read-only from a finding, and Escape returns', async () => {
    await tabUntil(page, /^View source at this line$/);
    await page.keyboard.press('Enter');
    const expectedImport = findingSourcePath === 'src/server/router.ts'
      ? "import { handleQuote } from './handlers';"
      : "import { routes } from './router';";
    await expect.poll(() => page.locator('.source-panel').innerText()).toContain(findingSourcePath);
    await expect.poll(() => page.locator('.source-panel').innerText()).toContain(expectedImport);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator('.source-panel').count()).toBe(0);
  });

  it('navigates the tree with arrow keys', async () => {
    await page.keyboard.press('Escape'); // back to overview
    await page.locator('[role="treeitem"]').first().focus();
    const first = await focusedText(page);
    expect(first).toContain('harbor');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    const expanded = await page.evaluate(() => document.activeElement?.getAttribute('aria-expanded'));
    expect(expanded).toBe('true');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('#inspector-title').count()).toBe(1);
  });

  it('keeps every request on the loopback origin and logs no errors', () => {
    const origin = new URL(server.url).origin;
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.filter((u) => !u.startsWith(origin))).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe.runIf(browserAvailable && viewerBuilt)('deep links', () => {
  it('restores a file and tab from an allowlisted fragment and ignores others', async () => {
    const { page } = await openViewer();
    await page.waitForSelector('#overview-title');
    const loaded = await readArtifactDirectory(path.join(work, 'harbor-out'));
    if (!loaded.ok) throw new Error('invalid');
    const node = loaded.bundle.graphs[0]!.nodes.find((n) => n.kind === 'file' && n.path === 'src/ui/Dock.tsx')!;
    await page.goto(`${server.url}#v=1&file=${node.lineageId}&tab=dependencies`);
    await expect.poll(() => page.locator('#inspector-title').innerText()).toBe('Dock.tsx');
    expect(await page.locator('[role="tab"][aria-selected="true"]').innerText()).toBe('Dependencies');
    await page.goto(`${server.url}#v=1&file=javascript:alert(1)&evil=1`);
    await page.reload();
    await page.waitForSelector('#overview-title');
    await expect.poll(() => page.locator('[role="status"][aria-live="polite"]').innerText()).toContain('unsupported or invalid');
  });
});

describe.runIf(browserAvailable && viewerBuilt)('browser-only artifact opening', () => {
  let staticServer: Server;
  let origin: string;
  beforeAll(async () => {
    // The viewer as plain static files: no /api, no session, no artifact endpoint.
    const root = viewerDirectory();
    staticServer = createServer((req, res) => {
      const rel = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.resolve(root, rel);
      if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
      createReadStream(file).pipe(res);
    });
    await new Promise<void>((r) => staticServer.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(staticServer.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => staticServer.close(() => r())));

  it('validates picked files locally and sends nothing anywhere', async () => {
    // A separate context: no session cookie, no server API, just static files.
    const isolated = await browser.newContext();
    const page = await isolated.newPage();
    const requests: { url: string; method: string }[] = [];
    page.on('request', (r) => requests.push({ url: r.url(), method: r.method() }));
    await page.goto(`${origin}/`);
    await page.getByRole('button', { name: 'Open artifact folder…' }).waitFor();
    const before = requests.length;
    await page.locator('input[type="file"]').setInputFiles(path.join(work, 'harbor-out'));
    await page.waitForSelector('#overview-title');
    const after = requests.slice(before);
    // Only the loader worker script itself may be fetched; no artifact bytes are sent.
    expect(after.every((r) => r.method === 'GET' && r.url.startsWith(origin) && /\/assets\/.*\.js$/.test(r.url))).toBe(true);
    expect(requests.filter((r) => r.method !== 'GET')).toEqual([]);
    const loaded = await readArtifactDirectory(path.join(work, 'harbor-out'));
    expect(await page.locator('#overview-title').innerText()).toBe(loaded.ok ? loaded.bundle.manifest.repo.displayName : '?');
  });
});
