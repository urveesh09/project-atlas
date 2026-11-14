# ADR-102: Road marks, moving traffic, park paths, boats and glazing with depth

Date: 2026-11-14. Status: accepted for the viewer.

## Evidence and cause

After ADR-101 the owner asked for a second realism round and, on 2026-11-14, for
buildings that look "less like fake". Captures of the bundled Vue analysis on the
development host (GT 730, full detail) showed three remaining tells:

- **Dead streets.** Asphalt carried only parked cars: no lane marks, no crossings and
  nothing moving.
- **Blank parks and sea.** Park parcels were lawn and trees only, and the water was empty.
- **Flat windows.** Every rectangular window was one flat tinted rectangle on the wall,
  with no reveal, frame, sill or sign of a room behind it.

## Decision

- `openLand` adds crossing footpaths to park parcels at least 5 cells across and a pool
  with a paved rim to parcels at least 7 across. Pools live in `Decor.pools`, separate
  from `Decor.ponds`, so the pond and bridge counts of a style stay as they were.
- `streets` paints dashed centre lines beside depth-1 blocks wherever both lane cells are
  street. A block ringed entirely by street also gets zebra crossings and cars driving a
  rectangular circuit in two lanes, in opposite directions, capped by `MAX_TRAFFIC`.
  Styles without `vehicles` get no marks and no traffic.
- `boats` puts 3–9 sailing boats on circuits beyond the beach in every style.
- Moving objects use `circuitMaterial`: the vertex shader places each instance from the
  shared ambient clock, so traffic costs no CPU per frame and stops with reduced motion
  and the lite renderer. Marks use `roadMarkMaterial`, which fades to the average tone
  when a dash is smaller than a pixel.
- The facade shader gives rectangular windows (patterns 0–3, 7 and 9) depth: a shaded
  reveal under the lintel and along one jamb, blinds at a per-window height with slats,
  mullions and a transom, and on walls a dark frame, a pale sill and its shadow.
  Curtain-wall glass takes the glazing detail without frame or sill. Everything scales
  brightness or mixes toward neutral, as before, so the lens colour still reads, and all
  of it sits inside the existing distance fade.
- Wall faces at least 0.2 cells wide darken toward their vertical corners, and each tier
  at least half a cell tall ends in a shaded parapet under a pale coping line. Each pane
  tilts its sky reflection by its own small amount, so a glass tower no longer mirrors
  the sky as one sheet.
- Decoration still keeps clear of `CityData.rootPlots`, districts and plots.

## Verification

- `pnpm verify` with required browser tests on Windows, 2026-11-14: 98 test files passed,
  6 skipped; 1122 tests passed, 95 skipped. That run preceded the corner, parapet and
  pane-tilt change to the facade shader; the change after it was checked by the city
  architecture tests and a GT 730 capture only; the full suite has not been rerun locally.

- `apps/web/test/city-architecture.test.ts`: paths lie inside parks; marks exist only for
  styles with vehicles and lie on street inside the repository block; traffic circuits,
  where present, are sampled clear of districts, plots and parks; boats lie beyond the
  beach. The test fixture has no block with a full street ring, so it yields no traffic
  circuit and that sampling is not exercised by it; the bundled Vue city does show traffic.
- GT 730 captures of the Vue city: Modern draws 35–38 calls (33–34 before), frame time
  16.7 ms median. GPU time per megapixel was read several times before and after the
  street work and the readings overlapped (ground view 12.5–18.2 ms/MP before, 18.1–20.5
  after; street view 13.7–23.0 before, 12.4–14.0 after) on a host too noisy to separate
  them. A longer comparison was stopped by the host for low memory and produced no
  result. The cost of this round, including the glazing detail, is therefore unmeasured.
