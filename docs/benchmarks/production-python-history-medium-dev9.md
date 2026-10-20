# Historical analysis capacity — medium, 12 frames (plan §15.2)

Recorded 2026-10-20T12:08:51.376Z by `node scripts/bench-history.mjs`. Language: python; mode: history. 20 measured runs after one warm-up, each in a fresh process whose analysis owns and closes its parser pool, as in a production analysis sandbox; every run uses a cold fact cache, complete analysis and artifact packing.

## Environment

- **os:** Linux 6.18.33.2-microsoft-standard-WSL2 x64
- **cpu:** Intel(R) Core(TM) i5-10400 CPU @ 2.90GHz
- **cpuCount:** 12
- **memoryGiB:** 7.7
- **node:** v24.22.0
- **nodeFlags:** --max-old-space-size=1536
- **git:** 2.47.3
- **parserWorkers:** 2
- **processPerRun:** true
- **containerLimits:** {"memoryBytes":2147483648,"cpuMax":"400000 100000"}
- **runtimeImage:** sha256:4e8161a5fd5b70be7f55c4bec7d7ba6423b219c2f4ca8e756770b04642277a85
- **sourceCommit:** 8fc45c0dd1c98cfbb73981fb1edebb1de9202abd
- **benchmarkSourceCommit:** 8fc45c0dd1c98cfbb73981fb1edebb1de9202abd
- **benchmarkWorkingTreeDirty:** false

## Fixture (synthetic "medium", python, history, deterministic)

- HEAD: 3,252 files, 31,553 import statements
- Parsed languages: {"typescript":0,"javascript":0,"python":3240}; language validation: pass
- HEAD dependency edges: 30,294 (limits hit: none); Python fixture policy atlas.capacity.python/2 (ADR-067)
- History: 40 mainline commits over 58.5 days (root boundary), 12 analyzed frames, 7 renames, 3,259 lineages; status complete

## Result

| Measure | Value | Budget |
|---|---:|---:|
| p50 | 47.74 s | |
| p95 | 54.28 s | ≤ 90 s |
| max | 57.01 s | |
| largest parser-child VmHWM | 169.26 MiB | recorded per child in JSON |
| artifact (all chunks) | 4.73 MiB | ≤ 5.00 MiB |
| whole-job cgroup peak | 1374.95 MiB | ≤ 2048.00 MiB |
| — selected graph | 1.44 MiB | |
| — 11 historical frames (deltas) | 2.37 MiB | |
| — history / layout | 0.49 MiB / 0.43 MiB | |

**Pass.** Time: pass; size: pass; all measured runs complete with 12 frames: pass; twenty-sample minimum: pass; parser-memory capture: pass; resource gate: pass (events {"low":0,"high":0,"max":0,"oom":0,"oom_kill":0,"oom_group_kill":0}). Format atlas.artifact/1.4.0; frame-delta transport per ADR-026.
