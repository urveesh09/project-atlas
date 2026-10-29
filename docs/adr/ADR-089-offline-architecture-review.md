# ADR-089: Offline architecture policy review

Date: 2026-10-29. Status: accepted for Q3. Owner continuation after merged PR #54
authorizes the next increment of the external-findings roadmap.

## Evidence and cause

ATLAS already has validated file dependencies, bounded lineage and cycle components.
Teams cannot yet declare production/test or package boundaries and review their
violations against a selected baseline. A new scanner or executable policy language
would add risk without providing the facts needed for this workflow.

## Decision

- Add `atlas review-architecture <artifact> --policy <json> --commit <full-oid>
  --out <review.json> [--baseline <earlier-full-oid>] [--markdown] [--fail-on new|all]`.
  JSON is the default file; `--markdown` selects a human-readable file. Standard
  output stays a bounded machine summary under `--json`. Recreate each format with
  a distinct output path. No repository, Git, scanner, configuration or network runs.
- Policies are explicit operator-selected strict JSON, not repository-discovered
  code. At most 16 uniquely named rules and 64 KiB. Forbidden-dependency rules use
  from/to selectors: canonical path prefixes (segment boundaries, empty means all),
  file roles, exact owning package paths. Fields combine by AND, values by OR.
  Missing fields mean unrestricted; empty selectors/arrays and duplicates fail.
  No regex, glob, external URI, rule plugin, severity or executable expression.
  Duplicate JSON keys (including escaped aliases) and depth beyond 32 are rejected.
  Each rule explicitly names file edge kinds. All confidence levels are evaluated
  and disclosed. External packages, unresolved imports and package declarations
  are outside this first file-to-file policy contract.
- One optional static-cycle rule uses the existing fixed synchronous value policy.
  Compare component identity by sorted member lineages within one analysis. Rename
  continuity follows analyzer lineage; new members form a newly observed component.
  This does not enumerate every simple cycle or detect a new route inside an existing
  component. Keep bounded member evidence; a truncated non-closed witness is omitted,
  never presented as a closed cycle. Core cycle generation/output is unchanged.
- JSON sidecars carry policy/hash, analysis identity, snapshot identities, coverage,
  per-rule match/count summaries and source-free file/edge/location evidence. At most
  2,000 rows, 32 cycle members, 64 witness hops and four observation locations per
  edge. Evaluate/count all matches before retaining bounded evidence. Truncation,
  partial graph coverage and selectors matching no files are explicit uncertainty.
  Zero observed violations is not a repository-wide clean/security/runtime verdict.
- Compare only ordered frames of one validated artifact. Relations match source and
  target lineages, kind and confidence; the policy is identical on both sides.
  States are newly observed, continuing, or uncompared. Missing old relations are
  counted as no longer observed, never resolved. Artifact provenance is not authenticated.
- Default CLI mode reports, without making policy decisions for CI. Opt-in
  `--fail-on new|all` returns 3 for observed matching violations, 2 for incomplete
  evidence otherwise, 0 for complete evaluation without a blocking match, 1 for
  failure, 64 usage, 130 cancellation. `new` requires a baseline. It is an architecture
  policy check over supplied evidence, not an automatic security/merge approval.
- All output is exclusive mode 0600 outside the immutable artifact, with an 8 MiB
  byte ceiling. Markdown escapes input text and creates no active links/HTML. Graph,
  analyzer and artifact versions/bytes remain unchanged. No new dependencies.
- Q3 delivers offline CLI/CI JSON and readable review reports. Interactive city
  overlays/import, persistent decisions, private workspaces and billing are later work.

## Verification

Independently authored internal-edge/cycle expectations, adversarial policy/output
tests, rename and partial coverage, deterministic permutations, 10,000-file/100,000-edge
capacity observations, real Git fixture analysis and relocated CLI smoke are required.
Run full verification, the six-repository exact baseline and existing browser/security
matrix. Record failures and actual results in the status and PR. Human/device/live-site
G6/R6 gates remain open; no release, deployment or active signing recipe is authorized.
