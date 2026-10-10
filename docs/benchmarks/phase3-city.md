# Phase 3 production city acceptance measurements

Recorded 2026-10-10T14:53:00.907Z. Runs: 20; cold-route runs: 20. Fixtures are committed repositories passed through the real analyzer and artifact validator.
Complete: true; full acceptance invocation: true; measured local gates: pass. Manual/device gates below remain separate.

## Environment

- **os:** Windows_NT 10.0.26200 x64
- **cpu:** Intel(R) Core(TM) i5-10400 CPU @ 2.90GHz
- **logicalCpus:** 12
- **memoryGiB:** 15.9
- **node:** v24.15.0
- **viewport:** 1920x1080
- **dpr:** 1
- **parserWorkers:** 2
- **chromium:** 156.0.8078.4
- **gpu:** ANGLE (NVIDIA, NVIDIA GeForce GT 730 (0x00001287) Direct3D11 vs_5_0 ps_5_0, D3D11)

## Measurements

20k union layout p95: 25.25 ms (budget 2,000 ms).

Load total includes navigation, scripts, transport and validation. Post-chunks starts when the final required chunk has been read into the validating worker and includes remaining validation, index preparation, main-thread transfer and first 3D frame. The loader processes chunks sequentially, so earlier validation overlaps acquisition of later chunks. The plan's 3-second budget applies to post-chunks; the 8-second cold-route gate covers the entire route. Both are reported.

Search/selection use the browser's input/Enter clock through matching committed results and two animation-frame boundaries, excluding automation transport. Long tasks include all measured interaction/camera traces.

| Files | Edges | Load total p95 | Post-chunks p95 | Search p95 | Selection/overlay p95 | Camera frame p95 | Draw calls | Main + worker retained heap | Result |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 300 | 2932 | 700.77 ms | 256.7 ms | 32.5 ms | 63.3 ms | 16.8 ms | 9 | 15.28 MiB | Pass |
| 3000 | 30085 | 3002.12 ms | 974.8 ms | 36.1 ms | 64.8 ms | 16.8 ms | 9 | 73.48 MiB | Pass |
| 10000 | 99975 | 8809.33 ms | 2743.8 ms | 41 ms | 91.3 ms | 16.8 ms | 9 | 216.76 MiB | Pass |

Medium cold route (10 Mbps download/upload, 100 ms emulated latency, disabled HTTP cache, existing local session): p95 6730.27 ms, 20 runs, pass against 8,000 ms.

## Resource and accessibility evidence

- 300 files: artifact atlas.artifact/1.2.0, 189220 compressed / 3583737 decoded bytes. Main + worker heap before forced collection: 39.81 MiB; retained: 15.28 MiB. Focused close-up frame p95: 16.70 ms. Twenty map/3D replacement cycles: active geometries 7 → 5, textures 0, post-GC main heap growth 1.22 MiB; 0 automated AA violations. Long tasks across all measured interaction/camera traces: none ms.
- 3000 files: artifact atlas.artifact/1.2.0, 1930846 compressed / 36033436 decoded bytes. Main + worker heap before forced collection: 222.01 MiB; retained: 73.48 MiB. Focused close-up frame p95: 16.70 ms. Twenty map/3D replacement cycles: active geometries 7 → 5, textures 0, post-GC main heap growth 1.27 MiB; 0 automated AA violations. Long tasks across all measured interaction/camera traces: none ms.
- 10000 files: artifact atlas.artifact/1.2.0, 6158662 compressed / 115696572 decoded bytes. Main + worker heap before forced collection: 649.18 MiB; retained: 216.76 MiB. Focused close-up frame p95: 16.70 ms. Twenty map/3D replacement cycles: active geometries 7 → 5, textures 0, post-GC main heap growth 1.08 MiB; 0 automated AA violations. Long tasks across all measured interaction/camera traces: 52.0 ms.

Firefox 157.0: worker artifact import, search and inspector, table and map, reduced motion, automated AA; 0 automated violations.

Follow-up [CPU attribution report](phase3-interaction-profile.json): 20 fresh dense imports and interaction/camera traces, 0 observed long tasks. Profiling adds overhead and does not replace the unprofiled latency samples. Original task durations above remain recorded; an isolated unreproduced outlier does not establish its cause or certify another device. Review traces again on the reference device.

## Interpretation and remaining manual gates

- Recorded actual GPU is not asserted to be the plan's exact integrated-GPU reference device.
- Heap measurements include the main realm and the owned dedicated worker. Both pre-GC and retained post-GC heap are reported; the 300 MiB active-data gate uses retained heap. Native GPU memory and process RSS are outside JS heap.
- Automated AA and keyboard/touch checks do not replace a human screen-reader audit.

Detailed samples, immutable fixture commits, layout IDs and errors are in the adjacent JSON. Synthetic fixtures measure performance, not empirical language coverage. History/compare references are Phase 4.
