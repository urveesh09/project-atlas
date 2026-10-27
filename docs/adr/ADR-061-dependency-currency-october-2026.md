# ADR-061: Dependency currency, October 2026

Date: 2026-10-16. Status: accepted, merged in [PR #20](https://github.com/urveesh09/project-atlas/pull/20) on 2026-10-16. Local verification below.
Amends ADR-014's runtime pin. ADR-015's resolution policy remains unchanged.

## Evidence and cause

The owner directed implementation of the production plan in PR #19, beginning with
M1. Node 24.15.0 was the implementation runtime, but misses subsequent security
releases. [Node's official release](https://nodejs.org/en/blog/release/v24.22.0)
confirms 24.22.0, released on 2026-10-14, on the existing LTS major.

## Decision

### M1.1: runtime and images

- Pin `.nvmrc` to 24.22.0 and raise the workspace engine minimum to `>=24.22.0 <25`.
  CI and release workflows already read `.nvmrc`; none needs a literal Node version.
- Use the multi-architecture OCI index of `node:24.22.0-trixie-slim` in both
  Dockerfiles, resolved with `docker buildx imagetools inspect` on 2026-10-16:
  `sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315`.
  Non-root identities, sandbox limits and the exact Git pin are unchanged.
- Update active prerequisite and archive instructions. Keep past environment records
  and accepted ADRs intact.
- Let `atlas doctor` diagnose older 24.x installations with a warning, rather than
  fail before users can see the recommendation. Unsupported majors still fail.
  JSON exposes `warn` explicitly; warnings alone do not set `ok: false` or a failing
  exit code. Human output uses the existing warning glyph and a warning summary.
- Keep analyzer and artifact versions, corpus goldens, parser pins, and
  `NODE_BUILTIN_SOURCE_VERSION = '24.15.0'` unchanged. Comparison with 24.22.0's
  `module.builtinModules`, including the four prefix-only entries checked through
  `module.isBuiltin`, found no added or removed specifiers. Future additions need a
  separate semantic decision and versioned change.
- Use a checksum-verified portable Windows runtime for local verification, without
  replacing the owner's system installation. The official archive
  `node-v24.22.0-win-x64.zip` matched `SHASUMS256.txt`:
  `f9683a19877e12a9b167305c8db71040d812876359de21f0d2e97c3f321f80c3`.

### M1.6: versions deliberately held back

- TypeScript stays on 6.0.3 for the analyzer's compiler API (ADR-013/015). A new
  major/compiler API or workspace compiler migration needs separate investigation.
- `@types/node` stays on 24.x to match the runtime major; it is not an invitation to
  move to Node 26 types.
- Node stays on the supported 24 LTS major for this release. A Node 26 migration is
  separate work after its LTS stabilization, as the production plan requires.
- pnpm stays exactly 10.34.6. Lockfile/settings migration is outside M1.1; a change
  in security support would require revisiting this decision.

Other M1 tasks add their own sections and evidence in separate pull requests. This
record does not claim the remaining dependency upgrades or P1 are complete.

## Verification

- Eight hand-authored runtime boundary cases exercise both JSON and human doctor
  output through the real command and offline Git probe: 24.0.0, 24.15.0 and 24.21.9
  warn; 24.22.0, 24.22.1 and 24.23.0 pass; 23.11.0 and 25.0.0 fail. All eight pass
  under Node 24.22.0.
- `ATLAS_REQUIRE_BROWSER_TESTS=1 pnpm verify` on 24.22.0: 742 passed, 81
  service-gated skipped, including the 39 normal-mode viewer journeys. Typecheck,
  viewer build, dependency direction (15 packages), and contracts (six files) pass.
- Four pinned repositories, five offline cold repeats each: all 28 authored facts,
  canonical graphs and compressed transports match the previous committed baseline.
  Only the report's timestamp, runtime and observed timings change. Vite's partial
  status is expected; no output or assertion was changed to make the check pass.
  Some image builds overlapped Vite repeats; no capacity claim uses these timings.
- Both Dockerfiles build on the pinned base. Both images report 24.22.0 / uid 10001
  with no network, a read-only root, no capabilities and no-new-privileges. Legacy
  `pnpm deploy` still emits development peer warnings under the existing scoped
  peer-check override; no dependency or override was added to hide them.
- Frozen offline installation succeeds without lockfile changes. The actual CLI on
  system Node 24.15.0 reports `warn`, `ok: true`, exit 0; on portable 24.22.0 it
  reports `ok`, `ok: true`, exit 0.
- Viewer journeys also pass 39/39 with `CI=1` (software rendering).
- Portable CLI smoke passes all six stages outside the checkout, without installing
  dependencies or using the network. The 11,018,736-byte development archive has
  SHA-256 `f44ea600c5f2de39355dec2ef675ed58b42ca6497344c53963ee0d5759e479b9`;
  this is a dirty-tree packaging check, not a selected release candidate.
- Required CI, including hosted container faults and Windows/Linux corpus equality,
  is tracked in the implementation pull request; local skipped service suites are
  not reported as passes. M1.1 is not marked landed before owner merge.

No G6 human, reference-device or deployment acceptance item is closed by a runtime
upgrade.

## M1.2: bounded TOML parsing security update (2026-10-16)

### Evidence and cause

`smol-toml` 1.8.0 is affected by GHSA-r4xh-jqrq-34v2. A valid, admitted 1 MiB
manifest makes production discovery take 2,504.5356 ms and fails the authored
1,000 ms regression. Discovery runs synchronously in the analyzer parent, before
source-parser children. Git blob bytes are capped at 1 MiB by inventory; discovery
also bounds string length. These existing limits constrain exposure but do not
remove the inefficient parse path.

### Decision

- Pin 1.9.1 exactly, BSD-3-Clause with no runtime dependencies. Keep the named
  `parse` import. ADR-057 remains an accurate historical record.
- Upstream tables now have null prototypes; existing validated own-property reads
  remain suitable. Upstream also tightens malformed TOML rejection. Keep ATLAS's
  invalid-manifest warnings; do not add unsafe compatibility shims.
- Add four checks: full-size discovery under one second, over-limit pyproject and
  Pipfile rejection, and safe interpretation of prototype-like metadata. A disposable
  test child has a 10-second deadline; production limits are unchanged.
- The owner's 2026-10-16 direction combines M1.2 and M1.3 in one PR with individual
  commits. This overrides this batch's separate-PR guidance, not its verification.

### Verification

The old dependency fails the new timing assertion, while its other three checks
pass. With 1.9.1 all four pass; the same input's diagnostic measures 148.4486 ms.
See [the retained diagnostic](../benchmarks/production-toml-security.md) for the input,
initial failure, exact context and caveats. Full verification passes 746 tests with
81 service-gated skips, including 39 normal viewer journeys. Four pinned repositories
with five offline cold repeats preserve all canonical/wire payloads and 28 authored
facts against the committed baseline, including Flask. Generated contracts remain
unchanged. Production dependency audit reports no known advisories. Combined-PR CI
must still pass; Dependabot alert closure remains a post-merge GitHub check.

## M1.3a: viewer runtime patch upgrades (2026-10-16)

### Evidence and decision

- Pin React/React DOM 19.3.1 and React Three Fiber 9.8.2 exactly, keeping TypeScript,
  Three.js and React type packages at their existing pins.
- Review official React and Fiber release notes. ATLAS uses Fiber only in the
  rendering spike; the production city owns its Three.js renderer and resolution
  control. No `setDpr` calls conflict with Fiber's updated Canvas DPR behavior.
- The 9.8.2 npm package still omits LICENSE. Supply the MIT text from upstream commit
  `d74622ea8ed717f7212d7e19d65ff3e325508389` (tag `v9.8.2`), SHA-256
  `9c35b5de7b7493a707fffe4eb23bd2f7f449153c1911f7c6eefb4e591fd5349a`.
  Update the exact-version fallback in the packager and remove the old version's copy.
  License acquisition is maintainer work; packaging remains offline.
- Keep this upgrade group in its own commit within the owner-requested combined PR.

### Verification

Full verification passes 746 tests with 81 service-gated skips, including the 39
normal viewer journeys; the software-renderer run also passes 39/39. All six
relocated distribution stages pass with the refreshed license. Its dependency
screen screenshot was visually inspected: city, selection, dependency arrows, tree,
controls and inspector render coherently. The computer-use browser's local bootstrap
was rejected by the cross-site guard, so no manual interaction pass is claimed and
no security policy was changed. The clean-commit rendering spike follows this
implementation checkpoint; results will be recorded with final batch evidence.
No rendering or accessibility assertion is weakened.

Sources: [React 19.3.1](https://github.com/react/react/releases/tag/v19.3.1),
[Fiber 9.8.2](https://github.com/pmndrs/react-three-fiber/releases/tag/v9.8.2),
[exact-tag license](https://github.com/pmndrs/react-three-fiber/blob/d74622ea8ed717f7212d7e19d65ff3e325508389/LICENSE).

## M1.3b: contract validation patch (2026-10-16)

### Evidence and decision

Pin Zod 4.6.7 at every workspace declaration (schema, analyzer-core, control and
worker). Review the [upstream comparison](https://github.com/colinhacks/zod/compare/v4.6.5...v4.6.7),
including earlier collection-size rejection. Keep the existing schemas, generated
files, analyzer and artifact versions. No contract regeneration is used to conceal
drift. This upgrade is its own commit within the combined PR.

### Verification

`pnpm contracts:check` passes without regeneration, and independent SHA-256 checks
confirm all five JSON Schemas and OpenAPI match their pre-upgrade bytes. Full
verification passes 746 tests with 81 service-gated skips. Four repositories × five
offline cold repeats preserve all 28 authored facts and exact canonical/wire payloads
against the committed baseline. No schema regeneration, version bump or golden
rewrite is necessary.

## M1.3c: test and accessibility tooling (2026-10-16)

### Evidence and decision

- Pin Vitest 5.0.5 at the root, Playwright 1.64.1 in all three declaring packages,
  and `@axe-core/playwright` 4.14.0 in both declaring packages.
- Review the official patch notes and reinstall/verify Chromium using the new
  Playwright package. Preserve every existing keyboard, rendering, reflow, source,
  artifact and axe assertion; new findings require fixes rather than rule exclusions.
- Keep the framework upgrade as its own implementation commit in the combined PR.
  Final reports may follow in a documentation-only evidence commit so performance
  measurements start from a clean implementation commit.

### Verification

The complete suite passes 746 tests with 81 service-gated skips under Vitest 5.0.5;
both normal and CI software-renderer viewer journeys pass 39/39 with axe 4.14.0.
The six relocated distribution stages pass; its dirty-tree development archive is
11,036,676 bytes, SHA-256
`83e7f1ef4bef71a2d7e9e226c906b6691b51de5d39665961a1907f7d6b2a31d1`.
Fresh keyboard dependency/finding screenshots were inspected and retained locally.
Generated candidate reports/images are restored; they are not release identities.
The dependency audit reports zero known advisories. Both API and sandbox images
build and run as uid 10001 on Node 24.22.0 with no network, read-only roots, no
capabilities and no-new-privileges. The sandbox's actual installed runtime packages
report TOML 1.9.1 and Zod 4.6.7. Local image IDs are recorded in implementation
status; they are development images, not a release selection. The final clean-commit
spike and combined CI are required before handoff. No missing physical or human
gate is treated as passed.

### Final local batch evidence

The clean `071aaab` implementation commit repeats the full 20-batch spike at all
three sizes: p95 17.8 ms, two draw calls each, 271/271 picks, both HTML fallbacks,
and no recorded scenario/picking errors. The
[report](../benchmarks/production-viewer-patches.md) retains both clean checkpoints
and hardware/method limits. Historical Phase 0 and release-candidate reports/images
remain untouched. All four implementation commits had `pnpm verify` pass before
commit; this final evidence-only commit records the subsequent clean run.
Required combined CI and owner merge remain pending. M1.4/M1.5 and P1/G6 are open.

Sources: [Vitest 5.0.5](https://github.com/vitest-dev/vitest/releases/tag/v5.0.5),
[Playwright 1.64.1](https://github.com/microsoft/playwright/releases/tag/v1.64.1),
[axe 4.14.0](https://github.com/dequelabs/axe-core-npm/releases/tag/v4.14.0).

## M1.4: image and CI service pins (2026-10-16)

### Evidence and decision

- A fresh `apt-get update` in the pinned Node 24.22.0 trixie image includes
  `trixie`, `trixie-updates` and `trixie-security`. `apt-cache policy git` still
  reports candidate `1:2.47.3-0+deb13u1` from trixie/main; no newer security-suite
  candidate is offered. Retain that exact sandbox package pin. The sandbox image
  itself reports the same installed package, Git 2.47.3, Node 24.22.0 and uid 10001.
- The official `postgres:17-alpine` multi-architecture index, resolved with
  `docker buildx imagetools inspect` on this date, is
  `sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24`.
  It already matches `deploy/compose.yaml`. Pin CI to this index too; the tested
  Linux/amd64 container reports PostgreSQL 17.11 on Alpine. Do not rename CI jobs.
- Add monthly checks to the release process because Docker Dependabot watches
  `/deploy`, not workflow image references. Superseded Git pins require a reviewed
  exact-pin update and container gates, rather than removing the constraint.
- No Dockerfile, analyzer, artifact, lockfile, generated contract or version changes
  are needed. Image currency is dated evidence, not an image vulnerability audit.

### Verification

All five workflows pass actionlint 1.7.7, run offline with its immutable image
`sha256:887a259a5a534f3c4f36cb02dca341673c6089431057242cdc931e9f133147e9`.
A fresh disposable PostgreSQL container on the exact index becomes healthy and
passes 28 database/control/API tests; two S3-dependent cases skip explicitly.
Full `pnpm verify` passes on Node 24.22.0: 746 tests pass, including all 39 viewer
journeys, with 81 service-gated skips. Typecheck, viewer build, dependency direction
(15 packages) and contract checks (six files) pass. Required CI follows before
handoff; no G6 item is closed.

## M1.5: Python parser runtime (2026-10-16)

Pin `web-tree-sitter` 0.27.1 and retain the hash-checked Python 0.25.0 grammar.
The existing loading API builds unchanged. Runtime provenance participates in
analysis identity, so this is deliberately analyzer `0.1.0-dev.7`, with baseline
and golden updates governed by
[ADR-062](ADR-062-python-parser-runtime-and-analysis-identity.md).
That record holds the upstream API/ABI review, semantic comparison and verification;
past ADR-056/060 runtime and evidence descriptions remain historical records.

## M2.4: Bounded property testing (2026-10-16)

The production plan and owner direction approve the new development dependency
`fast-check` 4.10.2, pinned exactly in the root package and lockfile. It is test-only;
no production dependency closure, analyzer provenance or artifact version changes.
The registry integrity is
`sha512-iK2f+YrcmoeGqk6fA0ea2bptcu/itMIm4NfEozq6N25+aG6h7s5HZbB/k1aV7b5w5sFLMCbbtRUsTVR+BgC3xw==`.

Properties complement the authored examples rather than replacing their expected
facts. Fixed seeds, bounded sizes/depth and bounded run counts make failures
reproducible; fast-check prints the minimized input and replay path. Coverage:

- canonical JSON parse/write, structural equality, streaming and digest agreement;
  arbitrary UTF-16 is preserved or rejected with `CanonicalJsonError`;
- repository paths preserve valid Unicode/case and reject escapes, controls and
  Git metadata rather than normalizing multiple Git identities together;
- all four Python manifest formats recover generated literal requirements, contain
  malformed text, reject oversized text and terminate cyclic requirements includes;
- artifact imports reject malformed manifests and changed chunk payloads, making
  only allowlisted, bounded reads; gzip metadata is deliberately not confused with
  the content hashes that the format actually verifies;
- indexed/delta transport round-trips generated extension data exactly; malformed
  schemas/references/runs produce only the decoders' named errors, and accepted
  decoded graphs respect their requested/production bounds.

No random seed, unbounded fuzzing, percentage gate or production deadline change.
The focused suite passes all 24 properties on 2026-10-17: 2,638 generated examples
at the fixed seeds, excluding fast-check's additional shrinking attempts. The
first run passed 23 and failed one because the test used an invalid extension key
`property`. The actual schema requires a dotted namespace (`primitives.ts`);
correct the positive generator to `atlas.property`. Seed 1128812107, replay path
`0:0`, shrank to value `0`. This was a test-data defect, not an analyzer change.
The complete 24-property retest passes. Full verification and CI outcomes are
recorded in implementation status and the PR when completed.

## M2.5: Informational V8 coverage (2026-10-17)

The production plan approves development-only `@vitest/coverage-v8` 5.0.5, pinned
exactly to match Vitest. `pnpm coverage` builds the viewer and runs the existing
suite with the V8 provider. Include all production TS/TSX files, including unimported
ones; write ignored text/JSON/HTML reports. Add no percentage threshold or CI gate.

[Coverage scope and first observations](../coverage.md) distinguish Node-process
instrumentation from browser/subprocess execution and service-gated tests. Initial
coverage is 57.47% lines and 49.42% branches; authored checks remain the correctness
evidence. Four risk-driven tests cover bounded local loading, streamed expansion,
multi-page upload purge/isolation and static-only setup metadata. Full verification
after those additions passes 755 tests, 81 explicit service-gated skips.
Retain the initial setup-test expectation failure and its contract-based correction.
No production runtime, analysis identity or artifact contract changes.
