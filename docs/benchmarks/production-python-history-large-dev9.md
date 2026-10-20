# Historical analysis capacity — large, 12 frames (plan §15.2)

Recorded 2026-10-19T08:44:37.301Z by `node scripts/bench-history.mjs`. Language: python; mode: history. 20 measured runs after one warm-up, each in a fresh process whose analysis owns and closes its parser pool, as in a production analysis sandbox; every run uses a cold fact cache, complete analysis and artifact packing.

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

## Fixture (synthetic "large", python, history, deterministic)

- HEAD: 9,992 files, 99,922 import statements
- Parsed languages: {"typescript":0,"javascript":0,"python":9980}; language validation: pass
- HEAD dependency edges: 98,112 (limits hit: none); Python fixture policy atlas.capacity.python/2 (ADR-067)
- History: 40 mainline commits over 58.5 days (root boundary), 12 analyzed frames, 7 renames, 9,999 lineages; status complete

## Result

| Measure | Value | Budget |
|---|---:|---:|
| p50 | 194.96 s | |
| p95 | 197.35 s | ≤ 240 s |
| max | 198.88 s | |
| largest parser-child VmHWM | 172.93 MiB | recorded per child in JSON |
| artifact (all chunks) | 10.60 MiB | ≤ 20.00 MiB |
| whole-job cgroup peak | 1800.01 MiB | ≤ 2048.00 MiB |
| — selected graph | 4.46 MiB | |
| — 11 historical frames (deltas) | 3.96 MiB | |
| — history / layout | 1.19 MiB / 0.99 MiB | |

**Pass.** Time: pass; size: pass; all measured runs complete with 12 frames: pass; twenty-sample minimum: pass; parser-memory capture: pass; resource gate: pass (events {"low":0,"high":0,"max":0,"oom":0,"oom_kill":0,"oom_group_kill":0}). Format atlas.artifact/1.4.0; frame-delta transport per ADR-026.
