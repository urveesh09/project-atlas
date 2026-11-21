# Baked facade textures

Two images in `apps/web/src/assets` are made here: `facade-walls.jpg`, the wall materials
([ADR-103](../../docs/adr/ADR-103-baked-wall-materials.md)), and `facade-rooms.jpg`, the rooms
behind the windows ([ADR-104](../../docs/adr/ADR-104-rooms-behind-windows.md)). The viewer
only loads the images. Blender is needed only to make them again, for example to change a
material, its scale or its relief, or to furnish the rooms differently.

## Sources

All from [Poly Haven](https://polyhaven.com/license), CC0 (public domain). Each folder needs
the 1k (or larger) `diff.jpg`, `nor_gl.jpg` and `disp.jpg`.

| Layer | Facade material | Poly Haven asset | Authors | Real size |
|---|---|---|---|---|
| 0 | Render / plaster | [beige_wall_001](https://polyhaven.com/a/beige_wall_001) | Dimitrios Savva, Rico Cilliers | 3 m |
| 1 | Brick | [red_bricks_04](https://polyhaven.com/a/red_bricks_04) | Rob Tuytel | 2.5 m |
| 2 | Precast concrete | [concrete_wall_003](https://polyhaven.com/a/concrete_wall_003) | Dimitrios Savva, Rico Cilliers | 3 m |
| 3 | Metal cladding | [metal_plate_02](https://polyhaven.com/a/metal_plate_02) | Rob Tuytel | 2 m |
| 4 | Ashlar stone | [sandstone_blocks_05](https://polyhaven.com/a/sandstone_blocks_05) | Rob Tuytel | 3 m |

The rooms also use these, `diff.jpg` only:

| Used for | Poly Haven asset | Authors |
|---|---|---|
| Wooden floors and furniture | [oak_veneer_03](https://polyhaven.com/a/oak_veneer_03), [walnut_veneer](https://polyhaven.com/a/walnut_veneer) | Jenelle van Heerden |
| Upholstery and bedding | [rough_linen](https://polyhaven.com/a/rough_linen) | colormass, Rico Cilliers |
| Office carpet | [dirty_carpet](https://polyhaven.com/a/dirty_carpet) | Rohit Seervi |

Download them from the asset pages, or the files API, which lists each map's URL:
`https://api.polyhaven.com/files/<id>`. Rename them to `<maps>/<id>/diff.jpg`,
`nor_gl.jpg` and `disp.jpg`.

## Steps

```sh
# 1. Bake (Blender 5.3; about 3 minutes on 3 threads of an i5-10400)
blender -b --factory-startup -P scripts/facade-textures/bake.py -- --src <maps> --out <bake> --threads 3
# 2. Pack (Python with numpy and Pillow)
python scripts/facade-textures/pack.py <bake> apps/web/src/assets/facade-walls.jpg --compare
# 3. Rooms (about 2 minutes) and their atlas
blender -b --factory-startup -P scripts/facade-textures/rooms.py -- --src <maps> --out <rooms> --threads 3
python scripts/facade-textures/pack.py --rooms <rooms> apps/web/src/assets/facade-rooms.jpg
```

`bake.py` sets each layer's tile size, relief depth, normal-map strength and occlusion
distance. `pack.py` sets each layer's brightness contrast and prints the per-layer
brightness statistics; every mean must be 1 to within 0.001. Keep the layer order, which is the
facade shader's material index (`MATERIAL` in `apps/web/src/city/themes.ts`), and keep
`WALL_TILE` in `apps/web/src/city/walls.ts` and the shader's tile sizes in step with
`bake.py`. Then run `pnpm vitest run apps/web/test/city-walls.test.ts` and look at close
views of every city style before committing a new image.

`rooms.py` lists the 16 rooms in atlas order (`ROOMS`). Offices must stay at 1, 5, 9 and 13
(`OFFICE_ROOMS` in `walls.ts`), and `W`, `H`, `D` and `CN` must stay in step with the
shader's room box (one cell wide, one storey tall, 1.5 cells deep) and `ROOM_CN`.
