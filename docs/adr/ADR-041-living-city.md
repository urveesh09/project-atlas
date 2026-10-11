# ADR-041: Perspective-only living city

Date: 2026-10-11. Status: accepted. Supersedes decision 1 of
[ADR-040](ADR-040-cinematic-camera-and-atmosphere.md), which offered two camera modes.
Extends [ADR-039](ADR-039-city-styles.md). Changes no contract, artifact byte, URL fragment
or version.

## Evidence and cause

The owner did not want the isometric mode and asked for the city to be "as realistic as
possible":
- smoother sea waves;
- Eastern palaces and pavilions, not just pagodas;
- Western forts and mansions;
- trees that do not look fake.

They also asked that the frame rate not drop.

The first wave shader used pure sine swells. At grazing angles its Fresnel reflection turned
them into regular stripes across the sea. Close-ups showed that lit windows sparkled per
pixel. The window hash multiplied interpolated per-instance values by 43,758, so their last
bits picked "lit" at random per pixel.

## Decision

1. **Perspective only.** The isometric camera and its code paths are removed. The city note
   says perspective makes nearer buildings look larger, and points to the 2D map and file
   table for exact comparison.
2. **A living sea.**
   - Normals come from five octaves of drifting gradient noise, each faded before it would
     alias, plus a faint swell.
   - The surface has Fresnel sky reflection, a sun glint and turquoise shallows that deepen
     offshore, with foam lapping the beach line.
   - Distant water skips octaves it cannot show, and the hash uses no `sin`.
   - Eastern lotus ponds reuse the shader, calm and without foam.
3. **Ambient motion.** Waves, drifting clouds (billboards in a ring beyond the camera's reach)
   and swaying foliage share one clock.
   - It runs only on a hardware GPU, outside low detail and reduced motion.
   - Frames come at 24 per second while the view is idle; camera motion redraws at the
     display rate.
   - It pauses while hidden, scrolled away or measured, and for 1.5 s after typing or
     clicking elsewhere on the page.
   - Frozen at time zero everything still renders, which is what CI's software renderer
     shows.
4. **Diversity, still meaningless.**
   - Eastern adds palace halls on three-tier marble terraces with balustrades, tiered halls,
     octagonal pavilion halls, colonnaded ground storeys and arcaded gate towers. The source
     role roof becomes a curved pavilion roof with upturned corners and a finial; it is still
     the legend's pointed four-sided roof, with the pyramid's footprint and height.
   - Western adds fortresses (battered base, four turrets, battlements), manors (chimneys,
     shuttered windows, a front door), chapels with pinnacles, and arcades and doors at street
     level.
   - Modern adds glass lobbies and rooftop plant.
   - Packages with town walls gain a paifang or a gatehouse in the south wall. Eastern header
     strips may become lotus ponds with arched bridges.
   - Facades and accents keep the lens colour rules of ADR-039. Stone, metal and gates are
     fixed colours, never facades.
5. **Trees.** Canopies are clusters of rounded blobs whose normals bend towards the canopy
   centre, so light wraps them. Vertex colours shade the underside and speckle the leaves.
   The species are plane, round, oak, conifer, pine, blossom, willow and cypress.
6. **Fixes found on the way.**
   - Window hash inputs are quantised.
   - A selection's overlay no longer re-renders the shadow map unless the visible harbour
     depots change.
   - The search box cancels its deferred close when refocused. A stale close used to hide
     the results list under new typing.

7. **Software renderers get low detail.** CI run
   [38160443032](https://github.com/urveesh09/project-atlas/actions/runs/38160443032) failed
   on `verify (windows-latest)`, while its other seven jobs passed. Three tests failed:
   - Harbor's main-pass draw calls reached 30 against the e2e bound of under 30.
   - A history e2e test timed out.
   - An analyzer test running in parallel reported `partial` coverage.

   CI renders with SwiftShader on the CPU. The full scene starved the parallel tests and
   tipped the draw-call bound. The changes:
   - A software renderer (SwiftShader, llvmpipe, Microsoft Basic) now gets the low-detail
     scene: no shadows, trees, clouds, waves or facade patterns. Users without a GPU benefit
     the same way.
   - Lawns and road markings are folded into the single ground mesh on every machine, saving
     two draw calls.
   - No test bound changed.

8. **Selection never steals focus back.** CI run
   [38161310296](https://github.com/urveesh09/project-atlas/actions/runs/38161310296)
   failed `verify (ubuntu-latest)`. The search selection did not reach the inspector, and
   the history test stopped at snapshot 9 after 3 of 7 ArrowLeft presses. The timeline moves
   focus synchronously, so a slow machine would still reach snapshot 5. Stopping at 9 means
   focus left mid-sequence.

   The cause is old code: selecting with `focusInspector` focused the inspector heading on
   the next animation frame. When frames are late (a heavier scene, software rendering,
   load), that callback can land after the viewer, or a test, has focused something else.
   It then takes focus back and swallows the following keys. The same race explains the
   earlier local failures during `pnpm verify`.

   The deferred focus now applies only if focus has not moved since the selection.

## Verification

- GPU timer queries on Vite (2,842 files): the wave shader cost 2.5 ms per frame at first and
  about 1–1.5 ms after the octave skip and cheaper hash. Fantasy totals are 6.9–7.5 ms.
- Real Chromium on the development host, 120-frame camera orbits:
  - Vite: all ten orbits per style at the 16.7 ms refresh cap, both fresh and after 30 s of
    idle ambient motion.
  - 10,000-file city: all at the cap.
  - Draw calls: 21–42.
  - Snapshot change: p95 ≤ 46 ms.
  - Search-to-inspector selection: p95 37–38 ms in every style (budget 100 ms).
  - Ten forced-growth frame-swap cycles per style keep GPU resources constant.
- `apps/web/test/city-architecture.test.ts`, 33 tests:
  - corner parts stay within 0.7 of a plot centre;
  - terraces, gates, ponds, bridges and lotus never touch a plot;
  - a wall-ringed package has 5 segments and a gate;
  - the pavilion roof keeps the pyramid's footprint and height.
- Viewer e2e: see the implementation status. Three tests had failed, only ever in a run during
  or straight after `pnpm verify`: the selection did not reach the inspector within the
  1-second poll. After the selection-shadow and ambient-yield fixes, the same sequence
  passed. No assertion or timeout was changed.
- After decision 7:
  - SwiftShader is detected as low detail and draws 23 calls on Vue; the development GPU
    draws 29 with full detail and animation.
  - `CI=1 pnpm verify` (SwiftShader, as on CI): 627 tests passed.
  - The GPU e2e suite: 27 passed, including draw calls under 30 on Harbor.
