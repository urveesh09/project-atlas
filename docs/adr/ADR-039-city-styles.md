# ADR-039: Selectable decorative city styles

Date: 2026-10-11. Status: accepted. Extends [ADR-038](ADR-038-decorative-city-architecture.md);
changes no contract, artifact byte, URL fragment or version.

## Evidence and cause

After ADR-038 the owner still found the city "very basic blocks". They asked for cities like
modern ones, eastern-fantasy (Chinese xianxia) pavilions and palaces, and western-fantasy
buildings, without hindering the app's purpose.

The risk is meaning. Ornate roofs and eaves cover much of what an isometric camera sees, so a
fixed-colour roof could hide the lens colour that carries a metric. A tall pagoda drawn by
stretching one model would distort storeys. Walls and street furniture could also land on
plots.

## Decision

1. **Three styles, one grammar.** The viewer offers *Modern city*, *Eastern fantasy* and
   *Western fantasy* (`apps/web/src/city/themes.ts`).
   - Modern: towers, slabs, setbacks, rotundas, a banded glass tower; curtain-wall, ribbon
     and punched windows; streetlights and a dashed ring-road line.
   - Eastern: square and octagonal pagodas, palace halls on marble platforms, tower
     pavilions and gate towers; flared eaves with upturned corners on every storey; lattice
     screens between timber pillars. Vermilion walls with gold caps and corner pavilions
     around each package; stone lanterns, pines and cherry blossom; lacquered harbour halls.
   - Western: keeps and round towers with battlements, jettied half-timber houses, wizard
     towers with balconies, chapels and guild halls; arched, slit and timber facades.
     Crenellated stone walls with corner towers around each package; iron lamps, oaks and
     cypresses.
2. **Meaning stays put.**
   - Every body still tops out at code-line height and stays inside its 1×1 plot.
   - The facade carries exactly the lens colour; patterns are tints of it that fade before
     they alias.
   - Eaves, bands and battlements take a fixed darker shade of the *same* lens colour, so a
     whole building reads as one metric hue from any zoom.
   - Role roofs keep their silhouettes and are fitted to each archetype's top.
   - Picking, selection outlines, markers, × marks, compare ghosts and arcs are unchanged.
   - Only stone platforms, walls, lamps and trees use fixed colours. They are ground
     furniture, never facades.
3. **Storeys grow with code.** Accent parts are fixed in world size and repeat at a storey
   spacing from the ground. A larger file gets more pagoda storeys or balcony rings, never
   stretched ones. Each building has at most 14 storey parts. Low detail keeps only base and
   top parts.
4. **Free space only.** Walls sit on each package's outer border cell, and lamps on header
   strips and the ring road's outer edge. Neither is assigned to plots by the packer (plan
   §11.4).
5. **A viewer preference.** The style is chosen in the city toolbar and kept in browser
   storage. If storage is blocked, the choice lasts for the page; the default is Modern. It
   never enters the URL fragment, artifacts or hosted state. PNG metadata records it as
   `cityStyle`, and the city note says styles carry no data. Switching style or detail
   rebuilds the renderer but keeps the camera.
6. **Budgets.**
   - Each part kind and outline is one growable instanced batch with a shared material.
   - Eave subdivision is the least that shows the upturned corners: 3, 2 and 0 extra steps
     for 4, 8 and 12 sides.
   - With the original 4 steps everywhere, the 10,000-file Eastern city drew about 1.8 M
     triangles in its largest batches and showed 33–66 ms windows. The reduction removed
     them (below).

## Verification

- `apps/web/test/city-architecture.test.ts` (6 checks × 3 styles). Per style:
  - style is independent of height, metrics and colour;
  - low roles stay on low forms;
  - bodies stay inside the plot with outward faces;
  - parts reach at most 0.7 of a cell from the plot centre at every storey;
  - decoration is deterministic and clear of every plot (trees 0.35, lamps, walls and
    towers 0.2–0.35 cells);
  - trees, lamps and towers are coloured meshes below 1.1 high.
- `pnpm verify` and `check-repository-baseline.mjs` pass (see implementation status).
- Real Chromium on the development host:
  - Vue (702 files): 26–38 draw calls in every style.
  - 10,000-file city in low detail: 18–24 draw calls, and every one of six 120-frame camera
    orbits per style at the 16.7 ms refresh cap (budget 50 ms).
  - Ten cycles of kiosk, all-maximum-height, half and full frames per fantasy style keep GPU
    geometry constant (23 and 25), with exact picking and no page errors.
  - The toolbar switch keeps the camera exactly, survives reload, and leaves the URL
    fragment empty.
