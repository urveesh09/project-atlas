# ADR-063: Python capacity fixtures and measurement

Date: 2026-10-16. Status: implementation checkpoint; measurements pending.
Production M2.2. Extends ADR-037; no analyzer or artifact version change.

## Evidence and cause

Existing capacity fixtures contain only TypeScript. Python and mixed repositories
need the same file/import scale, realistic bodies and temporal mutations under the
unchanged 15/60-second HEAD and 90/240-second historical budgets. A parser smoke or
single warm-up is not capacity evidence.

## Decision

- Keep the original TypeScript generator unchanged, pinned by an evolution digest
  checked against main before recording. Transform only authored synthetic source
  templates into Python. Never translate or execute analyzed repositories.
- Preserve file counts, ten import statements per generated function module, ten
  projects, branching bodies and the 40-commit edit/add/delete/rename schedule.
  Python uses source-layout projects, package stubs, literal project metadata,
  standard-library and declared PyPI imports and TYPE_CHECKING guards. Its typing
  import replaces one generated import, retaining ten statements. Mixed fixtures
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
