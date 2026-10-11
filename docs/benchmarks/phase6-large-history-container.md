# Historical analysis capacity — large, 12 frames (plan §15.2)

Recorded 2026-10-11T09:06:21.638Z by `node scripts/bench-history.mjs`. 20 measured runs after one warm-up, each in a fresh process whose analysis owns and closes its parser pool, as in a production analysis sandbox; every run uses a cold fact cache and performs the whole pipeline: first-parent walk, rename-aware diffs, 12 frame graphs, churn, hotspots, union layout and frame-delta packing within the export limits.

## Environment

- **os:** Linux 6.18.33.2-microsoft-standard-WSL2 x64
- **cpu:** Intel(R) Core(TM) i5-10400 CPU @ 2.90GHz
- **cpuCount:** 12
- **memoryGiB:** 7.7
- **node:** v24.15.0
- **nodeFlags:** --max-old-space-size=1536
- **git:** 2.47.3
- **parserWorkers:** 2
- **processPerRun:** true
- **containerLimits:** {"memoryBytes":2147483648,"cpuMax":"400000 100000"}
- **runtimeImage:** sha256:efdc0f7840372236e408c3ae5dd4b7b7d4a5bc1f699789f873e6bd137c38c271
- **sourceCommit:** 2a70452e8fc1a2ec6d5978dabbdf03c8d72d5637
- **benchmarkSourceCommit:** 8d14a54fdb3d3490b64c4842c5da9f36a997eead
- **benchmarkWorkingTreeDirty:** false

## Fixture (synthetic "large" with history, deterministic)

- HEAD: 9,992 files, 98,500 import statements
- History: 40 mainline commits over 58.5 days (root boundary), 12 analyzed frames, 7 renames, 9,999 lineages; status complete

## Result

| Measure | Value | Budget |
|---|---:|---:|
| p50 | 196.26 s | |
| p95 | 202.37 s | ≤ 240 s |
| max | 208 s | |
| artifact (all chunks) | 10.43 MiB | ≤ 20.00 MiB |
| whole-job cgroup peak | 1830.15 MiB | ≤ 2048.00 MiB |
| — selected graph | 4.40 MiB | |
| — 11 historical frames (deltas) | 3.87 MiB | |
| — history / layout | 1.19 MiB / 0.97 MiB | |

**Pass.** Time: pass; size: pass; all measured runs complete with 12 frames: pass; twenty-sample minimum: pass; resource gate: pass (events {"low":0,"high":0,"max":0,"oom":0,"oom_kill":0,"oom_group_kill":0}). Format atlas.artifact/1.3.0; frame-delta transport per ADR-026.
