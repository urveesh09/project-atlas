# ADR-040: Cinematic perspective camera, shadows and atmosphere

Date: 2026-10-11. Status: accepted. Builds on [ADR-038](ADR-038-decorative-city-architecture.md)
and [ADR-039](ADR-039-city-styles.md); changes no contract, artifact byte, URL fragment or
version.

## Evidence and cause

The owner found the isometric city good but not enticing, and asked for "a fully 3D city with
a perspective camera, natural depth, orbiting, smooth zoom, and beautiful architectural views"
in every style, without hindering the app's purpose. The plan permits smooth, intentional
camera limits and flights. It requires reduced motion to disable them, decoration to stay
seeded and cheap, and the medium and large budgets to hold (plan §11.7, §12.5, §15).

## Decision

1. **Two camera modes.** A *Camera* control offers *Cinematic 3D*, the default, and
   *Isometric*. Like the city style, the choice is a per-viewer browser preference. It never
   enters URLs or artifacts, and switching keeps the camera within a mode. The city note says
   that perspective makes nearer buildings look larger, and recommends Isometric for exact
   height comparison.
2. **Cinematic camera.**
   - A 42° perspective lens with damped orbiting, zoom towards the cursor and panning along
     the ground.
   - Polar and distance limits keep the camera above the street and inside the scenery ring.
   - *Reset city* is a low three-quarter establishing shot with the horizon visible.
     *Focus selection* and double-click frame a building at a low, readable elevation.
   - *Reset*, *Focus*, *North* and double-click glide over 0.65 s. With
     `prefers-reduced-motion` they jump, and damping is off. Pointer input cancels a glide.
3. **Shadows.**
   - A single directional shadow map (hardware 2×2 PCF, 2048² or 4096² by island size) at
     0.62 intensity, so shade darkens the lens colour but never hides it.
   - It renders only when buildings change, never per camera move.
   - Probe `drawCalls` reports steady-state frames. The shadow update's extra calls are
     reported separately, and an ordinary frame follows.
   - The old translucent shadow quads are gone. Low detail has no shadows.
4. **Atmosphere (cinematic only).**
   - A gradient sky dome with a sun glow in the key light's direction, so shadows and sun
     agree.
   - An ocean to the horizon with a moving specular glint, and linear fog that leaves the
     island crisp and fades the distance into the sky.
   - Seeded scenery from 3.4 to 5 island extents out:
     - Modern: green headlands and a neighbouring skyline.
     - Eastern: karst pillars, some crowned with pagodas, floating islands and mist banks.
     - Western: snow-capped peaks, foothills and a hilltop castle.
   - None of it is pickable, and all of it lies beyond the island and its water ring.
   - Clip planes follow the camera distance to keep depth precision.
   - Evidence marks and overlays are never fogged.
5. **GPU budget work.** GPU timer queries on Vite (2,842 files) showed what dominated the
   fantasy styles: per-triangle vertices on tens of thousands of instanced eaves and parts,
   and 27,942 battlement merlons on hundreds of package walls. The changes:
   - Parts, trees, lamps and towers are indexed and flat-shaded per fragment.
   - Facades share vertices within each face.
   - Town walls go to the 48 largest packages, with at most about 5,000 merlons.

   Fantasy GPU time fell from 11.4–11.9 ms to 6.8–7.0 ms per frame on the development host.

## Verification

- Real Chromium on the development host, with each 120-frame camera orbit measured from a
  settled view. "Orbits at the cap" means every orbit's p95 frame time was the 16.7 ms
  refresh cap.
  - Vite (2,842 files) with shadows: all ten orbits per style at the cap. Before the GPU
    work, Eastern and Western had 33–83 ms windows.
  - 10,000-file city, low detail by default: all ten orbits per style at the cap.
  - Main-pass draw calls: 19–36 for Vue, Vite and the 10k city in every style (budgets 150
    and 250).
  - A snapshot change including the shadow update: p50 34 ms, p95 ≤ 50 ms (budget 250 ms).
  - Ten frame-swap cycles per style keep GPU geometry and textures constant.
- `viewer.e2e.test.ts` (27 tests, cinematic default) passes. The pick-after-focus test and
  the benchmark scripts now wait for the probe's `cameraMoving` to clear before reading
  screen positions or timing frames, because focus and reset glide; no assertion changed.
- `apps/web/test/city-architecture.test.ts`:
  - scenery is deterministic and lies beyond the island, belt, beach and water ring;
  - the camera's limit sits inside the scenery ring;
  - the sky is unfogged and drawn behind everything;
  - only the largest 48 packages get walls.
