# ADR-081: Python and mixed capacity results

Date: 2026-10-20. Status: proposed; exact-head CI and owner merge required. Production
M2.2. Completes the measurement planned by
[ADR-063](ADR-063-python-capacity-fixtures-and-measurement.md). Its fixture rule of a
`typing` import in every module is superseded by policy `atlas.capacity.python/2`
([ADR-067](ADR-067-shared-dependency-edge-budget.md)); its other measurement rules are
unchanged. Analyzer `0.1.0-dev.9`; budgets, schemas and resource limits are unchanged.

## Evidence and cause

**Earlier rows are superseded.** ADR-063 measured three dev.7 HEAD rows on a fixture that
added a `typing` import to every module. Neither that fixture nor dev.7 is the analyzer
being released, so those reports stay as history and are not rows of this matrix.

**The first dev.9 attempt found a defect.** On `6ad88a6` (the 3.15 grammar, without the
edge budget), Python large HEAD failed its warm-up: the merged package and source edges
exceeded the 100,000-edge schema bound. ADR-067 fixes the analyzer and the fixture policy;
the failure report is kept as
[production-python-head-large-edge-overflow-6ad88a6](../benchmarks/production-python-head-large-edge-overflow-6ad88a6.md).

## Decision

1. **One source and one image for every row.** Commit `8fc45c0` (analyzer dev.9 with the
   3.15 grammar and the shared edge budget), from a clean worktree, and runtime image
   `sha256:4e8161a5…77a85`, labelled with that revision. Every report records both and
   `benchmarkWorkingTreeDirty: false`.
2. **Unchanged method (ADR-037, ADR-063).** Each row prepares one deterministic fixture
   with policy `atlas.capacity.python/2`, then runs one warm-up and 20 measured analyses,
   each in a fresh process. The container has 4 CPUs, 2 GiB, no swap, no network and uid
   10001. HEAD rows use 3,000 and 9,850 files; history rows use 3,000 and 9,740 files
   with 12 frames.
3. **Unchanged budgets (plan §15.2).** p95 at most 15 s for medium HEAD, 60 s for large
   HEAD, 90 s for medium history and 240 s for large history. Artifacts at most 5 MiB
   (medium) and 20 MiB (large). The whole job stays within the 2 GiB cgroup with no
   memory events.
4. **Reports are published unchanged** as `docs/benchmarks/production-{python,mixed}-
   {head,history}-{medium,large}-dev9.{json,md}`.
5. **Scope.** This is development-host evidence: an Intel i5-10400 running Docker in a
   WSL2 VM with 7.7 GiB. It closes M2.2. The reference-hardware row of R6-01 and gate G6
   stay open.

## Verification

All eight rows pass every gate: time, size, 20 complete samples, language validation,
parser-memory capture and resources. No row hit an edge or other limit, and every
cgroup recorded zero `low`, `high`, `max` and OOM events.

| Row | Edges | p50 | p95 | Max | Budget | Parser child | Job peak | Artifact |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Python HEAD medium | 29,740 | 5.75 s | 5.96 s | 6.01 s | 15 s | 168.69 MiB | 475.43 MiB | 1.65 MiB |
| Mixed HEAD medium | 29,217 | 5.57 s | 5.74 s | 5.84 s | 15 s | 222.03 MiB | 579.19 MiB | 1.71 MiB |
| Python HEAD large | 98,149 | 17.85 s | 18.09 s | 18.18 s | 60 s | 171.95 MiB | 663.71 MiB | 5.43 MiB |
| Mixed HEAD large | 96,511 | 16.74 s | 17.43 s | 17.63 s | 60 s | 233.56 MiB | 828.06 MiB | 5.59 MiB |
| Python history medium | 30,294 | 47.74 s | 54.28 s | 57.01 s | 90 s | 169.26 MiB | 1,374.95 MiB | 4.73 MiB |
| Mixed history medium | 29,801 | 45.88 s | 46.21 s | 47.98 s | 90 s | 221.80 MiB | 1,210.24 MiB | 4.92 MiB |
| Python history large | 98,112 | 194.96 s | 197.35 s | 198.88 s | 240 s | 172.93 MiB | 1,800.01 MiB | 10.60 MiB |
| Mixed history large | 96,509 | 190.02 s | 196.86 s | 257.55 s | 240 s | 239.66 MiB | 1,892.41 MiB | 11.00 MiB |

Edges are the HEAD dependency edges of the fixture. "Parser child" is the largest VmHWM
of any parser child; "job peak" is the cgroup's peak.

**Where the headroom is small:**
- **Large-history memory.** The mixed job peaks at 1,892.41 MiB, 92% of 2 GiB, and Python
  at 1,800.01 MiB; the TypeScript large-history row was 1,830.15 MiB. Large-history export
  remains the tightest phase (AGENTS.md "Memory").
- **Medium-history artifact size.** Mixed medium history packs 4.92 MiB against a 5 MiB
  budget; the TypeScript medium history was 4.70 MiB.
- **One slow sample.** In mixed large history, sample 7 took 257.55 s; the other 19 took
  187.56–196.86 s. The gate is p95, which passes at 196.86 s. Its cause was not
  determined, and the row recorded no memory events.

**One row was measured twice.** On 2026-10-19 the first Python medium-history attempt was
stopped during its 18th measured sample. The host was critically low on memory, Claude Code stopped
the monitoring task, and the agent then removed the capacity container. The runner
exited 137 without a report, and the matrix script went on to the next rows. Python medium
history was rerun alone on 2026-10-20, with the same commit, image and fixture policy;
that run is the published row. Its samples range from 46.20 to 57.01 s, wider than mixed
medium history's 45.25–47.98 s; the cause was not determined, and p95 is 54.28 s against
90 s.
