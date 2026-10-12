# ADR-043: Bake fallback, tower proportions and wall materials

Date: 2026-10-12. Status: accepted. Extends [ADR-042](ADR-042-grounded-city-and-view-controls.md)
(its decision 1 keeps the field; this ADR corrects its fallback). Changes no contract,
artifact byte, URL fragment or version.

## Evidence and cause

A review of ADR-042 found a reproducible bug and asked for visual variety next:

- **Stale fallback.** The bake worker's error handler was a closure created by the first
  bake. If the worker failed after a snapshot change, the fallback re-baked the *first*
  snapshot, and the stale-result guard discarded it. The current snapshot kept outdated
  shading until another bake was requested. The reviewer reproduced this with the extracted
  method and a simulated worker failure.
- **Repetition.** Tall buildings were square shafts drawn from a few silhouettes. Walls were
  plain lens colour with windows, so neighbouring towers read as copies.

## Decision

1. **`OcclusionBaker` owns bake scheduling** (`apps/web/src/city/baker.ts`).
   - It keeps the latest pending request and applies only that.
   - A worker error, or a worker that cannot start, bakes the latest pending request
     inline. Every later bake also runs inline.
   - A newer request replaces an inline bake that has not run yet.
   - The renderer only uploads the bytes it is given. The worker and the deferral are
     injected, so tests drive the exact failure sequence.
2. **Seeded plan proportions.** A body whose tiers are all four-sided may be a slab: depth
   over width is 1, 1, 0.86 or 0.74, chosen from the file's seed.
   - Outline parts (eaves, bands, battlements, platforms) and the role roof follow the
     plan. Corner parts keep their square plan and move with the corners.
   - Plans only narrow, so every body stays inside its plot.
3. **New silhouettes.**
   - Modern: art deco (a shaft stepping in three times to a crown), an octagonal shaft on a
     podium, and a slab whose upper floors step back on one side.
   - Western: a bell tower with two set-back stages and corner pinnacles.
   - They join existing families, so districts keep a character but mix more shapes.
4. **Wall materials** in the facade shader, between the windows:
   - Modern: precast panels, metal fins, brick or render.
   - Eastern: render, brick or ashlar.
   - Western: ashlar, brick or render.

   A district alternates two neighbouring materials. Materials change brightness only, so
   the lens hue holds. They are drawn only where the window pattern is visible, and fade
   before they would shimmer. A distant city pays nothing for them.

Style still comes only from layout seeds and the district, never from height, metrics or
lens data. The test asserting that is unchanged and still passes. Footprints, heights, role
roofs and picking boxes are unchanged.

## Verification

- `apps/web/test/city-occlusion.test.ts`, 3 new tests:
  - the reviewer's sequence (bake A, bake B, worker error) bakes and applies exactly B;
  - a stale worker result is ignored, the latest is applied, and after a failure two quick
    requests bake only the newer one, inline;
  - a worker that cannot start bakes inline.
- `apps/web/test/city-architecture.test.ts`: aspect stays in (0.7, 1], is 1 for any plan
  with non-square tiers, and the material comes from the style's own list. A first draft
  of the split slab had a 0.2 half-width top; the existing roof-fit test rejected it, and
  it is 0.23.
- GT 730, 120-frame orbits, one render per sample:

  | City | Style | GPU default | GPU close | Orbits at cap |
  |---|---|---|---|---|
  | Vite | Modern | 7.3 ms | 11.4 ms | 6 of 6 |
  | Vite | Eastern | 9.2 ms | 12.3 ms | 6 of 6 |
  | Vite | Western | 8.8 ms | 12.4 ms | 6 of 6 |
  | 10,000 files | Modern | 8.1 ms | 9.3 ms | 6 of 6 |
  | 10,000 files | Western | 10.3 ms | 11.5 ms | 6 of 6 |

- Expanded to 1920 x 1080 on Vite: 39 of 40 orbits at the cap.
  - The exception was the fifth consecutive heavy Modern orbit, with a p95 of 33.3 ms; the
    frame guard then lowered the ratio to 0.61.
  - Two repeated Modern runs and a Western run were all at the cap, at ratios 0.63–0.73.
- Snapshot change on Vite: p95 65 ms (Modern) and 46 ms (Western); budget 250 ms.
  Selection on Vue: p95 41–44 ms; budget 100 ms.
- `pnpm verify`: 635 passed, 80 service-gated skips.
- Viewer e2e: 27 of 27 on the GPU and with `CI=1` (SwiftShader).
- The corpus baseline is exact.
- Captures:
  - [Modern materials](../images/city-materials-modern.png);
  - [Western materials](../images/city-materials-western.png);
  - [Modern proportions](../images/city-proportions-modern.png).
