import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, firefox, webkit, type Browser, type BrowserContext, type BrowserType, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readArtifactDirectory } from '@atlas/artifact/node';
import { ARTIFACT_VERSION, GRAPH_SCHEMA_VERSION } from '@atlas/schema';
import { createScanEvidence, parseQualityReport, qualityTarget } from '@atlas/graph';
import { run, type CliIO } from '@atlas/cli';
import { viewerDirectory } from '../src/commands/serve.js';
import { SourceAttachment } from '../src/server/source.js';
import { startViewerServer, type RunningViewerServer } from '../src/server/server.js';
import { buildDemoRepository, createGitFixture, type GitFixture } from '@atlas/test-fixtures';
import { audit } from '../../../apps/web/test/audit.js';
import type {} from '../../../apps/web/src/city/probe.js';

// Every poll here checks a correct state after a real browser action, not a latency
// budget: interaction budgets are measured on reference hardware. On CI's GPU-less
// runners (software WebGL), correct states were observed arriving after Vitest's default
// one-second poll, most often on macOS (ADR-068). The assertions are unchanged.
vi.setConfig({ expect: { poll: { timeout: 5_000 } } });

/**
 * Gate G2 journeys in a real browser, keyboard only (plan §17 P2.6): find a file, inspect
 * its static dependencies and limitations, and explain a diagnostic. Every request is
 * recorded to prove nothing leaves the loopback origin, and a browser-only artifact open
 * proves picked files are not uploaded.
 */
const ENGINES: Record<string, BrowserType> = { chromium, firefox, webkit };
/** The engine that runs these journeys: Chromium by default; CI also runs Firefox and WebKit (ADR-069). */
const engineName = process.env['ATLAS_E2E_BROWSER'] ?? 'chromium';
const engine = ENGINES[engineName];
if (!engine) throw new Error(`ATLAS_E2E_BROWSER must be one of ${Object.keys(ENGINES).join(', ')}, not ${engineName}`);
const browserAvailable = existsSync(engine.executablePath());
let viewerBuilt = true;
try {
  viewerDirectory();
} catch {
  viewerBuilt = false;
}
if (process.env['ATLAS_REQUIRE_BROWSER_TESTS'] === '1' && (!browserAvailable || !viewerBuilt)) {
  throw new Error(
    `Required browser tests need installed ${engineName} and a built viewer. Run playwright install ${engineName} and pnpm build:web.`,
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
  // GPU-less CI runners get software WebGL: SwiftShader in Chromium. Firefox needs a display
  // for Mesa's software OpenGL, so CI runs it headed inside Xvfb with its software-renderer
  // blocklist overridden (ADR-069). WebKit needs nothing.
  const ci = Boolean(process.env['CI']);
  browser = await engine.launch({
    headless: process.env['ATLAS_E2E_HEADED'] !== '1',
    args: engineName === 'chromium' && ci ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [],
    ...(engineName === 'firefox' && ci ? { firefoxUserPrefs: { 'webgl.force-enabled': true } } : {}),
  });
  context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  demo?.dispose();
  if (work) rmSync(work, { recursive: true, force: true });
});

