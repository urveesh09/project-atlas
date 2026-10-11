# ADR-035: Phase 6 candidate evidence and portable CLI distribution

Date: 2026-10-11. Status: accepted for candidate tooling; G6 sign-off remains open.

## Context and decisions

Successful development-checkout commands do not prove a distributable CLI. Matching
an analyzer's own generated expectations does not prove real-repository correctness.
Automated accessibility audits do not represent human screen-reader use. These are
different acceptance requirements in plan §1.5, §15–17.

P6.1 pins three public repositories by numeric identity and immutable commit: a small
JS package, Vue's TS workspace and Vite's mixed TS/JS workspace. Expected roles and
import targets are authored from committed source before analysis. Explicit acquisition
uses the existing safe Git reader; five subsequent cold runs per repository are offline.
Every canonical and wire chunk digest, including historical graphs and layout, must
match across repeats. CI independently repeats this on Windows and Linux and compares
the reports. Envelope timestamps and publication IDs do not enter the comparison.
Repeat equality proves determinism, not correctness; the independent examples prove
only their stated cases. Unsupported framework transforms and intentional invalid
fixtures remain visible, including Vite's partial result. No corpus source enters Git.

P6.4 tooling produces an archive from the compiled, locked CLI dependency closure and
the built static viewer. Workspace module and parser-worker paths are preserved.
Runtime dependencies are real files rather than pnpm symlinks. Conflicting versions
fail packaging instead of silently selecting one. Third-party license text accompanies
the bundle; a pinned upstream license supplies the missing fiber 9.8.1 npm notice.
No lifecycle hook, package installation or registry publication runs during packaging.

The archive is a **candidate**, retaining development package versions. It requires
Node 24.15.x and Git ≥2.38, as diagnosed by `atlas doctor`. It is not a native executable,
a hosted deployment or a final npm release. Its inventory records every file's length
and SHA-256, source commit, dirty-tree status and lockfile digest. These verify integrity
and provenance; they are not a release signature. Reports must expose a dirty build.

The distribution gate extracts into a fresh directory outside the checkout and verifies
all distributed bytes. Doctor, analysis, verify, inspect and serve run using that bundle
with entry-process outbound sockets denied. Chromium exercises the bundled city,
12-frame history, keyboard search and an independently known dependency; its requests
must stay on loopback. Existing parser isolation and network-less sandbox tests cover
analysis children. CI runs the relocated distribution gate on both supported OSes.

Candidate documentation and tooling are prepared while P6.2/P6.3 are unfinished.
Their preparation does **not** waive P6.4's dependencies or make G6 pass. The release
audit identifies each remaining measurement and human/operator review explicitly.
Reference-device timings cannot be inferred from a faster development computer;
SwiftShader is functional evidence only. Original failed/contended reports are retained.

## Consequences and alternatives

- A portable JS archive avoids publishing an unreviewed version to npm and removes
  package-manager/install-hook requirements from the end-user path. Node/Git remain
  prerequisites. Native single-file bundling is deferred because child/module paths
  and the static viewer need separate validation.
- Real-repository artifacts stay local until explicitly exported/shared. Source-free
  artifacts still disclose paths, declaration names, relationships and commit IDs.
- Corpus timing observations are separate from 20-run synthetic capacity gates.
  The near-limit 9,992-file HEAD fixture is documented as such; it does not substitute
  for an exact 10,000-file/100,000-edge or 20,000-lineage temporal capacity measurement.
- Registry audit results are dated observations. Git, image OS packages and runtime
  deployment controls require their own operator review before public launch.

## Evidence

[Corpus definitions](../release/repository-corpus.json), [measured corpus report](../release/real-repositories.md),
[distribution smoke](../release/distribution-smoke.md), [release audit](../release/release-audit.md),
`scripts/package-cli.mjs`, `scripts/verify-cli-package.mjs`,
`scripts/validate-real-repositories.mjs`, `scripts/compare-repository-reports.mjs` and
the mandatory distribution/corpus jobs in `.github/workflows/ci.yml`.

The complete local integration run initially timed out a two-analysis overwrite test
under file-level contention (674 other checks passed). Its isolated rerun passed all
19 CLI checks and the affected case in 10.91 s. Vitest file concurrency is now bounded
to two because each file may create parser children or Docker jobs. Test deadlines and
production performance budgets are unchanged; the final full run must still pass.
