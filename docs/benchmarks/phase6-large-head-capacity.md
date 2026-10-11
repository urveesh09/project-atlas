# HEAD analysis capacity — large (plan §15.2)

Recorded 2026-10-11T04:28:39.848Z by `node scripts/bench-analysis.mjs`. 20 measured runs after one warm-up, each with a cold fact cache, so every file is parsed every time.

## Environment

- **os:** Windows_NT 10.0.26200 x64
- **cpu:** Intel(R) Core(TM) i5-10400 CPU @ 2.90GHz
- **cpuCount:** 12
- **memoryGiB:** 15.9
- **node:** v24.15.0
- **git:** 2.55.0.windows.3
- **parserWorkers:** 2

## Fixture (synthetic "large", deterministic)

- 9,992 files, 9,980 parsed, 98,500 import statements, 97,734 edges
- Artifact: 6212 KiB compressed (budget 20 MiB)

## Result

| Measure | Value | Budget |
|---|---:|---:|
| p50 | 20.28 s | |
| p95 | 20.59 s | ≤ 60 s |
| max | 20.67 s | |
| artifact | 6.07 MiB | ≤ 20 MiB |

**Pass.** Time: pass; artifact size: pass. Times cover the whole HEAD pipeline after acquisition (local objects) and include artifact packing, but not writing to disk. Format: atlas.artifact/1.3.0; indexed graph transport per ADR-018.
