# ADR-107: Radix menus and tooltips, Kenney cars, trees, baked ground and roofs, a real nft check

Date: 2026-11-21. Status: accepted for the viewer and the production rehearsal.

## Evidence and cause

After ADR-106 the owner asked for three follow-ups in one change, at high quality and
without breaking anything:

1. **UI.** Icon buttons used the browser's `title` tooltip (slow, unstyled, absent on touch
   and keyboard focus), and the five city menus (Scope, Saved views, Notes, Bands, Share)
   were hand-built `<details>` panels that needed the ADR-106 placement code to stay inside
   the city card. Reviewing them found two further faults introduced with ADR-106's
   dropdowns: with a list open, Escape also cleared the selection (Explorer's shortcut ran
   after Radix handled the key) or left the workspace while the list stayed open (City's
   capture-phase shortcut stopped the event first), and the F, `[` and `]` shortcuts
   swallowed type-ahead letters meant for the list.
2. **3D.** City cars were two boxes. Ground paving, street asphalt and roof tiles were
   procedural patterns.
3. **Rehearsal.** The production rehearsal's "nft validates current GitHub ranges" step ran
   `docker run` without `-i`, so `nft --check --file -` read an empty input and passed
   whatever the rules said (every other piped container call in the scripts uses `-i`).
4. **Trees** (asked for during the change, with half as many if that bought quality).
   Crowns were smooth clusters of balls, conifers three plain cones, every tree of a kind
   faced the same way, and the species tint multiplied the whole tree, so trunks drew
   almost black-green.

## Decision

### UI

- **Tooltips** (`Tip`, `@radix-ui/react-tooltip` 1.4.1, MIT): the nine city view and camera
  buttons and the top bar's toggles show a small inverted tip with the shortcut as a key
  chip, on hover and on keyboard focus, in place of `title`. Each control keeps its own
  accessible name. Where a label collapses to an icon (narrow layouts), the tip appears only
  while the label is hidden (`onlyIfLabelHidden`).
- **City menus** (`CityMenu`, `@radix-ui/react-popover` 1.3.1, MIT) replace the `<details>`
  menus: a trigger button with the same look, label, count badge and turning chevron, and
  a panel that Radix places below it, flipping or sliding to stay inside the city card
  (the card is the collision boundary), capped to the room available and scrolling beyond
  that. One menu is open at a time; it stays open while the city is used around it, as
  before; the trigger or Escape closes it and focus returns to the trigger. Focus moves
  into the panel when it opens. ADR-106's `placeOpenMenus` is removed.
- **Keys** (`app/layers.ts`): while a dropdown list or a city menu is open, viewer shortcuts
  stand aside: keys typed inside it reach it, and Escape closes it alone. Explorer ignores
  an Escape that Radix has already handled.
- **Focus hand-back.** Radix returns focus to a closed layer's trigger a task later. As for
  ADR-106's dropdowns, a menu now takes focus back only if nothing else has it; otherwise
  switching straight from one menu to another pulled focus out of the new menu and its
  first Escape was lost.

### Cars

- `scripts/vehicle-models/convert.py` (Blender) rebuilds three models from Kenney's Car Kit
  3.1 (CC0): sedan, SUV and sports hatchback. Each face takes its palette colour snapped to
  the swatch, flat areas of one colour merge losslessly, the body is collapsed to 480
  triangles (220 tore fenders and bumpers), the 332-triangle wheels become 8-sided tyres
  with a pale hub, and the model turns to face +x (found from amber headlights and red tail
  lights) at 0.40–0.44 long, 0.19 wide, eased from the kit's toy stance. 640 triangles a car.
  The output is a generated module, `apps/web/src/city/vehicle-models.ts` (77 KB).
- The body (the saturated hue covering most area, with its gradient kept as a brightness
  factor) carries `atlasPaint`; `withPaintMask` patches three.js's own `color_vertex` chunk
  so instance paint tints only the body, never glass, lights, trim or tyres.
- Parked and moving cars split across the three models (about 50/30/20, by list position,
  so a city always draws the same): four more draw calls in Modern. The Vue demo draws 981
  cars, about 0.63 M triangles plus 0.51 M in the shadow pass; the caps (2,400 parked, 480
  moving) are unchanged. Moving cars' contact shadow shrinks to the car's footprint.

### Trees

- **Half as many.** At the owner's request, `cityDecor` keeps about half of the planting
  places (`TREE_KEEP`). The choice is a hash of the place, taken after the place's random
  numbers are drawn, so lamps, ponds, paths and every other decoration stay exactly where
  they were, and each remaining tree keeps its place, kind, size and tint. In all three
  styles of the test city this was checked against the previous code: every other list
  was identical and 49–50 % of the trees remained.
- **The 8,000 cap counts places, not trees.** Final review found that the first version
  checked the cap against kept trees. Below the cap that changes nothing, which is why the
  demo comparison passed. In a city with about 16,000 planting places, though, it let
  8,000 finer trees through (main drew 8,000 coarser ones), and its extra random draws
  shifted every later decoration. The cap now counts planting places, as main's did when
  every place became a tree. On that 1,000-package city, compared with main in all three
  styles:
  - every other decoration list is identical;
  - every kept tree is one of main's;
  - 3,979, 3,979 and 4,054 trees remain where main drew 8,000.

  The `tree cap` test in `city-architecture.test.ts` fails on the first version (8,000
  trees) and passes now.
