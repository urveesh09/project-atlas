# Phase 4 historical analysis benchmark (Gate G4)

Recorded 2026-10-10T17:21:33.051Z by `node scripts/bench-history.mjs`. 20 measured runs after one warm-up; every run uses a cold fact cache and performs the whole pipeline: first-parent walk, rename-aware diffs, 12 frame graphs, churn, hotspots, union layout and frame-delta packing within the export limits.

## Environment

- **os:** Windows_NT 10.0.26200 x64
- **cpu:** Intel(R) Core(TM) i5-10400 CPU @ 2.90GHz
- **cpuCount:** 12
- **memoryGiB:** 15.9
- **node:** v24.15.0
- **git:** 2.55.0.windows.3
- **parserWorkers:** 2

## Fixture (synthetic "medium" with history, deterministic)

- HEAD: 3,252 files, 31,100 import statements
- History: 40 mainline commits over 58.5 days (root boundary), 12 analyzed frames, 7 renames, 3,259 lineages; status complete

## Result

| Measure | Value | Budget |
|---|---:|---:|
| p50 | 65.83 s | |
| p95 | 68.86 s | ≤ 90 s |
| max | 69.67 s | |
| artifact (all chunks) | 12.96 MiB | ≤ 5 MiB |
| — selected graph | 1.43 MiB | |
| — 11 historical frames (deltas) | 5.81 MiB | |
| — history / layout | 2.01 MiB / 3.71 MiB | |

**Fail.** Time: pass; size: fail. Format atlas.artifact/1.3.0; frame-delta transport per ADR-026.
