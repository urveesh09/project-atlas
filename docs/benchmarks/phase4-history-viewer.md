# Phase 4 snapshot-change benchmark (Gate G4)

Recorded 2026-10-10T18:30:29.054Z by `node apps/web/scripts/bench-history-viewer.mjs` against the medium history artifact from `scripts/bench-history.mjs --keep` (12 frames, 3,252 files and 29,757 edges at the selected commit). Latency is measured in the page from the click on a snapshot to the drawn frame showing its buildings.

Environment: Windows_NT 10.0.26200 x64; Intel(R) Core(TM) i5-10400 CPU @ 2.90GHz; Chromium (Playwright) at 1920x1080; GPU ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver).

| Measure | p50 | p95 | max | Budget |
|---|---:|---:|---:|---:|
| Snapshot change, frame cached (20) | 132.9 ms | 135.5 ms | 137.8 ms | ≤ 250 ms p95 |
| Stepping back with 1.5 s per snapshot, idle prefetch (11) | 2912.9 ms | 4919.6 ms | 4919.6 ms | (reported) |
| Worst case: jump to unvisited snapshots, no pause — worker decode + validate (11) | 4093.5 ms | 11288.2 ms | 11288.2 ms | (reported) |

Combined main + owned worker retained JS heap after collection after each of four full sweeps over all snapshots: 208.71 MiB → 208.58 MiB → 208.6 MiB → 208.38 MiB (bounded LRU: the selected commit plus at most two other frames per realm). Draw calls after the sweeps: 6.

Pre-collection combined JS allocations: 525.63 MiB → 657.34 MiB → 315.59 MiB → 322.91 MiB. Not a startup/RSS peak guarantee. The decode-chain cache is request-scoped; the caller owns retained frames.
Comparison of two non-HEAD snapshots: 226.41 MiB retained main + owned worker (365.44 MiB before collection).
**Pass.** Page errors: 0. This machine is not the plan's reference integrated-GPU laptop; the reference-device repeat remains a release audit.
