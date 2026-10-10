# Phase 0 rendering spike (P0.4)

Recorded 2026-10-10T10:06:51.711Z by `pnpm spike:render`. Synthetic city; 20 runs × 60 orbit frames per scenario after warm-up.

## Environment

- **os:** Windows_NT 10.0.26200 x64
- **cpu:** Intel(R) Core(TM) i5-10400 CPU @ 2.90GHz
- **cpuCount:** 12
- **memoryGiB:** 15.9
- **node:** v24.15.0
- **browser:** chromium 156.0.8078.4
- **headless:** true
- **viewport:** 1920x1080
- **deviceScaleFactor:** 1
- **renderer:** ANGLE (NVIDIA, NVIDIA GeForce GT 730 (0x00001287) Direct3D11 vs_5_0 ps_5_0, D3D11)

## Continuous camera movement

| Scenario | Files | Districts | Layout ms | Draw calls | Triangles | Frame p50 ms | Frame p95 ms | JS heap MiB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| orbit-3000 | 3000 | 235 | 91.6 | 2 | 38820 | 16.7 | 17.9 | 12.9 |
| orbit-10000 | 10000 | 765 | 261 | 2 | 129180 | 16.7 | 17.8 | 22.3 |
| orbit-20000 | 20000 | 1538 | 515.4 | 2 | 258456 | 16.6 | 17.8 | 29.1 |

## Picking and fallback

- Top-down pick correctness: **271/271** sampled buildings returned their own lineage ID.
- WebGL unavailable → HTML fallback shown: **true**
- Context loss (WEBGL_lose_context) → HTML fallback shown: **true**

## Interpretation

These are spike measurements, not release benchmarks. Section 15 budgets are validated on the
recorded reference device in P3.6/P6.2. If `renderer` names SwiftShader or another software
rasterizer, frame times reflect CPU rendering and are a pessimistic bound.
