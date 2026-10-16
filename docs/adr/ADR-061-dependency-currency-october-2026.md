# ADR-061: Dependency currency, October 2026

Date: 2026-10-16. Status: proposed for M1.1 review; local verification below.
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
