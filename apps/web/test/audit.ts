import { AxeBuilder } from '@axe-core/playwright';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
/** Automated rules only. Incomplete checks and screen-reader usability still need people. */
export async function audit(page: Page, state: string) {
  const started = performance.now();
  const cpu = process.cpuUsage();
  const directory = process.env['ATLAS_A11Y_REPORT_DIR'];
  const engine = page.context().browser()?.browserType().name() ?? 'unknown';
  const stage = (phase: 'begin' | 'settled' | 'complete' | 'failed') => {
    if (!directory)
      return;
    mkdirSync(directory, { recursive: true });
    appendFileSync(path.join(directory, `audit-timings-${engine}-${process.pid}.jsonl`), `${JSON.stringify({
      format: 'atlas.a11y-timing/1', state, phase, recordedAt: new Date().toISOString(), elapsedMs: performance.now() - started,
      testWorkerCpuMicros: process.cpuUsage(cpu), platform: process.platform,
    })}\n`);
  };
  stage('begin');
  try {
    // Audit the settled page. axe counts opacity in contrast, so a menu still fading in
    // (0.14 s) read as 2.56:1 text in Chromium runs (ADR-079). Infinite animations, such as
    // spinners, never finish and are left running; the wait is bounded either way.
    const pageState = await page.evaluate(async () => {
      await Promise.race([
        Promise.all(document.getAnimations()
          .filter((animation) => animation.playState === 'running' && animation.effect?.getComputedTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => undefined))),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      const mode = document.querySelector<HTMLSelectElement>('select[aria-label="View"]')?.value;
      const renderer = document.querySelector('[data-city-renderer]')?.getAttribute('data-city-renderer')
        ?? (document.querySelector('.city-table') ? 'table' : null);
      return {
        mode: mode && ['3d', 'map', 'table'].includes(mode) ? mode : null,
        renderer: renderer && ['3d', 'map', 'table'].includes(renderer) ? renderer : null,
        visibility: document.visibilityState,
        canvases: document.querySelectorAll('canvas').length,
        runningAnimations: document.getAnimations().filter(animation => animation.playState === 'running').length,
      };
    });
    const settledAt = performance.now();
    stage('settled');
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
    const completedAt = performance.now();
    if (directory) {
      const rules = (rows: typeof result.violations) => rows.map(({ id, impact, helpUrl, nodes }) => ({ id, impact, helpUrl, targets: nodes.map((node) => node.target) }));
      mkdirSync(directory, { recursive: true });
      // One file per test process: independent jobs/files cannot interleave records.
      // Deliberately omit URLs, DOM HTML, source text and user-entered values.
      appendFileSync(path.join(directory, `axe-${engine}-${process.pid}.jsonl`), `${JSON.stringify({
        state, recordedAt: new Date().toISOString(), engine, browserVersion: page.context().browser()?.version(),
        platform: process.platform, axeVersion: result.testEngine.version,
        viewport: page.viewportSize(), violations: rules(result.violations), incomplete: rules(result.incomplete),
        passedRules: result.passes.map((rule) => rule.id), inapplicableRules: result.inapplicable.map((rule) => rule.id),
        timingMs: { settle: settledAt - started, axe: completedAt - settledAt, total: completedAt - started },
        testWorkerCpuMicros: process.cpuUsage(cpu), pageState,
      })}\n`);
    }
    stage('complete');
    return result.violations;
  }
  catch (error) {
    try { stage('failed'); } catch { /* Preserve the original audit failure if logging also fails. */ }
    throw error;
  }
}