async function openViewer(): Promise<{ page: Page; requests: string[]; errors: string[] }> {
  expect(context.pages()).toHaveLength(0);
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

/**
 * What the page shows, for a poll that timed out: a failure then says what the viewer
 * did instead (for example, fell back from 3D), not only that it did not succeed in time.
 */
async function pageState(page: Page, errors: readonly string[]): Promise<string> {
  const shown = await page.evaluate(() => {
    const text = (selector: string) => document.querySelector(selector)?.textContent?.trim().slice(0, 160) ?? null;
    let stats: unknown = null;
    try {
      stats = window.__atlasCity?.stats() ?? null;
    } catch (error) {
      stats = `stats() threw: ${String(error)}`;
    }
    return { hash: location.hash, inspector: text('#inspector-title'), city3d: window.__atlasCity !== undefined, stats, cityMessage: text('.city-message'), status: text('[role="status"][aria-live="polite"]') };
  });
  return JSON.stringify({ ...shown, pageErrors: errors.slice(-5) });
}
/**
 * The page does not scroll sideways. A failure names the widths and the elements that
 * stick out, so an intermittent overflow can be explained rather than rerun away.
 */
async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const layout = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth,
    outside: [...document.querySelectorAll('body *')]
      .filter((el) => el.getBoundingClientRect().right > innerWidth + 0.5)
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${[...el.classList].map((c) => `.${c}`).join('')} right=${Math.round(el.getBoundingClientRect().right)}`),
  }));
  expect(layout.scrollWidth, JSON.stringify(layout)).toBeLessThanOrEqual(layout.innerWidth);
}
const explain = (page: Page, errors: readonly string[]) => async (error: unknown) => {
  throw new Error(`${error instanceof Error ? error.message : String(error)}
page state: ${await pageState(page, errors)}`, { cause: error });
};

/** Reads the provenance JSON from a PNG `iTXt` chunk, parsed here independently of the viewer. */
function embeddedProvenance(png: Buffer): Record<string, unknown> {
  for (let at = 8; at + 12 <= png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.subarray(at + 4, at + 8).toString('latin1');
    if (type === 'iTXt') {
      const data = png.subarray(at + 8, at + 8 + length);
      const keyword = data.subarray(0, data.indexOf(0)).toString('latin1');
      if (keyword === 'atlas.provenance') {
        // keyword NUL, flag 0, method 0, language NUL, translated keyword NUL, text
        let i = data.indexOf(0) + 3;
        i = data.indexOf(0, i) + 1;
        i = data.indexOf(0, i) + 1;
        return JSON.parse(data.subarray(i).toString('utf8')) as Record<string, unknown>;
      }
    }
    if (type === 'IEND') break;
    at += 12 + length;
  }
  throw new Error('The PNG carries no atlas.provenance text');
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

  afterAll(async () => { await page?.close(); });

  beforeAll(async () => {
    ({ page, requests, errors } = await openViewer());
    await page.waitForSelector('#overview-title');
    await capture(page, 'overview');
  });

  it('J1: finds a named file by search', async () => {
    expect(await audit(page, 'repository-overview')).toEqual([]);
    await page.keyboard.press('/');
    await page.keyboard.type('pricing');
    await expect
      .poll(() => page.locator('[role="option"][aria-selected="true"]').innerText())
      .toContain('src/server/pricing.ts');
    expect(await audit(page, 'search-results')).toEqual([]);
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('#inspector-title').innerText()).toBe('pricing.ts');
    // Focus moves deliberately to the inspector heading; the live region announces it.
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('inspector-title');
    await expect
      .poll(() => page.locator('[role="status"][aria-live="polite"]').innerText())
      .toContain('src/server/pricing.ts');
    expect(await audit(page, 'file-overview')).toEqual([]);
  });

  it('replaces the previous query and selects it with Enter, every time', async () => {
    // Enter could arrive before React rendered the newest results, and the choice was then
    // lost: 5 of 12 attempts in WebKit before the fix (ADR-069).
    const box = page.getByRole('combobox', { name: 'Search files, packages and declarations' });
    for (const name of ['Dock.tsx', 'pricing.ts', 'Dock.tsx', 'pricing.ts', 'Dock.tsx', 'pricing.ts']) {
      await box.focus();
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.type(name);
      await page.keyboard.press('Enter');
      await expect.poll(() => page.locator('#inspector-title').innerText()).toBe(name);
    }
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
    expect(await audit(page, 'file-dependencies')).toEqual([]);
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
      await page.keyboard.press('ControlOrMeta+A');
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
      for (const detail of await page.locator('.finding-detail').all()) {
        if (await detail.getAttribute('open') === null) await detail.locator('summary').click();
      }
      expect(await audit(page, `file-findings-${file}`)).toEqual([]);
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
    expect(await audit(page, 'source-dialog')).toEqual([]);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator('.source-panel').count()).toBe(0);
  });

  it('keeps source loading and unavailable states accessible, then restores the opener', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const pattern = '**/api/source?*';
    await page.route(pattern, async (route) => {
      await held;
      // An unreadable response follows the client's real error path without a network console error.
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{' });
    });
    const opener = page.getByRole('button', { name: 'View source at this line', exact: true }).first();
    try {
      await opener.focus();
      await page.keyboard.press('Enter');
      await page.getByRole('status').filter({ hasText: 'Loading source…' }).waitFor();
      expect(await audit(page, 'source-loading')).toEqual([]);
      release();
      await page.getByRole('status').filter({ hasText: 'Source unavailable (invalid response).' }).waitFor();
      expect(await audit(page, 'source-unavailable')).toEqual([]);
      await page.keyboard.press('Escape');
      expect(await page.locator('.source-panel').count()).toBe(0);
      expect(await opener.evaluate((el) => el === document.activeElement)).toBe(true);
    } finally {
      release();
      await page.unroute(pattern);
    }
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
    // WebKit also reports in-memory `blob:` URLs of this origin; they never reach a network.
    expect(requests.filter((u) => !u.startsWith(origin) && !u.startsWith(`blob:${origin}/`))).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe.runIf(browserAvailable && viewerBuilt)('production miniature city', () => {
  let page: Page;
  afterAll(async () => { await page?.close(); });
  beforeAll(async () => {
    expect(context.pages()).toHaveLength(0);
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
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type(name);
    await page.keyboard.press('Enter');
    await page.waitForSelector('#inspector-title');
    await expect.poll(() => page.locator('#inspector-title').innerText()).toBe(name);
  };
  it('shows real artifact buildings and bounded draw calls', async () => {
    const loaded = await readArtifactDirectory(path.join(work, 'harbor-out'));
    if (!loaded.ok) throw new Error('invalid');
    // Draw calls are counted per finished frame. Read them only once a steady frame exists:
    // WebKit could be read mid-bake, when 0 calls passed the bound vacuously (ADR-079).
    const steady = async (lite: boolean) => {
      await expect.poll(() => page.evaluate(() => {
        const s = window.__atlasCity?.stats();
        return s ? { lite: s.lite, drawn: s.drawCalls > 0, settled: s.occlusion !== 'baking' && !s.cameraMoving } : null;
      }), { timeout: 15_000 }).toMatchObject({ lite, drawn: true, settled: true });
      return page.evaluate(() => window.__atlasCity!.stats());
    };
    const initial = await page.evaluate(() => window.__atlasCity!.stats().lite);
    const stats = await steady(initial);
    expect(stats.buildings).toBe(loaded.bundle.layout.frameState.at(-1)!.files.length);
    // The default scene is held to the master plan's budget (<= 150 for a medium default
    // view). Full detail is animated and its count moves with what is in view.
    expect(stats.drawCalls).toBeLessThanOrEqual(150);
    expect(stats.pickCells).toBeGreaterThan(0);
    expect(await page.getByRole('group', { name: 'City controls', exact: true }).count()).toBe(1);
    expect(await page.getByRole('group', { name: 'City lens legend', exact: true }).count()).toBe(1);
    expect(await audit(page, 'city-3d')).toEqual([]);
    // The low-detail scene, which software renderers get when their name reveals them and
    // anyone can choose, stays compact: under 30 calls for Harbor in every engine (ADR-041).
    const lowDetail = page.getByRole('checkbox', { name: 'Low detail' });
    await lowDetail.check();
    expect((await steady(true)).drawCalls).toBeLessThan(30);
    await lowDetail.uncheck();
    await steady(initial);
  });
  it('keeps the explorer inside the window and names the repository in the title (ADR-058)', async () => {
    // Visually hidden tree labels once grew the page to thousands of pixels, so a wheel over
    // the header slid the whole explorer away. Each panel scrolls; the page itself does not.
    expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeLessThanOrEqual(0);
    await page.mouse.move(640, 24);
    await page.mouse.wheel(0, 800);
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => scrollY)).toBe(0);
    const loaded = await readArtifactDirectory(path.join(work, 'harbor-out'));
    if (!loaded.ok) throw new Error('invalid');
    expect(await page.title()).toBe(`${loaded.bundle.manifest.repo.displayName} as a city · ATLAS`);
  });
  it('reads city diagnostics without querying the graphics driver', async () => {
    const result = await page.evaluate(() => {
      const city = window.__atlasCity!;
      const canvas = document.querySelector<HTMLCanvasElement>('.city-canvas')!;
      const gl = canvas.getContext('webgl2')!;
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      const expectedRenderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unknown';
      const getExtension = gl.getExtension, getParameter = gl.getParameter;
      const calls: string[] = [];
      gl.getExtension = function (this: WebGL2RenderingContext, name: string) {
        calls.push('getExtension');
        return Reflect.apply(getExtension, this, [name]);
      } as typeof getExtension;
      gl.getParameter = function (name) {
        calls.push('getParameter');
        return getParameter.call(this, name);
      };
      try {
        return { stats: city.stats(), expectedRenderer, calls };
      } finally {
        gl.getExtension = getExtension;
        gl.getParameter = getParameter;
      }
    });
    expect(result.calls).toEqual([]);
    expect(result.stats.renderer).toBe(result.expectedRenderer);
    expect(result.stats.buildings).toBeGreaterThan(0);
  });
  it('keeps primary action text readable throughout enabled and disabled colour changes', async () => {
    const controls = await browser.newContext();
    try {
      const sample = await controls.newPage();
      await sample.setContent('<button class="button primary" style="margin:40px">Analyze repository</button>');
      // Exercise the actual shared CSS; pause state transitions at fixed fractions.
      await sample.addStyleTag({ path: path.resolve('apps/web/src/styles/app.css') });
      for (const theme of ['light', 'dark'] as const) {
        await sample.emulateMedia({ colorScheme: theme });
        const readings = await sample.evaluate(() => {
          const button = document.querySelector('button')!;
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 1;
          const context = canvas.getContext('2d')!;
          const luminance = (color: string) => {
            context.fillStyle = color;
            context.fillRect(0, 0, 1, 1);
            const [r, g, b] = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((v) => {
              const c = v / 255;
              return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
          };
          const rows: { fromDisabled: boolean; fraction: number; ratio: number; color: string; background: string }[] = [];
          for (const fromDisabled of [true, false]) {
            button.disabled = fromDisabled;
            for (const animation of button.getAnimations()) animation.finish();
            void getComputedStyle(button).backgroundColor;
            button.disabled = !fromDisabled;
            const animations = button.getAnimations();
            for (const animation of animations) animation.pause();
            for (const fraction of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
              for (const animation of animations) animation.currentTime = Number(animation.effect!.getTiming().duration) * fraction;
              const style = getComputedStyle(button), color = style.color, background = style.backgroundColor;
              const a = luminance(color), b = luminance(background);
              rows.push({ fromDisabled, fraction, color, background, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) });
            }
            for (const animation of animations) animation.finish();
          }
          return rows;
        });
        for (const reading of readings) expect(reading.ratio, JSON.stringify({ theme, ...reading })).toBeGreaterThanOrEqual(4.5);
      }
    } finally {
      await controls.close();
    }
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
    // Focus glides the cinematic camera; read screen positions once it settles.
    await page.waitForFunction(() => !window.__atlasCity!.stats().cameraMoving);
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
    for (const detail of await page.locator('.city-details').all()) {
      if (await detail.getAttribute('open') === null) await detail.locator('summary').click();
    }
    expect(await audit(page, 'reachable-files-and-external-list')).toEqual([]);
    for (const detail of await page.locator('.city-details').all()) {
      if (await detail.getAttribute('open') !== null) await detail.locator('summary').click();
    }
  });
  it('exports a bounded PNG and provenance without WebGL dependency', async () => {
    await page.getByLabel('View', { exact: true }).selectOption('map');
    await page.waitForSelector('[data-city-renderer="map"]');
    const downloads: import('playwright').Download[] = [];
    page.on('download', (d) => downloads.push(d));
    await page.locator('.city-share summary').click();
    await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
    await expect.poll(() => page.locator('.city-message').innerText(), { timeout: 5000 }).toContain('Exported PNG');
    // One download carries its own provenance (ADR-047); metadata is a separate, explicit action.
    await expect.poll(() => downloads.length).toBe(1);
    const png = downloads[0]!;
    expect(png.suggestedFilename()).toBe('atlas-city.png');
    const { readFileSync } = await import('node:fs');
    const bytes = readFileSync((await png.path())!);
    expect(bytes.subarray(1, 4).toString()).toBe('PNG');
    expect(bytes.readUInt32BE(16)).toBeLessThanOrEqual(2048);
    expect(bytes.readUInt32BE(20)).toBeLessThanOrEqual(2048);
    expect(bytes.readUInt32BE(16) * bytes.readUInt32BE(20)).toBeLessThanOrEqual(4_000_000);
    const embedded = embeddedProvenance(bytes);
    await page.getByRole('button', { name: 'Export metadata', exact: true }).click();
    await expect.poll(() => downloads.length).toBe(2);
    const json = downloads[1]!;
    expect(json.suggestedFilename()).toBe('atlas-city.metadata.json');
    const metadata = JSON.parse(readFileSync((await json.path())!, 'utf8'));
    expect({ ...embedded, camera: null }).toEqual({ ...metadata, camera: null });
    expect(metadata.lens).toBe('fan-in');
    expect(metadata.mode).toBe('map');
    expect(metadata.selectedPath).toBe('src/server/pricing.ts');
    expect(metadata.layoutVersion).toBe('atlas.layout/1.1.0');
    const artifact = await readArtifactDirectory(path.join(work, 'harbor-out'));
    if (!artifact.ok) throw new Error('Invalid export reference artifact');
    expect(metadata.artifactVersion).toBe(ARTIFACT_VERSION);
    expect(metadata.schemaVersion).toBe(GRAPH_SCHEMA_VERSION);
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
    expect(await audit(page, 'context-loss-map')).toEqual([]);
  });
  it('offers a semantic file table and passes automated AA checks', async () => {
    await page.getByLabel('View', { exact: true }).selectOption('table');
    expect(await page.locator('.city-table caption').innerText()).toContain('Included files');
    expect(await page.locator('.city-table').innerText()).toContain('src/server/pricing.ts');
    expect(await audit(page, 'file-table')).toEqual([]);
  });
  it('reflows controls at 320px and works with reduced motion and canvas disabled', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 320, height: 800 });
    await expectNoSidewaysScroll(page);
    await page.addStyleTag({ content: 'canvas { display: none !important; }' });
    await page.locator('.city-table').getByRole('button', { name: 'src/ui/Dock.tsx', exact: true }).click();
    await expect.poll(() => page.locator('#inspector-title').innerText()).toBe('Dock.tsx');
    expect(await audit(page, 'narrow-reduced-motion-table')).toEqual([]);
  });
});

/**
 * Beta 2 activation (ADR-047): a guided start whose tasks name real targets, counts that
 * name their units, and an expanded workspace that keeps search and evidence.
 */
describe.runIf(browserAvailable && viewerBuilt)('guided start and workspace', () => {
  let page: Page;
  let errors: string[];
  afterAll(async () => { await page?.close(); });
  beforeAll(async () => {
    ({ page, errors } = await openViewer());
    await page.waitForSelector('#overview-title');
  });

  it('starts with tasks that select their named targets', async () => {
    const tasks = page.getByRole('list', { name: 'Suggested tasks' });
    const trace = tasks.getByRole('button', { name: /Trace a file’s dependencies/ });
    const named = (await trace.innerText()).split('\n')[1]!.split(',')[0]!.trim();
    await trace.click();
    await expect.poll(() => page.locator('#inspector-title').innerText()).toBe(named);
    expect(await page.locator('[role="tab"][aria-selected="true"]').innerText()).toBe('Dependencies');
    expect(await page.getByRole('combobox', { name: 'Dependencies', exact: true }).inputValue()).toBe('both');
    const note = await page.locator('.count-note').innerText();
    expect(note).toMatch(/internal import statements? reach \d+ files?/);
    expect(note).toContain('type-only included');
    await tasks.getByRole('button', { name: /Explore a package/ }).click();
    await expect.poll(() => page.locator('[role="tab"][aria-selected="true"]').innerText()).toBe('Overview');
    await page.getByRole('button', { name: 'Hide', exact: true }).click();
    expect(await page.locator('.start').count()).toBe(0);
    await page.getByRole('button', { name: 'Show guided start' }).click();
    expect(await page.locator('.start').count()).toBe(1);
  });

  it('expands into a workspace that keeps search, controls and evidence', async () => {
    await page.getByRole('button', { name: 'Expand city', exact: true }).click();
    await page.waitForSelector('.app.is-workspace');
    const visible = async (selector: string) => page.locator(selector).first().isVisible();
    expect(await visible('.search input')).toBe(true);
    expect(await visible('.city-inspector')).toBe(true);
    expect(await page.getByLabel('Lens', { exact: true }).isVisible()).toBe(true);
    expect(await visible('.sidebar')).toBe(false);
    // find → select → explain without leaving the workspace
    await page.getByRole('combobox', { name: 'Search files, packages and declarations' }).focus();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('pricing.ts');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('#inspector-title').innerText()).toBe('pricing.ts');
    expect(await visible('.app.is-workspace')).toBe(true);
    expect(await audit(page, 'workspace-expanded')).toEqual([]);
    await page.getByRole('button', { name: 'Hide the evidence panel' }).click();
    expect(await visible('.city-inspector')).toBe(false);
    expect(await audit(page, 'workspace-evidence-hidden')).toEqual([]);
    await page.getByRole('button', { name: 'Show the evidence panel' }).click();
    await page.locator('.city-surface, [data-city-renderer]').first().focus();
    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator('.app.is-workspace').count()).toBe(0);
    expect(await page.locator('#inspector-title').innerText()).toBe('pricing.ts');
    expect(await audit(page, 'workspace-restored')).toEqual([]);
  });

  it('highlights files by path pattern, with an exact count the table agrees with', async () => {
    await page.getByRole('combobox', { name: 'View', exact: true }).selectOption('table');
    const highlight = page.getByRole('searchbox', { name: 'Highlight paths' });
    await highlight.fill('src/server, !*.test.ts');
    const note = await page.locator('#city-pattern-help').innerText();
    const [, matched, total] = /Highlight: (\d+) of (\d+) files match/.exec(note)!;
    expect(Number(matched)).toBeGreaterThan(0);
    expect(await page.locator('.city-table caption').innerText()).toContain(`${matched} displayed of ${total}`);
    const paths = await page.locator('.city-table tbody th').allInnerTexts();
    expect(paths.length).toBe(Math.min(40, Number(matched)));
    expect(paths.every((p) => p.startsWith('src/server/') && !p.endsWith('.test.ts'))).toBe(true);
    await highlight.fill('a'.repeat(300));
    expect(await page.locator('#city-pattern-help').innerText()).toContain('longer than 256');
    expect(await audit(page, 'path-pattern-error')).toEqual([]);
    await highlight.fill('src/server');
  });

  it('counts the buildings in every legend band', async () => {
    await page.getByRole('combobox', { name: 'Lens', exact: true }).selectOption('fan-in');
    const counts = (await page.locator('.city-legend .legend-count').allInnerTexts()).map((t) => Number(t.replaceAll(',', '')));
    const total = Number(/of ([\d,]+) files match/.exec(await page.locator('#city-pattern-help').innerText())![1]!.replaceAll(',', ''));
    expect(counts).toHaveLength(6);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(total);
  });

  it('saves, applies, exports and imports named views', async () => {
    const views = page.locator('.city-saved');
    await views.locator('summary').click();
    expect(await audit(page, 'saved-views-menu')).toEqual([]);
    await views.getByRole('textbox', { name: 'Name' }).fill('Server consumers');
    await views.getByRole('button', { name: 'Save current view' }).click();
    await expect.poll(() => views.locator('[role="status"]').innerText()).toContain('Saved the view');
    // Change everything the view holds, then apply it again.
    await page.getByRole('combobox', { name: 'Lens', exact: true }).selectOption('structure');
    await page.getByRole('searchbox', { name: 'Highlight paths' }).fill('');
    await page.getByRole('combobox', { name: 'View', exact: true }).selectOption('map');
    await views.getByRole('button', { name: 'Server consumers', exact: true }).click();
    await expect.poll(() => page.getByRole('combobox', { name: 'Lens', exact: true }).inputValue()).toBe('fan-in');
    expect(await page.getByRole('combobox', { name: 'View', exact: true }).inputValue()).toBe('table');
    expect(await page.getByRole('searchbox', { name: 'Highlight paths' }).inputValue()).toBe('src/server');
    const download = page.waitForEvent('download');
    await views.getByRole('button', { name: 'Export views' }).click();
    const file = await (await download).path();
    const { readFileSync } = await import('node:fs');
    const exported = JSON.parse(readFileSync(file!, 'utf8'));
    expect(exported.format).toBe('atlas.views/1');
    expect(exported.views[0]).toMatchObject({ name: 'Server consumers', lens: 'fan-in', mode: 'table', pattern: 'src/server' });
    await views.getByRole('button', { name: 'Delete the view Server consumers' }).click();
    expect(await views.getByRole('button', { name: 'Server consumers', exact: true }).count()).toBe(0);
    await views.locator('input[type="file"]').setInputFiles(file!);
    await expect.poll(() => views.locator('[role="status"]').innerText()).toContain('Imported 1 view');
    expect(await audit(page, 'saved-views-imported')).toEqual([]);
    expect(await views.getByRole('button', { name: 'Server consumers', exact: true }).count()).toBe(1);
    await views.locator('summary').click();
    await page.getByRole('searchbox', { name: 'Highlight paths' }).fill('');
    await page.getByRole('combobox', { name: 'View', exact: true }).selectOption('3d');
    expect(await audit(page, 'saved-views-restored')).toEqual([]);
  });

  it('focuses on a folder and hides paths, keeping every plot fixed (ADR-051)', async () => {
    const view = page.getByRole('combobox', { name: 'View', exact: true });
    const caption = async () => /(\d+) displayed of (\d+)/.exec(await page.locator('.city-table caption').innerText())!.slice(1).map(Number) as [number, number];
    await page.getByRole('searchbox', { name: 'Highlight paths' }).fill('');
    await view.selectOption('table');
    const [, total] = await caption();
    await view.selectOption('map');
    await page.waitForSelector('[data-city-renderer="map"]');
    await page.getByRole('combobox', { name: 'Search files, packages and declarations' }).fill('pricing.ts');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('#inspector-title').innerText()).toBe('pricing.ts');
    const crumbs = page.locator('.city-trail button');
    await crumbs.last().click();
    const focus = page.getByRole('button', { name: /^Focus on / });
    const folder = (await focus.getAttribute('aria-label'))!.replace('Focus on ', '');
    await focus.click();
    await view.selectOption('table');
    const [shown] = await caption();
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(total);
    const rows = await page.locator('.city-table tbody th').allInnerTexts();
    expect(rows.every((p) => p.startsWith(`${folder}/`))).toBe(true);
    expect(await page.locator('.city-table caption').innerText()).toContain(`${total - shown} hidden by the scope`);
    const scope = page.locator('.city-scope');
    await scope.locator('summary').click();
    expect(await scope.locator('summary').innerText()).toContain(`${total - shown} hidden`);
    await scope.getByRole('textbox', { name: 'Hide paths' }).fill('*.test.ts, *.spec.ts');
    const [afterHide] = await caption();
    expect(afterHide).toBeLessThanOrEqual(shown);
    expect((await page.locator('.city-table tbody th').allInnerTexts()).some((p) => /\.(test|spec)\.ts$/.test(p))).toBe(false);
    expect(await audit(page, 'scope-menu')).toEqual([]);
    await scope.getByRole('button', { name: 'Show everything' }).click();
    expect((await caption())[0]).toBe(total);
    await scope.locator('summary').click();
    await view.selectOption('3d');
  });

  it('colours by any metric, with editable bands, a distribution and built-in views (ADR-052)', async () => {
    const lens = page.getByRole('combobox', { name: 'Lens', exact: true });
    const legendCounts = async () => (await page.locator('.city-legend .legend-count').allInnerTexts()).map((t) => Number(t.replaceAll(',', '')));
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    await lens.selectOption('code-lines');
    await expect.poll(() => page.locator('.city-legend').innerText()).toContain('0-49');
    const total = sum(await legendCounts());
    expect(total).toBeGreaterThan(0);
    const bands = page.locator('.city-bands');
    await bands.locator('summary').click();
    expect(await bands.getByRole('img').getAttribute('aria-label')).toMatch(/^Distribution over the files shown: 0-49: \d+/);
    await bands.getByRole('spinbutton', { name: 'Band 2 starts at' }).fill('10');
    await expect.poll(() => page.locator('.city-legend').innerText()).toContain('0-9');
    expect(sum(await legendCounts())).toBe(total);
    expect(await bands.locator('summary').innerText()).toContain('custom');
    // An invalid edit is reported and the last valid bands stay in use.
    await bands.getByRole('spinbutton', { name: 'Band 3 starts at' }).fill('5');
    expect(await page.locator('#bands-problem').innerText()).toContain('must start above');
    expect(await audit(page, 'bands-invalid-input')).toEqual([]);
    expect(await page.locator('.city-legend').innerText()).toContain('0-9');
    await bands.getByRole('button', { name: 'Even split' }).click();
    expect(sum(await legendCounts())).toBe(total);
    expect(await audit(page, 'bands-distribution')).toEqual([]);
    await bands.getByRole('button', { name: 'Reset' }).click();
    await expect.poll(() => page.locator('.city-legend').innerText()).toContain('0-49');
    await bands.locator('summary').click();
    const saved = page.locator('.city-saved');
    await saved.locator('summary').click();
    await saved.getByRole('button', { name: 'Most depended on', exact: true }).click();
    expect(await lens.inputValue()).toBe('fan-in');
    await saved.getByRole('button', { name: 'Largest files', exact: true }).click();
    expect(await lens.inputValue()).toBe('code-lines');
    expect(await page.getByRole('combobox', { name: 'Display filter' }).inputValue()).toBe('source');
    await saved.locator('summary').click();
    await page.getByRole('combobox', { name: 'Display filter' }).selectOption('all');
    await lens.selectOption('structure');
  });

  it('marks a folder with a colour and a note, lists it, and shares it as a file (ADR-053)', async () => {
    const view = page.getByRole('combobox', { name: 'View', exact: true });
    await view.selectOption('map');
    await page.waitForSelector('[data-city-renderer="map"]');
    await page.getByRole('combobox', { name: 'Search files, packages and declarations' }).fill('pricing.ts');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('#inspector-title').innerText()).toBe('pricing.ts');
    await page.locator('.city-trail button').last().click();
    const notes = page.locator('.city-notes');
    await notes.locator('summary').click();
    expect(await audit(page, 'notes-menu')).toEqual([]);
    const target = await notes.locator('form code').innerText();
    await notes.getByRole('radio', { name: 'Green' }).check();
    await notes.getByRole('textbox', { name: 'Note' }).fill('Pricing rules live here.');
    await notes.getByRole('button', { name: 'Mark', exact: true }).click();
    expect(await notes.locator('summary').innerText()).toContain('Notes (1)');
    expect(await page.locator('.legend-marks').innerText()).toContain(target);
    expect(await page.locator('.city-card-mark').innerText()).toContain('Pricing rules live here.');
    expect(await page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('atlas.notes.')))).toBe(true);
    const download = page.waitForEvent('download');
    await notes.getByRole('button', { name: 'Export notes' }).click();
    const file = await (await download).path();
    const { readFileSync } = await import('node:fs');
    const exported = JSON.parse(readFileSync(file!, 'utf8'));
    expect(exported.format).toBe('atlas.notes/1');
    expect(exported.notes).toEqual([expect.objectContaining({ path: target, colour: 'green', note: 'Pricing rules live here.' })]);
    await notes.getByRole('button', { name: 'Remove mark' }).click();
    expect(await page.locator('.legend-marks').count()).toBe(0);
    await notes.locator('input[type="file"]').setInputFiles(file!);
    await expect.poll(() => notes.locator('[role="status"]').innerText()).toContain('Imported 1 note');
    expect(await page.locator('.legend-marks').innerText()).toContain(target);
    expect(await audit(page, 'notes-imported')).toEqual([]);
    await notes.getByRole('button', { name: 'Remove mark' }).click();
    await notes.locator('summary').click();
    await view.selectOption('3d');
  });

  it('draws the package dependency graph with layers, cycles and a matching table (ADR-054)', async () => {
    const view = page.getByRole('combobox', { name: 'View', exact: true });
    await view.selectOption('packages');
    await page.waitForSelector('.pkg-view');
    const counts = async () => {
      const [, pkgs, deps] = /([\d,]+) packages, ([\d,]+) dependencies/.exec(await page.locator('.pkg-summary').innerText())!;
      return [Number(pkgs!.replaceAll(',', '')), Number(deps!.replaceAll(',', ''))] as const;
    };
    const [packages, dependencies] = await counts();
    expect(packages).toBeGreaterThan(1);
    expect(await page.locator('.pkg-node').count()).toBe(packages);
    expect(await page.locator('.pkg-edge').count()).toBe(dependencies);
    expect(await page.locator('.pkg-table tbody tr').count()).toBe(Math.min(200, dependencies));
    // Keyboard: a package box selects its package.
    const node = page.locator('.pkg-node').first();
    expect(await node.getAttribute('aria-label')).toContain(await node.locator('.pkg-meta').textContent());
    const name = (await node.getAttribute('aria-label'))!.split(':')[0]!;
    await node.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('#inspector-title').innerText()).toContain(name);
    expect(await node.getAttribute('aria-pressed')).toBe('true');
    // Type-only imports can only add package dependencies.
    const types = page.getByRole('checkbox', { name: 'Include type-only imports' });
    await types.check();
    expect((await counts())[1]).toBeGreaterThanOrEqual(dependencies);
    expect(await audit(page, 'package-graph')).toEqual([]);
    await types.uncheck();
    expect((await counts())[1]).toBe(dependencies);
    await view.selectOption('3d');
  });

  it('exports the city for 3D printing as a coloured 3MF and an STL (ADR-055)', async () => {
    const share = page.locator('.city-share');
    const { readFileSync } = await import('node:fs');
    await share.locator('summary').click();
    const [helpBox, menuBox] = await Promise.all([
      page.locator('.city-about > summary').boundingBox(),
      share.locator('.city-views-panel').boundingBox(),
    ]);
    expect(helpBox).not.toBeNull();
    expect(menuBox).not.toBeNull();
    expect(menuBox!.y).toBeGreaterThanOrEqual(helpBox!.y + helpBox!.height);
    expect(await audit(page, 'share-menu')).toEqual([]);
    let download = page.waitForEvent('download');
    await share.getByRole('button', { name: '3D print, coloured (3MF)' }).click();
    const threeMf = readFileSync((await (await download).path())!);
    expect(threeMf.subarray(0, 4).toString('latin1')).toBe('PK\x03\x04');
    expect(threeMf.toString('latin1')).toContain('3D/3dmodel.model');
    const buildings = Number(/([\d,]+) buildings/.exec(await page.locator('.city-message').innerText())![1]!.replaceAll(',', ''));
    expect(buildings).toBeGreaterThan(0);
    download = page.waitForEvent('download');
    await share.getByRole('button', { name: '3D print (STL)' }).click();
    const stl = readFileSync((await (await download).path())!);
    const triangles = stl.readUInt32LE(80);
    expect(stl.length).toBe(84 + triangles * 50);
    // A base, the nested district plinths and one box per building, 12 triangles each.
    expect(triangles % 12).toBe(0);
    expect(triangles / 12).toBeGreaterThan(buildings);
    expect(await page.locator('.city-message').innerText()).toContain('STL has no colours');
    await share.locator('summary').click();
  });

  it('audits keyboard, city and history help while each disclosure is open', async () => {
    await page.getByRole('button', { name: 'Keys', exact: true }).click();
    expect(await page.locator('#shortcuts').isVisible()).toBe(true);
    expect(await audit(page, 'keyboard-shortcuts')).toEqual([]);
    await page.getByRole('button', { name: 'Keys', exact: true }).click();
    for (const [selector, state] of [['.city-about', 'city-help'], ['.timeline-help', 'history-help']] as const) {
      const disclosure = page.locator(selector);
      await disclosure.locator('summary').click();
      expect(await disclosure.getAttribute('open')).not.toBeNull();
      expect(await audit(page, state)).toEqual([]);
      await disclosure.locator('summary').click();
    }
  });

  it('logged no page errors', () => {
    expect(errors).toEqual([]);
  });
});

describe.runIf(browserAvailable && viewerBuilt)('deep links', () => {
  // These journeys own independent pages. Keep the shared sign-in cookie, but release
  // each renderer/worker before the next journey instead of retaining live cities.
  afterEach(async () => { await Promise.all(context.pages().map((page) => page.close())); });
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
  it.each(['unavailable', 'blocked'] as const)('works with touch and %s WebGL without losing the file inspector', async (availability) => {
    const touch = await browser.newContext({
      hasTouch: true,
      viewport: { width: 390, height: 844 },
      storageState: await context.storageState(),
    });
    try {
      const page = await touch.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
      await page.addInitScript((availability) => {
        const probe = window as unknown as { __atlasWebGLAttempts: number };
        probe.__atlasWebGLAttempts = 0;
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
          if (type.startsWith('webgl')) {
            probe.__atlasWebGLAttempts++;
            if (availability === 'blocked') throw new DOMException('Graphics are disabled', 'SecurityError');
            return null;
          }
          return Reflect.apply(original, this, [type, ...args]);
        } as typeof original;
      }, availability);
      await page.goto(server.url);
      await page.waitForSelector('[data-city-renderer="map"]');
      expect(await audit(page, availability === 'blocked' ? 'touch-blocked-webgl-map' : 'touch-no-webgl-map')).toEqual([]);
      await page.getByRole('button', { name: 'Zoom in', exact: true }).tap();
      await page.getByRole('button', { name: 'Reset city', exact: true }).tap();
      const map = page.locator('[data-city-renderer="map"]');
      await map.scrollIntoViewIfNeeded();
      const bounds = (await map.boundingBox())!, x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
      const pixels = () => map.evaluate((el) => (el as HTMLCanvasElement).toDataURL());
      // Pan and pinch are synthesized with the DevTools protocol, which only Chromium has.
      // Firefox and WebKit still run the taps, the map fallback, table selection and layout.
      if (engineName === 'chromium') {
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
      }
      await page.getByLabel('View', { exact: true }).selectOption('table');
      await page.locator('.city-table').getByRole('button', { name: 'src/ui/Dock.tsx', exact: true }).tap();
      await expect.poll(() => page.locator('#inspector-title').innerText()).toBe('Dock.tsx');
      await expectNoSidewaysScroll(page);
      expect(await page.evaluate(() => (window as unknown as { __atlasWebGLAttempts: number }).__atlasWebGLAttempts)).toBe(1);
      expect(await page.locator('canvas[data-engine]').count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await touch.close();
    }
  });
  it('restores a file and tab from an allowlisted fragment and ignores others', async () => {
    const { page, errors } = await openViewer();
    await page.waitForSelector('#overview-title');
    const loaded = await readArtifactDirectory(path.join(work, 'harbor-out'));
    if (!loaded.ok) throw new Error('invalid');
    const node = loaded.bundle.graphs.at(-1)!.nodes.find((n) => n.kind === 'file' && n.path === 'src/ui/Dock.tsx')!;
    await page.goto(`${server.url}#v=1&file=${node.lineageId}&tab=dependencies`);
    await expect.poll(() => page.locator('#inspector-title').innerText()).toBe('Dock.tsx').catch(explain(page, errors));
    expect(await page.locator('[role="tab"][aria-selected="true"]').innerText()).toBe('Dependencies');
    const invalidUrl = `${server.url}#v=1&file=javascript:alert(1)&evil=1`;
    await page.goto(invalidUrl);
    await expect
      .poll(() => page.locator('[role="status"][aria-live="polite"]').innerText())
      .toContain('unsupported or invalid');
    expect(await audit(page, 'invalid-deep-link')).toEqual([]);
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('');
    // Same-document rejection normalizes the fragment. Start a new document to
    // exercise initial invalid-link admission without racing that normalization.
    await page.goto('about:blank');
    await page.goto(invalidUrl);
    await page.waitForSelector('#overview-title');
    await expect
      .poll(() => page.locator('[role="status"][aria-live="polite"]').innerText())
      .toContain('unsupported or invalid');
    expect(await audit(page, 'invalid-deep-link')).toEqual([]);
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
  afterAll(async () => { await page?.close(); });
  let errors: string[];
  const active = () => page.locator('.timeline-frame[aria-current="step"]').getAttribute('aria-label');
  const goTo = async (n: number) => {
    await page.locator('.timeline-frame').nth(n - 1).click();
    await expect.poll(active).toMatch(new RegExp(`^Snapshot ${n} of 12`));
  };
  const choose = async (name: string) => {
    await page.getByRole('combobox', { name: 'Search files, packages and declarations' }).focus();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type(name);
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('#inspector-title').innerText()).toBe(name);
  };
  beforeAll(async () => {
    expect(context.pages()).toHaveLength(0);
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
    // The strip is compact (ADR-047); its window and sampling are one click away, beside it.
    await page.getByText('How to read history').click();
    const summary = await page.locator('.timeline-summary').innerText();
    expect(summary).toContain('12 mainline commits');
    expect(summary).toContain('12 analyzed snapshots');
    expect(summary).toContain('first commit');
    // The overview names the same boundary in words, never the raw code.
    const windowFact = page.locator('.facts > div', { has: page.locator('dt', { hasText: /^Window$/ }) }).locator('dd');
    await expect.poll(() => windowFact.innerText()).toBe('reaches the first commit');
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
    expect(await audit(page, 'history-tombstone')).toEqual([]);
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
    expect(await audit(page, 'file-history-rename')).toEqual([]);
    await goTo(4);
    await expect.poll(() => page.locator('#inspector-title').innerText()).toBe('Cargo.tsx');
  });

  it('compares snapshots 6 -> 12 with exact differences, ghosts and separate interval activity', async () => {
    await goTo(12);
    await page.getByRole('button', { name: 'Compare snapshots…' }).click();
    await page.waitForSelector('.compare');
    // Select values are zero-based: retain the original visible 6 -> 12 regression.
    await page.locator('.compare-pick select').first().selectOption('5');
    const loaded = await readArtifactDirectory(path.join(work, 'harbor-out'));
    if (!loaded.ok) throw new Error('Invalid comparison reference artifact');
    const frames = loaded.bundle.manifest.frames;
    const expectedPaint = `${frames[5]!.snapshotId}>${frames[11]!.snapshotId}:codeLines`;
    // The HTML result commits before ThreeCity's effects update the renderer. Wait for
    // the existing paint readiness gate, for this exact pair, before reading its marks.
    await expect.poll(async () => (await page.evaluate(() => window.__atlasCity!.stats())).paint ?? '').toBe(expectedPaint);
    expect(await page.locator('.compare-direction').innerText()).toContain('from snapshot 6');
    expect(await page.locator('.compare-direction').innerText()).toContain('to snapshot 12');
    await expect.poll(() => page.locator('.compare-summary').innerText()).toContain('+ 4 added');
    const summary = await page.locator('.compare-summary').innerText();
    for (const part of ['− 1 deleted', '↪ 1 renamed', '✎ 4 content changed', '17 unchanged']) expect(summary).toContain(part);
    const stats = await page.evaluate(() => window.__atlasCity!.stats());
    expect(stats.ghosts).toBe(1);
    expect(stats.added).toBe(4);
    // Change colouring (ADR-050): on by default in code lines, legend bands sum to B's files.
    const colour = page.getByRole('combobox', { name: 'Colour by change' });
    expect(await colour.inputValue()).toBe('codeLines');
    expect(await page.locator('.city-legend strong').first().innerText()).toMatch(/^Change \d+ → \d+: code lines$/);
    const bandCounts = (await page.locator('.city-legend .legend-count').allInnerTexts()).map((t) => Number(t.replaceAll(',', '')));
    expect(bandCounts).toHaveLength(7);
    expect(bandCounts.reduce((a, b) => a + b, 0)).toBe(stats.buildings);
    expect(bandCounts[5]).toBe(4);
    await colour.selectOption('fanIn');
    await expect.poll(async () => (await page.evaluate(() => window.__atlasCity!.stats())).paint ?? '').toMatch(/:fanIn$/);
    await page.getByRole('combobox', { name: 'View', exact: true }).selectOption('table');
    expect(await page.locator('.city-table thead').innerText()).toMatch(/Fan-in, snapshot \d+ → \d+/);
    expect(await page.locator('.city-table .change-cell').count()).toBeGreaterThan(0);
    expect(await audit(page, 'comparison-table')).toEqual([]);
    await page.getByRole('combobox', { name: 'View', exact: true }).selectOption('3d');
    // A published handle is not a drawn city: first finish the preceding mode switch,
    // with this comparison's paint, before timing the next lens-state assertion.
    await page.waitForFunction((paint) => {
      const stats = window.__atlasCity?.stats();
      return stats !== undefined && stats.drawCalls > 0 && stats.paint === paint;
    }, `${frames[5]!.snapshotId}>${frames[11]!.snapshotId}:fanIn`);
    // Picking a lens asks for lens colours.
    await page.getByLabel('Lens', { exact: true }).selectOption('complexity');
    expect(await colour.inputValue()).toBe('off');
    await expect.poll(async () => (await page.evaluate(() => window.__atlasCity!.stats())).paint).toBeNull().catch(explain(page, errors));
    await page.getByLabel('Lens', { exact: true }).selectOption('structure');
    const text = await page.locator('.compare').innerText();
    expect(text).toContain('src/ui/Cargo.tsx → src/ui/Manifest.tsx');
    expect(text).toMatch(/mainline activity in this interval/i);
    expect(await page.locator('.compare section').last().locator('li').count()).toBe(6);
    // Beside-the-city layout: the compare panel follows the city and never covers it (ADR-050).
    const viewport = page.viewportSize()!;
    await page.setViewportSize({ width: 1440, height: 900 });
    const [cityBox, compareBox] = await Promise.all([page.locator('section.city').boundingBox(), page.locator('section.compare').boundingBox()]);
    expect(compareBox!.y).toBeGreaterThanOrEqual(cityBox!.y + cityBox!.height);
    await page.setViewportSize(viewport);
    expect(await audit(page, 'comparison-3d')).toEqual([]);
    // Explicit timeline navigation changes B and the comparison legend together.
    await goTo(11);
    await expect.poll(() => page.locator('.compare-pick select').last().inputValue()).toBe('10');
    await expect.poll(() => page.locator('.compare-direction').innerText()).toContain('to snapshot 11');
    await page.getByRole('button', { name: 'Close comparison' }).first().click();
    await expect.poll(async () => (await page.evaluate(() => window.__atlasCity!.stats())).ghosts).toBe(0);
  });

  it('matches the manual 5 -> 12 review card through the semantic table', async () => {
    await goTo(12);
    await page.getByLabel('View', { exact: true }).selectOption('table');
    await page.getByRole('button', { name: 'Compare snapshots…' }).click();
    await page.locator('.compare-pick select').first().selectOption('4');
    await expect.poll(() => page.locator('.compare-direction').innerText()).toContain('from snapshot 5');
    await expect.poll(() => page.locator('.compare-summary').innerText()).toContain('+ 7 added');
    // Independently checked from Harbor's Git trees/diff, not copied from analyzer output:
    // snapshot 5 has 20 files; 7 additions, 1 deletion, 1 rename, 4 modifications leave
    // 14 unchanged and 26 in snapshot 12. Snapshot 6 already has the tests/assets.
    const summary = await page.locator('.compare-summary').innerText();
    for (const part of ['− 1 deleted', '↪ 1 renamed', '✎ 4 content changed', '14 unchanged']) expect(summary).toContain(part);
    const text = await page.locator('.compare').innerText();
    for (const file of ['assets/harbor.png', 'assets/logo.svg', 'tests/pricing.test.ts', 'packages/geo/src/route.ts', 'src/server/db.cjs', 'src/server/store.json', 'src/ui/theme.json']) expect(text).toContain(file);
    expect(text).toContain('src/ui/Cargo.tsx → src/ui/Manifest.tsx');
    expect(await audit(page, 'manual-task-comparison-table')).toEqual([]);
    await page.getByRole('button', { name: 'Close comparison' }).first().click();
    await expect.poll(() => page.locator('.compare').count()).toBe(0);
    await page.getByLabel('View', { exact: true }).selectOption('3d');
    await page.waitForFunction(() => window.__atlasCity !== undefined);
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
      await expectNoSidewaysScroll(small);
      await small.getByRole('button', { name: 'Earlier' }).click();
      await expect.poll(() => small.locator('.timeline-frame[aria-current="step"]').getAttribute('aria-label')).toMatch(/^Snapshot 11 of 12/);
      expect(await audit(small, 'narrow-reduced-motion-history')).toEqual([]);
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

  /**
   * Bounded steps for a gate page: a stall names its step and what the page showed, so a
   * CI failure explains itself (Firefox run 39125232653 timed out with no detail).
   *
   * A folder pick waits for the page's response, not for Playwright to acknowledge the
   * pick. In WebKit CI, setInputFiles sometimes never returned although the page had
   * already received the folder (run 39137944001: the gate was validating). Whether the
   * pick returned is still recorded, and reported if anything stalls.
   */
  const watch = (page: Page) => {
    const requests: string[] = [];
    const pageErrors: string[] = [];
    const picks: string[] = [];
    page.on('request', (request) => requests.push(new URL(request.url()).pathname.split('/').pop() || '/'));
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    const stage = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([run(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('no result within 8 s')), 8_000); })]);
      } catch (error) {
        const shown = await page.evaluate(() => ({
          headings: [...document.querySelectorAll('h1')].map((h) => h.textContent),
          status: document.querySelector('[role="status"]')?.textContent?.trim().slice(0, 160) ?? null,
          focused: document.activeElement?.tagName ?? null,
        })).catch((reason: unknown) => `unreadable: ${String(reason)}`);
        throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}
