# ADR-103: Wall materials baked in Blender

Date: 2026-11-21. Status: accepted for the viewer.

## Evidence and cause

After ADR-102 the owner asked whether Blender, already used for architectural renders on
the development host, could make the city look much better without slowing the website.
Close views of the bundled Vue analysis (GT 730, full detail) showed that walls between
the windows were still drawn by the facade shader alone: brick as courses about five times
real size, ashlar as blocks the size of a storey, and render, precast concrete and metal as
flat colour. Nothing on a wall caught the light. Real-time games get this realism from
textures baked offline rather than from geometry, and Cycles renders far too slowly to run
in a browser (22 to 53 minutes a frame on this host), so Blender can only help as a build
tool.

## Decision

- **Build time only.** `scripts/facade-textures/bake.py` runs in Blender 5.3. For each wall
  material it builds one tile of wall at real size as displaced geometry (from CC0 Poly
  Haven height maps, stretched so the configured depth is the real relief: 15 mm brick
  joints, 25 mm stone joints), with a margin so occlusion wraps across the tile edge. It
  renders three orthographic passes: albedo, the shading normal (geometry plus a light
  touch of the normal map) and ambient occlusion. `pack.py` turns them into
  `apps/web/src/assets/facade-walls.jpg`. The viewer only loads that image; removing
  Blender changes nothing until the walls need baking again. `scripts/facade-textures/README.md`
  lists the sources and the steps.
- **Layers** follow the facade's material index: render (`beige_wall_001`, 3 m tile),
  brick (`red_bricks_04`, 2.5 m), precast concrete (`concrete_wall_003`, 3 m), metal
  cladding (`metal_plate_02`, 2 m) and ashlar (`sandstone_blocks_05`, 3 m). The viewer
  tiles each at real size against a storey of 0.3 world units (about 3 m), offset per
  building.
- **No hue is stored.** Red is brightness as a ratio (0.5 = unchanged): luminance times
  baked occlusion, high-passed to detail finer than a tenth of a tile, because broad stains
  would repeat visibly up a tower and the weathering map already varies tone at that scale.
  Each layer's mean is exactly 1, so mipmaps converge on the lens colour. Green and blue
  are the tangent-space normal, re-centred to average flat.
- **Format.** One 512 × 2560 RGB JPEG, quality 85, without chroma subsampling: 374 KiB.
  Measured on 2026-11-21 against the same atlas: PNG 1.9 MiB, lossless WebP 1.7 MiB, lossy
  WebP q90 246 KiB but always 4:2:0, which bled brightness into the normals (99th-percentile
  error 26/255 against 17/255), and 4:4:4 AVIF 273 KiB at 14/255, which older Safari cannot
  decode. In graphics memory the array texture with mipmaps is about 6.7 MiB.
- **Viewer.** `walls.ts` fetches and decodes the image off-screen without colour
  management into a `DataArrayTexture`. Until it arrives, or if it never does, the facade
  draws exactly its previous patterns (`atlasWallsReady` 0). The facade shader samples it
  once per wall pixel with explicit gradients, inside the existing distance fade. Real-size
  brick and ashlar replace the drawn courses; render, precast and metal keep their panel
  lines and gain the grain. The baked normal tilts the Lambert shading normal in the
  screen-space tangent frame (as three.js normal maps do), so sunlight rakes every joint.
  Glass, balustrades, slabs, lobby glazing and doors stay smooth. The lite renderer
  compiles all of it out.
- **Balconies.** Alternate bays of about half the punched-window buildings (patterns 0 and
  3) gain a pale slab, its shadow and a frosted balustrade across the window, in the same
  brightness-only terms as ADR-102's glazing.

## Verification

- `pnpm verify` with required browser tests on Windows, 2026-11-21, on this change: 99 test
  files passed, 6 skipped; 1126 tests passed, 95 skipped.
- `apps/web/test/city-walls.test.ts` (4 tests): the shipped image has one square tile per
  material, 4:4:4 sampling and fewer than 450 KiB; the placeholder is flat; rows flip per
  layer so v runs up the wall; loaded walls swap only into a detailed facade, and the
  program cache key differs with walls. `city-architecture.test.ts`: 32 tests pass.
- GT 730 captures of the Vue city at 1192 × 648, with the texture and with its request
  blocked (the fallback), Modern, Western and Eastern: the shader compiles under ANGLE
  (Direct3D 11) with no page or console errors; draw calls are unchanged (36, 44, 43);
  frame time is the 16.7 ms median vsync cap either way. Western stone towers show coursed
  ashlar with lit and shaded joints; Modern's curtain walls are, as intended, almost
  unchanged, and render at this distance shows little grain.
- GPU time per megapixel was not measured. The A/B comparison is held until the owner asks
  for it (a longer comparison was stopped for low memory during ADR-102), so the per-pixel
  cost of this change is unmeasured beyond frames staying at the cap.
- CI's software renderer runs the lite scene, so CI never compiles the textured path; the
  GT 730 captures above are its only compile evidence.
