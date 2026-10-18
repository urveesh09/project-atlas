import { AxeBuilder } from '@axe-core/playwright';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
/** Automated rules only. Incomplete checks and screen-reader usability still need people. */
export async function audit(page: Page, state: string) {
  // Audit the settled page. axe counts opacity in contrast, so a menu still fading in
  // (0.14 s) read as 2.56:1 text in Chromium runs (ADR-079). Infinite animations, such as
  // spinners, never finish and are left running; the wait is bounded either way.
  await page.evaluate(() => Promise.race([
    Promise.all(document.getAnimations()
      .filter((animation) => animation.playState === 'running' && animation.effect?.getComputedTiming().iterations !== Infinity)
      .map((animation) => animation.finished.catch(() => undefined))),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]));
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const directory = process.env['ATLAS_A11Y_REPORT_DIR'];
  if (directory) {
    const engine = page.context().browser()?.browserType().name() ?? 'unknown';
    const rules = (rows: typeof result.violations) => rows.map(({ id, impact, helpUrl, nodes }) => ({ id, impact, helpUrl, targets: nodes.map((node) => node.target) }));
    mkdirSync(directory, { recursive: true });
    // One file per test process: independent jobs/files cannot interleave records.
    // Deliberately omit URLs, DOM HTML, source text and user-entered values.
    appendFileSync(path.join(directory, `axe-${engine}-${process.pid}.jsonl`), `${JSON.stringify({
      state, recordedAt: new Date().toISOString(), engine, browserVersion: page.context().browser()?.version(),
      platform: process.platform, axeVersion: result.testEngine.version,
      viewport: page.viewportSize(), violations: rules(result.violations), incomplete: rules(result.incomplete),
      passedRules: result.passes.map((rule) => rule.id), inapplicableRules: result.inapplicable.map((rule) => rule.id),
    })}\n`);
  }
  return result.violations;
}
