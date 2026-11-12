# ADR-101: Realism pass on the city's land, streets and surroundings

Date: 2026-11-12. Status: accepted for the viewer.

## Evidence and cause

The owner asked for a markedly more realistic city. Captures of the bundled Vue analysis
on the development host (GT 730, full detail, 902 × 432 stage) showed where the scene
read as a model rather than a place:

- **Empty ground.** Shelf packing leaves the ends of shelves and whole margins of the
  repository block free. On Vue that was most of the island: one flat, pale surface the
  same tone as the plazas.
- **Faceted scenery.** Hills were stretched icosahedra and mountains were cones, lit per
  facet, with one colour per height band.
- **No street life.** Streets had no vehicles, and their colour matched the paving beside
  them, so a street did not read as a street.
- **Blank towers at city range.** Windows fade out, correctly, where a window is smaller
  than a pixel. A tall tower was then a single flat colour from top to bottom.
- **Flat light.** Sky light was almost as strong as sunlight, so sunlit and shaded faces
  were close in value.
- **Untextured surfaces.** Grass, sand, asphalt and plazas were each one flat colour, and
  a wall was the same tone from corner to corner. The owner named this directly: the land
  looked basic. Real surfaces vary at every scale, and that variation is much of what
  separates a polished game from a flat one.

The data encodings were never the problem and are unchanged: height is code lines, the
facade keeps one lens hue, the roof shape is the file role, and plots are fixed.

## Decision

1. **Parkland on open ground.** `openLand` in `architecture.ts` rasterizes the repository
   block at one cell. Every depth-1 district and every plot that stands directly on the
   block keeps a paved street two cells wide. The remaining free land is cut into parcels
   of at most 11 × 11 cells, and each parcel of at least 3 × 3 becomes a lawn planted with
   the style's trees around a seeded clearing. The gaps between parcels read as paths.
   - `CityData.rootPlots` lists the plots on the repository block for every frame, so
     a park never occupies a plot that is empty in the snapshot on screen. It is a view
     field built from the layout artifact; no artifact or layout byte changes.
   - Park trees stop at 1,800 by widening their spacing, not by stopping part-way across.
2. **Parked vehicles (Modern).** Cars stand on the street cell outside each block's kerb,
   seeded, in nine paint colours, at most 2,400. A car is 20 triangles in one instanced
   batch. Both ends must be on paved street. The fantasy styles have none.
3. **Streets read as streets (Modern).** The street grid and the perimeter road are
   asphalt grey, with a pale kerb. Plazas keep their paving colours.
4. **Terrain.** Hills and mountains are height fields over an irregular footprint, with
   smooth normals. Ridged fractal noise carves spurs and gullies. Ground cover follows
   altitude and slope: woodland with meadow clearings, bare rock where steep, a pale
   shore, and snow on high ground flat enough to hold it. Karst towers are weathered
   columns with vegetation on the dome and ledges, standing on low wooded shoals.
   - The camera limit now follows the nearest land actually built, because footprints are
     irregular.
5. **Sky.** A faster falloff from the horizon, a deeper zenith, a warm band under the
   sun and a visible disc.
6. **Light.** Sky light 2.05 → 1.7 and cooler, sunlight 2.5 → 3.0 and warmer, shadow
   strength 0.62 → 0.70, at full detail only. Shaded faces keep their lens hue.
7. **Service floors.** Modern towers of five storeys or more darken one storey in four by
   17%. The band is four times the height of a window, so it stays visible about four
   times farther away. It changes brightness only.
8. **Surface detail.** One seeded, tiling 256 × 256 texture (`detailTexture` in
   `shading.ts`) holds fine grain, soft blotches and vertical streaks in its three
   channels. It is built in code, so nothing is downloaded, and it is mipmapped, so grain
   averages away with distance instead of shimmering. Surfaces sample it in world space at
   several scales:
   - grass: broad lush and dry patches, mottling, tufts and blade grain;
   - sand: ripples; asphalt: aggregate and the lighter and darker panels of old repairs,
     continuous between the street grid and the perimeter road;
   - plazas: broad staining over the existing paving joints;
   - walls: uneven tone and rain streaks, starting at a different place in the map for
     each building. This scales brightness only, within about ±15%, so the lens hue holds.
   - Glass also mirrors the sun: panes flare when the camera meets its reflection.
9. **Draw order.** Lawns, parks and road markings moved to their own mesh, drawn before
   the districts and the road they lie on, so the paving underneath fails the depth test
   instead of being shaded and covered. This costs one draw call.

Low detail (and so every software renderer) keeps the parks' lawns and the new terrain,
sky and street colours. It has no trees, vehicles, shadows, window patterns or surface
detail.

### Not done, and why

- **Imported models (Blender, glTF).** Buildings must stretch to any height and width
  while repeating storeys, take one data colour, and draw thousands of copies in a few
  calls. Authored meshes do none of these without a second pipeline, and they add
  download weight. The city stays procedural.
- **Post-processing** (bloom, screen-space occlusion, depth of field). Each is a
  full-screen pass. On the GT 730 the scene already uses 5 to 7 ms of GPU time at this
  stage, and [ADR-042](ADR-042-grounded-city-and-view-controls.md) measured 21 to 22 ms
  for a larger repository in full screen before level of detail steps in.

## Verification

- Geometry and placement tests (`apps/web/test/city-architecture.test.ts`):
  - parks keep at least 1.5 cells from every district and every plot, stay inside the
    repository block and are at least 2.5 cells wide;
  - vehicles are outside every district, clear of every plot and inside the block, and
    exist only in styles that define them;
  - the existing determinism, plot-clearance, scenery-distance and camera-limit tests
    still hold.
- GPU time on the GT 730, bundled Vue analysis, 902 × 432 stage (0.39 megapixels), five
  fixed cameras, a 150-frame orbit each, GPU timer queries. The renderer reports the
  highest recent sample, in ms per megapixel. Two to five runs per build:

  | Style | Before | After | Highest single reading after |
  |---|---|---|---|
  | Modern | 10.0 – 13.9 | 12.0 – 15.2 | 16.6 |
  | Eastern | 12.0 – 17.3 | 13.9 – 18.3 | 21.6 |
  | Western | 12.7 – 15.9 | 14.8 – 18.4 | 18.4 |

  - The "After" range is what repeated runs agreed on. Six readings were higher in one
    run and normal when repeated (16.6 to 21.6; the last column gives the highest per
    style). Their cause is not established; they are recorded, not discarded.
  - That is about 0.6 to 1 ms more per frame at this stage. Every orbit, before and
    after, held the 16.7 ms refresh interval at p50 and p95.
  - Surface detail accounts for about 0.4 ms per megapixel of it.
  - The first version cost 3 ms per megapixel more. Removing the parks alone returned it
    to the baseline, so the cost was sub-pixel triangles in trees and cars, not the new
    shaders. Wider tree spacing, a 20-triangle car, and drawing cars only from 5 rendered
    pixels per cell brought it to the figures above.
  - Steady draw calls: Modern 32 → 33 or 34 (34 when cars are in range), Western and
    Eastern 41 → 42. The master plan's budget is 150.
- Captures from the same cameras, before and after:
  [street before](../images/city-realism-before-street.png),
  [street after](../images/city-realism-modern-street.png),
  [island before](../images/city-realism-before-island.png),
  [island after](../images/city-realism-modern-island.png),
  [ground close up](../images/city-realism-modern-ground.png),
  [Western](../images/city-realism-western-island.png) and
  [Eastern](../images/city-realism-eastern-quarter.png).
