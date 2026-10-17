# HEAD analysis capacity — medium, 1 frames (plan §15.2)

Recorded 2026-10-16T16:05:17.156Z by `node scripts/bench-history.mjs`. Language: python; mode: head. 20 measured runs after one warm-up, each in a fresh process whose analysis owns and closes its parser pool, as in a production analysis sandbox; every run uses a cold fact cache, complete analysis and artifact packing.

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
- **runtimeImage:** sha256:fcea3d16cf470c3c446b5a855e5afc84644025d96ff56b3e39d7b19198473719
- **sourceCommit:** c923ccb9052648531d623b5c7d148f2e1c47c51c
- **benchmarkSourceCommit:** c923ccb9052648531d623b5c7d148f2e1c47c51c
- **benchmarkWorkingTreeDirty:** false

## Fixture (synthetic "medium", python, head, deterministic)

- HEAD: 3,142 files, 30,000 import statements
- Parsed languages: {"typescript":0,"javascript":0,"python":3130}; language validation: pass
- History disabled; one selected frame.

## Result

| Measure | Value | Budget |
|---|---:|---:|
| p50 | 5.71 s | |
| p95 | 5.78 s | ≤ 15 s |
| max | 5.81 s | |
| largest parser-child VmHWM | 168.73 MiB | recorded per child in JSON |
| artifact (all chunks) | 1.62 MiB | ≤ 5.00 MiB |
| whole-job cgroup peak | 480.36 MiB | ≤ 2048.00 MiB |
| — selected graph | 1.28 MiB | |
| — history / layout | 0.13 MiB / 0.21 MiB | |

**Pass.** Time: pass; size: pass; all measured runs complete with 1 frames: pass; twenty-sample minimum: pass; parser-memory capture: pass; resource gate: pass (events {"low":0,"high":0,"max":0,"oom":0,"oom_kill":0,"oom_group_kill":0}). Format atlas.artifact/1.4.0; frame-delta transport per ADR-026.
