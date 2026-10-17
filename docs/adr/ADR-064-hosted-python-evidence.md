# ADR-064: Hosted Python evidence uses an independently authored repository

Date: 2026-10-16. Status: accepted for production M2.3; CI tracked in the PR.
Extends ADR-031, ADR-056/057 and ADR-060 for production M2.3.

## Evidence and cause

The container security gates and hosted browser journeys previously analyzed the
TS/JS Harbor fixture. A parser smoke test alone cannot prove that the deployed
worker dependency closure includes the Python WASM grammar, that an offline
sandbox can analyze Python history, or that publication and browser loading work.

## Decision

- Add a separate, authored Harbor Python fixture in `@atlas/test-fixtures`.
  Its expectations precede its first analysis: eight files, five Python files
  (including one `.pyi`), seven imports, three internal resolutions, three
  standard-library resolutions and one declared PyPI `requests` resolution.
- Use two commits with a content-preserving `rules.py` → `policy.py` rename.
  Assert the surviving lineage as well as both actual file occurrences; missing
  occurrences cannot accidentally compare equal. The pricing function has one
  decision, complexity two, one internal consumer and one internal dependency.
- Run the complete coordinator → Docker acquisition → offline analysis →
  verified publication flow. Load every published chunk through the real artifact
  loader, not just the manifest. Assert exact files, imports, coverage, metrics,
  absence of findings, history and container/network cleanup.
- Add a hosted Chromium journey that submits that repository, follows the job,
  opens the result, selects a Python file using the keyboard and inspects its
  internal, builtin and PyPI dependencies. Audit accessibility and retain the
  existing suite-wide check that secrets never appear in URLs.
- With container gates enabled, the browser journey uses the actual deployed
  image too. Database-only development retains the explicit process-isolation
  path. No Python interpreter, dependency installation or repository execution is
  involved in either analysis path.

No production analysis, schema, runtime pin, permissions or deadline changes.
The existing mandatory hosted CI job discovers both tests; job names stay fixed.

## Verification

All 145 physical hosted checks pass locally: PostgreSQL, real S3, Docker security
gates and seven Chromium journeys. The initial run passed 144 and failed the new
journey because its broad `option` selector also matched native dropdown options.
Scope the selector to the search-results listbox and wait for the expected result;
do not change product code, deadlines or assertions to hide the failure. The full
145-check retest passes. The independently checked artifact passed in both runs.
The final focused retest additionally requires a non-null rename lineage.

Local tests use the actual immutable deployed sandbox image
`sha256:fcea3d16cf470c3c446b5a855e5afc84644025d96ff56b3e39d7b19198473719`
(clean source `c923ccb9052648531d623b5c7d148f2e1c47c51c`, the M2.2 harness
checkpoint; its production worker closure equals this branch's). The existing
hosted CI job rebuilds from this PR's exact source. Host: Windows, Node 24.22.0,
Docker Desktop Linux engine 29.8.1. Full verification and required CI outcomes are
recorded in implementation status and the PR. M2.2 capacity, the expanded corpus
and G6 acceptance remain independent requirements.

## Windows browser-test follow-up (2026-10-17)

Run 38996642868 failed the existing history rename search on Windows; one targeted
job rerun passed. Run 38998758410 on the branch's main merge then failed an existing
guided-start tab assertion. These are browser polling timeouts, not the documented
native Vitest crash. The failures are retained; their precise scheduling cause has
not been established. Do not keep rerunning until a green result or raise deadlines.

Inspection found a concrete harness ownership defect: the serial viewer groups kept
their live pages, WebGL contexts and query workers until the entire file ended.
The independent deep-link journeys also leaked two pages. Close group-owned pages
in their group teardown, and independent deep-link pages after each journey. Preserve
the shared sign-in cookie. Assert an empty page inventory before opening the next
independent journey/group, so this resource leak cannot silently return. Historical
fresh-page and reduced-motion contexts retain their existing finally cleanup.

This is a harness resource fix; it does not establish that retained pages caused
either CI timeout. Product code, functional deadlines, assertions and separate
performance gates are unchanged. Repeat local software-rendering evidence and the
new required CI result are recorded in the PR before this work is considered ready.

The focused software-rendered run passes 39/39 journeys (67.01 s). Full verification
under software rendering then passes 756 tests, 83 conditional skips (202.23 s),
including those 39 journeys and the CPython oracle. Required CI must still pass on
the correction's exact commit.
