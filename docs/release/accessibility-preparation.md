# Accessibility preparation: automated coverage and manual handoff

Production plan M3.3, 2026-10-17. This is supporting evidence for R6-04, which remains
**open**. No screen-reader sessions or participant outcomes are claimed here.

## Coverage inventory

`packages/cli/test/viewer.e2e.test.ts` runs the same journeys in Chromium, Firefox and
WebKit. Audits inspect visible content at the following checkpoints, rather than
auditing a menu only after closing it:

| Surface | Audited states |
|---|---|
| Entry and validation | Starting, static landing, validation loading, cancellation, malformed input, unsupported version, valid recovery, browser-only opened artifact |
| Repository and selection | Overview, open search results, file overview/dependencies/findings, expanded finding disclosures, invalid deep link |
| Source dialog | Verified read-only text, loading, unavailable response; keyboard Escape restores its opener |
| City renderers | 3D, context-loss map, touch map with WebGL unavailable or throwing a security exception (ADR-071), semantic file table, package graph with dependency table |
| Workspace | Expanded, evidence hidden, restored; search remains usable |
| Menus and help | Saved views before/after import, Scope, Bands including invalid boundaries, Notes before/after import, Share, keyboard shortcuts, city help, history help |
| Evidence and history | Reachable files, expanded overlay/external lists, path-pattern error, absent-file tombstone, rename history, original 6→12 comparison in table/3D and a separate manual-task 5→12 table comparison |
| Reflow and motion | 320 CSS px table with canvas hidden and reduced motion; narrow history/comparison; touch fallback |

`apps/worker/test/hosted.e2e.test.ts` adds Chromium audits with a real API, database and
coordinator: hosted landing, invalid submission, queued/running/ready, Python dependencies,
public result, inline delete confirmation/deleted, partial result and unavailable history,
failed, cancelled, expired, unknown and another-session job. Repeated message variants
use shared components; this inventory does not claim every possible error-code string
or combination of settings has been tested.

The source panel is the application's nonmodal dialog. Menus are native disclosures;
deletion is an inline confirmation group. Native folder pickers/download interfaces,
screen-reader speech, zoom and visual focus require the separate human protocol.

Primary-action enabled/disabled transitions also have an independent contrast check
(ADR-071): the actual shared CSS is sampled at seven fixed fractions in each direction
and both themes. All 28 computed foreground/background ratios per engine must meet
4.5:1. The hosted audit still checks the real submission-error screen; no rule or
animation is excluded to obtain a pass.

## Method and retained evidence

The shared `apps/web/test/audit.ts` runs axe's WCAG 2 A/AA, 2.1 A/AA and 2.2 AA rule
tags. All reported violations fail the journey. No rules, targets, budgets or existing
assertions are excluded to obtain a pass. These automated rules cannot prove full
WCAG conformance or that a canvas is understandable to a screen-reader user.

Set `ATLAS_A11Y_REPORT_DIR` to retain one JSONL file per engine/test process. Records
include state, UTC date, browser/axe version, OS, viewport, passed/inapplicable rule IDs,
violation targets and **incomplete** rule targets requiring judgment. URLs, HTML, source
text and entered values are omitted. This is an opt-in test report, not product
telemetry. CI retains reports for seven days in `accessibility-<OS>`,
`accessibility-firefox`, `accessibility-webkit` and `accessibility-hosted` artifacts,
including failed jobs that reached an audit. Download and preserve the evidence with
the release review before artifact expiry. A missing report is not a passing audit.

PowerShell reproduction, after installing the pinned toolchain/dependencies and building
the packages/viewer:

```powershell
pnpm --filter @atlas/web exec playwright install chromium firefox webkit
$env:ATLAS_REQUIRE_BROWSER_TESTS = '1'
$env:ATLAS_A11Y_REPORT_DIR = '.atlas-tmp/accessibility-review'
$env:ATLAS_E2E_BROWSER = 'chromium' # repeat with firefox and webkit
pnpm exec vitest run packages/cli/test/viewer.e2e.test.ts
# Hosted: start disposable services and set ATLAS_TEST_DATABASE_URL per hosted-development.md.
$env:ATLAS_REQUIRE_HOSTED_TESTS = '1' # a missing database must fail, never silently skip
pnpm exec vitest run apps/worker/test/hosted.e2e.test.ts
```

Use fresh report directories for distinct runs; JSONL deliberately appends. Firefox on
GPU-less Linux uses the headed Xvfb/Mesa setup in ADR-069. Hosted local process-runner
tests are not evidence of container isolation; CI's hosted gate exercises containers.

## Defects found during preparation

Cancelling validation removed the focused Cancel button and left `document.activeElement`
as `BODY`. A real-browser regression reproduced this before the fix. The replacement
landing/loading/error screen now focuses its named heading once per phase transition;
progress updates do not refocus it. The journey checks cancellation and source-dialog
focus return. This is keyboard evidence; announcement quality still needs people.

WCAG 2.1 A also found `label-content-name-mismatch` on the package diagram: its names
omitted visible metadata, and adjacent SVG text nodes had no DOM word separator.
Names now contain the displayed label/metadata with full names retained when shortened;
the two text lines have an explicit separator. Visual geometry is unchanged.

Firefox additionally found the open Share menu partly covering city help, leaving a
7 × 24 px target. Help now sits above the toolbar/popovers, with an explicit non-overlap
regression. This is separate from M3.4's intermittent narrow-layout overflow.

The manual 5→12 card also quoted counts for 6→12. Independent Git inspection confirms
the intended task has 7 added, 1 deleted, 1 renamed, 4 changed and 14 unchanged files.
The card is corrected and has its own table journey; the existing 6→12 regression and
its original counts remain intact. GPU checks wait for the exact comparison paint
through the existing readiness gate before reading marks, avoiding a stale renderer read.

Retained incomplete checks also exposed labels on generic containers. City controls and
the lens legend now have explicit named-group semantics. Symbol-only presence/comparison
buttons can still require human judgment for label-in-name, and nonuniform backgrounds
require contrast review. These are recorded as incomplete, never silently counted as passes.

## Human follow-up

Local Windows verification records 48 checkpoints (47 named states) in each engine,
plus 17 hosted checkpoints, with zero reported violations. Contrast and symbol-only
label-in-name checks remain incomplete where axe cannot judge them. The first hosted
CI run failed on a request-handler cleanup race despite passing assertions; ADR-070
records the failure and the local fix/retest. Refer to the PR checks for final CI outcomes.

Follow the numbered NVDA/Firefox/Chrome and VoiceOver/Safari scripts in
[manual-review.md](manual-review.md). Inspect retained `incomplete` targets in that
candidate, including contrast judgments over nonuniform backgrounds. Record actual
speech, focus, settings, defects and retests. Linux/Windows Playwright WebKit is not a
macOS VoiceOver session. R6-04 and the five-developer acceptance gate stay open.
