# ADR-027: Frames in the viewer and the history interface

Date: 2026-10-10. Status: accepted for Phase 4. Amends ADR-023 (worker ownership).

## Data flow

- **Opening.** The loader worker opens the artifact lazily: manifest, history and layout first, then the selected graph (plan §11.7). It keeps the opened artifact in a `FrameStore` that pins the selected frame and holds an LRU of two other decoded frames, or one when the selected graph has more than 60,000 edges and observations.
- **Queries.** Every query names its frame: search, reach, overlay, frame preparation and A/B comparison. A response can never be applied to a snapshot other than the one it was computed for.
- **Ownership.** The retained worker belongs to the dataset session (`ViewerDataset`), not to a query client. A client wraps it and disposing the client leaves it alive, so a development StrictMode remount keeps history available. The app terminates it when the dataset is replaced or the app unmounts. A request past its deadline still terminates the worker (stall containment).
- **Main thread.** `ViewerModel` is one frame. The provider keeps the selected frame plus two others, never evicting the active frame or a compare pair. Frame changes use a ticket, so the latest request wins. The next older snapshot is prefetched when idle.

## Behaviour

- **Fixed plots.** The 3D renderer is created once per layout ID with instance capacity for every union plot. `setCity` rewrites heights, presence, colours and the pick index in place, so the camera, GPU context and orientation survive a snapshot change. The 2D map resets its view only for a new layout.
- **Selection across frames.** Files are matched by lineage. Folders and packages are matched by path, so a directory that became a package continues. Perimeter nodes are matched by name, and tree expansion is carried over through these counterparts. An absent file becomes a *tombstone*: the inspector shows its last and next appearance, its history and links, never a substitute. An absent folder clears the selection with an announcement.
- **Strip.** Analyzed snapshots are evenly spaced 44 px targets, with the window commits that were not sampled shown as ticks in each gap. Arrow keys, Home and End move from the focused snapshot, with roving focus, and selection follows focus. The window, sampling, mainline semantics and plot anchoring are explained next to it. Stepping is opt-in and absent under reduced motion. Nothing autoplays.
- **Compare.** A→B uses explicit selectors with swap. The city shows B, with outlined ghosts for deleted plots (at A's height) and raised diamonds for added files; the legend explains both, and shape never relies on colour alone. The panel lists additions, deletions, renames and moves, content changes, raw metric deltas with unavailable sides named, projected dependency changes, and, separately, the mainline commits in the interval.
- **Lenses.** Changed commits (up to the snapshot shown) and Hotspot score, or Structure attention when usable history is absent. The two are never relabelled as each other. The inspector shows raw factors, percentiles, weights, cohort size and the HEAD-baseline note.
- **Links.** `#v=1&frame=<snapshot>&file=<lineage>&tab=…` opens a historical frame. An unknown frame is rejected with the existing invalid-link message.

## Measurements

These were recorded on the development machine with SwiftShader; see `docs/benchmarks/phase4-history-viewer.md`.

| Measure | Result |
|---|---|
| Cached snapshot change | 135.5 ms p95 across 20 samples (budget 250 ms) |
| Retained main + owned worker heap across four full sweeps | 208.71 → 208.58 → 208.60 → 208.38 MiB |
| Two non-HEAD snapshots compared | 226.41 MiB retained main + owned worker (budget 300 MiB) |
| First visits | reported separately, not hidden |

Pre-collection combined JS allocations reached 657.34 MiB in the sweep measurements. Retained heap is not a peak-process memory guarantee. The raw report identifies dev.5, fixture commit, analysis identity and layout hash; no page errors occurred. Reference-device and human assistive-technology audits remain open.
