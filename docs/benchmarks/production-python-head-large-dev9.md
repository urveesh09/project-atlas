# HEAD analysis capacity — large, 1 frames (plan §15.2)

Recorded 2026-10-19T06:55:28.448Z by `node scripts/bench-history.mjs`. Language: python; mode: head. 20 measured runs after one warm-up, each in a fresh process whose analysis owns and closes its parser pool, as in a production analysis sandbox; every run uses a cold fact cache, complete analysis and artifact packing.

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

## Fixture (synthetic "large", python, head, deterministic)

- HEAD: 9,992 files, 99,878 import statements
- Parsed languages: {"typescript":0,"javascript":0,"python":9980}; language validation: pass
- HEAD dependency edges: 98,149 (limits hit: none); Python fixture policy atlas.capacity.python/2 (ADR-067)
- History disabled; one selected frame.

## Result

| Measure | Value | Budget |
|---|---:|---:|
| p50 | 17.85 s | |
| p95 | 18.09 s | ≤ 60 s |
| max | 18.18 s | |
| largest parser-child VmHWM | 171.95 MiB | recorded per child in JSON |
| artifact (all chunks) | 5.43 MiB | ≤ 20.00 MiB |
| whole-job cgroup peak | 663.71 MiB | ≤ 2048.00 MiB |
| — selected graph | 4.41 MiB | |
| — history / layout | 0.40 MiB / 0.62 MiB | |

**Pass.** Time: pass; size: pass; all measured runs complete with 1 frames: pass; twenty-sample minimum: pass; parser-memory capture: pass; resource gate: pass (events {"low":0,"high":0,"max":0,"oom":0,"oom_kill":0,"oom_group_kill":0}). Format atlas.artifact/1.4.0; frame-delta transport per ADR-026.
