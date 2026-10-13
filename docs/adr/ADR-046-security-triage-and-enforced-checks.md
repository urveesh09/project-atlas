# ADR-046: Security triage and enforced checks

Date: 2026-10-13. Status: accepted. Builds on [ADR-044](ADR-044-release-engineering-and-pilot-readiness.md)
(release engineering). Changes no contract, artifact byte or analyzer version.

## Evidence and cause

An external Beta 1 assessment of `677a19f` found that the security scanners ran green but
their findings had never been triaged:
- 15 open CodeQL alerts;
- 48 open Scorecard findings, 43 of them for workflow actions referenced by movable tags;
- a `main` ruleset that blocked deletion and force pushes but required neither CI nor a
  pull request, although ADR-044 says pull requests are the default and CI must pass;
- secret scanning and push protection disabled.

The owner asked for every non-billing part of Beta 2 to be set up, access controls
included, before any commercial work. A green scan only means the scan ran.

## Decision

### 1. Every CodeQL alert gets a recorded disposition

Fixes are proven by an oracle test that keeps the replaced code as the reference, so
behaviour (and the corpus bytes) cannot drift.

| Alerts | Finding | Disposition |
|---|---|---|
| #1 `analyzer-ts/src/workspace.ts` | Polynomial regular expression | **Fixed, real.** Workspace globs come from the analyzed repository's `package.json` and `pnpm-workspace.yaml`. A glob such as `*a*a*a…b` against a long directory name made the generated expression backtrack polynomially, so a hostile repository could stall analysis until its deadline. Replaced by `compileWorkspaceGlob`: segment-level reachability plus a two-pointer wildcard match, O(segments × parts × length). `workspace-glob.test.ts` compares it with the old expression on 20,000+ random glob/path pairs, and checks a hostile case completes in under 2 s. |
| #2, #3 `ingest/src/local-repository.ts` | Polynomial regular expression | **Fixed.** `.git/config` lines were stripped with `\s*[#;].*$`, which is quadratic on long runs of spaces. The local repository is the user's own, but the reader takes up to 1 MiB, so it is now scanned by index. `git-config.test.ts` compares 20,000 random configs with the old expressions, and checks 400,000 spaces parse in under 1 s. |
| #8 `local-repository.ts` | File-system race | **Fixed.** `readSmall` checked size with `stat` and then read the path again. It now uses one handle and never reads more than the limit plus one byte, even if the file grows. |
| #5 `apps/api/src/server.ts`, #6 `cli/src/server/server.ts` | File-system race | **Fixed.** Static viewer assets are read through one handle after the real-path check (`readRegularFile`). The assets belong to the installed build, so this was defence in depth. |
| #7 `cli/test/cli.test.ts`, #9 `scripts/package-cli.mjs`, #10 `scripts/verify-cli-package.mjs` | File-system race | **Dismissed: test/maintainer tooling.** They hash files the same process just created in its own temporary directory; no other party can write there. |
| #4 `ingest/test/local-git.test.ts` | Code built from a string | **Dismissed: test.** The test builds a child-process script from a path it generated, to prove grandchildren are killed. |
| #11, #12 `control/src/storage.ts` | File data sent over HTTP | **Dismissed: intended.** This is the S3 client: sending a published artifact to the operator's configured bucket over a signed request is its purpose. |
| #13–#15 `occlusion.worker.ts`, `loader.worker.ts`, `query.worker.ts` | Message handler without origin check | **Dismissed: false positive.** These are dedicated workers: only the page that created them can post to them, and `MessageEvent.origin` is empty there. A cross-origin `window` message handler would need an origin check, and the viewer has none. |

### 2. Workflow actions are pinned to commit SHAs

Every `uses:` names a full 40-character commit with its exact version as a comment
(`actions/checkout@3d3c42e… # v7.0.1`), resolved from each action's own tags on
2026-10-13. This fixes 43 Scorecard findings. Dependabot's monthly `github-actions`
group already updates SHA pins together with their comments, so pinning does not freeze
the actions.

### 3. `main` requires a pull request and the checks that define "verified"

The `main` ruleset now has:
- deletion and force-push protection (as before);
- a required pull request with **zero** approvals;
- required status checks, which must pass on the latest base commit:
  - `verify (ubuntu-latest)` and `verify (windows-latest)`;
  - `hosted service gates (PostgreSQL, S3, containers, browser)`;
  - `pinned repository corpus (ubuntu-latest)` and `(windows-latest)`;
  - `pinned corpus Windows/Linux determinism`;
  - `live GitHub acquisition spike`;
  - `CodeQL (JavaScript/TypeScript)` and `dependency review`;
- no bypass actors, including the owner.

**Why zero approvals:** ATLAS has one maintainer. GitHub does not let an author approve
their own pull request, so a required approval would deadlock every change. The
`CodeReview` Scorecard finding is accepted until a second maintainer joins. Then the
count becomes one and code-owner review is required. The software render spike stays
informational, as its name says.

Branches are deleted after merge. Auto-merge is allowed, so a pull request can merge
once its checks pass. Merge commits and squash merges are allowed; rebase merges are
off, so each merged pull request is recorded once. The live acquisition job uses GitHub's anonymous quota (60 per hour).
If it fails on quota, re-run it after the reset; never use a personal token (AGENTS.md).

### 4. Secret scanning and push protection are on

Both are free for public repositories. Push protection rejects a push that contains a
recognised credential before it reaches GitHub.

### 5. Scorecard checks that cannot be engineered honestly

- **Maintained** (repository under 90 days old) and **CII Best Practices** (needs an
  OpenSSF badge application) will change with time or a deliberate application. They are
  left open, not suppressed.
- **Fuzzing:** the parsers have property-style random tests (this ADR adds two oracle
  suites) but no continuous fuzzer, so the finding is accurate.
- **Code-Review:** see section 3.

## Verification

- `pnpm exec vitest run packages/analyzer-ts/test`: 69 passed, including the new
  oracle test.
- `packages/ingest/test/git-config.test.ts`: 2 passed.
- `pnpm exec vitest run packages/ingest packages/cli apps/api`: 186 passed, 22
  service-gated tests skipped.
- `pnpm verify`: 640 passed, 80 skipped (service-gated).
- `actionlint 1.7.7`: no findings on all five workflows.
- `node scripts/check-repository-baseline.mjs`: exact committed bytes for all three
  repositories.
- The ruleset, merge settings and secret-scanning state are read back from the GitHub API
  after they are applied. The pull request that lands this ADR is the first change merged
  under the ruleset.
