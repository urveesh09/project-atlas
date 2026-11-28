"""Convert Kenney Car Kit models into the city's car meshes (ADR-107).

    blender -b --factory-startup -P scripts/vehicle-models/convert.py -- --kit "<Car Kit>/Models/GLB format" --out apps/web/src/city/vehicle-models.ts

Kenney's Car Kit 3.1 (CC0, kenney.nl; see README.md) draws each car at about 2,000 triangles,
332 of them per wheel. The city may show 2,400 parked and 480 moving cars at once, so each
model is rebuilt at city scale:

- every face takes the colour its UVs point to in the kit's palette texture, as a material
  per colour, so simplification never smears one colour into another;
- coplanar faces of one colour are merged and the body is collapsed to `BODY_TRIANGLES`;
- the wheels become plain 8-sided tyres with a pale hub on the outer face;
- the car turns to face +x (the circuit shader drives along +x), is scaled to a city car
  (`LENGTH` world units long, a storey being 0.3) and eased from the kit's toy stance
  (`WIDTH`, `HEIGHT`);
- the body (the saturated hue covering the most area) becomes a paint flag plus a brightness
  factor that keeps the kit's gradient shading, so the viewer paints only the body per car;
  glass, lights, tyres and trim keep their colours.

The output is a generated TypeScript module of quantised triangles. Blender is a build tool:
the viewer never runs it.
"""

import argparse
import base64
import colorsys
import math
import os
import sys

import bmesh
import bpy
import numpy as np

# (Kenney model, city length in world units). A storey is 0.3, about 3 m.
MODELS = [("sedan", 0.42), ("suv", 0.44), ("hatchback-sports", 0.40)]
BODY_TRIANGLES = 480
WIDTH = 0.19  # world units, every model
HEIGHT = 0.86  # height scale relative to length scale: a little lower than the kit's toy stance
WHEEL_SIDES = 8
QUANT = 16384  # int16 steps per world unit


def args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--kit", required=True)
    p.add_argument("--out", required=True)
    return p.parse_args(argv)


def srgb_of(img):
    w, h = img.size
    a = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(h, w, 4)[..., :3], w, h  # Blender stores the image's raw sRGB bytes for byte images


