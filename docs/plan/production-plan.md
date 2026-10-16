# Production plan

Written 2026-10-16, after PR #18 merged. This is the plan for taking ATLAS from beta to a
production release, both the local CLI and the hosted service. It is written so that an
agent who has never seen the repository can pick up any task and finish it to the
standard the owner expects.

The [master plan](PROJECT_ATLAS_V0.1_MASTER_PLAN.md) remains the specification, and
[AGENTS.md](../../AGENTS.md) the rulebook. Read AGENTS.md first. If this plan contradicts
AGENTS.md, follow AGENTS.md and tell the owner.

**Owner direction, 2026-10-16.** The owner approves every dependency upgrade this plan
recommends, and wants the product as close to production as it can get before the public
demo is refreshed. That approval covers upgrades and the new dev dependencies named
below. Each still needs its own pull request, evidence and, where this plan says so, an
ADR. It does not cover:
- new product scope, such as notebooks or private repositories;
- the owner-only actions in §7.

## Contents

1. Where things stand
2. What "production" means here
3. How to work
4. The plan, in milestones
   - M1: platform currency and security
   - M2: correctness evidence for Python
   - M3: platforms and browsers
   - M4: hosted production kit
   - M5: release and acceptance
5. How to test
6. Coding standards
7. Owner-only actions
8. Recording work
9. Never

## 1. Where things stand

- **Product.**
  - ATLAS analyzes committed TS/JS and Python.
  - Each analysis becomes a verified, source-free artifact. The viewer draws it as a
    city with history, findings and comparison.
  - The hosted service analyzes public GitHub repositories in offline sandboxes.
- **Versions.**
  - Packages: `0.1.0-beta.1`.
  - Analyzer: `0.1.0-dev.7` (M1.5 runtime provenance; ADR-062).
  - Graph: `atlas.graph/1.1.0`.
  - Artifact: `atlas.artifact/1.4.0`. Readers accept 1.0–1.4.
  - ADRs run up to ADR-062; M1 adds sections to ADR-061. The next new decision is ADR-063.
- **Evidence.**
  - After M1.5's five parser regressions, `pnpm verify` passes 751 tests; 81 more
    skip conditionally. The CPython oracle runs in this evidence. Per-commit
    results are in the status log.
  - The viewer file has 39 browser journeys, and the hosted file 6 PostgreSQL journeys.
  - Four public repositories are pinned and reproduced byte for byte on Windows and Linux:
    is-plain-obj, vuejs/core, vite and pallets/flask.
- **Open gate.** G6 is open until R6-01…R6-07 in the
  [release audit](../release/release-audit.md) have real evidence. These items need human
  reviewers, reference hardware or a real deployment.
- **Found in the audit for this plan, 2026-10-16:**

| Finding | Severity | Task |
|---|---|---|
| Node.js is pinned to 24.15.0 (2026-04-15). It missed the security releases 24.17.0 and 24.18.1; the current 24.x is 24.22.0 (2026-10-14) | High | M1.1 |
| `smol-toml` 1.8.0 has a quadratic-time parse advisory (Dependabot alerts 1 and 2). It parses untrusted `pyproject.toml` files. Fixed in 1.9.0; latest 1.9.1 | Medium | M1.2 |
| The capacity benchmarks predate Python. Nothing has measured the WASM Python parser at the 10,000-file limit under the hosted 2 GiB cap | High for hosted launch | M2.2 |
| The hosted container gates use a TS/JS fixture only. Nothing has shown the sandbox image analyzing Python | High for hosted launch | M2.3 |
| CI runs on Windows and Linux only. The CLI is offered for macOS too, but never tested there | Medium | M3.1 |
| Browser journeys run in Chromium only | Medium | M3.2 |
| Operator metrics are JSON only, and the runbook's alerts exist only as prose. Standard monitoring needs Prometheus text | Medium | M4.2 |
| Nothing ships a production deployment: no reverse proxy config, worker service unit, egress firewall rules or backup job | High for hosted launch | M4.1, M4.3 |
| Released images have provenance attestations but no SBOM or vulnerability scan | Medium | M4.4 |
| The sandbox image pins Debian `git=1:2.47.3-0+deb13u1`. The build breaks once Debian supersedes that version | Medium | M1.4 |
| CI's PostgreSQL service uses the floating tag `postgres:17-alpine`, not a digest | Low | M1.4 |
| There are no property-based or fuzz tests, and no coverage report | Medium | M2.4, M2.5 |
| User docs still say TS/JS only in several places | Low | M2.1 |

## 2. What "production" means here

ATLAS is production-ready when every line below is true, with linked evidence. Track
progress by updating this table's status column as tasks land.

