# ADR-085: Local external findings, with explicit provenance and conservative comparison

Date: 2026-10-28. Status: proposed; owner authorized this product extension in chat.

## Evidence and cause

PR #51 completed the earlier deployment/correctness recommendations. Main and the
other local checkouts contain no external-findings implementation. The owner asks
to begin the recommended scanner-integration and change-review work. Importing
customer-produced results preserves ATLAS's offline, non-executing analysis boundary.

## Decision

1. Start with **Ruff SARIF 2.1.0**, not an unsupported claim of general SARIF or
   SonarQube parity. No scanner, repository configuration, plugin or fix is executed.
   No commercial rule collection is bundled. A physical producer check uses Ruff
   0.17.3, Windows archive SHA-256
   `a84d9ac74af8ef5bac84a1888a1634df18e6e985e2f930d35c052beacd00e813`.
2. `atlas findings <report.sarif> --artifact <dir> --commit <full-oid> --out <file>`
   writes a separate `atlas.quality/1` report. The commit must identify an analyzed
   frame. The binding is explicitly **user-declared**, not authenticated producer
   provenance: Ruff does not record the scanned Git revision or complete scan scope.
   The caller must run Ruff against the corresponding committed contents.
3. Keep core artifacts unchanged. Sidecars bind the analysis, repository, snapshot,
   commit, file occurrence, lineage and blob. Schema validation and reference checks
   run again on import. Never serve an unlisted sidecar through the artifact server.
4. An explicit source-root URI maps Ruff's absolute local file URIs to repository
   paths. No basename guessing, filesystem lookup, remote URI fetch or traversal.
   Unmapped/unsupported/suppressed records and duplicates are counted. A report with
   dropped records is visibly partial. Input bytes, records, findings and positions
   are bounded. Invalid imports preserve the previous valid UI state.
5. Persist **no report messages, snippets, source, fixes, author data, absolute paths,
   arbitrary properties or links**. Rule codes and versions have constrained syntax;
   labels come from ATLAS's small controlled catalog. Original report text remains local.
6. The browser opens normalized sidecars locally in a bounded disposable worker.
   Its receiver checks the native dedicated-worker channel metadata (empty origin,
   null source and trusted event) and a real `File` before reading bytes. This is a
   private creator channel, not a cross-document window listener; these checks do
   not authenticate the scanned commit or scope.
   Findings select the corresponding file through existing synchronized city/tree/
   inspector navigation. Historical reports never leak into another frame. Keep at
   most a current and baseline report, in memory only; replacement ends their session.
7. Compare exact rule/lineage/position occurrences only within one analysis and Ruff
   version. Label unmatched locations **newly reported** / **no longer reported**;
   a line shift may create both. Scan scope/configuration are unverified, so absence
   never means resolved, clean or safe. No merge gate is built on this evidence.
8. Preserve V0.1 release acceptance items. Later increments need separate ADRs:
   authenticated CI provenance/coverage, robust issue tracking and architecture
   gates, other producers, private sharing and team review. Runtime tracing remains
   deferred. Existing free features remain free (ADR-048).

## Verification

Author expectations for real Ruff F401/F821 results before import. Exercise hostile
URIs, source-root boundaries, UTF-8/size limits, malformed records, suppressed results,
duplicates, wrong bindings, frame changes and comparison uncertainty. Run actual CLI
and browser journeys (including offline/no-upload and accessibility), distribution,
the real-repository baseline and all CI checks. Record failures and final counts in
implementation status; do not infer human/device/site acceptance from these checks.

Initial local verification completed on 2026-10-28: 962 passing tests (92 gated/platform
skips), all 50 viewer journeys in each browser engine plus final focused retests,
the six-repository/five-repeat baseline guard and eight relocated distribution stages.
The actual producer check and two test-assertion failures/retests are documented in
[the functional report](../benchmarks/external-quality-import.md) and
[implementation status](../implementation-status.md). Owner merge and exact-head
CI remain required. No original release gate is closed by this extension.

PR #52's initial CodeQL review flagged `js/missing-origin-check` (alert 74) at the
worker's `self.onmessage`. The explicit channel/payload checks above replace the
implicit assumption, without suppressing the rule or dismissing the alert. Six
regression cases exercise the actual handler; native imports are tested in each
browser engine. Follow-up `pnpm verify` passes 968 tests with 92 gated/platform skips;
the portable archive passes eight stages. See implementation status, including the
separately recorded first-head macOS J1 timeout; this worker guard does not explain it.

## Primary references

- [Ruff output configuration](https://docs.astral.sh/ruff/configuration/).
- [SARIF 2.1.0](https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html).
- [Semgrep rules license](https://semgrep.dev/legal/rules-license/): engine and rule
  licensing are separate; this increment distributes neither.
