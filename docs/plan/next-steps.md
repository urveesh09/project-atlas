# Next steps after Python integration

Written 2026-10-16, after PR #17 ([ADR-060](../adr/ADR-060-python-integration.md)) merged.
This is the work queue for the next agent or contributor. It says what to do and in what
order, how to test each kind of change, and the standards a change must meet.

The [master plan](PROJECT_ATLAS_V0.1_MASTER_PLAN.md) remains the specification.
[AGENTS.md](../../AGENTS.md) remains the rulebook; read it first. Where this file and
AGENTS.md disagree, AGENTS.md wins. Tell the owner about the conflict.

## 1. Where things stand

- **Product.** ATLAS analyzes committed TS/JS and Python. The four pillars and the Phase 6
  tooling are implemented. Gate G6 stays open on human, hardware and deployment acceptance
  (R6-01…R6-07 in the [release audit](../release/release-audit.md)).
- **Versions.** Packages `0.1.0-beta.1`. Analyzer `0.1.0-dev.6`. Graph schema
  `atlas.graph/1.1.0`. Artifact `atlas.artifact/1.4.0`, and readers accept 1.0–1.4.
- **Pinned corpus.** Four public repositories in
  [repository-corpus.json](../release/repository-corpus.json): is-plain-obj, vuejs/core,
  vite and pallets/flask. Each is analyzed five times, offline, and compared byte for byte
  with [real-repositories.json](../release/real-repositories.json) on Windows and Linux.
- **ADRs.** The latest is ADR-060, so the next decision is ADR-061.
- **Tests.** `pnpm verify` runs 734 tests, with 81 skipped unless their services are
  enabled. The viewer end-to-end file has 39 browser journeys, and the hosted file has 6
  PostgreSQL journeys.
- **Public demo.** <https://urveesh09.github.io/project-atlas/> shows vuejs/core. The
  analyzer changed in ADR-060, so the demo only reflects it after the owner dispatches the
  `demo site` workflow or publishes a release.

## 2. How to work here

- **One task per branch and pull request.** Branch from an up-to-date `main` and name it
  after the task, for example `beta3/smol-toml-1.9`.
- **The owner merges.** Open the pull request, make every check pass and resolve every
  review thread (CodeQL alerts open threads). Then stop and report. Never merge, and never
  push to `main`.
- `main` requires the named CI checks and an up-to-date branch. If `main` moves, update
  your branch and rerun the checks.
- **Ask the owner before:**
  - new scope beyond V0.1: a new language, runtime tracing, private repositories;
  - new dependencies or toolchain changes;
  - anything that changes the public demo or repository settings.

  Record the direction in an ADR before building.
- **Decide UX details yourself.** The owner asked agents to make interface decisions that
  clearly improve the product. Explain them in the ADR and the pull request.
- **Finish what you start.** A task is done when its evidence exists and its checks pass,
  locally and in CI. Don't hand back half-verified work. If something can't be verified,
  such as hardware or human review, say so plainly.

## 3. Work queue

Do these in order unless the owner says otherwise. Each item lists why it matters, what to
change, how to test it, and when it is done.

### W1. Fix the smol-toml quadratic parse (security, needs the owner's go-ahead)

- **Why.** Dependabot alerts 1 and 2 report a medium advisory against `smol-toml` 1.8.0:
  `parse()` takes quadratic time because `parseKey` rescans to the end of the document on
  each key line. 1.9.0 fixes it.
  - `packages/analyzer-py/src/projects.ts` parses every committed `pyproject.toml` with it.
    Those files come from untrusted repositories, and the hosted service analyzes public
    ones, so a crafted manifest could stall an analysis job.
  - The owner closed Dependabot's PR #14 on 2026-10-16, while merging #17, and the alert
    is still open. **Confirm with the owner before starting.**
- **Change.**
  1. Pin `"smol-toml": "1.9.0"` exactly in `packages/analyzer-py/package.json`. Run
     `pnpm install` so only that entry changes in `pnpm-lock.yaml`.
  2. Read the 1.8.0→1.9.0 changelog for parse-result changes. Any change in parsed values
     can change artifact bytes.
  3. Find where `parseToml` runs: the main analysis process or a parser child. Find which
     byte limit applies to manifests before parsing.
  4. Add a regression test in `packages/analyzer-py/test/`. Parse a pyproject with many
     thousands of key lines at the largest size the analyzer admits. Assert a generous
     time bound that 1.8.0 fails and 1.9.0 passes, and show both results in the pull
     request.
  5. ADR-061: record the advisory, the version change and the evidence. ADR-057 names
     1.8.0, so ADR-061 supersedes that one statement. Don't edit ADR-057.
  6. The library table in [toolchain.md](../toolchain.md) doesn't list analyzer-py's
     libraries yet. Add `smol-toml` 1.9.0 and `web-tree-sitter` 0.25.10. Then add a
     `### Security` entry to CHANGELOG `[Unreleased]`.
