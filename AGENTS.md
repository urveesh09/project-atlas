# Guide for coding agents

Read this before changing anything. It is the shortest path to working safely in this
repository. People should start with [docs/START_HERE.md](docs/START_HERE.md).

## 1. Orientation (read in this order)

1. [docs/plan/PROJECT_ATLAS_V0.1_MASTER_PLAN.md](docs/plan/PROJECT_ATLAS_V0.1_MASTER_PLAN.md): the
   specification. When unsure what is required, reread the relevant section; don't guess.
2. [docs/implementation-status.md](docs/implementation-status.md): what is done, with evidence.
3. [docs/release/release-audit.md](docs/release/release-audit.md): requirement → evidence
   trace, and the open acceptance items R6-01…R6-07.
4. [docs/adr/](docs/adr/): design decisions and dated evidence. Every non-obvious choice lives here.
   Check for an ADR before "fixing" something that looks odd.
5. [docs/plan/production-plan.md](docs/plan/production-plan.md): the path to production,
   with milestones, how to test each kind of change, and the coding standards. Start
   there for new work.

**Current state (2026-10-18):** the four pillars and Phase 6 candidate tooling are
implemented for committed TS/JS and Python (`.py`, `.pyi`), including mixed repositories.
M3.3 accessibility preparation landed in PR #36, after macOS and cross-browser CI
landed in PRs #34 and #35. M3.5 silent WebGL fallback, GPU-free diagnostics and
primary-action contrast landed in PR #37 (ADR-071). M4.1 reference deployment kit
landed via PR #39 (ADR-072); M4.2 monitoring landed in PR #40 (ADR-073).
M4.3 landed in PR #41: private streaming backups and a quarantined scratch-only
restore drill (ADR-074). The current task is M4.4: scanned, immutable OCI image
publication and signed-origin verification (ADR-075). Never point restored cleanup at live storage; older backups
cannot remember later deletions. M4.5 service levels stack on it
([hosted-slo.md](docs/hosted-slo.md), ADR-076): provisional objectives measured from
`/metrics`, with tested rules and incident handling. M4.6 adds privacy, terms and
takedown pages (ADR-077): the owner supplies the wording and contact, and a production
API refuses to start without them or with the shipped placeholders. ADR-078 deletes job
records 30 days after they end, through a schema-owned function the worker may only
execute, and requires a status page (`ATLAS_STATUS_URL`). None authorizes a live
deployment or closes R6-06.
Human R6-04 review and M3.4 intermittent layout diagnosis remain open. M2.2
capacity and M2.7 lazy-import syntax remain open. M1 upgrades landed in PRs #20, #22,
#23 and #24. Analyzer `0.1.0-dev.8` records corrected namespace lookup
(ADR-066); parser runtime provenance remains ADR-062 and the artifact schema stays 1.4.0. Cython, notebooks and further languages
remain opaque buildings. The hosted Python journey (ADR-064)
and the uv workspace and mixed corpus (ADR-065) have landed. Python capacity (M2.2)
still needs its full measurement matrix. The master plan has no Phase 7.
Gate G6 stays open on the exact capacity-fixture matrix, human, reference-hardware and
deployment acceptance (R6-01…R6-07).
Do not mark those done without real results. Any new scope beyond V0.1, such as runtime
tracing, more languages or private hosted repositories, needs the owner's direction and
an ADR first.

## 2. Non-negotiable rules

- **Repositories are data, never code.** Never check out, install, build or run anything
  from an analyzed repository: hooks, filters, configs, scripts. Read only committed
  Git objects through `packages/ingest`. Analysis has **no network**. Hosted acquisition
  goes only through the egress broker (`github.com`/`api.github.com:443`).
- **Artifacts contain no source text, author emails, commit messages or absolute paths.**
  Management tokens never appear in URLs.
- **Honest evidence.** Never fabricate results, participants or measurements; never relax
  a budget, deadline or assertion to make a gate pass; never count a partial run as a
  pass. Keep failed reports. A fix records the original failure, the cause and the retest.
- **Exact bytes.** Canonical JSON, IDs and artifact payloads are deterministic and
  cross-platform. A change that should preserve output must pass
  `node scripts/check-repository-baseline.mjs`, which compares against the committed real
  corpus. A deliberate semantic change bumps `ANALYZER_VERSION`
  (`packages/analyzer-core/src/options.ts`) or `ARTIFACT_VERSION`
  (`packages/schema/src/versions.ts`), comes with an ADR, and updates the baseline in the same commit.
- **Changing an ADR:** supersede it with a new ADR; don't silently rewrite accepted decisions.
- **Dependency direction** (enforced by `pnpm check:deps`): `schema` is foundational;
  analyzers never import the viewer or API; the viewer never imports analyzer or ingest
  code; runtime instrumentation is banned in V0.1.
- **Pinned toolchain:** Node 24.22.0 or newer 24.x, pnpm 10.34.6, exact library versions
  ([toolchain](docs/toolchain.md)). Don't upgrade pnpm or dependencies casually, and don't use floating versions.
- **Least privilege** for hosted roles, sandboxes (uid 10001, read-only root, no
  capabilities) and tokens. Never put a personal token in containers, files or logs.

## 3. Map

