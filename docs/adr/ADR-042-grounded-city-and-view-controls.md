# ADR-042: Grounded city, view controls and a frame guard

Date: 2026-10-12. Status: accepted. Extends [ADR-041](ADR-041-living-city.md). Changes no
contract, artifact byte, URL fragment or version.

## Evidence and cause

The owner asked for the city to come closer to realism and for a better city experience on
their own hardware (Intel i5-10400, 16 GB RAM, NVIDIA GT 730), without the frame rate
dropping. A review of the living city found:
- buildings looked pasted on the ground: nothing darkened where walls meet the street or
  between tall blocks;
- paved surfaces were flat colour, and glass looked painted;
- package labels overlapped in dense views, and the first 20 packages were always the ones
  named;
- the stage was small, the camera had no way back to a previous view, and the selected
  file's place in the tree was visible only in the inspector.

Baseline on the GT 730 (commit `f36b218`, stage 48vh = 518 px, 1192 px wide), GPU time per
frame by timer query, default and close views:

| City | Style | Default | Close |
|---|---|---|---|
| Vite | Modern | 6.5 ms | 9.6 ms |
| Vite | Eastern | 8.1 ms | 10.4 ms |
| Vite | Western | 8.2 ms | 11.3 ms |
| 10,000 files | Modern | 4.2 ms | 5.4 ms |

All 120-frame orbits were at the 16.7 ms refresh cap.

Measurements on the way changed the design:
1. The first sky-occlusion field was a 2,364 x 3,072 single-channel texture without mipmaps.
   Wide views read it scattered across memory: 5 ms of a 20 ms frame. Mipmaps cut it to
   0.4 ms.
2. District surfaces are nested boxes, so a deep district's pixel was shaded up to eight
   times. With paving that cost 2.8 ms.
3. The previous commit at a 62vh stage already missed frames on Vite (GPU 12.0 ms Modern,
   15.7 ms Western; orbit p95 33 and 66 ms). The taller stage, not the new effects, was the
   cost. At the old 518 px stage the new build measured 5.8 ms default and 9.4 ms close,
   below the baseline.
4. **The orbit measurement rendered twice per sample.** `measureFrames` rendered its sample,
   and the `change` event of `controls.update()` queued a second, ordinary frame: 121
   renders for 60 samples. Interactive orbiting renders once per frame. Every earlier orbit
   result, including the Phase 3 benchmark's, was measured this way, so those results
   overstate GPU load; they are kept as recorded.
5. Resizing a WebGL canvas stalls ANGLE on Windows. A per-frame dynamic resolution made
   orbits worse, not better.
6. In full screen (1920 x 1080), Vite's overview needed 21–22 ms of GPU. Level of detail
   counted CSS pixels, so trees and lamps switched on that a lower drawing-buffer ratio
   could not pay for.

## Decision

1. **Baked sky occlusion.** A worker bakes, per frame's buildings, how much open sky each
   ground texel sees past nearby buildings, trees and town walls (`occlusion.ts`).
   - Occlusion follows the subtended elevation, `1 - d / sqrt(d^2 + h^2)`. It is narrowed by
     the azimuth the occluder spans, which widens with height, tapered to zero at its reach
     (at most 4 units). Occluders multiply visibility.
   - The texture has texels of 0.14 units, up to 3,072 a side, stored in 16-bit fixed point
     and output as R8 with mipmaps.
   - Ground, district and facade shaders read it with one filtered fetch. Sky light is
     multiplied by the squared visibility and sun light by about half of it. Walls sample
     the ground just in front and fade up the storeys, reaching higher in dense blocks.
   - The previous field stays until a new bake lands. The bake falls back to the main thread
     if a worker cannot start. Low detail and software renderers skip it.
2. **Surface identity in the shader.** No textures or geometry are added.
   - District surfaces: Modern concrete slabs, Eastern staggered flagstones, Western cobbles,
     with per-slab tone. The street grid gets fine aggregate. Patterns fade before they
     would shimmer.
   - Pitched source roofs get tile courses and ridge seams.
   - Facade glass gets Fresnel reflection of the style's sky, or the street when facing
     down. Paper screens barely reflect, and lit windows glow instead.
3. **Cheaper drawing.**
   - Deeper districts draw first, each surface before its kerb.
   - The ground draws after districts and buildings, and the sea last.
   - Faded facade patterns are skipped by a uniform branch.
   - Window counts and seeds read face sizes through `flat` varyings. Interpolation had put
     one tower's face width on a rounding boundary, so windows speckled.
4. **Labels with priority.**
   - The hovered or singly selected building is always named, in a dark pill with a leader
     to its roof.
   - Package names follow: the selection's package first, then the largest on screen. A name
     is skipped where another label already stands, and distant names fade. At most 24 are
     drawn.
