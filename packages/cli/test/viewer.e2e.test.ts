import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readArtifactDirectory } from '@atlas/artifact/node';
import { ARTIFACT_VERSION } from '@atlas/schema';
import { run, type CliIO } from '@atlas/cli';
import { viewerDirectory } from '../src/commands/serve.js';
import { SourceAttachment } from '../src/server/source.js';
import { startViewerServer, type RunningViewerServer } from '../src/server/server.js';
import { buildDemoRepository, type GitFixture } from '@atlas/test-fixtures';
import { audit } from '../../../apps/web/test/audit.js';
import type {} from '../../../apps/web/src/city/probe.js';

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
  throw new Error(
    'Required browser tests need installed Chromium and a built viewer. Run playwright install chromium and pnpm build:web.',
  );
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
  const io: CliIO = {
    stdout: { write: () => true },
    stderr: { write: () => true },
    env: { NO_COLOR: '1' },
    cwd: work,
    signal: new AbortController().signal,
  };
  expect(await run(['analyze', demo.dir, '--out', 'harbor-out'], io)).toBe(0);
  const loaded = await readArtifactDirectory(path.join(work, 'harbor-out'));
  if (!loaded.ok) throw new Error('invalid artifact');
  server = await startViewerServer({
    artifactDir: path.join(work, 'harbor-out'),
    bundle: loaded.bundle,
    viewerDir: viewerDirectory(),
    source: await SourceAttachment.attach(demo.dir, loaded.bundle),
  });
  browser = await chromium.launch({ args: process.env['CI'] ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [] });
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

