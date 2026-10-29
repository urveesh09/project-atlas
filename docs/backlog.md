# Backlog

Everything known to be unresolved, in one place (2026-10-29). Each item links to its
evidence. History stays in the [implementation status](implementation-status.md) log;
this page says only what is open, who can close it, and the next step.

When an item closes, remove it here and record the evidence in the status log in the same
pull request. Nothing here may be marked done without real results (AGENTS.md §2).

## Release acceptance (gate G6)

From the [release audit](release/release-audit.md). Automation cannot close these.

| Item | Needs | Next step |
|---|---|---|
| R6-01 capacity | Reference machine: 4 cores, 2 GiB per job, SSD | Agent: the three exact 20-run rows on the development host (exact HEAD, exact history, dense HEAD; about 2 hours, quiet machine) when the owner schedules them. Then the same matrix on the reference machine |
| R6-02 device | Integrated-GPU, 8 GiB, 1920×1080 machine; Chromium and Firefox | Measure cold load, interaction, memory and constrained network as specified. Earlier measurements showed real startup costs to investigate |
| R6-03 usability | Five developers | Run the [manual task protocol](release/manual-review.md) |
| R6-04 accessibility | Screen-reader users and reviewers | Run the [numbered NVDA and VoiceOver scripts](release/manual-review.md#screen-reader-rehearsal-scripts-m33) |
| R6-05 install | An independent person on a fresh machine | Reproduce the candidate hash, `doctor` and the offline demo |
| R6-06 deployment | A real domain, host and operator | Deploy the [reference kit](../deploy/production/README.md), then verify TLS, firewall, roles, backups, restore, alerts and canaries live |
| R6-07 sign-off | Release owner | After R6-01…R6-06: triage every known defect and lock the final identities |

Agent work that prepares these (production plan M5.2): one reviewer packet per R6 item
(what to run, on what, what to record), then the candidate freeze with the exact archive
and image identities.

## Defects and reliability

| Item | State | Evidence and next step |
|---|---|---|
| Narrow-screen sideways scroll (M3.4) | Open, not reproduced | Seen once, Windows CI run 39010571149: the 390 px touch page scrolled sideways just after the inspector opened. Not reproduced since; see the 2026-10-27 entry in the status log. The check names the overflowing elements: fix at the cause when it recurs. No speculative CSS |
| WebKit folder-pick stall | Mitigated; cause unknown | Playwright's `setInputFiles` once never returned although the page had the folder ([ADR-079](adr/ADR-079-draw-call-guards-and-folder-picks.md)). Picks now wait for the page, and every step is bounded and reports its state. Since 2026-10-18, 12 of 12 CI runs passed the Firefox and WebKit journeys on the first attempt |
| macOS cold keyboard/audit timeout | Observed once in PR #52; cause unproven | Existing J1 hit its 30-second deadline in [run 40707908446](https://github.com/urveesh09/project-atlas/actions/runs/40707908446); the other 49 journeys passed. Retained audit records eventually report zero violations for its three named states. Preserve the deadline; if it recurs, capture per-step/audit durations and renderer/CPU state before choosing a fix. See the 2026-10-28 status entry |
| Scorecard Binary-Artifacts | By design | It flags `packages/analyzer-py/grammar/tree-sitter-python.wasm`, a grammar built reproducibly from pinned sources and checked by hash ([ADR-080](adr/ADR-080-python-3-15-syntax.md)). Only the owner triages or dismisses security alerts |

## Owner actions

- **Required checks.** Add `verify (macos-latest)`, `pinned repository corpus (macos-latest)`
  and `viewer journeys (firefox|webkit)` to the ruleset for `main`
  ([ADR-068](adr/ADR-068-macos-in-ci.md), [ADR-069](adr/ADR-069-firefox-and-webkit-journeys.md)).
  The ruleset requires nine checks, and these are not among them.
- **Release `v0.1.0-beta.2`.** The tag exists (2026-10-19) and its release run left a
  draft. Review and publish it, or leave it as a draft; then move the versions to the
  next `-dev` version.
- **Pages deploys from releases.** The `github-pages` environment allows only the `main`
  branch, but a published release runs `demo site` from its tag, which GitHub then
  refuses to deploy. That path has never run. Allow tags `v*` in Settings → Environments,
  or run `demo site` from `main` after publishing
  ([release process](release/release-process.md#owner-settings)).
- **Merged branches.** Deleting the remote branches of merged pull requests is safe and
  optional.

## Proposed product work (owner direction and an ADR first)

Ideas that build on data ATLAS already produces. Except for the authorized increment
below, each remains new scope.
The owner authorized external findings on 2026-10-28: Ruff SARIF import and conservative
local report comparison landed in PR #52 (ADR-085). Q2.1 scan declarations and offline
GitHub verification landed in PR #53 (ADR-086). Q2.2 contextual review within one
history artifact, historical-target/producer policies and browser navigation are
implemented for review (ADR-087). The inactive signing recipes need owner review,
copy/merge and dispatch
before there is a live ATLAS scan proof; a real vendor signature fixture is a separate
test. Consider adding `scan provenance verifier (offline)` to required checks after
review. Cross-artifact/long-term issue databases, other producers and Q3 architecture
gates remain future work. Context fingerprints are best-effort evidence continuity;
no disappearing result is automatically resolved. Existing V0.1 acceptance work is unchanged.

- **Review a change.** Start from the changed files, show changed dependencies and the
  static consumer paths, and link every statement to its evidence. No claims about
  predicted runtime impact.
- **Onboarding routes.** Extend the guided start into team-written sequences (entry point,
  package, dependencies, relevant tests) with explanations and saved camera positions.
- **Architecture rules.** Teams declare allowed package boundaries and get evidence when a
  new dependency or cycle breaks one.
- **Persistent review workspace.** Baselines, decisions, notes and review history kept
  across weeks, with private access. Hosted private repositories are beyond V0.1.
- **Change briefing.** New cycles, dependency changes and hotspot movement against an
  explicit baseline.
- **Task-first start.** "Understand this repository", "Review changes", "Inspect a hotspot"
  as entry points into the existing tools.
- **Adaptive detail.** Choose low detail from measured frame times, for browsers that hide
  a software renderer (ADR-079, "Not decided here").
- **Fit more history frames.** Size-aware delta bases and a more compact artifact encoding,
  to keep more of the 12 frames on large repositories (ADR-083, ADR-084).
- **After acceptance** (production plan M5.3): `1.0.0`, npm publication of the CLI, a
  Python demo, notebooks, namespace package imports and the Node 26 migration.
