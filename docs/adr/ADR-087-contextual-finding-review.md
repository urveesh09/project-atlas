# ADR-087: Conservative contextual finding review

Date: 2026-10-29. Status: implemented for Q2.2 review; continued development authorized after
the owner merged PR #53 (`e518ecf`). Builds on ADR-085/086, without rewriting them.

## Evidence and cause

Exact line numbers turn inserted lines into apparent new/disappearing findings.
Matching only rule and file also conflates repeated code. An authenticated report
still contains producer assertions: neither an attestation nor disappearance proves
a semantic fix. File lineage is bounded to one history artifact (plan §7).

## Decision

1. Add optional `atlas review-findings <current.scan.json> --baseline <old.scan.json>
   --artifact <dir> --repo <dir> --out <review.json>`. Require different sampled frames,
   baseline before current in mainline order, and the same analysis/repository.
   Keep core artifacts/analyzer versions unchanged; no scanner or repository code runs.
2. Read only committed objects with the existing sanitized local Git adapter. Validate
   both frame file/blob inventories against their committed trees. No checkout, hooks,
   filters, configuration, source URL fetch, dependency installation or network.
3. A contextual anchor hashes the exact finding line plus up to two physical lines on
   each side, with boundary positions represented. Preserve whitespace, case and Unicode;
   normalize CRLF line terminators only. Require a known column and a unique full
   context in that file. Do not persist text. Identical context within the same lineage,
   Ruff version, profile and column yields a deterministic tracking ID across line
   shifts and accepted renames. This is evidence continuity, not universal issue identity.
4. Repeated/unavailable context or unknown columns use a blob-and-location ID, stable
   only while blob/location stay identical. Never guess between duplicate contexts,
   copy a tracking identity into another lineage, or carry one through changed context.
   Changed neighborhoods and ambiguous edits remain unmatched, even if likely a fix.
5. Bound reads to 1 MiB per blob and 64 MiB total, 16 KiB per context, 4,096 findings
   per side, 8,192 review rows and 8 MiB input/output. Limits are explicit; unavailable
   anchors remain visible. Read each blob at most once; at most 200,000 context windows
   are indexed per review. A blob that cannot fit the remaining window budget has
   unavailable contextual anchors rather than a sampled uniqueness claim.
   Native object reads batch at most 64 blobs/8 MiB to avoid spawning Git per finding.
   Validate each read blob's actual Git object hash before indexing context.
6. The separate `atlas.finding-review/1` stores the two normalized quality reports,
   original scan byte digests, profiles/coverage summaries, source-free anchors and
   deterministic rows. Validate counts, ordering, reference partition and derived IDs
   on every opening. No source, original messages, machine paths or arbitrary metadata.
7. Optional `--current-proof <dir> --baseline-proof <dir>` independently select operator-
   reviewed directories with `bundle.jsonl`, `trust.json`, `trusted-root.jsonl`.
   Both or neither; `--gh` remains an explicit trusted executable. Verify both original
   scan byte strings with ADR-086's real verifier. Failed proof produces no review.
   Comparable declarations require both verified, complete declared analyzed-Python
   scope, same Ruff version/profile and approved repository/workflow/ref/root identity.
   Each workflow/source revision stays exactly pinned by its own policy. Revisions may
   differ: a direct workflow's signer revision changes with the source commit. Equality
   of those revisions would make legitimate cross-commit review impossible. Operators
   must review both approved producer revisions; no claim of identical transitive code.
   Preserve `atlas.scan-trust/1` direct-source equality. Historical mode requires an
   explicit operator-selected `atlas.review-scan-trust/1`: separately pin the scan
   target commit and the nested producer checkout/workflow/root policy. A current
   workflow can attest both historical/current subjects in one artifact; its certificate
   source is the producer checkout, not automatically either inspected revision.
   Store both pins as declared metadata. Untrusted subject JSON never chooses this mode.
8. Unique matches are `continuing`. Other rows stay `unmatched-current/baseline` unless
   authenticated comparable declarations with unique context or identical blob/location establish that
   an occurrence is newly/no longer reported. Missing Python lineage, missing source,
   changed context, duplicate context and changed configuration remain explicit.
   Never label a result resolved, safe or mergeable. Exit 2 means useful but uncertain
   review (including unsigned declarations); exit 0 still does not mean lint-clean.
9. The browser imports a review locally and atomically binds both reports to frames.
   Validate references and deterministic rows in a disposable bounded worker. Show
   tracking basis and current/baseline navigation with an explicit unauthenticated
   declaration warning, even when copied JSON claims successful verification. Opening
   other reports or clearing/replacing the dataset clears the review. No trust receipt,
   persistent team service, quality gate, billing or signing activation.

## Verification plan

Author expected matches before running code: insertion, rename, severity change,
duplicates, copy/delete/recreate, unknown columns, changed context/version/profile,
partial scans, malformed bindings/rows, missing source, wrong policy and cancellation.
Three-frame fixtures must demonstrate IDs survive repeated unchanged-context movement.
Exercise real CLI/source reads and a real Ruff producer; mock orchestration separately
from the existing actual offline signature test. Browser tasks cover atomic recovery,
no upload, 320 px/keyboard/accessibility and forged authentication claims. Run full
verification, all engines, distribution and six-repository baseline before owner merge.
Record failed attempts and limits. Human/device/site G6/R6 acceptance remains open.

Actual local verification: 1,021 tests pass with 92 disclosed skips; all 53 browser
journeys pass in Chromium (CI software rendering), Firefox and WebKit. The full-size
review importer keeps the existing seven-second worker deadline. Real isolated Ruff
and committed Git data produce the independently expected renamed/shifted finding;
all Git metadata bytes stay unchanged. The first filter-label defect and the historical
producer/target design correction are recorded in the [functional evidence](../benchmarks/finding-review.md).
Twenty fresh-process synthetic capacity runs retain 4,096 matches each; see the
[observations](../benchmarks/finding-review-capacity.md). These are not live ATLAS
signatures or human/device/site acceptance. Final corpus, distribution and exact-head
CI evidence belong to the status entry and PR before owner merge.

## Primary references

- [GitHub CLI verification policy flags](https://cli.github.com/manual/gh_attestation_verify).
- [GitHub artifact attestations and build provenance](https://docs.github.com/en/actions/concepts/security/artifact-attestations).
