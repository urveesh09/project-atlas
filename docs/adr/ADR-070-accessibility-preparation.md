# ADR-070: Named accessibility audits and an honest manual-review handoff

Date: 2026-10-17. Status: accepted. Production plan M3.3; extends ADR-069.

## Evidence and cause

The existing axe journeys usually inspected primary screens. Some menu audits ran
after closing the menu, and source, validation and hosted error states had gaps. The
tag set included WCAG 2.1 AA but omitted its A rules. A clean result did not cover all
applicable automated rules or establish a usable screen-reader experience.

Four product defects were identified:

- **Focus after cancellation.** In the real static viewer, activate Cancel loading
  with the keyboard. Removing that button leaves `document.activeElement.tagName`
  as `BODY`. The pre-fix regression failed with `expected 'BODY' not to be 'BODY'`.
- **Visible package text missing from its accessible name.** With WCAG 2.1 A enabled,
  axe reports serious `label-content-name-mismatch` on Harbor's three diagram buttons.
  They display `packageMeta` file-pair counts, but their `aria-label` omitted them.
  The adjacent SVG text nodes also had no separating whitespace in the DOM. Adding
  only the missing counts still failed the rule. Sharing the displayed label/metadata
  and separating the text nodes fixes both causes without changing geometry.
- **Labels on generic containers.** Retaining `incomplete` results exposes
  `aria-prohibited-attr` on `.city-toolbar` and `.city-legend`: generic divs cannot
  reliably expose these names. They now have explicit `group` semantics. This does
  not introduce a toolbar widget or impose an unimplemented arrow-key pattern.
- **Share obscured city help in Firefox.** An open menu left only a 7 × 24 px strip
  of the help summary clickable, failing WCAG 2.2 AA `target-size`. It appeared in
  three audited states, including a later context-loss view with Share still open.
  Move the help disclosure into the city heading, above the toolbar/popovers, and
  explicitly check non-overlap while Share is open. M3.4's separate narrow overflow
  remains unproven; this does not claim to resolve it.

During test expansion, two disclosure loops also timed out: Playwright's `all()`
returns indexed locators, and filtering on `[open]` while changing it shifts those
indices. Stable disclosure locators with explicit open-state checks fix the test
driver. The package violation caused two later shared-page checks to fail as well;
the original five-failure run is retained locally. No timeout or assertion was relaxed.
The first metadata regression also used HTML-only `innerText` on SVG text; it now
uses `textContent`. That failed run is retained, and the focused package journey
passes after correcting the SVG separation and the test driver.

WebKit also exposed an existing comparison-test synchronization error: the HTML
summary can commit before ThreeCity's effects apply its ghosts/paint. Reading GPU
counts at that point returned zero; the next test inherited the unclosed comparison.
The existing paint-readiness poll now runs before the count assertions and requires
that exact pair's snapshot IDs, rather than just a metric suffix. The original 6 → 12
counts and existing five-second correctness deadline are unchanged.

The manual card called for 5 → 12 but quoted the original browser test's 6 → 12 counts
(select value `5` is zero-based). A first 5 → 12 trial with the old counts failed and
is retained. Independent Git tree/diff inspection confirms:

- 5 → 12: 20 → 26 files; **7 added, 1 deleted, 1 renamed, 4 modified, 14 unchanged**.
- 6 → 12: 23 → 26 files; **4 added, 1 deleted, 1 renamed, 4 modified, 17 unchanged**.

Snapshot 6 adds `assets/harbor.png`, `assets/logo.svg` and `tests/pricing.test.ts`.
Keep the original 6 → 12 assertions, correct the manual card and add a separate 5 → 12
HTML/table journey with the independently checked paths. No renderer behavior,
analysis fact or interaction budget changes to accommodate a test.

The first CI run, **39053028580** on `bd8c2a2`, failed its hosted gate despite
146 passing assertions: the newly held job-status route was released and immediately
removed, allowing interception cleanup to handle it before its callback continued.
The local hosted run independently reproduced `Route is already handled!` with seven
passing assertions and one unhandled rejection, so neither run is counted as passing.
Release the gate, then `unrouteAll({ behavior: 'wait' })` drains the only installed
handler before interception changes. Errors remain fatal; none are ignored. The
seven-journey local retest passes without unhandled errors. Preserve both original logs.

## Decision

1. Audit visible states with stable names across Chromium, Firefox and WebKit. Expand
   disclosures through actual controls and inspect source loading/unavailable states,
   malformed/unsupported artifacts, cancellation/recovery and hosted lifecycle states.
   The [inventory](../release/accessibility-preparation.md) defines the coverage and limits.
2. Include axe's WCAG 2 A/AA, 2.1 A/AA and 2.2 AA tags. All returned violations fail.
   Keep `incomplete` findings for manual judgment; do not turn them into passes.
3. Opt-in JSONL reports record state, rule IDs/targets, browser/axe version, platform
   and viewport. Each process writes its own file. Omit HTML, source, request URLs and
   entered values. Existing CI browser/hosted jobs retain these reports, even on failure
   when available, for seven days. They are test evidence, not runtime telemetry.
4. Focus the local entry/validation/error heading once on each phase-kind transition.
   Progress updates leave keyboard focus alone. Hosted pages already use heading focus;
   source remains a nonmodal dialog with focus restored to its opener.
5. Package-button accessible names contain the same displayed label and metadata.
   If shortened visually, also retain the full name; dependency counts remain available.
   City controls and the legend expose named groups rather than labelled generic divs.
   City help sits above the toolbar so Share cannot partially cover its target.
   City geometry, metrics, analysis identities and artifact versions do not change.
6. Supply numbered NVDA/Firefox/Chrome and VoiceOver/Safari scripts, including native
   pickers, real zoom, announcements, fallback, source, history and public lifecycle.
   Automation cannot perform the human review. R6-04 and G6 remain open.

## Verification

Exact local counts and command outcomes are recorded in the dated M3.3 section of
[implementation status](../implementation-status.md). CI uses the existing required
journeys and gates; no gate, budget or branch-protection setting changes here. The
six-repository baseline check guards the byte-preserving boundary. Native OS dialogs,
actual screen-reader speech, reference-device performance and user acceptance remain
manual work under the release audit.