const focusedText = (page: Page) =>
  page.evaluate(() => (document.activeElement as HTMLElement | null)?.innerText ?? '');

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
    await expect
      .poll(() => page.locator('[role="option"][aria-selected="true"]').innerText())
      .toContain('src/server/pricing.ts');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('#inspector-title').innerText()).toBe('pricing.ts');
    // Focus moves deliberately to the inspector heading; the live region announces it.
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('inspector-title');
    await expect
      .poll(() => page.locator('[role="status"][aria-live="polite"]').innerText())
      .toContain('src/server/pricing.ts');
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
    // Inspect both members: the same cycle names its subject only when
    // another member is focused. A cycle has no single source range.
    for (const file of ['router.ts', 'handlers.ts']) {
      await page.keyboard.press('/');
      await page.keyboard.press('Control+A');
      await page.keyboard.type(file);
      await page.keyboard.press('Enter');
      await expect.poll(() => page.locator('#inspector-title').innerText()).toBe(file);
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
      const subject = page.locator('[role="tabpanel"] .finding-subject .link');
      if (await subject.count()) {
        findingSourcePath = await subject.innerText();
        expect(findingSourcePath).not.toBe(`src/server/${file}`);
      } else {
        expect(await page.locator('[role="tabpanel"] .finding-subject').count()).toBe(0);
        findingSourcePath = `src/server/${file}`;
      }
      expect(['src/server/router.ts', 'src/server/handlers.ts']).toContain(findingSourcePath);
      expect(panel).toContain('not a runtime deadlock');
      expect(panel).toMatch(/WARNING/);
      if (file === 'router.ts') await capture(page, 'findings');
    }
  });

  it('opens verified source read-only from a finding, and Escape returns', async () => {
    await tabUntil(page, /^View source at this line$/);
    await page.keyboard.press('Enter');
    const expectedImport =
      findingSourcePath === 'src/server/router.ts'
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

describe.runIf(browserAvailable && viewerBuilt)('production miniature city', () => {
  let page: Page;
  beforeAll(async () => {
    page = await context.newPage();
    if (!signedIn) {
      await page.goto(server.sessionUrl);
      signedIn = true;
    }
    // Session bootstrap redirects to the root and strips query parameters. Enable
    // the test probe only after authorization, including when this suite runs alone.
    const url = new URL(server.url);
    url.searchParams.set('atlasBenchmark', '1');
    await page.goto(url.href);
    await page.waitForSelector('#city-title');
    await page.waitForFunction(() => !!window.__atlasCity);
  });
  const choose = async (name: string) => {
    await page.getByRole('combobox', { name: 'Search files, packages and declarations' }).focus();
    await page.keyboard.press('Control+A');
    await page.keyboard.type(name);
    await page.keyboard.press('Enter');
    await page.waitForSelector('#inspector-title');
    await expect.poll(() => page.locator('#inspector-title').innerText()).toBe(name);
  };
  it('shows real artifact buildings and bounded draw calls', async () => {
    const loaded = await readArtifactDirectory(path.join(work, 'harbor-out'));
    if (!loaded.ok) throw new Error('invalid');
    const stats = await page.evaluate(() => window.__atlasCity!.stats());
    expect(stats.buildings).toBe(loaded.bundle.layout.frameState.at(-1)!.files.length);
    expect(stats.drawCalls).toBeLessThan(30);
    expect(stats.pickCells).toBeGreaterThan(0);
  });
  it('keeps the camera still on selection and across lenses', async () => {
    const before = await page.evaluate(() => window.__atlasCity!.cameraState());
    await choose('pricing.ts');
    await page.getByLabel('Lens', { exact: true }).selectOption('complexity');
    expect(await page.evaluate(() => window.__atlasCity!.cameraState())).toEqual(before);
    expect(page.url()).toContain('lens=complexity');
    await page.getByLabel('Lens', { exact: true }).selectOption('fan-in');
    expect(await page.evaluate(() => window.__atlasCity!.cameraState())).toEqual(before);
    expect(await page.locator('.city-legend').innerText()).toContain('25+');
  });
  it('synchronizes a real spatial pick with tree and inspector', async () => {
    const loaded = await readArtifactDirectory(path.join(work, 'harbor-out'));
    if (!loaded.ok) throw new Error('invalid');
    const file = loaded.bundle.graphs.at(-1)!.nodes.find((n) => n.kind === 'file' && n.path === 'src/ui/Dock.tsx')!;
    // Explicit focus is separate from single-click selection.
    await choose('Dock.tsx');
    await page.getByRole('button', { name: 'Focus selection' }).click();
    const point = await page.evaluate((id) => window.__atlasCity!.screenPointOf(id), file.id);
    expect(point).not.toBeNull();
    const hit = await page.evaluate((p) => window.__atlasCity!.pickAt(p!.x, p!.y), point);
    expect(hit).toBe(file.id);
    await page.mouse.click(point!.x, point!.y);
    await expect.poll(() => page.locator('#inspector-title').innerText()).toBe('Dock.tsx');
    expect(await page.locator('[role="treeitem"][aria-selected="true"]').innerText()).toContain('Dock.tsx');
  });
  it('shows directional overlays, type policy, limits and bounded reach through HTML', async () => {
    await choose('pricing.ts');
    await expect.poll(() => page.locator('[data-overlay-count]').innerText()).toMatch(/Overlay: [1-9]/);
    await page.getByLabel('Include type-only', { exact: true }).check();
    await expect.poll(() => page.locator('[data-overlay-count]').innerText()).toContain('including type-only');
    await page.getByRole('button', { name: 'Show reachable files', exact: true }).click();
    await expect.poll(() => page.locator('.reach-results').innerText()).toContain('depth ≤ 2');
    expect(await page.locator('.reach-results').innerText()).toContain('packages/ledger/src/index.ts');
  });
  it('exports a bounded PNG and provenance without WebGL dependency', async () => {
    await page.getByLabel('View', { exact: true }).selectOption('map');
    await page.waitForSelector('[data-city-renderer="map"]');
    const downloads: import('playwright').Download[] = [];
    page.on('download', (d) => downloads.push(d));
    await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
    await expect.poll(() => page.locator('.city-message').innerText(), { timeout: 5000 }).toContain('Exported PNG');
    await expect.poll(() => downloads.length).toBe(2);
    const png = downloads.find((d) => d.suggestedFilename() === 'atlas-city.png')!;
    const json = downloads.find((d) => d.suggestedFilename().endsWith('.json'))!;
    const { readFileSync } = await import('node:fs');
    const bytes = readFileSync((await png.path())!);
    expect(bytes.subarray(1, 4).toString()).toBe('PNG');
    expect(bytes.readUInt32BE(16)).toBeLessThanOrEqual(2048);
    expect(bytes.readUInt32BE(20)).toBeLessThanOrEqual(2048);
    expect(bytes.readUInt32BE(16) * bytes.readUInt32BE(20)).toBeLessThanOrEqual(4_000_000);
    const metadata = JSON.parse(readFileSync((await json.path())!, 'utf8'));
    expect(metadata.lens).toBe('fan-in');
    expect(metadata.mode).toBe('map');
    expect(metadata.selectedPath).toBe('src/server/pricing.ts');
    expect(metadata.layoutVersion).toBe('atlas.layout/1.1.0');
    const artifact = await readArtifactDirectory(path.join(work, 'harbor-out'));
    if (!artifact.ok) throw new Error('Invalid export reference artifact');
    expect(metadata.artifactVersion).toBe(ARTIFACT_VERSION);
    expect(metadata.schemaVersion).toBe('atlas.graph/1.0.0');
    expect(metadata.metricDefinitionVersion).toBe('atlas.metrics/1');
    expect(metadata.analyzer).toEqual(artifact.bundle.manifest.analyzer);
    expect(metadata.analysisKey).toBe(artifact.bundle.manifest.analysisKey);
    expect(metadata.optionsDigest).toBe(artifact.bundle.manifest.optionsDigest);
  });
  it('retains selection through graphics context loss', async () => {
    await page.getByLabel('View', { exact: true }).selectOption('3d');
    await page.waitForFunction(() => !!window.__atlasCity);
    await page.evaluate(() => window.__atlasCity!.loseContext());
    await page.waitForSelector('[data-city-renderer="map"]');
    expect(await page.locator('#inspector-title').innerText()).toBe('pricing.ts');
    expect(await page.locator('.city-message').innerText()).toContain('context was lost');
  });
  it('offers a semantic file table and passes automated AA checks', async () => {
    await page.getByLabel('View', { exact: true }).selectOption('table');
    expect(await page.locator('.city-table caption').innerText()).toContain('Included files');
    expect(await page.locator('.city-table').innerText()).toContain('src/server/pricing.ts');
    expect(await audit(page)).toEqual([]);
  });
  it('reflows controls at 320px and works with reduced motion and canvas disabled', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 320, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.addStyleTag({ content: 'canvas { display: none !important; }' });
    await page.locator('.city-table').getByRole('button', { name: 'src/ui/Dock.tsx', exact: true }).click();
    await expect.poll(() => page.locator('#inspector-title').innerText()).toBe('Dock.tsx');
    expect(await audit(page)).toEqual([]);
  });
});

describe.runIf(browserAvailable && viewerBuilt)('deep links', () => {
  it('round-trips file, lens and fallback mode; latest search wins when input changes rapidly', async () => {
    const { page } = await openViewer();
    await page.waitForSelector('#overview-title');
    const loaded = await readArtifactDirectory(path.join(work, 'harbor-out'));
    if (!loaded.ok) throw new Error('invalid');
    const node = loaded.bundle.graphs.at(-1)!.nodes.find((n) => n.kind === 'file' && n.path === 'src/ui/Dock.tsx')!;
    await page.goto(`${server.url}#v=1&file=${node.lineageId}&lens=fan-in&mode=map&tab=findings`);
    await page.waitForSelector('[data-city-renderer="map"]');
    expect(await page.getByLabel('Lens', { exact: true }).inputValue()).toBe('fan-in');
    expect(await page.locator('#inspector-title').innerText()).toBe('Dock.tsx');
    const search = page.getByRole('combobox', { name: 'Search files, packages and declarations' });
    await search.fill('pricing');
    await search.fill('Dock.tsx');
    await expect.poll(() => page.locator('[role="option"][aria-selected="true"]').innerText()).toContain('Dock.tsx');
    await page.keyboard.press('Enter');
    expect(await page.locator('#inspector-title').innerText()).toBe('Dock.tsx');
    await page.reload();
    await page.waitForSelector('[data-city-renderer="map"]');
    expect(await page.locator('#inspector-title').innerText()).toBe('Dock.tsx');
    expect(await page.getByLabel('Lens', { exact: true }).inputValue()).toBe('fan-in');
  });
  it('works with touch and unavailable WebGL without losing the file inspector', async () => {
    const touch = await browser.newContext({
      hasTouch: true,
      viewport: { width: 390, height: 844 },
      storageState: await context.storageState(),
    });
    try {
      const page = await touch.newPage();
      await page.addInitScript(() => {
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
          if (type.startsWith('webgl')) return null;
          return Reflect.apply(original, this, [type, ...args]);
        } as typeof original;
      });
      await page.goto(server.url);
      await page.waitForSelector('[data-city-renderer="map"]');
      await page.getByRole('button', { name: 'Zoom in', exact: true }).tap();
      await page.getByRole('button', { name: 'Reset city', exact: true }).tap();
      const map = page.locator('[data-city-renderer="map"]');
      await map.scrollIntoViewIfNeeded();
      const bounds = (await map.boundingBox())!, x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
      const pixels = () => map.evaluate((el) => (el as HTMLCanvasElement).toDataURL());
      const before = await pixels(), cdp = await touch.newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 24, y: y + 20 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const panned = await pixels(); expect(panned).not.toBe(before);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x - 20, y, id: 1 }, { x: x + 20, y, id: 2 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 60, y, id: 1 }, { x: x + 60, y, id: 2 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(await pixels()).not.toBe(panned);
      expect(await page.locator('#overview-title').count()).toBe(1);
      await cdp.detach();
      await page.getByLabel('View', { exact: true }).selectOption('table');
      await page.locator('.city-table').getByRole('button', { name: 'src/ui/Dock.tsx', exact: true }).tap();
      await expect.poll(() => page.locator('#inspector-title').innerText()).toBe('Dock.tsx');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally {
      await touch.close();
    }
  });
  it('restores a file and tab from an allowlisted fragment and ignores others', async () => {
    const { page } = await openViewer();
    await page.waitForSelector('#overview-title');
    const loaded = await readArtifactDirectory(path.join(work, 'harbor-out'));
    if (!loaded.ok) throw new Error('invalid');
    const node = loaded.bundle.graphs.at(-1)!.nodes.find((n) => n.kind === 'file' && n.path === 'src/ui/Dock.tsx')!;
    await page.goto(`${server.url}#v=1&file=${node.lineageId}&tab=dependencies`);
    await expect.poll(() => page.locator('#inspector-title').innerText()).toBe('Dock.tsx');
    expect(await page.locator('[role="tab"][aria-selected="true"]').innerText()).toBe('Dependencies');
    const invalidUrl = `${server.url}#v=1&file=javascript:alert(1)&evil=1`;
    await page.goto(invalidUrl);
    await expect
      .poll(() => page.locator('[role="status"][aria-live="polite"]').innerText())
      .toContain('unsupported or invalid');
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('');
    // Same-document rejection normalizes the fragment. Start a new document to
    // exercise initial invalid-link admission without racing that normalization.
    await page.goto('about:blank');
    await page.goto(invalidUrl);
    await page.waitForSelector('#overview-title');
    await expect
      .poll(() => page.locator('[role="status"][aria-live="polite"]').innerText())
      .toContain('unsupported or invalid');
  });
});

/**
 * Gate G4 in a real browser (plan §17 P4.6): sampled snapshots, fixed plots, lineage-
 * preserving selection, tombstones, A/B comparison, history lenses and deep links, with
 * keyboard operation and automated accessibility checks. Harbor's authored story gives the
 * expectations: pricing.ts appears in commit 4 and changes in 5, 9 and 12; legacy.ts lives
 * from commit 3 to 11; Cargo.tsx is renamed to Manifest.tsx in commit 7.
 */
describe.runIf(browserAvailable && viewerBuilt)('history and comparison (Gate G4)', () => {
  let page: Page;
  let errors: string[];
  const active = () => page.locator('.timeline-frame[aria-current="step"]').getAttribute('aria-label');
  const goTo = async (n: number) => {
    await page.locator('.timeline-frame').nth(n - 1).click();
    await expect.poll(active).toMatch(new RegExp(`^Snapshot ${n} of 12`));
  };
  const choose = async (name: string) => {
    await page.getByRole('combobox', { name: 'Search files, packages and declarations' }).focus();
    await page.keyboard.press('Control+A');
    await page.keyboard.type(name);
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('#inspector-title').innerText()).toBe(name);
  };
  beforeAll(async () => {
    page = await context.newPage();
    errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    if (!signedIn) {
      await page.goto(server.sessionUrl);
      signedIn = true;
    }
    const url = new URL(server.url);
    url.searchParams.set('atlasBenchmark', '1');
    await page.goto(url.href);
    await page.waitForSelector('.timeline-strip');
    await page.waitForFunction(() => !!window.__atlasCity);
  });

  it('states the window, the sampling and the anchoring next to the strip', async () => {
    const summary = await page.locator('.timeline-summary').innerText();
    expect(summary).toContain('12 mainline commits');
    expect(summary).toContain('12 analyzed snapshots');
    expect(summary).toContain('first commit');
    await page.getByText('How to read history').click();
    const help = await page.locator('.timeline-help').innerText();
    expect(help).toContain('sampled');
    expect(help).toContain('one fixed plot');
    expect(await page.locator('.timeline-frame').count()).toBe(12);
    expect(await active()).toContain('selected commit');
  });

  it('keeps the camera and plots fixed and the lineage selected across snapshots (keyboard)', async () => {
    await choose('pricing.ts');
    const before = await page.evaluate(() => window.__atlasCity!.cameraState());
    await page.locator('.timeline-frame[aria-current="step"]').focus();
    for (let i = 0; i < 7; i++) await page.keyboard.press('ArrowLeft');
    await expect.poll(active).toMatch(/^Snapshot 5 of 12/);
    // Same lineage, earlier occurrence: still pricing.ts, now with 2 changed commits.
    await expect.poll(() => page.locator('#inspector-title').innerText()).toBe('pricing.ts');
    expect(await page.evaluate(() => window.__atlasCity!.cameraState())).toEqual(before);
    const loaded = await readArtifactDirectory(path.join(work, 'harbor-out'));
    if (!loaded.ok) throw new Error('invalid');
    expect((await page.evaluate(() => window.__atlasCity!.stats())).buildings).toBe(loaded.bundle.layout.frameState[4]!.files.length);
    await expect.poll(() => page.locator('[role="status"][aria-live="polite"]').innerText()).toContain('Snapshot 5 of 12: 2026-08-10');
    expect(page.url()).toContain(`frame=${loaded.bundle.manifest.frames[4]!.snapshotId}`);
    await page.getByRole('tab', { name: 'History' }).click();
    expect(await page.locator('.tabpanel').innerText()).toContain('2 of these happened up to the snapshot shown');
  });

  it('shows a tombstone with last and next appearance instead of a substitute', async () => {
    await goTo(11);
    await choose('legacy.ts');
    await goTo(12);
    await page.waitForSelector('.tombstone');
    expect(await page.locator('.tombstone .inspector-path').innerText()).toContain('Not present in snapshot 12');
    await page.getByRole('button', { name: /Last seen: snapshot 11 as src\/ui\/legacy\.ts/ }).click();
    await expect.poll(active).toMatch(/^Snapshot 11 of 12/);
    await expect.poll(() => page.locator('#inspector-title').innerText()).toBe('legacy.ts');
  });

  it('follows a rename on one plot and lists the rename in the file history', async () => {
    await goTo(12);
    await choose('Manifest.tsx');
    const point = await page.evaluate(() => {
      const city = window.__atlasCity!;
      return city.stats().buildings;
    });
    expect(point).toBeGreaterThan(0);
    await page.getByRole('tab', { name: 'History' }).click();
    const panel = await page.locator('.tabpanel').innerText();
    expect(panel).toContain('git-rename');
    expect(panel).toContain('src/ui/Cargo.tsx → src/ui/Manifest.tsx');
    await goTo(4);
    await expect.poll(() => page.locator('#inspector-title').innerText()).toBe('Cargo.tsx');
  });

  it('compares A -> B with exact differences, ghosts and separate interval activity', async () => {
    await goTo(12);
    await page.getByRole('button', { name: 'Compare snapshots…' }).click();
    await page.waitForSelector('.compare');
    await page.locator('.compare-pick select').first().selectOption('5');
    await expect.poll(() => page.locator('.compare-summary').innerText()).toContain('+ 4 added');
    const summary = await page.locator('.compare-summary').innerText();
    for (const part of ['− 1 deleted', '↪ 1 renamed', '✎ 4 content changed', '17 unchanged']) expect(summary).toContain(part);
    const stats = await page.evaluate(() => window.__atlasCity!.stats());
    expect(stats.ghosts).toBe(1);
    expect(stats.added).toBe(4);
    const text = await page.locator('.compare').innerText();
    expect(text).toContain('src/ui/Cargo.tsx → src/ui/Manifest.tsx');
    expect(text).toMatch(/mainline activity in this interval/i);
    expect(await page.locator('.compare section').last().locator('li').count()).toBe(6);
    expect(await audit(page)).toEqual([]);
    // Explicit timeline navigation changes B and the comparison legend together.
    await goTo(11);
    await expect.poll(() => page.locator('.compare-pick select').last().inputValue()).toBe('10');
    await expect.poll(() => page.locator('.compare-direction').innerText()).toContain('to snapshot 11');
    await page.getByRole('button', { name: 'Close comparison' }).first().click();
    await expect.poll(async () => (await page.evaluate(() => window.__atlasCity!.stats())).ghosts).toBe(0);
  });

  it('colors churn and hotspot lenses with explained, never invented, values', async () => {
    await goTo(12);
    await page.getByLabel('Lens', { exact: true }).selectOption('churn');
    expect(await page.locator('.city-legend').innerText()).toContain('counted only up to the snapshot shown');
    await page.getByLabel('Lens', { exact: true }).selectOption('hotspot');
    expect(await page.locator('.city-legend').innerText()).toContain('not a defect');
    await choose('pricing.ts');
    await page.getByRole('tab', { name: 'Overview' }).click();
    const overview = await page.locator('.tabpanel').innerText();
    expect(overview).toMatch(/hotspot score/i);
    expect(overview).toContain('Changed commits');
    expect(overview).toMatch(/0\.35/);
    await page.getByLabel('Lens', { exact: true }).selectOption('structure');
  });

  it('opens a historical frame and lineage from a deep link', async () => {
    const loaded = await readArtifactDirectory(path.join(work, 'harbor-out'));
    if (!loaded.ok) throw new Error('invalid');
    const sixth = loaded.bundle.graphs[5]!;
    const pricing = sixth.nodes.find((n) => n.kind === 'file' && n.path === 'src/server/pricing.ts')!;
    const fresh = await context.newPage();
    try {
      await fresh.goto(`${server.url}#v=1&frame=${sixth.snapshotId}&file=${pricing.lineageId}&tab=history`);
      // Both navigations create a cold page/worker/frame load. Wait for startup;
      // cached-frame performance has its own unchanged, separately measured budget.
      await fresh.locator('.topbar .repo-name').waitFor({ timeout: 60_000 });
      await expect.poll(() => fresh.locator('.timeline-frame[aria-current="step"]').getAttribute('aria-label'), { timeout: 30_000 }).toMatch(/^Snapshot 6 of 12/);
      await expect.poll(() => fresh.locator('#inspector-title').innerText()).toBe('pricing.ts');
      expect(await fresh.locator('[role="tab"][aria-selected="true"]').innerText()).toBe('History');
      // An unknown frame is rejected rather than approximated.
      await fresh.goto('about:blank');
      await fresh.goto(`${server.url}#v=1&frame=snap_${'0'.repeat(64)}`);
      await fresh.locator('.topbar .repo-name').waitFor({ timeout: 60_000 });
      await expect.poll(() => fresh.locator('[role="status"][aria-live="polite"]').innerText(), { timeout: 30_000 }).toContain('unsupported or invalid');
    } finally { await fresh.close(); }
  });

  it('never autoplays; reduced motion removes stepping; 320px reflows', async () => {
    const reduced = await browser.newContext({ viewport: { width: 320, height: 800 }, reducedMotion: 'reduce' });
    try {
      const small = await reduced.newPage();
      await small.goto(server.sessionUrl.replace(/_session\/.*/, ''));
      const cookies = await context.cookies();
      await reduced.addCookies(cookies);
      await small.goto(server.url);
      await small.waitForSelector('.timeline-strip');
      expect(await small.getByRole('button', { name: 'Step through' }).count()).toBe(0);
      expect(await small.locator('.timeline-frame[aria-current="step"]').getAttribute('aria-label')).toContain('Snapshot 12 of 12');
      expect(await small.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await small.getByRole('button', { name: '‹ Earlier' }).click();
      await expect.poll(() => small.locator('.timeline-frame[aria-current="step"]').getAttribute('aria-label')).toMatch(/^Snapshot 11 of 12/);
      expect(await audit(small)).toEqual([]);
    } finally {
      await reduced.close();
    }
  });

  it('logged no page errors during the history journeys', () => {
    expect(errors).toEqual([]);
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
      res.writeHead(200, {
        'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html',
      });
      createReadStream(file).pipe(res);
    });
    await new Promise<void>((r) => staticServer.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(staticServer.address() as { port: number }).port}`;
  });
  afterAll(() => {
    // Browser keep-alive connections must not hold the server open.
    return new Promise<void>((r) => {
      staticServer.close(() => r());
      staticServer.closeAllConnections();
    });
  });

  it('validates picked files locally and sends nothing anywhere', async () => {
    // A separate context: no session cookie, no server API, just static files.
    const isolated = await browser.newContext();
    try {
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
      expect(after.every((r) => r.method === 'GET' && r.url.startsWith(origin) && /\/assets\/.*\.js$/.test(r.url))).toBe(
        true,
      );
      expect(requests.filter((r) => r.method !== 'GET')).toEqual([]);
      const loaded = await readArtifactDirectory(path.join(work, 'harbor-out'));
      expect(await page.locator('#overview-title').innerText()).toBe(
        loaded.ok ? loaded.bundle.manifest.repo.displayName : '?',
      );
    } finally { await isolated.close(); }
  });
});