| # | Criterion | Status |
|---|---|---|
| P1 | No dependency or runtime with a known, fixable vulnerability. The pins are current within their supported major versions, and a record says why each major version is held back | Open (M1) |
| P2 | Python has the same evidence quality as TS/JS: several real repositories with checks written before analysis, capacity budgets met, and the hosted path proven | Open (M2) |
| P3 | The CLI is tested on Windows, Linux and macOS. The viewer is tested in Chromium, Firefox and WebKit | Open (M3) |
| P4 | An operator can deploy the hosted service from the repository alone, with TLS, an egress firewall, least-privilege roles, monitoring with alerts, backups with a tested restore, and verified images | Open (M4) |
| P5 | The master plan's §16.5 definition of done: all gates pass, no P0/P1 defects, docs match the implementation, a reproducible demo, visible limitations, and operator recovery | Open (M5; needs R6 evidence) |

"As close as we can get" means: agents finish P1–P4 completely, and prepare everything
for P5 so that only the human, hardware and owner steps remain.

## 3. How to work

- **One task per branch and pull request.** Branch from an up-to-date `main` and name the
  branch after the task, for example `prod/m1-node-24.22`. Small pull requests merge faster
  and are easier to prove.
- **The owner merges.** Make every CI check pass and resolve every review thread. CodeQL
  alerts open threads. Then report and stop. Never merge, and never push to `main`. If
  `main` moves, update your branch and rerun the checks.
- **Order.** M1 comes first, because later evidence should be gathered on the final
  runtime. After M1, M2, M3 and M4 can run in parallel. M5 comes last.
- **Ask the owner before:**
  - new product scope;
  - anything in §7;
  - any task where this plan turns out to be wrong.
- **Decide interface details yourself** when they clearly improve the product. Explain
  them in the ADR and the pull request.
- **Finish what you start.** A task is done when its evidence exists and its checks pass,
  locally and in CI. If something cannot be verified on this machine, such as macOS or real
  hardware, say so in the pull request. Never imply it was verified.

## 4. The plan

Each task lists why it matters, the change, how to test it and when it is done.

### M1. Platform currency and security

Write one ADR, **ADR-061 "Dependency currency, October 2026"**. Every M1 pull request
adds its own section to it, and it also records the versions deliberately held back (M1.6).

#### M1.1 Node.js 24.15.0 → 24.22.0 (high)