- **Test.**
  - `pnpm verify`
  - `node scripts/validate-real-repositories.mjs`, then
    `node scripts/check-repository-baseline.mjs`. Flask's `pyproject.toml` goes through
    this parser. The bytes must be identical; if they are not, stop and explain why.
- **Done when** CI is green, the baseline is unchanged and the Dependabot alerts close
  after merge.

### W2. Finish the Python documentation sweep

ADR-060 updated the main documents. These still say ATLAS is TS/JS-only or that the corpus
has three repositories (found 2026-10-16 with
`grep -rn -i "TS/JS\|three immutable\|three pinned"`):

| File | What is stale |
|---|---|
| `docs/guides/analyze-your-repository.md:90` | "Only TS/JS is analyzed in this beta" |
| `docs/START_HERE.md:77` | "Supports TypeScript/JavaScript" |
| `package.json` `description` | "explore a TS/JS repository" |
| `.github/workflows/ci.yml:115` | step name "Acquire only the three immutable public corpus commits" (the workflow already reads the corpus file) |
| `docs/product/editions-and-comparison.md:32` | dependency accuracy claims TS/JS only |
| `docs/release/release-audit.md:27` | the "TS/JS static resolution" row: add the Python evidence (ADR-056/057/060, flask's 12 authored checks) |
| `AGENTS.md` "Current state (2026-10-11)" and the `implementation-status.md` "Current milestone (2026-10-13)" header | dates and milestone predate Python |

- **Leave alone:**
  - the master plan, which is the V0.1 specification;
  - accepted ADRs;
  - CHANGELOG entries for past releases.
- **Rules.**
  - Say what is analyzed and what is not: Cython, notebooks and other languages stay
    opaque buildings.
  - Don't claim more than the evidence shows. Python is validated on one real repository
    so far; W3 adds more.
  - Branch protection requires CI *job* names, so a step can be renamed freely. Never
    rename a job: the owner would have to update the required checks.
- **Test.**
  - `pnpm verify`.
  - Check every link you touch resolves.
- **Done when** the grep above finds only intentional TS/JS mentions, each true as
  written.

### W3. Validate Python on more real repositories

- **Why.** The TS/JS corpus covers three shapes: single package, monorepo and mixed. Python
  has one, flask, a single `src/` layout project. The ADR-057 rules for workspaces,
  Poetry, setup.py and requirements files have only fixture evidence.
- **Choose 1–2 repositories** that add new shapes. For example:
  - a uv or Poetry workspace with several projects;
  - a repository mixing a TS/JS front end and a Python back end in one tree;
  - a flat layout project that declares dependencies in `requirements*.txt`.

  Each candidate must be:
  - public, permissively licensed (record the license);
  - under the analysis limits: 10,000 files per frame and 64 MiB of decoded source;
  - fast enough that five repeats keep the corpus CI jobs within their timeouts.

  Pin an exact commit. Propose the choices to the owner before adding them.
- **Author the checks before you analyze.**
  1. Read the repository's committed source.
  2. Write `checks` (files with roles, imports with expected outcomes) into
     `repository-corpus.json`, the same way flask's were written.
  3. Then run the analysis.

  If a check fails, decide whether the analyzer or the check is wrong. Record the original
  failure, the cause and the fix (AGENTS.md, "Honest evidence"). Never edit a check just to
  match the output.
- **Run.**
  - `node scripts/validate-real-repositories.mjs --acquire`, then without `--acquire`.
    That gives five offline cold repeats and regenerates `real-repositories.{json,md}`.
  - `node scripts/check-repository-baseline.mjs`.
  - `node scripts/compare-analysis-paths.mjs <main build root>`. It proves the existing
    repositories didn't change: the new ones differ by design, so the script exits 1;
    confirm that only they differ.
  - Open each new artifact in the viewer with `pnpm atlas serve`. Check the Python labels,
    the inspector rows and the browser console.
- **Record** the counts in the style of ADR-060's flask table:
  - files parsed;
  - imports by outcome;
  - undeclared externals, with the reason for each group.

  This is evidence, not a code change. Record it in `implementation-status.md` and the
  release audit. Write an ADR only if an analyzer rule changes.
- **If you find analyzer bugs,** fix them in their own pull request first.
  - A fix that changes output bumps `ANALYZER_VERSION`, gets an ADR and regenerates the
    baseline, all in the same commit.
  - Prove that TS/JS output is unchanged with `compare-analysis-paths.mjs`.

### W4. Scorecard and repository hygiene

Open code-scanning alerts on 2026-10-16 are all OpenSSF Scorecard checks:

| Alert | What to do |
|---|---|
| BinaryArtifacts: `packages/analyzer-py/grammar/tree-sitter-python.wasm` | It is vendored on purpose, and a test checks its recorded SHA-256 (ADR-056). Ask the owner to dismiss it as "won't fix" with that justification |
| BinaryArtifacts: a committed `.pyc` | Removed in the pull request that added this plan, and `__pycache__/` is now ignored. It closes on the next Scorecard run |
| Vulnerabilities | Closes with W1 |
| Fuzzing | Optional. Scorecard recognizes property-based tests (fast-check for TypeScript). Fuzz the bounded loaders: artifact chunks, delta and indexed graph decoding, TOML and requirement parsing. This needs a new exact-pinned dev dependency, so get the owner's approval and write an ADR first |
| BranchProtection, CodeReview, Maintained, CII best practices | Owner settings or time. Not agent work; mention them in the report |

### W5. Prepare `0.1.0-beta.2` (the owner tags it)

`[Unreleased]` in the CHANGELOG now holds ADR-053…ADR-060, including Python. When the owner
asks, prepare the release using [release-process.md](../release/release-process.md),
"Cutting a release":
- version files;
- release notes;
- the release audit;
- `node scripts/check-release-version.mjs`.

The owner creates the tag and publishes. Publishing redeploys the demo with the current
analyzer.

### W6. G6 acceptance items: what an agent may and may not do

R6-01…R6-07 need reference hardware, human reviewers, assistive technology or a production
deployment. An agent may:
- improve the scripts and protocols that collect that evidence;
- fix defects the reviews find;
- keep the audit's evidence links current.

An agent must never:
- mark these items done;
- invent participants or measurements;
- substitute local results for the reference hardware.

### Proposals that need the owner's direction first

Don't start these without it. Each would need an ADR.
- **Jupyter notebooks** (`.ipynb`): code cells as a Python module. They are currently
  `LANGUAGE_UNSUPPORTED`.
- **A Python demo** on the public site beside vuejs/core, such as flask.
- **Grammar gaps.** CPython accepts 3 of 1,844 standard-library files that the vendored
  grammar rejects (ADR-056). A newer grammar might close them, but it changes parse results.
- **`import ns` of a namespace package**, which is currently `unsupported`, as
  `NAMESPACE_PACKAGE` (ADR-057).

## 4. How to test

Tests run against package sources through Vitest aliases. Scripts, the CLI and sandboxes
run compiled `dist/`, so run `pnpm build` (and `pnpm build:web` for the viewer) before
using them.

### Always, before every commit

```sh
pnpm verify    # typecheck, viewer build, dependency direction, contracts, all unit tests
```

### By kind of change

| You changed | Also run |
|---|---|
| Runtime schemas in `packages/schema` | `pnpm contracts:generate`, then commit `packages/schema/generated/*` and `docs/api/openapi.json`. Never hand-edit them |
| Anything in analysis: ingest, analyzer-*, graph, history, layout | `node scripts/validate-real-repositories.mjs` then `node scripts/check-repository-baseline.mjs`. If output should be unchanged, it must pass as is. If it should change, follow AGENTS.md "Exact bytes" and prove TS/JS unchanged with `node scripts/compare-analysis-paths.mjs <root of a main build>` |
| The viewer (`apps/web`) | the browser journeys (below) and a real look: `pnpm atlas analyze <repo> --out <dir>`, then `pnpm atlas serve <dir> --repo <repo>`. Check keyboard use, 320 px width and the console |
| The hosted API, worker or control plane | the hosted journeys (below), and the full gates in [hosted-development.md](../hosted-development.md#test-gates) when sandboxes or storage are involved |
| CLI packaging or anything the packaged CLI ships | `pnpm verify:distribution`. It rewrites `docs/images/phase6-packaged-city.png` and `docs/release/distribution-smoke.{json,md}`; restore them with `git checkout --` unless the change is about them |
| Dependencies | everything above that touches the package, plus the corpus baseline |

### Browser journeys (viewer)

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

Run it a second time with `CI=1` set as well; CI uses that setting.

### Hosted journeys (PostgreSQL)

1. Start a throwaway container with a name that is unique to you:

   ```sh
   docker run -d --name atlas-<task>-pg -e POSTGRES_PASSWORD=atlas-local-test \
     -e POSTGRES_DB=atlas_test -p 127.0.0.1:55432:5432 postgres:17-alpine
   ```

2. Run the hosted journeys:

   ```sh
   ATLAS_TEST_DATABASE_URL=postgres://postgres:atlas-local-test@127.0.0.1:55432/atlas_test \
     pnpm exec vitest run apps/worker/test/hosted.e2e.test.ts
   ```

3. Remove that container: `docker rm -f atlas-<task>-pg`.

The machine may run other containers that are not yours. Never stop, remove or prune
them, or networks or volumes you didn't create. Avoid `docker system prune`.

### Writing tests

- **Write expectations by hand, from the specification or the ADR, before running the
  code.** If the first run disagrees, find out which side is wrong, and say so in the ADR.
  Never copy the output into the expectation.
- **Golden files and snapshots** (`vitest -u`) are updated only for a deliberate change.
  Read the whole diff first, and explain it in the commit.
- **Never weaken an assertion, raise a timeout or skip a test to make CI pass.** A
  Windows-only native worker crash (`0xC0000409`) is a known flake: confirm it by rerunning
  once. If the same test fails twice, it is a real failure.
- **Cover the edge cases,** not just the happy path:
  - empty, missing and malformed input;
  - limits and Unicode paths;
  - both TS/JS-only and mixed TS/JS + Python repositories.
- **Viewer tests drive the page** like a person: roles, labels and keyboard. Assert visible
  text, and run `audit(page)` for accessibility.

## 5. Coding standards

- **Read the code around your change and match it:** naming, structure, comment density and
  idiom. Look for an existing helper before writing one.
  - `compareUtf8` and `compareAscii` for ordering;
  - `codeLabels` for ecosystem wording;
  - `HISTORY_BOUNDARY_TEXT` for history windows;
  - `nodeIdentityKey` for node identity.
- **Strict TypeScript.**
  - No `any`, and no `as` casts that hide a real type error.
  - Type lookup tables by their enum, such as `Record<HistoryBoundary, string>`, so a new
    value fails to compile instead of rendering a raw code. That gap caused the "Window
    ends: days" bug.
- **Determinism.** Analysis output must not depend on:
  - time, randomness, locale (`localeCompare`), `Map`/object insertion order from
    unordered sources, the platform's path separator, or line endings.

  Sort explicitly. Same input, same bytes, on Windows and Linux.
- **Untrusted input.** An analyzed repository is data. Bound every parse:
  - by size, depth and time;
  - fail closed with a named reason code;
  - never execute, import or fetch anything it names.

  Analysis has no network.
- **Layering.** `pnpm check:deps` enforces it:
  - the viewer never imports analyzer or ingest code;
  - `packages/schema` is shared with the browser, so it has no static `node:` imports.
- **User-facing text** is plain, specific and honest.
  - Name what is missing, and never show zero for "unknown".
  - Never show internal codes or enum values, such as `days` or `commit-cap`, where a
    sentence belongs.
  - A TS/JS-only analysis keeps its exact existing wording.
- **Accessibility** in the viewer:
  - everything works by keyboard and has an accessible name;
  - targets are at least 44 px;
  - layouts reflow at 320 px;
  - reduced motion is respected;
  - there is an HTML equivalent for anything drawn on the canvas.
- **Comments** explain why, and cite the ADR or plan section. Don't narrate what the code
  does. Remove dead code rather than commenting it out.
- **Small, reviewable changes.** Don't mix refactors with behaviour changes or reformat
  unrelated code. Generated files change only through their generators.
- **Files use LF line endings** (`.gitattributes`). On Windows, editors and scripts can
  write CRLF; check `git diff` after scripted edits.

## 6. Recording work

- **Commit messages** say why, not just what.
- **Pull request descriptions** cover:
  - what changed;
  - bugs found along the way;
  - how it was verified, with exact counts;
  - anything left open.
- **Every behaviour change updates:**
  - the CHANGELOG under `[Unreleased]`;
  - a dated section in `docs/implementation-status.md`, with evidence and exact counts;
  - the release audit, when a gate's evidence changes.
- **A non-obvious decision** gets the next ADR (Date/Status, Evidence and cause, Decision,
  Verification). Then update the ADR range in AGENTS.md (`ADR-001…ADR-0NN`).
- **Keep failed reports.** A fix records the original failure, its cause and the retest.
- **When a task is done,** update this file: remove the item or mark it done with a link to
  its pull request, so the next agent starts from the truth.

## 7. Never

- Run, build, install or check out anything from an analyzed repository.
- Put source text, author emails, commit messages or absolute paths in artifacts, or put
  tokens in URLs, files, containers or logs.
- Fabricate results, or relax a budget, deadline or assertion to pass a gate.
- Merge your own pull request, push to `main`, skip hooks, or force-push someone else's
  branch.
- Commit `.atlas-tmp/`, build output or local scratch files.
- Touch containers, networks, processes or files you didn't create.
