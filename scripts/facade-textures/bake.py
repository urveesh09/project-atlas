"""Bake the facade wall materials in Blender (ADR-103).

Run with Blender 5.3 (any 4.2+ should work):

    blender -b --factory-startup -P scripts/facade-textures/bake.py -- --src <maps> --out <dir> [--res 512] [--threads 3]

`<maps>/<id>/` holds Poly Haven's 1k `diff.jpg`, `nor_gl.jpg` and `disp.jpg` for every id in
LAYERS (README.md lists where each comes from). For each material this builds one tile of
wall at its real size as displaced geometry, with a margin so occlusion wraps across the
tile edge, and renders three orthographic passes from straight ahead: linear albedo, the
shading normal (geometry plus a light touch of the normal map) and ambient occlusion.
Each pass is saved as `<out>/<id>_<pass>.npy` (float32, rows from the top, RGB or one
channel) for pack.py. Blender is a build tool only: the viewer never runs it.
"""

import argparse
import math
import os
import sys

import bpy
import numpy as np

# Order is the facade shader's wall material index (architecture.ts):
# 0 render/plaster, 1 brick, 2 precast concrete, 3 metal cladding, 4 ashlar stone.
# (Poly Haven id, tile size in metres, relief depth in metres, normal-map strength, AO distance in metres)
LAYERS = [
    ("beige_wall_001", 3.0, 0.003, 0.6, 0.02),
    ("red_bricks_04", 2.5, 0.015, 0.35, 0.04),
    ("concrete_wall_003", 3.0, 0.004, 0.5, 0.02),
    ("metal_plate_02", 2.0, 0.005, 0.4, 0.03),
    ("sandstone_blocks_05", 3.0, 0.025, 0.35, 0.06),
]
MARGIN = 0.15  # of a tile, on every side
STEPS = 384  # grid quads per tile edge


def args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--src", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--res", type=int, default=512)
    p.add_argument("--threads", type=int, default=3)
    p.add_argument("--only", default="")
    return p.parse_args(argv)


def load(path, colour):
    img = bpy.data.images.load(path, check_existing=True)
    img.colorspace_settings.name = "sRGB" if colour else "Non-Color"
    return img


def pixels(img):
    w, h = img.size
    a = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(h, w, 4)  # rows from the bottom


def sample(height, u, v):
    """Bilinear, wrapping sample of a (h, w) map at UV (v up), like Blender's REPEAT."""
    h, w = height.shape
    x = (u % 1.0) * w - 0.5
    y = (v % 1.0) * h - 0.5
    x0 = np.floor(x).astype(np.int64)
    y0 = np.floor(y).astype(np.int64)
    fx, fy = x - x0, y - y0
    x0 %= w
    y0 %= h
    x1, y1 = (x0 + 1) % w, (y0 + 1) % h
    top = height[y0, x0] * (1 - fx) + height[y0, x1] * fx
    bottom = height[y1, x0] * (1 - fx) + height[y1, x1] * fx
    return top * (1 - fy) + bottom * fy