def face_colours(obj, pixels, w, h):
    """Palette colour of each face: the texel at the face's UV centroid, snapped to its swatch.

    The kit's swatches are gradients; at city scale a gradient reads as one colour, and one
    colour per swatch lets coplanar faces of a part merge without changing its shape.
    """
    me = obj.data
    uv = me.uv_layers.active.data
    out = []
    for poly in me.polygons:
        u = sum(uv[i].uv[0] for i in poly.loop_indices) / poly.loop_total
        v = sum(uv[i].uv[1] for i in poly.loop_indices) / poly.loop_total
        x = min(w - 1, max(0, int((u % 1.0) * w)))
        y = min(h - 1, max(0, int((v % 1.0) * h)))
        out.append(tuple(np.round(pixels[y, x] * 255).astype(int).tolist()))
    buckets = {}
    for c in out:
        buckets.setdefault(tuple(v // 40 for v in c), []).append(c)
    mean = {k: tuple(round(sum(c[i] for c in cs) / len(cs)) for i in range(3)) for k, cs in buckets.items()}
    return [mean[tuple(v // 40 for v in c)] for c in out]


def by_colour(obj, colours):
    """One material per distinct colour; faces keep their colour through decimation."""
    palette = sorted(set(colours))
    me = obj.data
    me.materials.clear()
    for c in palette:
        m = bpy.data.materials.new(f"c{c[0]}_{c[1]}_{c[2]}")
        me.materials.append(m)
    index = {c: i for i, c in enumerate(palette)}
    me.polygons.foreach_set("material_index", [index[c] for c in colours])
    return palette


def decimate(obj, target):
    bpy.context.view_layer.objects.active = obj
    planar = obj.modifiers.new("planar", "DECIMATE")
    planar.decimate_type = "DISSOLVE"
    planar.angle_limit = math.radians(2.0)
    planar.delimit = {"MATERIAL", "SEAM"}
    bpy.ops.object.modifier_apply(modifier=planar.name)
    tri = obj.modifiers.new("tri", "TRIANGULATE")
    bpy.ops.object.modifier_apply(modifier=tri.name)
    n = len(obj.data.polygons)
    if n > target:
        collapse = obj.modifiers.new("collapse", "DECIMATE")
        collapse.decimate_type = "COLLAPSE"
        collapse.ratio = target / n
        collapse.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=collapse.name)
    return len(obj.data.polygons)


def world_tris(obj, palette):
    """World-space triangles with their colour, from a triangulated mesh."""
    me = obj.data
    mw = obj.matrix_world
    tris = []
    for poly in me.polygons:
        vs = [mw @ me.vertices[i].co for i in poly.vertices]
        for k in range(1, len(vs) - 1):
            tris.append(((vs[0], vs[k], vs[k + 1]), palette[poly.material_index]))
    return tris


def wheel(centre, radius, width, outward):
    """An 8-sided tyre around the x axis (Blender's across-car axis): dark tread and sidewall,
    with a pale hub of about half the wheel's radius on the outer face."""
    tyre, hub = (38, 40, 44), (176, 180, 186)
    cx, cy, cz = centre

    def ring(r):
        return [(cy + r * math.cos(2 * math.pi * k / WHEEL_SIDES), cz + r * math.sin(2 * math.pi * k / WHEEL_SIDES)) for k in range(WHEEL_SIDES)]

    rim, inner = ring(radius), ring(radius * 0.55)
    x_out, x_in = cx + outward * width / 2, cx - outward * width / 2
    tris = []
    for k in range(WHEEL_SIDES):
        j = (k + 1) % WHEEL_SIDES
        (y0, z0), (y1, z1) = rim[k], rim[j]
        (h0, g0), (h1, g1) = inner[k], inner[j]
        tris.append((((x_out, y0, z0), (x_in, y0, z0), (x_in, y1, z1)), tyre))
        tris.append((((x_out, y0, z0), (x_in, y1, z1), (x_out, y1, z1)), tyre))
        tris.append((((x_out, h0, g0), (x_out, y0, z0), (x_out, y1, z1)), tyre))
        tris.append((((x_out, h0, g0), (x_out, y1, z1), (x_out, h1, g1)), tyre))
        tris.append((((x_out, cy, cz), (x_out, h0, g0), (x_out, h1, g1)), hub))
    # Counter-clockwise seen from outside on the +x side; mirror the winding on the -x side.
    return tris if outward > 0 else [((a, c, b), col) for (a, b, c), col in tris]


def convert(kit, name, length):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=os.path.join(kit, f"{name}.glb"))
    image = next(i for i in bpy.data.images if i.size[0] > 0)
    pixels, w, h = srgb_of(image)
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    # Road wheels only: a spare carried on the back (the SUV's "wheel-back") is left off.
    wheels = [o for o in meshes if o.name.startswith("wheel") and ("left" in o.name or "right" in o.name)]
    bodies = [o for o in meshes if not o.name.startswith("wheel")]
    # Wheels: centre, radius and width from their world bounding boxes.
    spins = []
    for o in wheels:
        pts = [o.matrix_world @ v.co for v in o.data.vertices]
        lo = [min(p[i] for p in pts) for i in range(3)]
        hi = [max(p[i] for p in pts) for i in range(3)]
        centre = tuple((lo[i] + hi[i]) / 2 for i in range(3))
        spins.append((centre, (hi[2] - lo[2]) / 2, hi[0] - lo[0], 1 if centre[0] > 0 else -1))
    # Body: one object, colour per face, simplified.
    bpy.ops.object.select_all(action="DESELECT")
    for o in bodies:
        o.select_set(True)
    bpy.context.view_layer.objects.active = bodies[0]
    if len(bodies) > 1:
        bpy.ops.object.join()
    body = bpy.context.view_layer.objects.active
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    colours = face_colours(body, pixels, w, h)
    palette = by_colour(body, colours)
    before = len(body.data.polygons)
    after = decimate(body, BODY_TRIANGLES)
    tris = world_tris(body, palette)
    # The paint: the hue covering the most area among saturated colours. The kit's palette
    # cells are vertical gradients, so a body is many shades of one hue, not one colour.
    def hue_key(col):
        h, sat, val = colorsys.rgb_to_hsv(*(x / 255 for x in col))
        return round(h * 12) % 12 if sat > 0.25 and val > 0.25 else None

    area = {}
    for (a, b, c), col in tris:
        key = hue_key(col)
        if key is not None:
            area[key] = area.get(key, 0.0) + ((b - a).cross(c - a)).length / 2
    paint_hue = max(area, key=area.get)
    painted = [hue_key(col) == paint_hue for _, col in tris]
    # Each painted face keeps its gradient shading as a brightness factor about 1.
    lum = lambda col: 0.2126 * col[0] + 0.7152 * col[1] + 0.0722 * col[2]
    weights = [((b - a).cross(c - a)).length / 2 for (a, b, c), _ in tris]
    mean = sum(lum(col) * w for ((_, col), w, p) in zip(tris, weights, painted) if p) / sum(w for w, p in zip(weights, painted) if p)
    shade = [min(1.25, max(0.7, lum(col) / mean)) for _, col in tris]
    paint = tris[painted.index(True)][1]
    # Which end is the front: amber or white headlights at one end, red tail lights at the other.
    def lights(test):
        ys = [((a + b + c) / 3).y for ((a, b, c), col), p in zip(tris, painted) if test(col) and not p]
        return sum(ys) / len(ys) if ys else None

    head = lights(lambda c: c[0] > 200 and c[1] > 140 and c[2] < 130)
    tail = lights(lambda c: c[0] > 150 and c[1] < 100 and c[2] < 100)
    ys = [p.y for (tri, _) in tris for p in tri]
    mid = (min(ys) + max(ys)) / 2
    if head is not None and tail is not None:
        front = 1 if head > tail else -1
    elif head is not None:
        front = 1 if head > mid else -1
    else:
        front = -1 if tail is not None and tail > mid else 1
    for centre, radius, width, outward in spins:
        extra = wheel(centre, radius, width, outward)
        tris += extra
        painted += [False] * len(extra)
        shade += [1.0] * len(extra)
    # Into the city frame: x forward, y up, z to the right; scaled and eased.
    ys = [p[1] for (tri, _) in tris for p in tri]
    xs = [p[0] for (tri, _) in tris for p in tri]
    long_ = max(ys) - min(ys)
    wide = max(xs) - min(xs)
    s = length / long_
    sw = WIDTH / wide
    sh = s * HEIGHT
    cy = (min(ys) + max(ys)) / 2
    out = []
    for (tri, col), p, f in zip(tris, painted, shade):
        pts = []
        for q in tri:
            x, y, z = q[0], q[1], q[2]
            pts.append(((y - cy) * s * front, z * sh, x * sw * front))
        # Paint faces carry their shade in the colour bytes (200 = 1.0) and the paint flag.
        out.append((pts, (round(200 * f),) * 3 if p else col, p))
    print(f"CAR {name}: body {before} -> {after} faces; {len(out)} triangles; {sum(painted)} painted; paint hue of {paint}; front {'+y' if front > 0 else '-y'}; "
          f"size {length:.2f} x {WIDTH:.2f} x {max(p[1] for t, _, _ in out for p in t):.3f}", flush=True)
    return out


def encode(tris):
    pos = np.array([c for pts, _, _ in tris for p in pts for c in p], dtype=np.float64)
    q = np.clip(np.round(pos * QUANT), -32768, 32767).astype("<i2")
    rgba = np.array([[*col, 255 if painted else 0] for _, col, painted in tris for _ in range(3)], dtype=np.uint8)
    return base64.b64encode(q.tobytes()).decode(), base64.b64encode(rgba.tobytes()).decode()


def main():
    o = args()
    lines = [
        "// Generated by scripts/vehicle-models/convert.py from Kenney's Car Kit 3.1 (CC0). Do not edit.",
        "// Each model: triangles as int16 positions (x forward, y up, z right; 1/QUANT world units)",
        "// and per-vertex sRGB colour bytes whose alpha marks the body paint; on painted vertices the",
        "// colour bytes hold a brightness factor (200 = 1.0) that keeps the kit's shading (ADR-107).",
        f"export const VEHICLE_QUANT = {QUANT};",
        "export const VEHICLE_MODELS: readonly { name: string; positions: string; colours: string }[] = [",
    ]
    for name, length in MODELS:
        positions, colours = encode(convert(o.kit, name, length))
        lines.append(f"  {{ name: '{name}', positions: '{positions}', colours: '{colours}' }},")
    lines.append("];")
    with open(o.out, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    print(f"wrote {o.out} ({os.path.getsize(o.out)} bytes)", flush=True)


main()
