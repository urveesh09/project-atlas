# ADR-092: Isolate browser verification from other test files

Date: 2026-10-29. Status: accepted for PR #55's CI correction. ADR-090 and ADR-091
are reserved for the concurrently developed architecture viewer and local workspace.
Amends the test scheduling of ADR-068; no product, graph or artifact contract changes.

## Evidence and cause

PR #55 head `0656688` passed 17 checks, including all 31 new Q3 tests and the
Firefox/WebKit journeys. [macOS verification](https://github.com/urveesh09/project-atlas/actions/runs/40924967843/job/123627912440)
failed the unchanged 30-second named-view journey. Its audits eventually recorded
zero violations at 17:54:37.721Z (menu), 17:55:05.539Z (imported), and
17:55:26.285Z (restored). Those late records do not turn the timed-out journey into
a pass: its callback continued after Vitest reported its deadline.

The other file worker ran the exact-capacity fixture for 24.56 seconds, approximately
17:54:46–17:55:11Z, then the Python oracle for 84.54 seconds, approximately
17:55:16–17:56:41Z. The overlap with browser/audit work is established. It does not
prove CPU contention was the sole cause of the timeout. Existing scheduling isolated
container/database fault gates, but omitted required browser verification. A prior
macOS J1 audit timeout has the same unresolved timing limitation (backlog).

## Decision

- `ATLAS_REQUIRE_BROWSER_TESTS=1` selects one Vitest file worker, just as physical
  fault gates do. Browser, accessibility, parser and capacity tests all remain enabled;
  their explicit concurrency inside each test remains unchanged. Other Node-only runs
  keep two file workers. No deadline, poll, assertion, rule or coverage requirement is
  relaxed, no test is split to enlarge its budget, and no retry hides the first failure.
- Keep all existing automated accessibility tags/rules, incomplete records and named
  state reports. Add sanitized begin/settled/complete/failed lifecycle timing records
  plus settle/axe/total durations and **test-worker** CPU deltas. These are not browser
  or system-wide CPU measurements. Read only the current renderer/view mode,
  visibility, animation count and canvas count; do not enable benchmark mode, query
  WebGL contexts, pause rendering or change product state to make an audit pass.
- Retain the original macOS logs and audit artifact. Treat isolation as removal of
  proven avoidable workload overlap, not proof that every future runner timing issue
  is fixed. G6's human/device accessibility acceptance stays open.

## Verification

Before commit, run full browser-enabled verification with the original 30-second
journeys and unchanged audit assertions; inspect lifecycle records and durations.
CI must pass the complete platform/browser/security matrix on the corrected head.
The follow-up branches inherit this correction before their final tests and PRs.
