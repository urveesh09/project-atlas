# Informational test coverage

Production M2.5 adds `pnpm coverage`, using development-only
`@vitest/coverage-v8` 5.0.5, matched exactly to Vitest. It builds the viewer first;
the existing global setup compiles subprocess entrypoints. Install Chromium as
described in the contributor guide to run the browser journeys.

```sh
pnpm coverage
```

Reports are local and ignored: `coverage/index.html`, `coverage/coverage-final.json`
and `coverage/coverage-summary.json`. The include list covers every production
TypeScript/TSX file, including ones never imported by the test runner. No threshold
or CI gate is added. A higher percentage does not establish correct import facts,
security policy or useful developer workflows.

## Scope and first observation (2026-10-17)

The initial standard-suite run passes 751 tests with 81 explicit service-gated
skips. It records 57.47% lines (7,850/13,658), 56.19% statements, 49.42% branches
and 52.48% functions. This is Node-process V8 coverage on the M2.5 branch based on
`4d0f6ee`; it does not instrument browser JavaScript or independent subprocesses.
The 39 browser journeys and CPython oracle actually run, but their successful
external execution must not be misrepresented as V8 instrumentation of that code.

Some low results and their interpretation:

| Module/group | Initial line / branch % | What the observation means |
|---|---:|---|
| `artifact/src/browser.ts` | 93.75 / 62.50 | Browser adapters are exercised in Node, but hostile file metadata and streamed expansion need explicit checks |
| `artifact/src/node.ts` | 90.62 / 73.75 | Existing filesystem/jail/transaction tests execute in this process; CLI child execution is separate |
| `analyzer-py/src/projects.ts` | 80.48 / 66.97 | Manifest error/literal-only branches deserve risk-driven tests |
| `analyzer-py/src/resolver.ts` | 93.52 / 78.71 | High execution coverage still missed the real namespace-precedence defect found independently by M2.6 |
| `control/src/storage.ts` | 43.88 / 24.27 | Local storage runs; real S3 is gated off in this report |
| `control/src/github.ts` | 10.63 / 6.02 | Shared quota behavior requires the PostgreSQL gates |
| `control/src/publications.ts` | 5.45 / 12.24 | Publication visibility/lifecycle are mostly service-gated |
| `control/src/jobs.ts`, `operations.ts` | 0 / 0 | They need real database/coordinator journeys, not shallow mocks to improve a score |
| Browser-only React/city modules and subprocess entrypoints | Mostly 0 | Browser journeys, parser isolation, CLI and sandbox gates validate them separately; this Node report cannot measure their execution |

The report includes the full per-file list. These observations do not replace the
mandatory PostgreSQL, S3, sandbox, browser or offline real-repository gates.

## Risk-driven additions

- Refuse enormous picked-file metadata before allocating/reading its contents;
  preserve the chosen-folder boundary and missing-file behavior.
- Exercise the real streaming browser decompressor with a highly compressible
  payload: refuse expansion beyond the cap and accept the exact cap.
- Purge 125 objects through the real filesystem store in bounded pages of
  100/25/0, while retaining a different upload intact.
- Read literal `setup.py` metadata without executing its top-level exception;
  reject computed requirements and escaping package roots with the named warning.

All four focused checks pass. The initial setup test incorrectly expected no
warning; ADR-057 explicitly requires one for non-literal metadata. Read that
contract and assert exact `SETUP_PY_NONLITERAL`, rather than changing production.
The original three-pass/one-failure result is retained in the implementation log.
Full verification after these additions passes 755 tests with 81 explicit skips.
The repeated full coverage run also passes 755 tests with 81 explicit skips:
57.49% lines (7,852/13,658), 56.24% statements, 49.48% branches and 52.48%
functions. Browser-adapter coverage is now 100% lines / 87.50% branches; project
manifest branches are 67.58%, and storage branches 25.24%. The small numerical
change illustrates why the security invariants, not percentages, are the purpose
of these tests. Required CI is tracked in the PR. No production behavior, budget
or deadline changes.
