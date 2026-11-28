# City cars

`apps/web/src/city/vehicle-models.ts` is generated here from Kenney's Car Kit
([ADR-107](../../docs/adr/ADR-107-menus-tooltips-cars-surfaces.md)). The viewer only reads
that module. Blender is needed only to regenerate it, for example to add a model or change
the triangle budget.

## Source

[Car Kit 3.1 by Kenney](https://kenney.nl/assets/car-kit) (www.kenney.nl), CC0 1.0. The
package's `License.txt` says: "You can use this content for personal, educational, and
commercial purposes", with credit to Kenney welcome but not required. The kit used here is
`kenney_car-kit_3.1.zip` from the author's
[OpenGameArt page](https://opengameart.org/content/car-kit) (SHA-256
`fac7dacac5c7874348cf19729af3ef205f3d366493edaf0a827d93f4fdf3d0c4`). Models: `sedan`, `suv`
and `hatchback-sports`.

## Steps

```sh
# Unzip the kit, then (Blender 5.3; a few seconds):
blender -b --factory-startup -P scripts/vehicle-models/convert.py -- \
  --kit "<kit>/Models/GLB format" --out apps/web/src/city/vehicle-models.ts
pnpm vitest run apps/web/test/city-surfaces.test.ts
```

`convert.py` sets the models and their city lengths (`MODELS`), the body budget
(`BODY_TRIANGLES`), width, height easing and the wheel's sides. It prints, per model, the
faces before and after, the painted face count, the paint hue and which way the model
faced. Look at the cars in every city style before committing a new module: too low a body
budget tears fenders and bumpers.
