# Phase 2 HEAD analysis benchmark (Gate G2)

Recorded 2026-10-11T04:18:41.337Z by `node scripts/bench-analysis.mjs`. 20 measured runs after one warm-up, each with a cold fact cache, so every file is parsed every time.

## Environment

- **os:** Windows_NT 10.0.26200 x64
- **cpu:** Intel(R) Core(TM) i5-10400 CPU @ 2.90GHz
- **cpuCount:** 12
- **memoryGiB:** 15.9
- **node:** v24.15.0
- **git:** 2.55.0.windows.3
- **parserWorkers:** 2

## Fixture (synthetic "medium", deterministic)

- 3,142 files, 3,130 parsed, 30,000 import statements, 29,584 edges
- Artifact: 1895 KiB compressed (medium budget 5 MiB)

## Result

| Measure | Value | Budget |
|---|---:|---:|
| p50 | 6.51 s | |
| p95 | 6.81 s | ≤ 15 s |
| max | 6.91 s | |
| artifact | 1.85 MiB | ≤ 5 MiB |

**Pass.** Time: pass; artifact size: pass. Times cover the whole HEAD pipeline after acquisition (local objects) and include artifact packing, but not writing to disk. Format: atlas.artifact/1.3.0; indexed graph transport per ADR-018.