gate state: ${JSON.stringify({ shown, picks, requests: requests.slice(-12), pageErrors: pageErrors.slice(-5) })}`, { cause: error });
      } finally {
        clearTimeout(timer);
      }
    };
    const pick = (folder: string) => {
      const entry = picks.push(`${path.basename(folder)}: pending`) - 1;
      void page.locator('input[type="file"]').setInputFiles(folder).then(
        () => { picks[entry] = `${path.basename(folder)}: returned`; },
        (error: unknown) => { picks[entry] = `${path.basename(folder)}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`; },
      );
    };
    return { stage, pick, requests };
  };

  it('audits starting and loading states and returns to the picker after cancellation', async () => {
    const isolated = await browser.newContext();
    let releaseSession!: () => void;
    const sessionHeld = new Promise<void>((resolve) => { releaseSession = resolve; });
    try {
      const page = await isolated.newPage();
      const { stage, pick } = watch(page);
      await page.route('**/api/session', async (route) => {
        await sessionHeld;
        await route.fulfill({ status: 404, body: '' });
      });
      await stage('open the viewer', async () => {
        await page.goto(`${origin}/`);
        await page.getByRole('status').filter({ hasText: 'Starting…' }).waitFor();
      });
      expect(await stage('audit starting', () => audit(page, 'viewer-starting'))).toEqual([]);
      releaseSession();
      await stage('show the picker', () => page.getByRole('button', { name: 'Open artifact folder…' }).waitFor());
      // A loader that never answers keeps the gate in "Validating" until Cancel.
      await page.route('**/assets/loader.worker-*.js', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '// A loader that never answers.\n' }));
      pick(path.join(work, 'harbor-out'));
      await stage('show validation', () => page.getByRole('heading', { name: 'Validating the selected artifact' }).waitFor());
      await expect.poll(() => page.getByRole('heading', { name: 'Validating the selected artifact' }).evaluate((el) => el === document.activeElement)).toBe(true);
      expect(await stage('audit loading', () => audit(page, 'artifact-loading'))).toEqual([]);
      await stage('cancel', async () => {
        await page.getByRole('button', { name: 'Cancel loading' }).focus();
        await page.keyboard.press('Enter');
        await page.getByRole('heading', { name: 'Explore a repository as a city' }).waitFor();
      });
      expect(await page.locator('#overview-title').count()).toBe(0);
      await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
      await expect.poll(() => page.getByRole('heading', { name: 'Explore a repository as a city' }).evaluate((el) => el === document.activeElement)).toBe(true);
      expect(await stage('audit cancelled', () => audit(page, 'artifact-loading-cancelled'))).toEqual([]);
    } finally {
      releaseSession();
      await isolated.close();
    }
  });

  it('audits malformed and unsupported artifact errors and recovers with a valid folder', async () => {
    const isolated = await browser.newContext();
    try {
      const page = await isolated.newPage();
      const { stage, pick } = watch(page);
      await stage('open the viewer', async () => {
        await page.goto(`${origin}/`);
        await page.getByRole('button', { name: 'Open artifact folder…' }).waitFor();
      });
      for (const [name, manifest, heading] of [
        ['malformed', '{', 'This artifact could not be opened'],
        ['unsupported', JSON.stringify({ artifactVersion: 'atlas.artifact/99.0.0', schemaVersion: GRAPH_SCHEMA_VERSION }), 'This artifact needs a different ATLAS version'],
      ] as const) {
        const directory = path.join(work, name);
        mkdirSync(directory);
        writeFileSync(path.join(directory, 'manifest.json'), manifest);
        pick(directory);
        await stage(`show the ${name} error`, () => page.getByRole('heading', { name: heading }).waitFor());
        await expect.poll(() => page.getByRole('heading', { name: heading }).evaluate((el) => el === document.activeElement)).toBe(true);
        expect(await page.getByRole('alert').isVisible()).toBe(true);
        expect(await page.getByRole('button', { name: 'Open another folder…' }).isVisible()).toBe(true);
        expect(await page.locator('#overview-title').count()).toBe(0);
        expect(await stage(`audit the ${name} error`, () => audit(page, `artifact-error-${name}`))).toEqual([]);
      }
      pick(path.join(work, 'harbor-out'));
      await stage('open the valid folder', () => page.waitForSelector('#overview-title'));
      expect(await stage('audit the recovery', () => audit(page, 'artifact-error-recovered'))).toEqual([]);
    } finally { await isolated.close(); }
  });

  it('validates picked files locally and sends nothing anywhere', async () => {
    // A separate context: no session cookie, no server API, just static files.
    const isolated = await browser.newContext();
    try {
      const page = await isolated.newPage();
      const { stage, pick } = watch(page);
      const requests: { url: string; method: string }[] = [];
      page.on('request', (r) => requests.push({ url: r.url(), method: r.method() }));
      await stage('open the viewer', async () => {
        await page.goto(`${origin}/`);
        await page.getByRole('button', { name: 'Open artifact folder…' }).waitFor();
      });
      // The start screen shows a real render of the demo city, described for screen readers.
      const preview = page.getByRole('img', { name: /vuejs\/core repository drawn as an ATLAS city/ });
      await expect.poll(() => preview.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1120);
      expect(await page.title()).toBe('ATLAS: your codebase as a city');
      expect(await audit(page, 'browser-only-landing')).toEqual([]);
      const before = requests.length;
      pick(path.join(work, 'harbor-out'));
      await stage('open the picked folder', () => page.waitForSelector('#overview-title'));
      expect(await stage('audit the opened artifact', () => audit(page, 'browser-only-artifact'))).toEqual([]);
      const after = requests.slice(before);
      // Only the viewer's own static files may be fetched: the loader worker script and, since
      // ADR-058, the bundled font subsets the explorer first uses. No artifact bytes are sent.
      // WebKit also reports in-memory `blob:` URLs of this origin; they never reach a network.
      const ownAsset = (url: string) => (url.startsWith(origin) && /\/assets\/[^/]+\.(?:js|woff2)$/.test(url)) || url.startsWith(`blob:${origin}/`);
      expect(after.filter((r) => r.method !== 'GET' || !ownAsset(r.url))).toEqual([]);
      expect(requests.filter((r) => r.method !== 'GET')).toEqual([]);
      const loaded = await readArtifactDirectory(path.join(work, 'harbor-out'));
      expect(await page.locator('#overview-title').innerText()).toBe(
        loaded.ok ? loaded.bundle.manifest.repo.displayName : '?',
      );
    } finally { await isolated.close(); }
  });
});


describe.runIf(browserAvailable && viewerBuilt)('external quality reports', () => {
  let qualityRepo: GitFixture, qualityServer: RunningViewerServer;
  const qualityDir = () => path.join(work, 'quality-artifact');
  const io = (): CliIO => ({ cwd: work, env: { NO_COLOR: '1' }, signal: new AbortController().signal, stdout: { write: () => true }, stderr: { write: () => true } });
  beforeAll(async () => {
    qualityRepo = createGitFixture([
      { date: '2026-10-01T00:00:00Z', message: 'two lint findings', files: { 'sample.py': 'import os\nprint(missing)\n' } },
      { date: '2026-10-02T00:00:00Z', message: 'one lint finding', files: { 'sample.py': 'import os\nprint(0)\n' } },
    ], { parent: work });
    expect(await run(['analyze', qualityRepo.dir, '--out', qualityDir()], io())).toBe(0);
    const loaded = await readArtifactDirectory(qualityDir());
    if (!loaded.ok) throw new Error('quality artifact');
    const raw = JSON.parse(readFileSync(new URL('../../graph/test/fixtures/ruff-0.17.3.sarif.json', import.meta.url), 'utf8'));
    writeFileSync(path.join(work, 'quality-old.sarif'), JSON.stringify(raw));
    raw.runs[0].results = raw.runs[0].results.filter((r: { ruleId: string }) => r.ruleId === 'F401');
    writeFileSync(path.join(work, 'quality-new.sarif'), JSON.stringify(raw));
    for (const [source, output, commit] of [
      ['quality-old.sarif', 'quality-old.json', loaded.bundle.manifest.frames[0]!.commit.oid],
      ['quality-new.sarif', 'quality-new.json', loaded.bundle.manifest.selectedCommit.oid],
    ]) expect(await run(['findings', source!, '--artifact', qualityDir(), '--commit', commit!, '--out', output!], io())).toBe(0);
    writeFileSync(path.join(work, 'quality-invalid.json'), '{"SECRET":"broken');
    const wrong = JSON.parse(readFileSync(path.join(work, 'quality-new.json'), 'utf8'));
    wrong.commitOid = '0'.repeat(40);
    writeFileSync(path.join(work, 'quality-wrong.json'), JSON.stringify(wrong));
    const scanProfile = { format: 'atlas.ruff-profile/1', isolated: true, ignoreNoqa: true, respectGitignore: false, forceExclude: false, targetVersion: 'py314', rules: ['F401', 'F821'] };
    for (const [index, source, output, profile] of [
      [1, 'quality-new.json', 'scan-new.json', scanProfile],
      [0, 'quality-old.json', 'scan-other-profile.json', { ...scanProfile, targetVersion: 'py313' }],
    ] as const) {
      const graph = loaded.bundle.graphs[index]!;
      const scan = createScanEvidence(parseQualityReport(readFileSync(path.join(work, source), 'utf8')), profile, { format: 'atlas.scan-scope/1', files: graph.nodes.flatMap((n) => n.kind === 'file' ? [{ path: n.path, blobOid: n.blobOid }] : []) }, 1, qualityTarget(graph, loaded.bundle.manifest.analysisId));
      writeFileSync(path.join(work, output), JSON.stringify(scan));
    }
    const wrongScan = JSON.parse(readFileSync(path.join(work, 'scan-new.json'), 'utf8'));
    wrongScan.scope.files[0].blobOid = '0'.repeat(40);
    writeFileSync(path.join(work, 'scan-wrong.json'), JSON.stringify(wrongScan));
    qualityServer = await startViewerServer({ artifactDir: qualityDir(), bundle: loaded.bundle, viewerDir: viewerDirectory(), source: SourceAttachment.none('NOT_REQUESTED') });
  }, 60_000);
  afterAll(async () => { await qualityServer?.close(); qualityRepo?.dispose(); });

  it('opens local reports, selects evidence, compares conservatively and hides stale findings', async () => {
    const isolated = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    try {
      const page = await isolated.newPage();
      const requests: { url: string; method: string }[] = [], errors: string[] = [];
      page.on('request', (r) => requests.push({ url: r.url(), method: r.method() }));
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(qualityServer.sessionUrl);
      await page.waitForSelector('#overview-title');
      await page.getByLabel('View', { exact: true }).selectOption('table');
      await page.getByRole('button', { name: 'External findings', exact: true }).focus();
      await page.keyboard.press('Enter');
      const panel = page.getByRole('region', { name: 'External findings', exact: true });
      await panel.waitFor();
      const start = requests.length;
      await page.locator('input[data-quality="current"]').setInputFiles(path.join(work, 'quality-new.json'));
      await expect.poll(() => panel.innerText()).toContain('Current report opened: 1 Ruff findings');
      await panel.getByRole('button', { name: 'sample.py:1:8', exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => page.locator('#inspector-title').innerText()).toBe('sample.py');
      expect(await page.getByRole('tabpanel').getByRole('heading', { name: /External Ruff findings/ }).isVisible()).toBe(true);
      expect(await page.getByRole('tabpanel').innerText()).toContain('F401');
      expect(await page.getByRole('tabpanel').innerText()).not.toContain('imported but unused');
      await page.locator('input[data-quality="baseline"]').setInputFiles(path.join(work, 'quality-old.json'));
      await expect.poll(() => panel.innerText()).toContain('0 newly reported; 1 no longer reported; 1 at the same location');
      expect(await panel.innerText()).toContain('Missing findings do not establish resolution');
      expect(await audit(page, 'external-quality-comparison')).toEqual([]);
      for (const name of ['quality-invalid.json', 'quality-wrong.json']) {
        await page.locator('input[data-quality="current"]').setInputFiles(path.join(work, name));
        await panel.getByRole('alert').waitFor();
        expect(await panel.innerText()).toContain('1 retained of 1');
        expect(await panel.innerText()).not.toContain('SECRET');
      }
      await page.getByRole('button', { name: /^Snapshot 1 of 2:/ }).click();
      await expect.poll(() => panel.innerText()).toContain('Report findings are hidden on this snapshot');
      expect(await page.getByRole('tabpanel').getByRole('heading', { name: /External Ruff findings/ }).count()).toBe(0);
      await panel.getByRole('button', { name: 'Show report snapshot', exact: true }).click();
      await expect.poll(() => panel.innerText()).not.toContain('Report findings are hidden on this snapshot');
      if (process.env['ATLAS_CAPTURE_QUALITY'] === '1') writeFileSync(path.resolve(`.atlas-tmp/quality-requests-${engineName}.json`), JSON.stringify(requests.slice(start).map((r) => ({ method: r.method, protocol: new URL(r.url).protocol, origin: new URL(r.url).origin })), null, 2));
      // WebKit also emits request events for local blob reads. Compare parsed origins:
      // a blob: URL keeps its creator's origin and performs no network upload.
      expect(requests.slice(start).filter((r) => r.method !== 'GET' || new URL(r.url).origin !== new URL(qualityServer.url).origin)).toEqual([]);
      expect(errors).toEqual([]);
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        await expectNoSidewaysScroll(page);
        expect(await audit(page, `external-quality-narrow-error-${width}`)).toEqual([]);
      }
      await panel.getByRole('button', { name: 'Clear reports', exact: true }).click();
      expect(await panel.innerText()).not.toContain('Current report opened');
      expect(await page.getByRole('tabpanel').getByRole('heading', { name: /External Ruff findings/ }).count()).toBe(0);
      await panel.getByRole('button', { name: 'Hide external findings', exact: true }).focus();
      await page.keyboard.press('Enter');
      expect(await page.locator('#external-quality-toggle').evaluate((e) => e === document.activeElement)).toBe(true);
    } finally { await isolated.close(); }
  });

  it('shows declared scan scope without authenticating it and blocks differing profile comparisons', async () => {
    const loaded = await readArtifactDirectory(qualityDir());
    if (!loaded.ok) throw new Error('quality artifact');
    const freshServer = await startViewerServer({ artifactDir: qualityDir(), bundle: loaded.bundle, viewerDir: viewerDirectory(), source: SourceAttachment.none('NOT_REQUESTED') });
    const isolated = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
      const page = await isolated.newPage();
      const requests: { url: string; method: string }[] = [], errors: string[] = [];
      page.on('request', (r) => requests.push({ url: r.url(), method: r.method() }));
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      await page.goto(freshServer.sessionUrl);
      await page.waitForSelector('#overview-title');
      await page.getByLabel('View', { exact: true }).selectOption('table');
      await page.getByRole('button', { name: 'External findings', exact: true }).click();
      const panel = page.getByRole('region', { name: 'External findings', exact: true });
      await page.locator('input[data-quality="current"]').setInputFiles(path.join(work, 'scan-new.json'));
      await expect.poll(() => panel.innerText()).toContain('1 of 1 analyzed Python files declared scanned');
      expect(await panel.innerText()).toContain('not authenticated in this browser');
      expect(await panel.innerText()).toContain('Python 3.14');
      expect(await audit(page, 'declared-scan-scope')).toEqual([]);
      if (process.env['ATLAS_CAPTURE_SCAN'] === '1') await page.screenshot({ path: path.resolve('.atlas-tmp/scan-scope-ui.png'), fullPage: true });
      await page.locator('input[data-quality="current"]').setInputFiles(path.join(work, 'scan-wrong.json'));
      await panel.getByRole('alert').waitFor();
      expect(await panel.innerText()).toContain('1 of 1 analyzed Python files declared scanned');
      await page.locator('input[data-quality="baseline"]').setInputFiles(path.join(work, 'scan-other-profile.json'));
      await expect.poll(async () => (await panel.getByRole('alert').allTextContents()).join(' ')).toContain('declared profiles must match');
      await page.setViewportSize({ width: 320, height: 844 });
      await expectNoSidewaysScroll(page);
      expect(await audit(page, 'declared-scan-scope-narrow')).toEqual([]);
      expect(requests.every((r) => r.method === 'GET' && new URL(r.url).origin === new URL(freshServer.url).origin)).toBe(true);
      expect(errors).toEqual([]);
      await panel.getByRole('button', { name: 'Clear reports', exact: true }).click();
      expect(await panel.getByRole('region', { name: 'Producer-declared scan scope' }).count()).toBe(0);
    } finally { await isolated.close(); await freshServer.close(); }
  });

  it('cancels a held import, recovers and clears reports on reload', async () => {
    const loaded = await readArtifactDirectory(qualityDir());
    if (!loaded.ok) throw new Error('quality artifact');
    const freshServer = await startViewerServer({ artifactDir: qualityDir(), bundle: loaded.bundle, viewerDir: viewerDirectory(), source: SourceAttachment.none('NOT_REQUESTED') });
    const isolated = await browser.newContext();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    try {
      const page = await isolated.newPage();
      await page.goto(freshServer.sessionUrl);
      await page.waitForSelector('#overview-title');
      await page.getByLabel('View', { exact: true }).selectOption('table');
      await page.getByRole('button', { name: 'External findings', exact: true }).click();
      const panel = page.getByRole('region', { name: 'External findings', exact: true });
      await page.route('**/assets/quality.worker-*.js', async (route) => { await held; await route.abort(); });
      await page.locator('input[data-quality="current"]').setInputFiles(path.join(work, 'quality-new.json'));
      await panel.getByRole('button', { name: 'Cancel and clear reports', exact: true }).waitFor();
      await panel.getByRole('button', { name: 'Cancel and clear reports', exact: true }).click();
      expect(await panel.innerText()).toContain('External reports cleared');
      release();
      await page.unrouteAll({ behavior: 'wait' });
      await page.locator('input[data-quality="current"]').setInputFiles(path.join(work, 'quality-new.json'));
      await expect.poll(() => panel.innerText()).toContain('Current report opened: 1 Ruff findings');
      if (process.env['ATLAS_CAPTURE_QUALITY'] === '1') await page.screenshot({ path: path.resolve('.atlas-tmp/quality-ui.png'), fullPage: true });
      await page.reload();
      await page.getByRole('button', { name: 'External findings', exact: true }).click();
      expect(await panel.innerText()).not.toContain('1 retained of 1');
    } finally { release(); await isolated.close(); await freshServer.close(); }
  });

});
