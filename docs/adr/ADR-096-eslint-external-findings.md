# ADR-096: Import ESLint findings for JavaScript and TypeScript

Date: 2026-11-11. Status: accepted for the local review workflow. Extends ADR-085.

## Evidence and cause

External findings currently accept Ruff SARIF for Python. The owner authorized
another code-quality improvement. JavaScript and TypeScript teams can already
produce machine-readable findings with ESLint's built-in JSON formatter.

## Decision

- Accept ESLint's plain `--format json` output through an explicit producer flag.
  The operator declares the ESLint version, commit and source root. The version
  and commit are declarations because the formatter records neither.
- Map absolute paths lexically against the supplied root, using exact repository
  paths. Accept local drive paths and POSIX paths. Reject traversal, network paths,
  URIs and paths outside the root. The importer performs no file lookups for paths
  named in the report.
- Reuse the bounded quality sidecar and viewer. Add an ESLint producer variant and
  keep the existing Ruff variant and identity. Compare only reports from the same
  analysis, producer and declared version. The scan-evidence and contextual
  review formats continue to require Ruff.
- Retain rule IDs, severity, starting position and analyzed file identity. Count
  suppressed, unsupported, unmapped and duplicate results. A fatal parse message
  counts as unsupported, so its omission makes the import partial. Source,
  messages, suggestions, fixes and machine paths stay out of the sidecar.
- ESLint and its rules run in the operator's trusted checkout or CI. ATLAS ships
  no ESLint dependency or rules. The import carries unverified scan scope and
  cannot establish coverage or resolution.

## Verification

Use actual ESLint output from an authored fixture. Exercise the CLI, snapshot
navigation, malicious paths, producer mismatches, limits and existing Ruff
reports. Check the packaged CLI, browser engines and unchanged analysis baseline.

ESLint 10.14.0 with typescript-eslint 8.72.2 reported `no-var` at
`sample.js:1:1`, `no-console` at `sample.js:2:1` and
`@typescript-eslint/no-explicit-any` at `sample.ts:1:22`. The checked-in
formatter fixture substitutes synthetic absolute paths for the workstation paths.
A separate producer run confirmed that ESLint places suppressed warnings and
fatal parse errors in different fields.

## References

- [ESLint formatters reference](https://eslint.org/docs/latest/use/formatters/#json)
- [ESLint LintResult contract](https://eslint.org/docs/latest/integrate/nodejs-api#-lintresult-type)
- [ESLint license](https://github.com/eslint/eslint/blob/v10.14.0/LICENSE)