| Path | Role |
|---|---|
| `packages/schema` | Contracts, IDs, canonical JSON, validators, delta/indexed transports; generated JSON Schema |
| `packages/ingest` | Safe local Git reader, GitHub admission/acquisition, egress broker |
| `packages/analyzer-ts`, `analyzer-py`, `analyzer-core` | TS/JS and Python facts and resolution; snapshot/history orchestration (`analyzeCommit`) |
| `packages/graph`, `history`, `layout` | Aggregation/SCCs/queries; lineage and churn; deterministic integer city layout |
| `packages/artifact` | Packing, verification and loading (Node and browser) |
| `packages/cli` | `atlas doctor/analyze/inspect/verify/serve` |
| `packages/control` | Hosted control plane: migrations, roles, storage, publications, GitHub budget |
| `apps/api`, `apps/worker`, `apps/web` | Hosted HTTP API; coordinator and sandboxes; React/Three.js viewer |
| `deploy/` | Sandbox and API images, development stack; `production/` reference kit and validation tooling |
| `scripts/` | Benchmarks, corpus validation, packaging, contract generation, release guard, demo site |
| `.github/` | CI, release, security, Scorecard and demo-site workflows; Dependabot; issue forms ([release process](docs/release/release-process.md)) |
| `.atlas-tmp/` | Ignored scratch: corpus, fixtures, reports. Never commit it |

`packages/schema` is shared with the browser. Don't add static `node:` imports there.
Node-only behaviour must be detected at runtime (see `canonical.ts`).

## 4. Commands

```sh
pnpm install --frozen-lockfile && pnpm build && pnpm build:web
pnpm verify                     # typecheck, viewer build, deps, contracts, tests: run before every commit
pnpm coverage                   # informational Node-process coverage; docs/coverage.md explains its limits
pnpm contracts:generate         # after changing runtime schemas; contracts:check must pass
pnpm verify:distribution        # portable CLI archive, tested outside the checkout
node scripts/validate-real-repositories.mjs [--acquire]   # 6 pinned real repos × 5 offline repeats
node scripts/check-repository-baseline.mjs                # exact committed corpus bytes
pnpm atlas analyze <repo> --out <dir> && pnpm atlas serve <dir> --repo <repo>
```

Tests run against package **sources** (Vitest aliases), but sandboxes, scripts and the CLI
run compiled `dist/`. Rebuild before benchmarks or container tests.

**Service-gated tests** skip unless enabled: PostgreSQL, S3, Docker sandboxes, Chromium
and live GitHub. The variables and setup are in [hosted development → Test gates](docs/hosted-development.md#test-gates).
With physical gates enabled, Vitest runs one file at a time (`vitest.config.ts`) because
fault tests deliberately exhaust memory and PIDs.

**Changes land through pull requests.** `main` requires a pull request and nine named
checks, with no bypass ([ADR-046](docs/adr/ADR-046-security-triage-and-enforced-checks.md)).
Work on a branch, push it and open a pull request; it merges once the checks pass.

**CI** (`.github/workflows/ci.yml`):
- `verify` and the pinned corpus each run on Ubuntu, Windows and macOS (ADR-068);
- the determinism job compares all three corpus reports;
- every viewer journey also runs in Firefox and WebKit on Ubuntu (`ATLAS_E2E_BROWSER`,
  ADR-069);
- hosted gates, live GitHub and the render spike.

`verify` names CPython 3.14.8 for the parser oracle (`ATLAS_ORACLE_PYTHON`). All jobs
must be green before a change counts as verified.

## 5. Recording work

- Update `docs/implementation-status.md` (task, evidence, exact counts) and the release
  audit when a gate's evidence changes. Use absolute dates.
- Benchmarks write reports to `docs/benchmarks/`. The capacity runner
  (`scripts/bench-history-container.mjs`) requires an image labelled
  `org.opencontainers.image.revision=<commit>` and records the working-tree state. Run
  acceptance measurements from a clean working tree; each sample uses a fresh process
  (ADR-037).
- New decisions get the next ADR number and the existing format: Date/Status,
  Evidence and cause, Decision, Verification.
  The current sequence is ADR-001…ADR-079; ADR-067 is reserved by the separate
  edge-budget work. Allocate ADR-080 next.
- Commit messages explain why. Never skip hooks.

## 6. Known pitfalls

- **Windows:** in Git Bash, heredocs can mangle backslash escapes and have injected NUL
  bytes. Use an editor tool or a script file for edits that contain `\x..`/`\u....`.
  A Python `open(p, 'w')` that fails mid-write truncates the file; check `git diff` after
  scripted edits. Normalize line endings (`.gitattributes`).
- **Intermittent Windows Vitest native worker exit** (`0xC0000409`/`3221226505`): confirm it
  by rerunning the failed job. Don't change tests to hide it, and don't assume it if the
  same test fails twice.
- **GitHub anonymous API quota** is 60/hour; live tests exhaust it quickly. The service
  fails closed. Wait for the reset rather than using someone's personal token.
- **One Docker engine per ATLAS database/coordinator** (ADR-034). Never remove containers
  or networks you didn't create; sandboxes are labelled `atlas.job`.
- **Production firewall:** the reference rules default-deny host output/forwarding.
  Never apply them on the developer/CI host; use the isolated container packet probe.
  Only an operator installs the reviewed site copy on a dedicated worker host.
- **Memory:** a hosted analysis job has 2 GiB total (parent heap 1536 MiB plus parser
  children). Large-history export is the tightest phase. Profile before optimizing, and
  prove optimizations byte-identical (ADR-036, ADR-037).
- **Generated files** (`packages/schema/generated/`, `docs/api/openapi.json`) come from
  `pnpm contracts:generate`; never hand-edit them.
