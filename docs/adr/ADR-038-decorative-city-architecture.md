# ADR-038: Seeded decorative architecture for the 3D city

Date: 2026-10-11. Status: accepted. Works within plan §11.1, §11.5 and §11.7; changes no
contract, artifact byte or version.

## Evidence and cause

The owner asked for a more appealing city: every building was the same 0.88-cell box with
two window dots, set on flat beige slabs, so different quarters of a repository looked
alike. Captures of the real Vue corpus before the change showed uniform towers whose only
differences were height and facade colour.

The plan already fixes what may carry meaning: height is code lines, the facade colour is
exactly one lens metric, the roof silhouette is the file role, footprints never change with
size, and selection never relies on colour. It permits seeded rooftop variants and cheap,
seeded trees, lamps and shorelines that never obscure evidence.

## Decision

1. **Variety is seeded and meaningless.** `apps/web/src/city/architecture.ts` chooses, per
   building, one of eight archetypes (block, slab, setback, podium-octagon, rotunda, tapered,
   cornice, stepped), a footprint trim of 0.92–1.0 and a window pattern. The choice uses the
   versioned `xorshift32` from `@atlas/layout`, seeded by the plot seed. Each district picks a
   style family from its layout ID, so quarters read as neighbourhoods. Style never depends
   on height, metrics, lens or frame, so scrubbing history changes only height, colour and
   presence on fixed plots. Fixed-height kiosk and declaration roles use only the low forms.
   The city note and PNG metadata state that styles and greenery carry no data.
2. **Encodings are unchanged.** Every body still tops out at `0.35 + height`, stays inside
   its 1×1 plot, and takes the lens colour from instance colour. Tier shading only scales
   brightness. Windows are a darker tint of the same colour and fade out (by screen-space
   derivative) before they would alias, so far views show the exact lens colour. Role roofs
   are scaled to the archetype's top outline but keep their silhouettes. Pick boxes,
   selection outlines, markers, × marks, compare ghosts and dependency arcs are unchanged.
3. **Decoration only uses free space.** Lawns and trees sit in each district's 2-cell header
   strip, the 1-cell border of package districts and a green belt outside the perimeter
   road. These are areas the packer never assigns to plots. The ground is a diorama
   (perimeter road, grass, beach, water), and external terminals become harbour depots at
   their existing anchors. Contact shadows are translucent ground quads along the key light.
   Districts render as kerbed blocks that step up gently with depth.
4. **Budgets first.** Each archetype is one instanced batch sharing one material. Batches
   grow on demand and dispose their old buffers. Low-detail mode omits trees, shadows and
   the window shader. There are no textures, shadow maps or per-building objects.

## Verification

- `apps/web/test/city-architecture.test.ts`:
  - style is independent of height, metric and colour, and varies across a city;
  - low roles stay on low forms;
  - every archetype vertex lies inside the plot, with outward side faces and unit height;
  - greenery is deterministic and clears every plot by 0.35 cells.
- `pnpm verify`: 37 files, 608 tests passed, 80 service-gated skips.
  `check-repository-baseline.mjs`: exact for all three real repositories.
- Real Chromium on the development host:
  - Draw calls: 22–31 for Vue (702 files) including a selection overlay; 16–18 for the
    10,000-file city (budgets 150 and 250).
  - Camera-orbit frame p95: 16.7 ms in default and low detail, which is the refresh cap.
  - 10 cycles of frame swaps that force every batch to grow kept GPU geometry counts
    constant (17) with no errors, and picking stayed exact.
- The committed `phase3-*` reference images and the 20-run `phase3-city` report predate
  this change. Rerun `apps/web/scripts/bench-city.mjs` to refresh them. They are not
  relabelled here.