- **No copies.** Each tree turns about the vertical and stretches 0.88–1.12 in height by its
  place, so trees of one kind no longer stand as identical copies facing one way. The wind
  is carried into each tree's own frame, so it still blows one way across the city.
- **Broadleaf trees** (round, plane, oak, cherry): a trunk forks into three to five limbs,
  each ending in a leaf mass, with a leader into a larger top mass. Crowns are lobed and
  show wood between the masses.
  - The trunk is one swept tube flared at the foot; separate cylinders opened pale gaps at
    bends.
  - Masses are pushed in and out by seeded noise and carry leaf clumps.
  - Normals blend each mass's own surface with the crown's round.
  - Vertex colours darken the underside and the folds between masses, warm the sunlit top
    and cool the shade.
- **The other kinds:**
  - the pine holds flat cloud pads on near-level limbs from a bowed trunk;
  - the cypress is three stacked, lumpy columns;
  - the conifer is six jagged, drooping tiers, darker below;
  - the willow is a dome over a curtain of strands with a ragged hem.
- **Colour and light.** Foliage carries `atlasPaint`, and `foliageMaterial` takes
  `withPaintMask`: the species tint colours leaves only and bark stays brown. `foliageMaterial`
  also wraps Lambert light by 0.35, changing one guarded line of three.js's own
  `lights_lambert_pars_fragment`, so light passes a crown's terminator softly.
- **Cost.** Triangles per tree, before → after:

  | Kind | Before | After |
  |---|---|---|
  | round | 264 | 472 |
  | plane | 344 | 580 |
  | oak | 392 | 668 |
  | cherry (blossom) | 344 | 560 |
  | willow | 164 | 428 |
  | conifer | 72 | 228 |
  | pine | 132 | 312 |
  | cypress | 104 | 316 |

  In the Vue demo, per city style:

  | Style | Trees | Tree triangles |
  |---|---|---|
  | Modern | 1,364 → 692 | 327,296 → 304,148 |
  | Western | 1,364 → 692 | 331,744 → 325,592 |
  | Eastern | 1,290 → 658 | 286,952 → 286,376 |

  Every style costs no more than before. Trees cast shadows, so the shadow pass shrinks by
  the same amount. Draw calls are unchanged (36, 43 and 44).

### Ground and roofs

- `bake.py --set surfaces` bakes five CC0 ambientCG materials in Blender as ADR-103 does the
  walls (`surface-detail.jpg`, 512 × 2560, 4:4:4, 389 KiB): PavingStones136 (modern
  concrete slabs), PavingStones128 (eastern flagstones), PavingStones070 (western cobbles),
  Asphalt023S and RoofingTiles013A. Brightness averages exactly 1, so far views keep the
  palette.
- `withPaving` (plazas by city style, streets), `withCover` (island asphalt) and `withTiles`
  (source roofs) sample them once per pixel and tilt the shading normal by the baked
  relief, replacing only the procedural fine detail. Broad weathering stays. Until the
  image loads, or if it never does, each draws exactly its previous pattern.
- **Scale.** Ground textures tile at the city's stylised scale (modern slabs 0.5 world
  units, cobbles about 0.15), as the procedural patterns did, not at true scale: captured
  at true scale, the pavers averaged to flat beige at the distances the city is seen from
  and the result looked worse than the procedural pattern. Roof tiles follow the roofs'
  own courses and ridges.
- The first modern choice (PavingStones126A) read as streaky planks; it was replaced.

### Rehearsal

- The nft step passes `-i`, and a negative control feeds it a batch with an invalid set
  element and requires `nft --check` to reject it, so the check can never again pass
  vacuously. Production refresh code already runs `nft` directly and is unchanged.

## Verification

Final local run on 2026-11-28 (Windows, Node 24.22.1, oracle Python 3.14), on the final code:

- `pnpm verify` with `ATLAS_REQUIRE_BROWSER_TESTS=1`: exit 0. 100 files passed and 6
  skipped; 1,136 tests passed and 95 skipped (service-gated).
- Viewer journeys (`CI=1`): 64 of 64 pass in each of Chromium, Firefox and WebKit.
- `build-demo-site` and `check-demo-site`: no problems.
- `pnpm verify:distribution` passed all 26 stages. It rewrote the recorded distribution
  evidence; those files were restored, not committed.
- GPU capture (GT 730, ANGLE D3D11, 1600 × 1000) of all three styles:
  - no page or console errors;
  - `surface-detail` loads (HTTP 200);
  - every style holds the 16.7 ms frame cap;
  - draw calls (shadow calls) are 36 (61) modern, 44 (78) western and 43 (74) eastern.

Two failures were found on the way and fixed:

- **Firefox, "validates picked files locally and sends nothing anywhere":** `expected [...]
  to deeply equal []`. The extra request was `GET /assets/surface-detail-<hash>.jpg`.
  - *Cause.* The test allows only the viewer's own bundled files, and the new texture was
    missing from its list. Firefox runs the full scene, which loads the texture; Chromium in
    CI mode runs the lite scene, which never fetches it.
  - *Fix.* The allow-list names `surface-detail` beside `facade-walls` and `facade-rooms`
    (the ADR-103 precedent). It is still a same-origin GET of a bundled asset.
  - *Retest.* 64 of 64 in Firefox.
- **Tree cap counting kept trees** (see Trees): the new `tree cap` test fails on the first
  version (8,000 trees) and passes on the fix.
