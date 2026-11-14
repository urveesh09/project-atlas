# City model guide

The public viewer is at [urveesh09.github.io/project-atlas](https://urveesh09.github.io/project-atlas/).
It opens a bundled Vue analysis and can read local artifacts through the browser.
GitHub Pages serves the latest published demo build. The release process explains
how a new build is published. [Demo deployment](../release/release-process.md#demo-site)

ATLAS builds its city models in TypeScript at runtime with Three.js. The building
catalog, shared mesh builders, and shaders are the source files for visual changes.
For setup and other parts of the software, see [Start here](../START_HERE.md).

## Building catalog

Open [themes.ts](../../apps/web/src/city/themes.ts), find the style under `THEMES`,
and search for the model name below in its `archetypes` array. Names also appear
in each style's `families` and `low` model pools. A model's array position can
change independently of those references.

### Modern city

Theme key `modern`. [Example view](../images/city-cinematic-modern.png)

| Model name | Shape |
|---|---|
| `block` | Square block with rooftop equipment |
| `slab` | Rectangular block with rooftop equipment |
| `setback` | Three tiers that narrow toward the top |
| `podium` | Octagonal shaft on a square podium |
| `rotunda` | Gently tapered twelve-sided shaft |
| `tapered` | Four-sided shaft with a narrower top |
| `cornice` | Tower with a projecting cornice near the roof |
| `stepped` | Two-tier low block with a narrower upper tier |
| `glass-tower` | Banded tower with a wider base and rooftop equipment |
| `deco` | Art deco shaft stepping back three times to a crown |
| `octagon` | Tapered octagonal shaft on a low podium |
| `split-slab` | Slab with shallower upper floors and rooftop equipment |

Low pool uses `block`, `slab` and `stepped`.

### Eastern fantasy

Theme key `eastern`. [Example view](../images/city-cinematic-eastern.png)

| Model name | Shape |
|---|---|
| `pagoda` | Tapered square body with repeated eaves on a plinth |
| `octagonal-pagoda` | Tapered octagonal body with repeated eaves |
| `palace-hall` | Rectangular hall on a tiered terrace |
| `tower-pavilion` | Twelve-sided upper tower on a square base |
| `gate-tower` | Narrow upper tier over a broad arcaded base |
| `hall` | Low rectangular hall on a terrace |
| `pavilion` | Low octagonal pavilion on a plinth |
| `tiered-hall` | Two halls with different footprints stacked on a terrace |
| `pavilion-hall` | Octagonal hall with widely spaced eaves on a terrace |

Low pool uses `hall` and `pavilion`.

### Western fantasy

Theme key `western`. [Example view](../images/city-cinematic-western.png)

| Model name | Shape |
|---|---|
| `keep` | Square keep with bands and battlements |
| `round-tower` | Twelve-sided tower with bands and battlements |
| `timber-house` | Jettied house with wider upper storeys and chimneys |
| `wizard-tower` | Tapered tower with projecting bands |
| `chapel` | Rectangular arcaded nave with corner pinnacles |
| `guild-hall` | Two-tier hall with an arcade and battlements |
| `cottage` | Low rectangular cottage with chimneys |
| `turret` | Low octagonal turret with battlements |
| `fortress` | Sloped base, square keep and four corner turrets |
| `manor` | Broad mansion with bands and four chimneys |
| `bell-tower` | Three set-back stages with corner pinnacles |

Low pool uses `cottage` and `turret`.

## Where to change each part

| What to change | Where to start |
|---|---|
| Building silhouette, taper, half-width or depth | The model's `tiers` in [themes.ts](../../apps/web/src/city/themes.ts). `box` defines a four-sided tier. `ring` defines an eight- or twelve-sided tier. `archetypeGeometry` and `prism` build the meshes in [architecture.ts](../../apps/web/src/city/architecture.ts). |
| Which models and windows a district uses | The paired `models` and `windows` lists under each entry in `families` or in `low` in [themes.ts](../../apps/web/src/city/themes.ts). `districtFamily` and `buildingStyle` select them in [architecture.ts](../../apps/web/src/city/architecture.ts). |
| Eaves, bands, battlements, turrets, pinnacles, chimneys, equipment, platforms and terraces | The model's `parts` in [themes.ts](../../apps/web/src/city/themes.ts), `partGeometry` and its mesh builders in [architecture.ts](../../apps/web/src/city/architecture.ts), and `storeyParts`, `PART_HEIGHT` and `CORNER_FIT` in [renderer.ts](../../apps/web/src/city/renderer.ts). |
| Roof shapes and fitting | The role roof batches and `layoutBuildings` in [renderer.ts](../../apps/web/src/city/renderer.ts). Source uses a pyramid or Eastern pavilion, test uses a six-sided cap, asset uses an eight-sided cone, and config, declaration and opaque use boxes with different proportions. `pavilionRoofGeometry` and `topExtent` are in [architecture.ts](../../apps/web/src/city/architecture.ts). Roof colours and model fit multipliers are in [themes.ts](../../apps/web/src/city/themes.ts). |
| Glass, windows, ground-storey entrances, wall patterns and tints | `WINDOW`, `BASE`, and `MATERIAL` in [themes.ts](../../apps/web/src/city/themes.ts) name the patterns. `facadeMaterial` in [architecture.ts](../../apps/web/src/city/architecture.ts) implements them in the shader. |
| Surface texture of grass, sand, asphalt, plazas and walls | `detailTexture` in [shading.ts](../../apps/web/src/city/shading.ts) builds the shared detail map. `withCover` applies it to the island's ground by `COVER` kind, `withPaving` to district surfaces, and the weathering block of `facadeMaterial` in [architecture.ts](../../apps/web/src/city/architecture.ts) to walls. The multipliers beside each sample set its strength. |
| Roads, kerbs, plazas, ground, roof tiles and contact shading | `ground` in [themes.ts](../../apps/web/src/city/themes.ts) and `PAVING` in [renderer.ts](../../apps/web/src/city/renderer.ts). `withPaving`, `withTiles` and `withOcclusion` are in [shading.ts](../../apps/web/src/city/shading.ts). The bake is computed in [occlusion.ts](../../apps/web/src/city/occlusion.ts) and scheduled by [baker.ts](../../apps/web/src/city/baker.ts). |
| Road marks, traffic, park paths, pools and boats | `streets`, `boats` and `openLand` in [architecture.ts](../../apps/web/src/city/architecture.ts) fill `Decor.roadMarks`, `traffic`, `boats`, `paths` and `pools`; `MAX_TRAFFIC` caps moving cars and `BOAT_PAINTS` colours hulls. `circuitMaterial` and `roadMarkMaterial` in [living.ts](../../apps/web/src/city/living.ts) draw them. Window reveals, blinds, mullions, frames and sills are the `atlasBoxed` block of `facadeMaterial`. [Decision record](../adr/ADR-102-streets-traffic-and-glazing.md) |
| Parks and parked cars on open ground | `openLand` in [architecture.ts](../../apps/web/src/city/architecture.ts) turns the free land of the repository block into park parcels and places kerbside cars. `STREET`, `PARCEL`, `MAX_PARK_TREES` and `MAX_VEHICLES` set street width, parcel size and the caps. Car paints are `vehicles` in [themes.ts](../../apps/web/src/city/themes.ts) (`null` for a style without cars), the car mesh is `vehicleGeometry`, and `VEHICLE_SCALE` in [renderer.ts](../../apps/web/src/city/renderer.ts) is the zoom from which cars draw. [Decision record](../adr/ADR-101-city-realism-pass.md) |
| Trees and lamps | The `trees` and `lamp` settings in [themes.ts](../../apps/web/src/city/themes.ts), plus `treeGeometry`, `lampGeometry` and `cityDecor` in [architecture.ts](../../apps/web/src/city/architecture.ts). Modern uses plane, round and conifer trees with `street` lamps. Eastern uses pine, blossom, willow and round trees with `lantern` lamps. Western uses oak, cypress and conifer with `iron` lamps. |
| Town walls, gates, corner towers, bridges and lotus ponds | `walls` and `ponds` in [themes.ts](../../apps/web/src/city/themes.ts). `cityDecor` places the objects. `cornerGeometry`, `gateGeometry`, `bridgeGeometry` and `lotusGeometry` build them in [architecture.ts](../../apps/web/src/city/architecture.ts). Wall and pond batches are in [renderer.ts](../../apps/web/src/city/renderer.ts). |
| External package depots and harbour | `terminal` in [themes.ts](../../apps/web/src/city/themes.ts), `depotGeometry` and `placeTerminals` in [renderer.ts](../../apps/web/src/city/renderer.ts), and `gableGeometry` and `depotEaveGeometry` in [architecture.ts](../../apps/web/src/city/architecture.ts). |
| Sea, sky, mountains, clouds and wind | `sky`, `scenery` and `clouds` in [themes.ts](../../apps/web/src/city/themes.ts). `skyDome` and `sceneryGeometry` are in [atmosphere.ts](../../apps/web/src/city/atmosphere.ts). There, `landform` shapes a hill or mountain, `pillar` a karst tower, and the `woodland` and `alpine` covers colour the ground by altitude and slope. `waterMaterial`, `cloudLayer` and `foliageMaterial` are in [living.ts](../../apps/web/src/city/living.ts). |
| City layout, footprints before decoration, code-line height and lens colours | [pack.ts](../../packages/layout/src/pack.ts) packs districts and plots. [height.ts](../../packages/layout/src/height.ts) computes building height. [view.ts](../../packages/layout/src/view.ts) prepares the city and maps lenses to colours. |
| Camera, labels, picking, view controls and alternative views | [renderer.ts](../../apps/web/src/city/renderer.ts) runs the camera, labels and picking. [ThreeCity.tsx](../../apps/web/src/city/ThreeCity.tsx) mounts the canvas. [City.tsx](../../apps/web/src/components/City.tsx) owns the toolbar and view controls. [MapCity.tsx](../../apps/web/src/city/MapCity.tsx) draws the 2D map. |
| STL and 3MF print models | [print3d.ts](../../apps/web/src/city/print3d.ts) builds a separate simplified model from the layout. The print export uses rectangular building bodies. |
| Landing preview or screenshots | The preview image lives in [city-preview.webp](../../apps/web/src/assets/city-preview.webp). [Documentation images](../images/) hold screenshots and benchmark captures. |

## Edit and preview

1. Change the relevant model or builder above. To add a silhouette, give it
   a unique name in `archetypes` and list it in a district or low pool. Keep
   the order of an existing pool if you want the same seeded choices. Keep
   tiers within the unit body and test the roof and any parts at the widest
   footprint and tallest building.
2. Keep the data encodings intact. File height represents code lines under
   the documented height policy, facade hue follows the active lens, and roof
   shape represents file role. Decorative choices follow seeds and districts.
   Layout changes affect the artifact and have a separate compatibility
   and baseline process. [City decisions](../adr/ADR-039-city-styles.md)
3. Preview with the authored Harbor history. From the repository root in
   PowerShell, use a new output folder name for each analysis.

   ```powershell
   pnpm install --frozen-lockfile
   pnpm build
   pnpm build:web
   $harbor = (node scripts/build-demo-repository.mjs | ConvertFrom-Json).repository
   pnpm atlas analyze $harbor --out .atlas-tmp/model-preview
   pnpm atlas serve .atlas-tmp/model-preview --repo $harbor --no-open
   ```

   Open the one-use URL printed by `atlas serve`. Under **City style**, switch
   between Modern city, Eastern fantasy and Western fantasy. Review a close-up
   and the whole city in standard and low detail, change a lens, and move
   through two snapshots. A second browser session needs a fresh serve URL.
4. Run the geometry and placement tests and then the full checks.

   ```powershell
   pnpm exec vitest run apps/web/test/city-architecture.test.ts apps/web/test/city-occlusion.test.ts
   $env:ATLAS_REQUIRE_BROWSER_TESTS = '1'
   pnpm verify
   ```

   For shader, draw-call, or instancing changes, use the [city benchmark](../../apps/web/scripts/bench-city.mjs)
   and compare against its previous measurements on the same device. For changes
   to the look of a model, update the matching catalog entry and capture the
   changed style. [Viewer test instructions](../plan/production-plan.md#browser-journeys)