5. **Selection and navigation.**
   - A ring marks each selected building's base. It pulses gently only when ambient motion
     is allowed.
   - A selection card shows the folder trail (each step selects that folder), the file's
     role and code lines, and the lens value.
   - Previous and Next view return to settled camera views, up to 40 (`[` and `]`).
   - Whole city resets the view.
   - Expand puts the stage in full screen, or a fixed overlay where full screen is refused
     (`F`; Esc leaves it first and keeps the selection).
   - The repository tree can be hidden, remembered per viewer like the city style.
   - The stage grows from 48vh to 54vh, which keeps every measured orbit at the refresh cap.
6. **Frame guard and calibrated resolution.**
   - Every 15th frame's GPU time is read back with a timer query, never blocking.
   - On a resize, such as Expand, the pixel ratio is chosen so the predicted frame takes at
     most 11 ms.
   - While the camera moves, if the 75th-percentile interval over 60 frames exceeds 20 ms,
     the ratio drops in proportion to the lateness, at most once per 1.5 s, down to half.
     The pixel count found sustainable carries over to later resizes.
   - Level of detail counts rendered pixels, so a lowered ratio also sheds trees, lamps and
     roofs.
   - The ratio never changes per frame.
7. **One render per measured sample.** `measureFrames` cancels the frame that
   `controls.update()` queues, so a sample is exactly one render, as in interaction.

8. **Inspector focus lands in the rendering commit.** A `CI=1` e2e run (SwiftShader) failed
   J1 once. The inspector showed `pricing.ts`, but focus was still in the search box when
   the test checked. Focus moved one animation frame after the selection (ADR-041 decision
   8), and SwiftShader frames on the taller stage can arrive after the title renders. Focus
   now moves in a layout effect of the commit that renders the inspector heading. The guard
   stays: focus never moves if the viewer has moved it since the selection. A frame later,
   any request still pending is settled. No test changed.

Plan rules are unchanged:
- height is code lines;
- a facade wall is exactly its lens colour; occlusion changes only its brightness, and only
  glass reflects the sky;
- role roofs keep their shapes;
- decoration stays seeded and off plots;
- labels, rings, card and controls carry only data the inspector already shows.

## Verification

- GPU timer queries and 120-frame orbits on the GT 730 (one render per sample), stage 54vh
  = 583 px:

  | City | Style | Default | Close | Orbits at cap |
  |---|---|---|---|---|
  | Vite | Modern | 7.6 ms | 11.1 ms | 6 of 6 |
  | Vite | Eastern | 9.5 ms | 12.2 ms | 6 of 6 |
  | Vite | Western | 9.6 ms | 12.4 ms | 6 of 6 |
  | 10,000 files | Modern | 7.8 ms | 9.2 ms | 6 of 6 |
  | 10,000 files | Eastern | 8.9 ms | 11.8 ms | 6 of 6 |
  | 10,000 files | Western | 10.4 ms | 11.7 ms | 6 of 6 |

- Expanded to 1920 x 1080, five default and five close orbits per run:
  - Vite: all at the cap in every style, at calibrated ratios 0.59–0.69.
  - 10,000 files: all at the cap at full resolution.
- Before the calibration, the guard alone reached a sustainable ratio within two to three
  orbits. In the meantime some orbits had a p95 of 33–50 ms.
- Snapshot change on Vite: p95 48 ms (Modern) and 56 ms (Western); budget 250 ms.
- Search-to-inspector selection on Vue: p95 42–43 ms; budget 100 ms.
- Draw calls: 18–41.
- UI walkthrough on Vue in Chromium:
  - Focus selection, then Previous and Next view, return and restore the view.
  - The breadcrumb selects `packages/runtime-core/src/components`.
  - Expand enters full screen; Esc leaves it and keeps the selection.
  - Hide tree removes the sidebar.
- `apps/web/test/city-occlusion.test.ts`, 5 tests:
  - grid bounds and size cap;
  - open sky without occluders;
  - darkening at a building fades to open sky;
  - taller buildings and canyons are darker;
  - determinism, and empty or flat occluders are ignored.
- `pnpm verify`: 632 passed, 80 service-gated skips.
- Viewer e2e: 27 of 27 on the GPU and with `CI=1` (SwiftShader). Before decision 8 one
  `CI=1` run failed J1 as described; after it, two consecutive `CI=1` runs and a GPU run
  passed 27 of 27, and `pnpm verify` passed again (632).
- CI run 38215086074 failed `verify (windows-latest)` on attempt 1. The analyzer's
  `--no-history` test reported `partial`: a wall-clock parse deadline, while the SwiftShader
  e2e ran alongside it. Rerunning only that job passed. The failure is recorded in the
  implementation status; no code or test changed for it.
- Captures:
  - [labels](../images/city-ux-modern-labels.png);
  - [contact occlusion](../images/city-ux-contact-occlusion.png);
  - [Western cobbles](../images/city-ux-western-cobbles.png);
  - [Eastern flagstones](../images/city-ux-eastern-flagstones.png);
  - [selection card](../images/city-ux-selection-card.png);
  - [expanded city](../images/city-ux-expanded.png).
