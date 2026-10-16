# Production M1.5: Python runtime upgrade evidence

Recorded 2026-10-16 on the Windows development host, Node 24.22.0, pnpm 10.34.6,
CPython 3.14.5. Baseline build: clean main `4a39f66`, analyzer `0.1.0-dev.6`.
New build: analyzer `0.1.0-dev.7`, runtime `web-tree-sitter` 0.27.1.
This is compatibility/correctness evidence, not capacity or reference-device acceptance.

## Independent Python oracle

The existing oracle reads the installed standard library as data and compares
CPython `ast`/`tokenize` against ATLAS imports, module declarations, per-callable
complexity and code lines. Neither run executes those files.

| Runtime | Files inspected | Both parse | CPython only | ATLAS only | Fact mismatches |
|---|---:|---:|---:|---:|---:|
| 0.25.10, before upgrade | 1,848 | 1,841 | 3 | 0 | 0 |
| 0.27.1, after upgrade | 1,848 | 1,841 | 3 | 0 | 0 |

The same three grammar gaps remain: `test_annotationlib.py`, `test_compile.py`,
`test_type_params.py`. The vendored grammar's bytes/hash/license are unchanged.
Its ABI 15 loads within the new runtime's supported range. Five new regression
cases check installed-runtime provenance and UTF-16 source ranges around astral
text at four input lengths, including EOF. All 19 extraction tests pass.

## Main-build comparison and deliberate identity change

`scripts/compare-analysis-paths.mjs` runs both builds offline against Harbor and
the four immutable corpus repositories. It uses ADR-060's existing normalization
of version-derived IDs and ID-ordered cycle/fan-in evidence choices. No comparator
rule was changed for this upgrade.

| Repository | Reported differences | Exact remaining difference |
|---|---:|---|
| Harbor | 1 | `summary.analyzerVersion`: dev.6 → dev.7 |
| sindresorhus/is-plain-obj | 1 | `summary.analyzerVersion`: dev.6 → dev.7 |
| vuejs/core | 1 | `summary.analyzerVersion`: dev.6 → dev.7 |
| vitejs/vite | 1 | `summary.analyzerVersion`: dev.6 → dev.7 |
| pallets/flask | 1 | `summary.analyzerVersion`: dev.6 → dev.7 |

The command exits 1 because it compares the summary version literally. A separate
strict assertion checks the complete report contains exactly these five version
transitions and no other differences. It passes. This is not reported as a zero-diff
command pass. All compared graph facts, import relationships, findings, metrics,
history and layout agree under the existing normalization, including Python.

Raw artifact identities/hashes change: the real parser identifier participates in
analysis identity and graph metadata. [ADR-062](../adr/ADR-062-python-parser-runtime-and-analysis-identity.md)
records the analyzer bump; the artifact schema stays 1.4.0. The first targeted run
has 48 passes and one failure: Harbor's old hash golden. That original failure is
retained locally. After the independent comparison, only its four version-derived
hashes are updated; the focused rerun passes. Authored fact expectations and
baseline rules remain intact.

## Packaged runtime

The sandbox Dockerfile builds successfully. Its development image is
`sha256:5776cdf106e54eeacc784e5f579773883d0264371e97d23183755da2faebca82`.
A real container with uid 10001, no network, read-only root, no capabilities,
no-new-privileges, two CPUs and 512 MiB (no swap) loads the grammar and parses an
authored Python string: one `os` import, callable complexity 2. This is a parser
smoke check, not a hosted Python journey or capacity benchmark (M2.2/M2.3 remain).

The initial smoke harness assumed a transitive package was at the deployment root
and failed with `ERR_MODULE_NOT_FOUND`. Resolving it through the deployed
analyzer-core package fixes the harness; the image itself is unchanged. The
corrected smoke reports Node 24.22.0, runtime 0.27.1, ABI 15 and `parsed`.

## Fresh corpus

All four immutable repositories pass five offline cold repeats. Every export verifies,
repeat hashes agree and all 28 authored source checks remain unchanged. Vite keeps its
expected partial status. The regenerated dev.7 baseline is committed with this upgrade;
raw hashes deliberately differ from dev.6 as explained above. No acquisition or analyzed
repository code execution is part of this repeat run.

## Full local verification and portable archive

`pnpm verify` passes 751 tests, with 81 explicit skips. The CPython oracle runs;
all 39 viewer journeys pass. Typecheck, viewer build, dependency direction (15
packages) and generated contracts (six files) pass. No assertion or budget changes.

All six relocated distribution stages pass. The 10,491,077-byte development archive
has SHA-256 `33914566fc0081776e5dd3280db38eedd39544dc650d565a6a20bcc393f447cf`.
Its source is `4a39f66` with a dirty working tree; it is not a release identity.
A separate extraction outside the checkout then analyzes, verifies and inspects an
authored one-file Python Git repository with CLI entry-process sockets denied:
one parsed file, zero parse failures, one standard-library import and complexity 2.
Its manifest identifies analyzer dev.7 and runtime 0.27.1. No dependency install is
used. Historical candidate reports/images are restored after retaining local copies.

Required CI is checked in the implementation PR before handoff. The registry audit reports zero known
advisories and GitHub reports zero open Dependabot alerts on this date. Neither is
an image vulnerability scan or release sign-off. All G6 acceptance items remain open.

## Reproduce

```sh
pnpm install --frozen-lockfile && pnpm build
pnpm exec vitest run packages/analyzer-py/test/oracle.test.ts --reporter verbose
pnpm exec vitest run packages/analyzer-py/test/extract.test.ts
node scripts/compare-analysis-paths.mjs <separately-built-main-root>
node scripts/validate-real-repositories.mjs
pnpm verify
pnpm verify:distribution
```

The main-build comparison deliberately reports the five summary-version changes
above. After this versioned baseline lands, subsequent byte-preserving work must
again pass `node scripts/check-repository-baseline.mjs` exactly.
