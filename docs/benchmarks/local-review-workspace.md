# Local review workspace: implementation evidence

Scope: Q4 preparation only, ADR-091. The CLI retains one source-free Q3 architecture
review and structured local decisions. No hosted/private/shared service, auth, billing,
deployment, release, source execution or network path is added. G6/R6 remains open.

## Authored checks

- Pure workspace tests bind canonical report digest, issue IDs and revision; reject
  tampered/unknown/duplicate decisions and arbitrary free text/identity fields.
  An acknowledged decision leaves the architecture policy's blocking exit unchanged.
- Store tests exercise exclusive private initialization and exports, exact roundtrip,
  one-writer concurrency, stale revision, write/rename/validation failure preservation,
  noncooperating byte changes, cancellation, lock/temp cleanup, artifact boundaries,
  directory aliases, hard links, Windows alternate data streams and nonregular
  files. POSIX-only permission/symlink cases are explicitly gated on Windows.
- CLI tests create a real committed TS fixture with an independently authored
  production-to-test dependency. They analyze it, admit its architecture review,
  decide/export/import/inspect, prove decisions do not change policy blocking,
  preserve stale-write bytes, reject forged-but-rehashed report counts by recomputing
  the matching artifact, and cover invalid arguments/cancellation/source exclusion.

The 2026-11-09 focused Windows run on Node 24.22.1 passed 16 tests. The one
POSIX-only permission/symlink case was skipped. Type checking passed and the
contract generator produced 16 contracts. The first store-test attempt failed
because the ESM module namespace could not be spied on directly. Vitest now
uses the module's spy mode to inject the same rename failure and keep its
state-preservation assertions.

The full Windows suite passed **1,068 tests** with **93 gated skips**,
including 53 Chromium viewer journeys. All **22 relocated CLI smoke stages**
passed, including initialization, revision-checked decision, export, import
and inspection of the restored workspace. The export retained the exact
report and excluded its temporary host path. The browser smoke run recorded
zero outbound requests and page errors.

All six pinned public repositories completed five offline repeats and matched
the committed artifact bytes and independent source checks. Vite retained its
expected partial coverage. The analyzer and artifact versions stay unchanged.

No timing, reference-device or whole-job capacity pass is claimed here.