**Landed:** [PR #20](https://github.com/urveesh09/project-atlas/pull/20),
2026-10-16. All eight CI jobs and both security jobs pass on `7ed263c`; the four
repository payloads remain byte-identical. Details are in ADR-061 and the status log.

- **Why.**
  - 24.15.0 missed two security releases: 24.17.0 (2026-06-17) and 24.18.1 (2026-07-28).
  - Node 24 enters maintenance on 2026-10-20 and stays supported until 2028-04-30, so 24.x
    is still the right major version (see M1.6).
- **Change.**
  - `.nvmrc` → `24.22.0`, and `engines.node` in `package.json` → `>=24.22.0 <25`.
  - Both Dockerfiles: `NODE_IMAGE` → the digest of `node:24.22.0-trixie-slim`. Resolve it
    with `docker buildx imagetools inspect node:24.22.0-trixie-slim`, then record the
    digest and the date. Use the multi-arch index digest, as today.
  - Update the prerequisite text that says 24.15 (found 2026-10-16):
    - `AGENTS.md:47`, `CONTRIBUTING.md:22`, `README.md:110`, `docs/START_HERE.md:26`;
    - `docs/toolchain.md:9`, `docs/guides/analyze-your-repository.md:15,21`;
    - `docs/release/README.md:25`, `docs/release/release-notes.md:44`;
    - the archive README text in `scripts/package-cli.mjs:112`;
    - the comment in `deploy/sandbox.Dockerfile:8`.
  - **Leave alone:**
    - accepted ADRs and dated benchmark host descriptions, which record what was true
      then;
    - `packages/analyzer-ts/src/builtins.ts`, whose built-in module list is pinned from
      Node 24.15.0 (`NODE_BUILTIN_SOURCE_VERSION`) as analysis semantics (ADR-015), not as
      the runtime. Compare it with `module.builtinModules` on 24.22.0. If the lists
      differ, refreshing it changes resolution: that is a separate pull request with an
      analyzer version bump and an ADR.
  - `atlas doctor` (`packages/cli/src/commands/doctor.ts:33`) accepts any 24.x. Make it
    warn, not fail, below the `engines` minimum, so users learn they are missing security
    fixes. Add a test.
  - Check that every workflow reads `.nvmrc` and has no literal version.
- **Test.**
  - `pnpm verify`.
  - The viewer journeys.
  - `node scripts/validate-real-repositories.mjs` and
    `node scripts/check-repository-baseline.mjs`. The bytes must be identical: a Node
    upgrade must not change output. If they differ, stop and find out why.
  - Build both images.
  - The hosted CI job builds the sandbox image and runs the container gates.
- **Done when** CI is green on the new Node version, the baseline is unchanged and the
  images build.

#### M1.2 `smol-toml` 1.8.0 → 1.9.1 (medium, security)

**Landed:** [PR #22](https://github.com/urveesh09/project-atlas/pull/22), merged
2026-10-16 as `42369b5`. Owner direction combined M1.2 and M1.3 in one pull request,
with independent commits for the security fix and each upgrade group. All eight CI
jobs and both security jobs pass on `9983155`. The first live acquisition job hit
anonymous API rate limits; only that failed job was rerun after waiting. Details
and both attempts are retained in implementation status. The separate-PR exception
applied only to that batch; test gates remain.

- **Why.** Dependabot alerts 1 and 2: quadratic-time `parse()`. Every committed
  `pyproject.toml` is parsed in `packages/analyzer-py/src/projects.ts`, from untrusted
  repositories. The hosted service analyzes public ones.
- **Change.**
  1. Pin `"smol-toml": "1.9.1"` exactly, then run `pnpm install`.
  2. Read the changelog from 1.8.0 to 1.9.1 for any parse-result changes.
  3. Find where `parseToml` runs (main process or parser child) and which byte limit
     applies before it.
  4. Add a regression test in `packages/analyzer-py/test/`. Parse a pyproject of many
     thousands of key lines, at the largest size the analyzer admits. Assert a time bound
     that 1.8.0 fails and 1.9.1 passes, and put both measured times in the pull request.
     ADR-057 names 1.8.0, so ADR-061 records the change. Never edit ADR-057.
  5. Add `smol-toml` and `web-tree-sitter` to the library table in `docs/toolchain.md`;
     they are missing. Add a CHANGELOG `### Security` entry.
- **Test.**
  - `pnpm verify`.
  - The corpus baseline must be unchanged; flask's `pyproject.toml` goes through this
    parser.
- **Done when** CI is green, the baseline is unchanged and both alerts close after the
  merge.

#### M1.3 Patch and minor upgrades

**Implementation checkpoints, 2026-10-16:** viewer runtime `4f9ad6c`, contracts
`ae28ce2`; test tooling is the fourth implementation commit in the owner-requested
combined M1.2/M1.3 PR. Local full-suite, corpus, contract, browser and packaging
evidence is recorded in ADR-061 and implementation status. The clean `071aaab`
final rendering spike passes with its retained report. The batch landed in PR #22
with the CI/security evidence above; P1 still needs M1.4/M1.5.

Do these as three pull requests, so a failure is easy to locate.

| Pull request | Packages | Main risk and the specific check |
|---|---|---|
| Viewer runtime | `react`, `react-dom` 19.3.0 → 19.3.1; `@react-three/fiber` 9.8.1 → 9.8.2. Update `docs/release/licenses/react-three-fiber-*-LICENSE` if its name carries the version | Rendering. Run the viewer journeys in both modes and `pnpm spike:render`, and look at the city |
| Contracts | `zod` 4.6.5 → 4.6.7 | `pnpm contracts:check` must pass **without** regenerating: generated JSON Schema and OpenAPI must stay byte-identical. If they change, read the diff and record it in ADR-061 |
| Test tooling | `vitest` 5.0.3 → 5.0.5; `playwright` 1.64.0 → 1.64.1 (then reinstall its browsers); `@axe-core/playwright` 4.13.0 → 4.14.0 | New axe rules can report real accessibility problems. Fix them in the viewer. Never disable a rule or narrow the audit to get green |

Use exact versions everywhere a package appears (`pnpm outdated -r`), and keep
`toolchain.md` in step.

#### M1.4 Images and CI services

**Landed:** [PR #23](https://github.com/urveesh09/project-atlas/pull/23), merged
2026-10-16 as `4a39f66`. All eight CI jobs and both security jobs pass first attempt
on `1dea04a`. The official PostgreSQL 17 Alpine index still matches
the development-stack digest, now pinned in CI too. A fresh APT update across
trixie, trixie-updates and trixie-security confirms the existing exact Git pin is
still current. ADR-061 and implementation status record the checks and CI evidence.

- **Sandbox `git` pin.**
  - Before changing anything, check whether `git=1:2.47.3-0+deb13u1` is still the
    current trixie version, including the security suite. Run
    `docker run --rm <node digest> sh -c "apt-get update && apt-cache policy git"`.
  - If a newer `+deb13uN` exists, pin it. A security update is the likely reason.
  - Record the check and its date in ADR-061.
  - Keep the exact pin, which keeps images reproducible. Add a sentence to
    `release-process.md`: rebuild failures from a superseded pin mean "update the pin".
- **CI PostgreSQL.** Pin `postgres:17-alpine` in `.github/workflows/ci.yml` by digest, as
  `deploy/compose.yaml` already does. Dependabot's docker job does not watch workflow
  files, so add the digest refresh to the monthly checklist in `release-process.md`.

#### M1.5 Python parser runtime: `web-tree-sitter` 0.25.10 → 0.27.1

**In progress, 2026-10-16:** runtime 0.27.1 builds with the unchanged ABI 15 grammar.
Provenance changes analysis identity, requiring analyzer `0.1.0-dev.7` and deliberate
baseline/golden updates (ADR-062). The CPython 3.14.5 oracle agrees before and after:
zero fact mismatches, same three grammar gaps. Main-build comparison finds only
the declared summary-version transition in all five repositories; fresh four-repo
corpus, full verification (751 tests) and relocated packaging pass. Required CI and
owner merge remain; P1/G6 remain open.

- **Why.** Two minor releases behind. The parser runtime processes untrusted input, so it
  should stay current.
- **Risk.** It can change parse trees, and the vendored grammar
  `packages/analyzer-py/grammar/tree-sitter-python.wasm` must be ABI-compatible with the
  new runtime.
- **Change.**
  1. Read the 0.26 and 0.27 release notes for API and ABI changes, and adapt
     `packages/analyzer-py/src/parser.ts`.
  2. Keep the vendored grammar unless the new runtime refuses it. If you must update it:
     - follow ADR-056's vendoring rules (licence, recorded SHA-256 and its test);
     - say whether it closes the known grammar gaps: 3 of 1,844 standard-library files.
- **Test.**
  - `pnpm verify`.
  - **The CPython oracle test** (`packages/analyzer-py/test/oracle.test.ts`). It runs
    only when Python 3.10 or newer is on `PATH`, and otherwise reports that it skipped.
    It must run in your evidence and keep 0 mismatches. Record the Python version used.
  - The corpus baseline.
- **If bytes change.** That is a deliberate semantic change:
  - bump `ANALYZER_VERSION`;
  - write an ADR;
  - regenerate the baseline in the same commit;
  - prove TS/JS unchanged with `node scripts/compare-analysis-paths.mjs <main build root>`.

#### M1.6 Versions deliberately held back (record in ADR-061)

| Package | Available | Decision and reason |
|---|---|---|
| `typescript` for the analyzer (`packages/analyzer-ts`) | 7.0.2 | **Stay on 6.0.3.** TypeScript 7 is the native compiler. Its npm package's main export is only `lib/version.cjs`; the compiler API exists only under `./unstable/*`. The resolver is built on the stable 6.x JavaScript API (`resolveModuleName` with a virtual host, ADR-013/015). Moving would change resolution semantics and needs its own design ADR once a stable API exists. 6.0.3 is the latest 6.x |
| `typescript` for type-checking the workspace | 7.0.2 | **Optional, later.** Using TS 7 for `tsc -b` while the analyzer keeps 6.0.3 as a library is possible, but needs a spike: build mode, removed options, declaration output. Not needed for production |
| `@types/node` | 26.x | **Stay on 24.x** (24.19.2 is the latest 24). Types must match the runtime's major version |
| Node.js | 26.x | **Stay on 24 LTS for this release.** 26 becomes LTS on 2026-10-28. Plan the move after it has had a few LTS patch releases (target 2027 Q1) with its own ADR, and before 24 reaches end of life on 2028-04-30 |
| pnpm | 11.x, 12.x | **Stay on 10.34.6**, the latest 10.x. A major version changes lockfile and settings behaviour. Check pnpm's support policy; if 10.x stops receiving security fixes, migrate under an ADR |

### M2. Correctness evidence for Python

#### M2.1 Documentation sweep

These files still say ATLAS is TS/JS only or that the corpus has three repositories (found
2026-10-16 with `grep -rn -i "TS/JS\|three immutable\|three pinned"`):

| File | Stale text |
|---|---|
| `docs/guides/analyze-your-repository.md:90` | "Only TS/JS is analyzed in this beta" |
| `docs/START_HERE.md:77` | "Supports TypeScript/JavaScript" |
| `package.json` `description` | "explore a TS/JS repository" |
| `.github/workflows/ci.yml:115` | a step named "Acquire only the three immutable public corpus commits" |
| `docs/product/editions-and-comparison.md:32` | claims dependency accuracy for TS/JS only |
| `docs/release/release-audit.md:27` | "TS/JS static resolution" row. Add the Python evidence: ADR-056/057/060 and flask's 12 checks |
| `AGENTS.md` "Current state (2026-10-11)"; `implementation-status.md` "Current milestone (2026-10-13)" | both are older than Python support |

- **Leave alone:** the master plan, accepted ADRs and past CHANGELOG releases.
- **CI names.** Branch protection requires job names, not step names. Rename steps
  freely, but never a job.
- **Accuracy.** Say what is not analyzed: Cython, notebooks and other languages stay
  opaque buildings.

#### M2.2 Python capacity benchmark (high for hosted launch)

- **Why.**
  - Every capacity result predates Python: medium HEAD 6.81 s p95, large HEAD 20.59 s,
    large history 202.37 s in 4 CPUs and 2 GiB.
  - Python is parsed by tree-sitter WASM inside the same bounded parser children. Its
    time and memory at the limits are unknown.
- **Change.**
  1. Extend the fixture generators (`scripts/build-history-fixture.mjs`, and the
     `--files` option of `bench-analysis.mjs`) with a Python mode, and a mixed mode with
     half TS/JS and half Python. The modes should produce realistic packages, imports and
     function bodies at the same file and edge counts as the TS/JS fixtures. A trivial
     one-line file per module is not a capacity test.
  2. Run the existing benchmarks with the plan's unchanged budgets (§15.2), 20 measured
     runs each:
     - medium and large HEAD;
     - medium 12-frame history;
     - large history in the container runner (`scripts/bench-history-container.mjs`,
       4 CPUs, 2 GiB, no swap).
  3. Record peak memory per parser child.
- **If a budget fails,** keep the report. Profile first, then fix: AGENTS.md "Memory".
  Prove any optimization byte-identical. Never relax a budget.
- **Done when** reports are in `docs/benchmarks/` and recorded in the status and the
  release audit, each pass or fail stated honestly.

#### M2.3 Hosted Python path (high for hosted launch)

- **Why.** The container gates and the hosted journeys use the Harbor TS/JS fixture.
  Nothing yet proves that `pnpm --filter @atlas/worker deploy --prod` puts
  `analyzer-py/grammar/tree-sitter-python.wasm` into the sandbox image, or that Python
  analysis works under the sandbox's read-only root, no network and resource limits.
- **Change.**
  1. Add a small authored Python fixture repository, with expectations written by hand,
     next to Harbor in `@atlas/test-fixtures`.
  2. Run it through the container gate (`ATLAS_CONTAINER_TESTS=1`) and one hosted
     journey.
  3. Assert that the published artifact has parsed Python files and PyPI packages.
- **Test.** The hosted CI job, and the same gates locally as in
  [hosted-development.md](../hosted-development.md#test-gates).

#### M2.4 Property-based tests on the untrusted-input boundaries

- **Why.** Every loader and parser of untrusted bytes should hold its bounds on arbitrary
  input, not just the authored cases. Scorecard's Fuzzing check also recognizes
  `fast-check`.
- **Change.**
  1. Add `fast-check` 4.10.2, exact, as a dev dependency. The owner approved new dev
     dependencies on 2026-10-16; record it in ADR-061.
  2. Write properties for:
     - artifact chunk loading and verification;
     - delta and indexed graph decoding;
     - canonical JSON round-trips;
     - `pyproject.toml`, `requirements.txt`, `setup.cfg` and `Pipfile` reading;
     - path normalization.
  3. Each property states an invariant: never throws anything except the named error,
     never exceeds a limit, and round-trips exactly.
  4. Use a fixed seed and a bounded number of runs, so CI stays deterministic and fast.
- **If a property finds a bug,** fix it with a regression test, and record it.

#### M2.5 Coverage report (informational)

- Add `@vitest/coverage-v8` 5.0.5, matching vitest, and a `pnpm coverage` script.
- Run it once and list the modules with low coverage in the pull request, then add tests
  where risk is highest: loaders, resolvers and the hosted control plane.
- **Do not set an arbitrary percentage gate.** The plan prefers authored expectations to
  a number.

#### M2.6 More real Python repositories

- **Why.** The TS/JS corpus covers single-package, monorepo and mixed shapes. Python has
  one repository, flask, which has one `src/` project. The workspace, Poetry, `setup.py`
  and requirements rules from ADR-057 have only fixture evidence.
- **Pick 2.** For example:
  - a uv or Poetry workspace with several projects;
  - a repository mixing a TS/JS front end with a Python back end.

  Each candidate must be:
  - public and permissively licensed (record the licence);
  - under the limits: 10,000 files per frame and 64 MiB of decoded source;
  - quick enough that five repeats fit the corpus CI timeouts.

  Pin an exact commit, and tell the owner your choices in the pull request.
- **Write the checks before you analyze.**
  1. Read the committed source.
  2. Write the `checks` in `repository-corpus.json` the way flask's were written.
  3. Then run the analysis.

  If a check fails, decide whether the analyzer or the check is wrong. Record the original
  failure, the cause and the fix. Never edit a check to match the output.
- **Run.**
  - `node scripts/validate-real-repositories.mjs --acquire`, then without `--acquire`.
  - `node scripts/check-repository-baseline.mjs`.
  - `node scripts/compare-analysis-paths.mjs <main build root>`. It exits 1 because the
    new repositories differ by design; confirm that only they differ.
  - Open each artifact with `pnpm atlas serve`.
- **Record** counts like ADR-060's flask table.
- **Analyzer bugs** found this way get their own pull request first, following the "Exact
  bytes" rule.

### M3. Platforms and browsers

#### M3.1 macOS in CI

- **Change.**
  - Add `macos-latest` to the `verify` matrix and the corpus matrix.
  - Extend `scripts/compare-repository-reports.mjs` so the determinism job compares all
    three operating systems.
- **Why it can fail.** macOS file systems are case-insensitive by default, and its Git is
  Apple's. The analyzer reads Git objects, not the file system, so the output must still
  match. Any difference is a bug to fix, not to accept.
- **Branch protection.** The new jobs become required checks only after the owner adds
  them. Tell the owner the exact job names.

#### M3.2 Firefox and WebKit journeys

- **Change.**
  1. Run a core subset of `packages/cli/test/viewer.e2e.test.ts` in Firefox and WebKit:
     - search (J1), dependencies (J2) and a diagnostic (J3);
     - the no-WebGL fallback;
     - deep links;
     - one history step.
  2. Parameterize the browser rather than copying tests.
  3. Install the browsers in CI with `playwright install --with-deps firefox webkit`.
- **Bugs.** Fix real browser bugs in the viewer. If WebGL is unavailable in a headless
  engine, the fallback journeys must still pass. Name the WebGL-only checks that were
  skipped, and why.

#### M3.3 Accessibility preparation for R6-04

- Run `audit(page)` on every view and dialog, not just the main ones. Fix what it finds.
- Update [manual-review.md](../release/manual-review.md) with a screen-reader script, so
  human reviewers can follow it step by step: NVDA with Firefox or Chrome, and VoiceOver
  with Safari.
- Do not mark R6-04 done: it needs people.

### M4. Hosted production kit

All of M4 lives under a new `deploy/production/`, documented in
[hosted-operations.md](../hosted-operations.md). Nothing in it may contain a secret,
domain or address from a real deployment. Use placeholders such as `atlas.example.org`.

#### M4.1 Reference deployment

- **Reverse proxy.** A pinned Caddy (or nginx) config implementing
  hosted-operations.md's "Reverse proxy requirements" exactly:
  - TLS on the public origin, and HSTS, which the API does not set;
  - `Host` forwarded unchanged and the client address appended to `X-Forwarded-For`;
  - 16 KiB bodies, about 10 s timeouts, and `GET`/`POST`/`DELETE` only;
  - no buffering for `text/event-stream`, and no caching under `/api/`.
- **Compose profile** for the API host, derived from `deploy/compose.yaml` without
  development settings:
  - no `ATLAS_DEVELOPMENT`;
  - secrets as files;
  - a read-only root, with all capabilities dropped and `no-new-privileges`.
- **Worker service unit** (systemd):
  - runs as uid 10001, with `ATLAS_WORK_ROOT` on local disk;
  - hardening: `NoNewPrivileges`, `ProtectSystem=strict`, `PrivateTmp`, and explicit
    `ReadWritePaths`;
  - `Restart=on-failure`, and a stop timeout longer than the worker's drain.
- **Egress firewall.** An nftables ruleset allowing broker containers only TCP 443 to
  GitHub's published address ranges. Add a script that refreshes those ranges from
  `https://api.github.com/meta`. Nothing else on the worker host gets outbound access,
  apart from the database and storage.
- **Test.**
  - Validate each config with its own tool in a pinned container: `caddy validate` and
    `nft -c -f`.
  - Run `scripts/hosted-rehearsal.mjs` against the production profile with a loopback
    certificate authority.
  - Run the existing egress-isolation container gates.

#### M4.2 Monitoring

- **Prometheus text.** Add Prometheus text exposition to the operator listener, for
  example `GET /metrics` with `Accept: text/plain`. Keep the JSON. Use the same fields,
  with names like `atlas_queue_oldest_queued_seconds`.
- **Rules and dashboard.**
  - Ship `deploy/production/alerts.yml` with the four alerts the runbook names.
  - Ship an optional Grafana dashboard JSON.
- **Test.**
  - A unit test of the text format.
  - `promtool check rules alerts.yml` in a pinned container.
  - The operator listener must stay loopback-only.

#### M4.3 Backups and restore drill

- **Change.**
  - A backup script and timer: `pg_dump -Fc`, kept for 7 days, as hosted-operations.md
    says. Storage needs no backup.
  - A restore drill script that:
    1. restores into a scratch database;
    2. runs `atlas-ops sweep` and `reconcile-storage`;
    3. checks that deleted, revoked and expired publications stay that way.

  The operator rehearsal already verifies restore semantics; reuse it.
- **Test.** Run the drill locally with throwaway containers, and record the result.

#### M4.4 Image supply chain

- **Release workflow.** For both images:
  - generate an SBOM (`docker/build-push-action` with `sbom: true` and
    `provenance: mode=max`);
  - scan with a pinned scanner, such as Trivy by digest. Fail on fixable critical or high
    findings.
- **Operators.** Document `gh attestation verify` for the CLI archive and both images, and
  make it a release-procedure step.
- **Test.** Run the release workflow's image job on a branch with a dry-run tag pattern,
  or locally with the same commands.

#### M4.5 Service levels and incidents

- Write `docs/hosted-slo.md`. It should define:
  - targets: publication availability, job success rate excluding expected limit
    outcomes, and queue time p95;
  - how each target is measured from `/metrics`;
  - severity levels;
  - first-response steps that link the existing runbooks;
  - how users are told.
- Keep the targets honest: base them on the rehearsal's measured numbers, not wishes.

#### M4.6 Public-service pages

- Add privacy, terms and takedown pages to the hosted landing, plus a contact link.
- The **owner** must supply the legal text and the contact address. The agent builds the
  pages with clearly marked placeholders, and the service refuses to start in production
  until they are configured. Never invent legal text.
- Describe the data handling the code actually does:
  - logs hold no IP addresses or repository names;
  - publications last 7 days;
  - revocation exists;
  - downloaded copies cannot be recalled.

### M5. Release and acceptance

#### M5.1 `0.1.0-beta.2`

When M1 is merged, prepare the release by following
[release-process.md](../release/release-process.md):
- version files;
- release notes;
- the release audit;
- `node scripts/check-release-version.mjs`.

The owner tags and publishes. Publishing also redeploys the public demo with the current
analyzer.

#### M5.2 Release candidate for G6

When M1–M4 are done:
- freeze a candidate commit;
- run every gate and record the exact archive and image identities;
- write the R6 evidence packets reviewers need: what to run, on what, and what to record.

**An agent must never** mark R6 items done, invent participants or measurements, or
substitute local hardware for the reference environment.

#### M5.3 After acceptance

These need the owner's direction, and each needs an ADR:
- `1.0.0` versioning;
- npm publication of the CLI;
- a Python demo next to vuejs/core;
- notebooks (`.ipynb`);
- namespace package imports, currently `unsupported`;
- the Node 26 migration.

## 5. How to test

Tests run against package sources through Vitest aliases. Scripts, the CLI and sandboxes
run compiled `dist/`, so run `pnpm build` (and `pnpm build:web` for the viewer) before
using them.

### Before every commit

```sh
pnpm verify    # typecheck, viewer build, dependency direction, contracts, all unit tests
```

### By kind of change

| You changed | Also run |
|---|---|
| Runtime schemas | `pnpm contracts:generate`. Commit `packages/schema/generated/*` and `docs/api/openapi.json`, and never hand-edit them |
| Analysis: ingest, analyzer-*, graph, history, layout | `node scripts/validate-real-repositories.mjs`, then `node scripts/check-repository-baseline.mjs`. If output must not change, it passes as is. A deliberate change follows AGENTS.md "Exact bytes" and proves TS/JS unchanged with `compare-analysis-paths.mjs` |
| The Python parser or grammar | the above, plus the CPython oracle test with Python 3.10 or newer on `PATH` (record the version) |
| The viewer | the browser journeys (below), and a manual check: `pnpm atlas analyze <repo> --out <dir>`, then `pnpm atlas serve <dir> --repo <repo>`. Check keyboard use, 320 px width and the console |
| Hosted API, worker or control plane | the hosted journeys (below), and the full gates in [hosted-development.md](../hosted-development.md#test-gates) when sandboxes, storage or the egress broker are involved |
| CLI packaging | `pnpm verify:distribution`. It rewrites `docs/images/phase6-packaged-city.png` and `docs/release/distribution-smoke.{json,md}`; restore them with `git checkout --` unless the change is about them. On Windows, run it from PowerShell, because Git Bash's `tar` breaks it |
| Dependencies or the runtime | everything above that the package touches, plus the corpus baseline and image builds |
| Performance-sensitive code | the relevant benchmark, with 20 measured runs, a fresh process per sample and a clean working tree (ADR-037) |
| Deployment configs | each config's own validator in a pinned container, and the operator rehearsal |

### Browser journeys

Install Chromium once:

```sh
pnpm --filter @atlas/web exec playwright install --with-deps chromium
```

Then run the journeys, in POSIX shell:

```sh
pnpm build && pnpm build:web
ATLAS_REQUIRE_BROWSER_TESTS=1 pnpm exec vitest run packages/cli/test/viewer.e2e.test.ts
```

Or in PowerShell:

```powershell
$env:ATLAS_REQUIRE_BROWSER_TESTS = '1'
pnpm exec vitest run packages/cli/test/viewer.e2e.test.ts
```

Run the journeys a second time with `CI=1` set as well; CI uses that setting.
`atlas serve` prints a single-use session link, so restart it for each new browser
session.

### Hosted journeys

1. Start a throwaway container named for your task:

   ```sh
   docker run -d --name atlas-<task>-pg -e POSTGRES_PASSWORD=atlas-local-test \
     -e POSTGRES_DB=atlas_test -p 127.0.0.1:55432:5432 postgres:17-alpine
   ```

2. Run the hosted journeys:

   ```sh
   ATLAS_TEST_DATABASE_URL=postgres://postgres:atlas-local-test@127.0.0.1:55432/atlas_test \
     pnpm exec vitest run apps/worker/test/hosted.e2e.test.ts
   ```

3. Remove the container: `docker rm -f atlas-<task>-pg`.

The machine may run other people's production containers. Never stop, remove or prune
anything you did not create, and never run `docker system prune`.

### Writing tests

- **Write expectations by hand,** from the specification or the ADR, before running the
  code. If the first run disagrees, find out which side is wrong and say so. Never copy
  output into an expectation.
- **Golden files and snapshots** (`vitest -u`) change only for a deliberate change. Read
  the whole diff first, and explain it in the commit.
- **Never** weaken an assertion, raise a timeout or skip a test to get green.
  - The Windows native worker crash (`0xC0000409`) is a known flake. Confirm it by
    rerunning once; a second failure is real.
  - Service-gated suites must report that they skipped, never pass vacuously.
- **Cover the edge cases:**
  - empty, missing and malformed input;
  - limits and Unicode paths;
  - TS/JS-only and mixed TS/JS + Python repositories.
- **Viewer tests drive the page** like a person: roles, labels and keyboard. Assert
  visible text, and run `audit(page)`.

## 6. Coding standards

- **Match the surrounding code:** naming, structure, comment density and idiom. Look for
  an existing helper before writing one:
  - `compareUtf8` and `compareAscii` for ordering;
  - `codeLabels` for ecosystem wording;
  - `HISTORY_BOUNDARY_TEXT` for history windows;
  - `nodeIdentityKey` for node identity;
  - `LIMITS` for every bound.
- **Strict TypeScript.**
  - No `any`, and no `as` cast that hides a real type error.
  - Type lookup tables by their enum (`Record<HistoryBoundary, string>`), so a new value
    fails to compile instead of rendering a raw code. That gap caused the "Window ends:
    days" bug.
- **Determinism.** Output never depends on:
  - time, randomness or locale (`localeCompare`);
  - insertion order from unordered sources;
  - the path separator or line endings.

  Sort explicitly. The same input gives the same bytes on every operating system.
- **Untrusted input.** Repositories, uploaded artifacts and HTTP requests are data.
  - Bound every parse by size, depth and time.
  - Fail closed with a named reason code.
  - Never execute, import or fetch anything the input names.
  - Analysis has no network.
- **Layering** (`pnpm check:deps`). The viewer never imports analyzer or ingest code.
  `packages/schema` runs in browsers, so it has no static `node:` imports.
- **Operations code.**
  - Logs are JSON lines with an event name, job ID and codes. They never contain secrets,
    tokens, request bodies, full IP addresses, repository names, source text or absolute
    paths.
  - Configuration fails at startup with a clear `ConfigError`, never at first use.
  - Every process handles `SIGTERM` by draining and closing its pools.
- **Security headers and permissions.** Keep the CSP and the other headers in
  `apps/api/src/server.ts` and `packages/cli/src/server/server.ts` strict; a new feature
  that needs a looser policy needs an ADR. Containers keep:
  - uid 10001;
  - a read-only root;
  - no capabilities;
  - `no-new-privileges`;
  - images pinned by digest.
- **Dependencies.**
  - Exact versions only, and lifecycle scripts stay disabled.
  - Each addition needs a reason and its licence recorded (MIT, BSD, Apache-2.0 or
    similar). Prefer packages without dependencies.
  - Never add a runtime dependency to `packages/schema` casually: it ships to every
    browser.
- **User-facing text** is plain, specific and honest.
  - Name what is missing, and never show zero for "unknown".
  - Never show internal codes where a sentence belongs.
  - A TS/JS-only analysis keeps its exact wording.
- **Accessibility.**
  - Everything works by keyboard and has an accessible name.
  - Targets are at least 44 px, and layouts reflow at 320 px.
  - Reduced motion is respected.
  - Everything drawn on the canvas has an HTML equivalent.
- **Comments** explain why, and cite the ADR or the plan section. Delete dead code; don't
  comment it out.
- **Small, reviewable pull requests.** Don't mix refactors with behaviour changes, or
  reformat unrelated code. Generated files change only through their generators.
- **LF line endings** (`.gitattributes`). On Windows, Python's `write_text` writes CRLF:
  use `read_bytes` and `write_bytes` in edit scripts. Check `git diff` after scripted
  edits.

## 7. Owner-only actions

An agent prepares these and asks; it never does them itself:
- merging pull requests, creating tags and publishing releases;
- dispatching the `demo site` workflow;
- repository settings:
  - description, homepage and topics;
  - branch protection and required checks, including new jobs from M3.1;
  - Scorecard alert dismissals, for example the vendored grammar WASM under
    BinaryArtifacts, which a test pins by SHA-256 (ADR-056);
- buying a domain or hosting, DNS, TLS accounts and production secrets;
- legal text, the privacy notice and the contact address (M4.6);
- recruiting reviewers and providing reference hardware for R6-01…R6-05;
- signing off G6 (R6-07).

## 8. Recording work

- **Commit messages** explain why.
- **Pull request descriptions** cover:
  - what changed;
  - bugs found along the way;
  - how it was verified, with exact counts;
  - anything left open, or verified only partly.
- **Each behaviour change updates:**
  - the CHANGELOG under `[Unreleased]`;
  - a dated section in `docs/implementation-status.md`, with evidence and counts;
  - the release audit, when a gate's evidence changes.
- **Decisions** get the next ADR: Date/Status, Evidence and cause, Decision,
  Verification. Then update the range in AGENTS.md (`ADR-001…ADR-0NN`).
- **Failures.** Keep failed reports. A fix records the original failure, its cause and
  the retest.
- **This plan.** When a task lands, mark it done here with a link to its pull request, and
  update §2's status column. The next agent should start from the truth.

## 9. Never

- Run, build, install or check out anything from an analyzed repository.
- Put source text, author emails, commit messages or absolute paths in artifacts.
- Put tokens in URLs, files, containers or logs.
- Fabricate results, or relax a budget, deadline or assertion to pass a gate.
- Merge your own pull request, push to `main`, skip hooks, or force-push someone else's
  branch.
- Commit `.atlas-tmp/`, build output, secrets or local scratch files.
- Touch containers, networks, processes or files you did not create.