def wall(name, size, depth, disp):
    """A displaced grid covering one tile plus MARGIN, with UVs that repeat every tile."""
    span = size * (1 + 2 * MARGIN)
    n = int(round(STEPS * (1 + 2 * MARGIN))) + 1
    xs = np.linspace(-span / 2, span / 2, n)
    X, Y = np.meshgrid(xs, xs)
    U, V = X / size + 0.5, Y / size + 0.5
    Z = sample(disp, U, V) * depth
    mesh = bpy.data.meshes.new(name)
    mesh.vertices.add(n * n)
    mesh.vertices.foreach_set("co", np.stack([X, Y, Z], -1).astype(np.float32).ravel())
    i = np.arange(n * n).reshape(n, n)
    quads = np.stack([i[:-1, :-1], i[:-1, 1:], i[1:, 1:], i[1:, :-1]], -1).reshape(-1, 4)
    mesh.loops.add(quads.size)
    mesh.loops.foreach_set("vertex_index", quads.ravel().astype(np.int32))
    mesh.polygons.add(len(quads))
    mesh.polygons.foreach_set("loop_start", (np.arange(len(quads)) * 4).astype(np.int32))
    uv = mesh.uv_layers.new(name="UVMap")
    uv.data.foreach_set("uv", np.stack([U.ravel(), V.ravel()], -1)[quads.ravel()].astype(np.float32).ravel())
    mesh.update()
    mesh.validate()
    mesh.polygons.foreach_set("use_smooth", np.ones(len(quads), dtype=bool))
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def material(kind, diff, nor, strength, distance):
    m = bpy.data.materials.new(kind)
    try:
        m.use_nodes = True
    except Exception:
        pass
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    emit = nt.nodes.new("ShaderNodeEmission")
    nt.links.new(emit.outputs["Emission"], out.inputs["Surface"])

    def image(img):
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = img
        t.extension = "REPEAT"
        t.interpolation = "Cubic"
        return t

    if kind == "albedo":
        nt.links.new(image(diff).outputs["Color"], emit.inputs["Color"])
    elif kind == "normal":
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nm.space = "TANGENT"
        nm.uv_map = "UVMap"
        nm.inputs["Strength"].default_value = strength
        nt.links.new(image(nor).outputs["Color"], nm.inputs["Color"])
        ma = nt.nodes.new("ShaderNodeVectorMath")
        ma.operation = "MULTIPLY_ADD"
        ma.inputs[1].default_value = (0.5, 0.5, 0.5)
        ma.inputs[2].default_value = (0.5, 0.5, 0.5)
        nt.links.new(nm.outputs["Normal"], ma.inputs[0])
        nt.links.new(ma.outputs["Vector"], emit.inputs["Color"])
    else:
        ao = nt.nodes.new("ShaderNodeAmbientOcclusion")
        ao.samples = 16
        ao.only_local = False
        ao.inputs["Distance"].default_value = distance
        nt.links.new(ao.outputs["AO"], emit.inputs["Color"])
    return m


def render(path, samples):
    s = bpy.context.scene
    s.cycles.samples = samples
    s.render.filepath = path
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(path)
    img.colorspace_settings.name = "Non-Color"
    a = pixels(img)[::-1, :, :3].copy()  # rows from the top
    bpy.data.images.remove(img)
    os.remove(path)
    return a


def main():
    o = args()
    os.makedirs(o.out, exist_ok=True)
    s = bpy.context.scene
    # Factory startup brings a cube, a light and a camera; only the wall may be seen.
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj)
    s.render.engine = "CYCLES"
    s.cycles.device = "CPU"
    s.cycles.use_denoising = False
    s.cycles.use_adaptive_sampling = False
    s.render.threads_mode = "FIXED"
    s.render.threads = o.threads
    s.render.resolution_x = s.render.resolution_y = o.res
    s.render.resolution_percentage = 100
    s.render.film_transparent = False
    try:
        s.render.image_settings.media_type = "IMAGE"
    except Exception:
        pass
    s.render.image_settings.file_format = "OPEN_EXR"
    s.render.image_settings.color_depth = "32"
    world = bpy.data.worlds.new("black")
    world.color = (0, 0, 0)
    s.world = world
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    s.collection.objects.link(cam)
    s.camera = cam
    cam.data.type = "ORTHO"
    cam.data.clip_start, cam.data.clip_end = 0.01, 100
    cam.location = (0, 0, 10)
    for pid, size, depth, strength, distance in LAYERS:
        if o.only and pid not in o.only.split(","):
            continue
        folder = os.path.join(o.src, pid)
        diff = load(os.path.join(folder, "diff.jpg"), True)
        nor = load(os.path.join(folder, "nor_gl.jpg"), False)
        disp = pixels(load(os.path.join(folder, "disp.jpg"), False))[:, :, 0]
        # Poly Haven heights use a narrow, varying slice of 0..1; stretch it so `depth` is the
        # real relief from joint to face.
        lo, hi = np.percentile(disp, [1, 99])
        disp = np.clip((disp - lo) / max(hi - lo, 1e-4), 0, 1)
        obj = wall(pid, size, depth, disp)
        cam.data.ortho_scale = size
        for kind, samples in (("albedo", 16), ("normal", 16), ("ao", 96)):
            obj.data.materials.clear()
            obj.data.materials.append(material(kind, diff, nor, strength, distance))
            a = render(os.path.join(o.out, f"{pid}_{kind}.exr"), samples)
            np.save(os.path.join(o.out, f"{pid}_{kind}.npy"), a.astype(np.float32))
            print(f"BAKED {pid} {kind} mean={a.mean(axis=(0, 1)).round(3).tolist()}", flush=True)
        bpy.data.objects.remove(obj)
    print("BAKE COMPLETE", flush=True)


main()
