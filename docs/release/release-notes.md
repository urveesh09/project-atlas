# ATLAS V0.1 candidate notes

Version `0.1.0-beta.2`, prepared 2026-10-18. The initial candidate was 2026-10-11, and
`0.1.0-beta.1` was tagged on 2026-10-14. **Release sign-off pending**, as tracked in the
[audit](release-audit.md). The portable archive is a review candidate; it is not published
to npm and no production hosted URL is supplied. The owner tags and publishes
([release process](release-process.md)).

## Since 0.1.0-beta.1

The full list is in the [changelog](../../CHANGELOG.md).
- **Python** (`.py`, `.pyi`) and mixed TS/JS–Python repositories. They are checked
  against CPython's own parser on its standard library, and the hosted Python journey
  passes.
- **Wider testing.** CI now runs on macOS as well as Windows and Linux, and every viewer
  journey runs in Firefox and WebKit. That found and fixed:
  - search ignoring Enter;
  - Safari failing to open picked folders;
  - a blocked-eval error.
- **Accessibility and fallback.** Accessibility audit tooling was extended, with
  screen-reader review scripts. Without 3D support the viewer now falls back to the 2D
  map silently.
- **Hosted production kit** (not a live deployment):
  - a hardened TLS/API profile and dedicated worker units with expiring egress rules;
  - Prometheus metrics with tested alerts;
  - private backups and an isolated restore drill;
  - scanned immutable images with verified provenance;
  - provisional service levels and incident handling;
  - privacy, terms and takedown pages carrying the owner's wording;
  - job records deleted after 30 days, and a required status page.

## Available behavior

- Committed TypeScript, JavaScript and Python (`.py`, `.pyi`) repositories, including
  mixed repositories, become deterministic miniature cities: packages,
  directories and files; synchronized search, tree, inspector, map and HTML table.
- Static import/re-export dependencies include direction, kind, resolution status,
  confidence and source evidence. Cycles have an example path; dense overlays have
  bounded arcs and explicit omitted counts with complete paged evidence.
- Diagnostics and hotspot lenses expose raw metrics and policy. Unknown/omitted
  analysis remains unknown, and a hotspot is not a defect verdict.
- First-parent Git evolution spans up to 90 days/200 commits/12 sampled frames,
  with conservative rename lineage, fixed union plots, tombstones, A/B comparison,
  interval activity and no future-churn leakage into earlier frames.
- Local `analyze`, `inspect`, `verify`, `serve` and `doctor` require no upload.
  Source opening requires an explicit matching local repository. Browser-picked
  artifacts remain local. PNG exports include provenance.
- The hosted public-GitHub flow supports consent, stages, cancellation, partial HEAD
  checkpoint recovery, immutable publication, seven-day expiry, visibility checks,
  deletion/revocation and purging. Acquisition and analysis use isolated containers;
  the API never holds Docker access. Operators have deployment/recovery runbooks.

## Corrections from the Phase 5 review

Worker startup now enforces exclusive same-database Docker-engine ownership before
reconciliation, including connection-loss fencing. A delayed home-route capabilities
probe cannot replace a newer analysis route. Fast acquisition cannot escape its disk
budget by completing before the first watchdog tick. Browser-only test resources close
reliably, and cold historical page-load assertions wait for actual startup. These changes
preserve analyzer identities, artifact contracts and performance thresholds.

## Candidate evidence and compatibility

[Five cold repeats for each of six immutable real repositories](real-repositories.md)
exercise independent roles/import examples and exact full-payload determinism. Windows
Linux and macOS repeat these checks in CI. The [portable CLI smoke](distribution-smoke.md)
verifies every extracted file and runs the CLI/viewer from outside the checkout without
dependency installation. The candidate includes third-party license notices.

Node 24.22.0 or newer 24.x and Git ≥2.38 are prerequisites. Writers emit artifact 1.4.0 and layout 1.1;
readers retain documented 1.0–1.3 compatibility. Analyzer identity is `0.1.0-dev.8`
([ADR-062](../adr/ADR-062-python-parser-runtime-and-analysis-identity.md)); its runtime
upgrade deliberately changes analysis keys, while existing artifacts stay readable.
Artifacts contain names/paths/relationships/commit IDs even when source is omitted.
See [capabilities](../contracts/capabilities.md), [CLI contract](../contracts/cli.md),
[metrics](../contracts/metrics.md) and [ADRs](../adr) for exact interpretation.

## Known limits and pending release work

Vite's pinned repository produces a useful partial result with unsupported/invalid
fixtures. Generated outputs, bundler-specific aliases/queries/globs, nonliteral imports,
unsupported assets and missing historical objects are reported explicitly. Compiler
resolution may substitute a declaration file for a `.js` specifier. Role labels are
heuristics. There is no promise of runtime-call correctness or full type checking.

Python uses the bundled, hash-checked WASM grammar; no Python interpreter is needed
for analysis. Cython, notebooks and other unsupported languages stay opaque when
included. Standard-library/declared-PyPI resolution is static, not proof of installed
dependency contents; runtime `sys.path` mutations and nonliteral imports retain limits.
The corpus includes Flask, a uv workspace and a mixed application, with authored
checks. The hosted Python journey passes. Python/mixed capacity measurements (M2.2) and
Python 3.15 lazy-import syntax (M2.7) remain open.

Development-host measurements do not certify the four-core/2 GiB analysis environment
or integrated-GPU reference laptop. Existing viewer reports disclose cold-load and
pre-collection allocation costs, including an 11.29 s first historical visit and
657.34 MiB combined pre-collection allocations. Retained-heap/cached-frame results do
not waive startup or reference-device gates. Large temporal capacity and remaining
reference interaction/network profiles require their recorded runs.

Five-developer usability, manual assistive-technology review, independent fresh-environment
reproduction and operator infrastructure sign-off remain open. Runtime tracing and
instrumentation, private hosted repositories, working-tree watching, repository execution,
call graphs and additional language families are deferred. See the audit for completion
criteria rather than assuming implementation completion means release approval.
