# ADR-063: Python capacity fixtures and measurement

Date: 2026-10-16; amended 2026-10-17 before acceptance. Status: accepted, merged in [PR #26](https://github.com/urveesh09/project-atlas/pull/26) on 2026-10-17; the final measurements are [ADR-081](ADR-081-python-capacity.md).
Production M2.2. Extends ADR-037; uses analyzer dev.8 from prerequisite ADR-066.

## Evidence and cause

Existing capacity fixtures contain only TypeScript. Python and mixed repositories
need the same file/import scale, realistic bodies and temporal mutations under the
unchanged 15/60-second HEAD and 90/240-second historical budgets. A parser smoke or
single warm-up is not capacity evidence.

## Decision

- Keep the original TypeScript generator unchanged, pinned by an evolution digest
  checked against main before recording. Transform only authored synthetic source
  templates into Python. Never translate or execute analyzed repositories.
- Preserve file counts, all ten original dependency imports per function module, ten
  projects, branching bodies and the 40-commit edit/add/delete/rename schedule.
  Python uses source-layout projects, package stubs, literal project metadata,
  standard-library and declared PyPI imports and TYPE_CHECKING guards. Its typing
  import is additional: eleven Python statements versus ten TS statements. Mixed fixtures
  use five projects per language (equal base counts); temporal additions/deletions
  can slightly change the ratio. Imports between projects remain within a language.
- Add explicit language/mode metadata to prepared fixtures; new language/mode runs
  must match it. Legacy TypeScript history fixtures remain usable without metadata.
- Measure each analysis in a fresh process in the existing immutable, offline,
  non-root, read-only 4-CPU/2-GiB/no-swap container. Close production-owned parser
  pools before export. Run twenty measurements after a separate warm-up for each
  Python/mixed medium/large HEAD and medium/large twelve-frame history matrix row.
- Observe only benchmark-process direct parser children via Linux `/proc` VmHWM,
  every 50 ms and immediately before the unchanged pool close. Kernel high-water
  counters retain transient peaks between samples. The benchmark-only close hook
  flushes before successful workers disappear; crashed children can have incomplete
  observations and never imply a complete-run pass. Report each child per sample.
  No metrics enter artifacts, parser IPC, production code or analysis identities.
- Reports retain raw timings, actual language counts, completeness, memory capture,
  cgroup peaks/OOM events and exact image/source identities. Small diagnostics are
  labelled as such. Twenty samples, complete frames, correct language, time/size
  budgets and physical resource limits all remain required for a matrix-row pass.
- Failed runs/reports are retained and profiled; budgets and assertions are never
  relaxed. This is enforced-resource development-host evidence; the exact reference
  machine and dense/union acceptance matrix in R6-01 remain separate.

## Verification

Four focused tests pass locally: original TypeScript evolution equality/digest,
Python/mixed count and parse invariants, determinism, and a real parser child.
Windows explicitly reports that `/proc` memory observation is unavailable; Linux
CI and the container measurement exercise actual VmHWM. Full local verification
passes 755 tests (81 explicit skips), including the oracle and browser journeys.
A diagnostic Python HEAD fixture completes in the real 4-CPU/2-GiB/no-swap container:
230 parsed Python files; parser-child peaks 151,994,368 and 153,260,032 bytes;
whole-job peak 455,606,272 bytes and zero OOM events. It uses the prior development
runtime image and dirty benchmark scripts solely to validate the harness. It is
explicitly a one-shot diagnostic, not a twenty-sample pass or release identity.
Clean-commit matrix results follow; no capacity pass is claimed yet.

## Pre-acceptance correction (2026-10-17)

The initial transformation replaced the first original dependency import with
`from typing import TYPE_CHECKING` to retain ten statements. That made the Python
graph less demanding. Preserve all ten original imports and add the real typing
import instead. This deliberately makes Python's observation workload slightly
heavier, without dropping a dependency or relaxing any budget. Type guards remain
real Python, rather than using a fake unreachable branch solely to match counts.

Three dev.7 HEAD batches completed before the session stopped between batches:
Python medium p95 5.78 s, mixed medium 5.84 s, Python large 18.53 s. Retain their
exact reports as historical, superseded evidence; they do not validate this stronger
fixture or dev.8. Restart every matrix row from a clean source/image containing
ADR-066's semantic correction. Keep the original TS evolution digest unchanged.

Also retain structured JSON/Markdown when no analysis completes, including the
warm-up. Unknown fixture/artifact/parser facts are null and every gate is false;
only actual environment/cgroup observations are recorded. A real subprocess test
with an absent fixture first fails because no report exists, then passes after
this correction. A killed entire container can still have only its host/session
log; missing measurements never become a pass.

The amended five-check harness suite passes, including the real first-warm-up
failure path. Full premeasurement verification on dev.8 passes 765 tests with
81 explicit service-gated skips; the CPython oracle and 39 viewer journeys run.
The original TS evolution digest still matches. These checks validate the tool,
not the outstanding twenty-run capacity matrix.
