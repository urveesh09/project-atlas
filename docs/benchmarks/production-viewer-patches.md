# M1.3: viewer and test-tool patch verification

Recorded 2026-10-16. These are development-host rendering-spike measurements, not
reference-device acceptance or a production-city FPS certification.

## Viewer runtime checkpoint

Run `pnpm spike:render` from clean commit `4f9ad6c`, with React/React DOM 19.3.1,
React Three Fiber 9.8.2, Playwright 1.64.0, Node 24.22.0. The retained
[raw report](production-viewer-runtime.json) records Windows 11 / i5-10400 / 16 GiB,
GT 730 through ANGLE D3D11, Chromium 156.0.8078.4, 1920×1080 and DPR 1.

Each size has a 30-frame warm-up followed by 20 batches of 60 frames, yielding
1,180 frame intervals per scenario under the existing harness.

| Buildings | Draw calls | Frame p50 | Frame p95 | Observed JS heap |
|---:|---:|---:|---:|---:|
| 3,000 | 2 | 16.6 ms | 17.9 ms | 9.3 MiB |
| 10,000 | 2 | 16.6 ms | 17.7 ms | 19.4 MiB |
| 20,000 | 2 | 16.7 ms | 17.8 ms | 26.1 MiB |

- 271/271 sampled roof picks return the correct lineage.
- WebGL unavailable and context-loss fallbacks both remain visible.
- No page errors occur in the scenarios or picking check.
- The historical Phase 0 reports remain unchanged.

These observations show the spike still performs and picks correctly on this
development GPU. Different commits, runtime versions, warm-up and host conditions
prevent treating differences from older reports as a controlled speed or memory
improvement. The complete production viewer is exercised separately by 39 browser
journeys in normal and software-renderer modes, including keyboard interaction,
reflow and accessibility checks.

## Final tooling checkpoint

Repeat `pnpm spike:render` from clean implementation commit `071aaab`, with Vitest
5.0.5, Playwright 1.64.1 and axe 4.14.0. Chromium installation is verified through
the new driver; the cached binary remains Chromium 156.0.8078.4. The same hardware,
viewport and 20 batches per size apply. See the [final raw report](production-test-tooling-render.json).

| Buildings | Draw calls | Frame p50 | Frame p95 | Observed JS heap |
|---:|---:|---:|---:|---:|
| 3,000 | 2 | 16.6 ms | 17.8 ms | 9.4 MiB |
| 10,000 | 2 | 16.6 ms | 17.8 ms | 19.4 MiB |
| 20,000 | 2 | 16.6 ms | 17.8 ms | 26.2 MiB |

All 271 picks are correct, both fallbacks work, and the recorded scenarios/picking
have no page errors. Final full verification passes 746 tests (81 service-gated
skips), with all 39 viewer journeys passing in both normal and software-renderer
modes using the updated axe audits. All six relocated offline CLI stages pass.
Both API/sandbox images build and smoke-test with the expected runtime packages.
The combined PR's hosted and cross-OS jobs remain required before handoff.

## Visual inspection boundary

The relocated offline CLI smoke passes all six stages with the new viewer runtime
and exact-tag license. Its dependency screen screenshot was inspected: the city,
selected file and dependency arrows align with the tree and inspector, and the
controls and evidence text remain readable. Temporary generated candidate files
were retained locally and restored rather than replacing release-candidate evidence.

The computer-use browser's local session bootstrap was rejected as a cross-site
request. Its tab and the task-owned viewer were closed. No request/header/security
policy was weakened; this attempt does not count as a manual interaction pass.
