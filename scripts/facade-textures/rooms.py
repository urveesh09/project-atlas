"""Render the rooms seen through the city's windows (ADR-104).

    blender -b --factory-startup -P scripts/facade-textures/rooms.py -- --src <maps> --out <dir> [--res 256] [--threads 3]

Builds 16 small furnished rooms (living rooms, offices, bedrooms, kitchens, studies and a
store room) and renders each once, from outside its window, as a pre-projected interior:
the camera stands on the room's axis `CN` half-depths in front of the window plane with a
field of view that exactly frames the window opening, so the facade shader can map any
point it finds on the room's walls, floor or ceiling straight to this image
(`uv = 0.5 + 0.5 * h.xy * CN / (1 + CN - h.z)` in the room's normalised box, front at
z = 1). Furniture stands against the back and side walls and low on the floor, where a
painted-on interior holds up from other angles.

`<maps>/<id>/` holds Poly Haven's `diff.jpg` for each id in TEXTURES (CC0). Writes
`<out>/room_<n>.png` (sRGB). pack.py --rooms assembles the atlas. Blender is a build tool
only: the viewer never runs it.
"""

import argparse
import math
import os
import random
import sys

import bpy

W, H, D = 3.0, 3.0, 4.5  # room width, height and depth in metres; the window is the front face
CN = 2.0  # camera distance in front of the window, in half-depths (shader constant)
TEXTURES = ["oak_veneer_03", "walnut_veneer", "rough_linen", "dirty_carpet"]
WALLS = ["#ebe5d9", "#ddd0b8", "#cdd6c6", "#d6d8db", "#c9d5e2", "#dcc3ac", "#e6dccb", "#d3cfc8"]

# (kind, wall paint, floor, seed): 16 rooms, row-major in the 4 x 4 atlas.
ROOMS = [
    ("living", 0, "oak", 1), ("office", 3, "carpet", 2), ("bedroom", 1, "oak", 3), ("kitchen", 6, "tile", 4),
    ("living", 2, "oak", 5), ("office", 7, "carpet", 6), ("study", 5, "oak", 7), ("living", 4, "carpet", 8),
    ("bedroom", 4, "carpet", 9), ("office", 0, "carpet", 10), ("kitchen", 1, "tile", 11), ("study", 3, "oak", 12),
    ("living", 5, "oak", 13), ("office", 6, "carpet", 14), ("bedroom", 7, "oak", 15), ("store", 3, "concrete", 16),
]


def args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--src", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--res", type=int, default=256)
    p.add_argument("--threads", type=int, default=3)
    p.add_argument("--samples", type=int, default=64)
    p.add_argument("--only", default="")
    return p.parse_args(argv)


def hex_rgb(h):
    h = h.lstrip("#")
    srgb = [int(h[i : i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple((c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4) for c in srgb) + (1.0,)


class Kit:
    """Materials and a unit cube shared by every object in a room."""

    def __init__(self, src):
        self.src = src
        self.cache = {}
        m = bpy.data.meshes.new("cube")
        v = [(x, y, z) for x in (-0.5, 0.5) for y in (-0.5, 0.5) for z in (-0.5, 0.5)]
        f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
        m.from_pydata(v, [], f)
        m.materials.append(None)  # one slot; each object fills it with its own material
        m.update()
        self.cube = m

    def _nodes(self, name):
        mat = bpy.data.materials.new(name)
        try:
            mat.use_nodes = True
        except Exception:
            pass
        return mat, mat.node_tree

    def paint(self, colour, rough=0.6, emit=0.0, metal=0.0):
        key = ("paint", colour, rough, emit, metal)
        if key not in self.cache:
            mat, nt = self._nodes(f"paint{len(self.cache)}")
            b = nt.nodes["Principled BSDF"]
            c = hex_rgb(colour) if isinstance(colour, str) else colour
            b.inputs["Base Color"].default_value = c
            b.inputs["Roughness"].default_value = rough
            b.inputs["Metallic"].default_value = metal
            if emit:
                b.inputs["Emission Color"].default_value = c
                b.inputs["Emission Strength"].default_value = emit
            self.cache[key] = mat
        return self.cache[key]

    def texture(self, pid, scale, tint=None, rough=0.5):
        key = ("tex", pid, scale, tint)
        if key not in self.cache:
            mat, nt = self._nodes(f"{pid}{len(self.cache)}")
            b = nt.nodes["Principled BSDF"]
            b.inputs["Roughness"].default_value = rough
            img = bpy.data.images.load(os.path.join(self.src, pid, "diff.jpg"), check_existing=True)
            t = nt.nodes.new("ShaderNodeTexImage")
            t.image = img
            t.projection = "BOX"
            t.projection_blend = 0.2
            co = nt.nodes.new("ShaderNodeTexCoord")
            mp = nt.nodes.new("ShaderNodeMapping")
            mp.inputs["Scale"].default_value = (scale, scale, scale)
            nt.links.new(co.outputs["Object"], mp.inputs["Vector"])
            nt.links.new(mp.outputs["Vector"], t.inputs["Vector"])
            out = t.outputs["Color"]
            if tint:
                mix = nt.nodes.new("ShaderNodeMix")
                mix.data_type = "RGBA"
                mix.blend_type = "MULTIPLY"
                mix.inputs[0].default_value = 1.0
                mix.inputs[7].default_value = hex_rgb(tint)
                nt.links.new(out, mix.inputs[6])
                out = mix.outputs[2]
            nt.links.new(out, b.inputs["Base Color"])
            self.cache[key] = mat
        return self.cache[key]

    def box(self, size, centre, mat):
        o = bpy.data.objects.new("part", self.cube)
        o.scale = size
        o.location = centre
        o.material_slots[0].link = "OBJECT"
        o.material_slots[0].material = mat
        bpy.context.scene.collection.objects.link(o)
        return o


def shell(kit, paint, floor):
    """Floor, ceiling and three walls; the front is the open window."""
    t = 0.05
    wall = kit.paint(paint, 0.85)
    kit.box((W + 2 * t, D + t, t), (0, D / 2, -t / 2), floor)
    kit.box((W + 2 * t, D + t, t), (0, D / 2, H + t / 2), kit.paint("#f4f2ee", 0.9))
    kit.box((W + 2 * t, t, H), (0, D + t / 2, H / 2), wall)
    for s in (-1, 1):
        kit.box((t, D + t, H), (s * (W / 2 + t / 2), D / 2, H / 2), wall)
    # Skirting and a ceiling light.
    kit.box((W, 0.02, 0.1), (0, D - 0.01, 0.05), kit.paint("#f2f0ea", 0.5))


def frame(kit, rnd, x, y, z, w, h, on_side=None):
    """A picture on the back wall (or a side wall when on_side is -1 or 1)."""
    art = kit.paint(rnd.choice(["#3b5a7a", "#a0522d", "#556b2f", "#c49a3a", "#7a3b4f", "#2f4f4f"]), 0.7)
    if on_side:
        kit.box((0.03, w + 0.06, h + 0.06), (x, y, z), kit.paint("#222222", 0.4))
        kit.box((0.035, w, h), (x - on_side * 0.005, y, z), art)
    else:
        kit.box((w + 0.06, 0.03, h + 0.06), (x, y, z), kit.paint("#222222", 0.4))
        kit.box((w, 0.035, h), (x, y - 0.005, z), art)


def plant(kit, rnd, x, y, size=1.0):
    kit.box((0.32 * size, 0.32 * size, 0.38 * size), (x, y, 0.19 * size), kit.paint("#8b5a3c", 0.7))
    green = kit.paint(rnd.choice(["#2e5e2e", "#3d6b35", "#29502f"]), 0.8)
    for i in range(5):
        a = i * 1.3
        kit.box((0.35 * size, 0.35 * size, 0.5 * size), (x + 0.1 * math.cos(a) * size, y + 0.1 * math.sin(a) * size, (0.6 + 0.12 * i) * size), green)


def ceiling_light(kit, x, y, w=0.6, d=0.6, strength=6.0):
    kit.box((w, d, 0.03), (x, y, H - 0.02), kit.paint("#fff4e0", 0.3, emit=strength))


def living(kit, rnd, k):
    fabric = kit.texture("rough_linen", 2.0, tint=rnd.choice(["#7a8a9a", "#9a7a5a", "#5a6a5a", "#8a5a5a", "#6a6a7a"]), rough=0.9)
    sw = rnd.uniform(1.8, 2.3)
    y = D - 0.5
    kit.box((sw, 0.9, 0.42), (0, y, 0.21), fabric)
    kit.box((sw, 0.22, 0.45), (0, D - 0.11, 0.62), fabric)
    for s in (-1, 1):
        kit.box((0.2, 0.9, 0.62), (s * (sw / 2 + 0.05), y, 0.31), fabric)
    kit.box((1.6, 2.0, 0.01), (0, D - 1.4, 0.005), kit.paint(rnd.choice(["#b8a88a", "#8a9aa8", "#a88a7a"]), 0.95))
    kit.box((0.9, 0.5, 0.4), (0, D - 1.4, 0.2), kit.texture("walnut_veneer", 1.5, rough=0.4))
    frame(kit, rnd, 0, D - 0.02, 1.65, rnd.uniform(0.8, 1.2), 0.65)
    s = rnd.choice((-1, 1))
    kit.box((0.04, 0.04, 1.5), (s * 1.25, D - 0.35, 0.75), kit.paint("#222222", 0.4, metal=1.0))
    kit.box((0.35, 0.35, 0.3), (s * 1.25, D - 0.35, 1.55), kit.paint("#fff0d0", 0.6, emit=4.0))
    plant(kit, rnd, -s * 1.2, D - 0.4)
    # TV on a low cabinet along a side wall.
    t = rnd.choice((-1, 1))
    kit.box((0.45, 1.6, 0.5), (t * (W / 2 - 0.23), D - 2.4, 0.25), kit.texture("walnut_veneer", 1.5, rough=0.4))
    kit.box((0.05, 1.2, 0.7), (t * (W / 2 - 0.05), D - 2.4, 1.25), kit.paint("#0b0c0e", 0.2))
    ceiling_light(kit, 0, D / 2, 0.5, 0.5, 4.0)


def office(kit, rnd, k):
    desk = kit.paint(rnd.choice(["#e8e6e1", "#c9b79c", "#d8d4cc"]), 0.4)
    dark = kit.paint("#1a1c20", 0.3)
    screen = kit.paint("#9fb6cc", 0.2, emit=1.5)
    chair = kit.paint(rnd.choice(["#2b2f36", "#3a3f4a", "#4a3a3a"]), 0.6)
    for x in (-0.75, 0.75):
        kit.box((1.3, 0.7, 0.04), (x, D - 0.4, 0.74), desk)
        kit.box((0.55, 0.03, 0.34), (x, D - 0.25, 1.0), dark)
        kit.box((0.52, 0.035, 0.3), (x, D - 0.27, 1.0), screen)
        kit.box((0.5, 0.5, 0.5), (x, D - 1.05, 0.45), chair)
        kit.box((0.5, 0.08, 0.55), (x, D - 1.3, 0.85), chair)
    for s in (-1, 1):
        kit.box((0.7, 1.4, 0.04), (s * (W / 2 - 0.36), D - 2.0, 0.74), desk)
        kit.box((0.03, 0.55, 0.34), (s * (W / 2 - 0.2), D - 2.0, 1.0), dark)
        kit.box((0.035, 0.52, 0.3), (s * (W / 2 - 0.22), D - 2.0, 1.0), screen)
    kit.box((0.02, 1.6, 0.9), (rnd.choice((-1, 1)) * (W / 2 - 0.01), D - 3.4, 1.5), kit.paint("#f5f5f3", 0.3))
    for y in (D - 1.0, D - 3.0):
        ceiling_light(kit, 0, y, 1.2, 0.3, 8.0)
    plant(kit, rnd, rnd.choice((-1, 1)) * 1.2, D - 3.6, 1.2)


def bedroom(kit, rnd, k):
    linen = kit.texture("rough_linen", 2.0, tint=rnd.choice(["#e8e4dc", "#b8c4d0", "#d0c0b0", "#c4ccc0"]), rough=0.95)
    wood = kit.texture(rnd.choice(["walnut_veneer", "oak_veneer_03"]), 1.5, rough=0.4)
    kit.box((1.7, 2.1, 0.5), (0, D - 1.05, 0.25), linen)
    kit.box((1.8, 0.08, 1.1), (0, D - 0.04, 0.55), wood)
    kit.box((1.6, 0.4, 0.15), (0, D - 0.3, 0.6), kit.paint("#f4f2ee", 0.9))
    for s in (-1, 1):
        kit.box((0.45, 0.4, 0.5), (s * 1.2, D - 0.25, 0.25), wood)
        kit.box((0.2, 0.2, 0.3), (s * 1.2, D - 0.25, 0.68), kit.paint("#ffe8c0", 0.6, emit=3.0))
    frame(kit, rnd, 0, D - 0.02, 1.75, 1.0, 0.5)
    t = rnd.choice((-1, 1))
    kit.box((0.6, 1.6, 2.2), (t * (W / 2 - 0.3), D - 3.0, 1.1), wood)
    ceiling_light(kit, 0, D / 2, 0.4, 0.4, 3.0)


def kitchen(kit, rnd, k):
    cab = kit.paint(rnd.choice(["#f0eee8", "#3c4a5a", "#6b7b5a", "#e8dcc8"]), 0.4)
    top = kit.paint("#eeeeea", 0.2)
    kit.box((W, 0.6, 0.88), (0, D - 0.3, 0.44), cab)
    kit.box((W, 0.62, 0.04), (0, D - 0.31, 0.9), top)
    kit.box((W, 0.35, 0.7), (0, D - 0.18, 1.85), cab)
    kit.box((W, 0.01, 0.55), (0, D - 0.01, 1.2), kit.paint("#d8d8d4", 0.2))
    s = rnd.choice((-1, 1))
    kit.box((0.7, 0.7, 1.9), (s * (W / 2 - 0.35), D - 1.0, 0.95), kit.paint("#c8ccd0", 0.25, metal=0.6))
    table = kit.texture("oak_veneer_03", 1.5, rough=0.4)
    kit.box((1.2, 0.8, 0.04), (0, D - 2.3, 0.75), table)
    for x in (-0.45, 0.45):
        for y in (D - 1.75, D - 2.85):
            kit.box((0.4, 0.4, 0.45), (x, y, 0.23), kit.paint("#5a4632", 0.6))
    kit.box((0.35, 0.35, 0.25), (0, D - 2.3, H - 0.6), kit.paint("#ffe6b0", 0.5, emit=6.0))
    kit.box((0.01, 0.01, 0.5), (0, D - 2.3, H - 0.25), kit.paint("#222222", 0.5))


def study(kit, rnd, k):
    wood = kit.texture(rnd.choice(["walnut_veneer", "oak_veneer_03"]), 1.5, rough=0.5)
    kit.box((W, 0.35, H - 0.2), (0, D - 0.175, (H - 0.2) / 2), wood)
    colours = ["#7a2e2e", "#2e4a7a", "#2e6a4a", "#c8a040", "#5a3a6a", "#d8d0c0", "#303030", "#a05030"]
    for shelf in range(6):
        z0 = 0.15 + shelf * 0.45
        x = -W / 2 + 0.05
        while x < W / 2 - 0.1:
            w = rnd.uniform(0.03, 0.07)
            h = rnd.uniform(0.22, 0.36)
            kit.box((w, 0.25, h), (x + w / 2, D - 0.37, z0 + h / 2), kit.paint(rnd.choice(colours), 0.8))
            x += w + 0.005
            if rnd.random() < 0.06:
                x += rnd.uniform(0.1, 0.3)
    kit.box((1.4, 0.7, 0.04), (0, D - 1.6, 0.75), wood)
    kit.box((0.25, 0.25, 0.35), (0.5, D - 1.6, 0.95), kit.paint("#ffe8c0", 0.6, emit=4.0))
    kit.box((0.5, 0.5, 0.5), (0, D - 2.2, 0.45), kit.texture("rough_linen", 2.0, tint="#6a3a2a", rough=0.8))
    ceiling_light(kit, 0, D / 2, 0.4, 0.4, 3.0)


def store(kit, rnd, k):
    card = kit.paint("#b08a5a", 0.9)
    for i in range(14):
        x = rnd.uniform(-1.2, 1.2)
        y = D - rnd.uniform(0.3, 1.8)
        s = rnd.uniform(0.35, 0.6)
        stack = rnd.randint(1, 3)
        for j in range(stack):
            kit.box((s, s, s * 0.8), (x, y, s * 0.4 + j * s * 0.8), card)
    kit.box((0.15, 0.15, 0.15), (0, D / 2, H - 0.3), kit.paint("#fff0d0", 0.5, emit=8.0))


def main():
    o = args()
    os.makedirs(o.out, exist_ok=True)
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj)
    s = bpy.context.scene
    s.render.engine = "CYCLES"
    s.cycles.device = "CPU"
    s.cycles.samples = o.samples
    s.cycles.use_denoising = True
    s.render.threads_mode = "FIXED"
    s.render.threads = o.threads
    s.render.resolution_x = s.render.resolution_y = o.res
    s.render.resolution_percentage = 100
    try:
        s.render.image_settings.media_type = "IMAGE"
    except Exception:
        pass
    s.render.image_settings.file_format = "PNG"
    s.render.image_settings.color_depth = "8"
    s.view_settings.view_transform = "AgX"
    world = bpy.data.worlds.new("sky")
    world.color = (0.55, 0.62, 0.72)
    s.world = world
    try:
        world.use_nodes = True
    except Exception:
        pass
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs["Color"].default_value = (0.55, 0.62, 0.72, 1)
        bg.inputs["Strength"].default_value = 0.6
    kit = Kit(o.src)
    c = CN * D / 2
    for n, (kind, paint, floor, seed) in enumerate(ROOMS):
        if o.only and str(n) not in o.only.split(","):
            continue
        for obj in list(bpy.data.objects):
            bpy.data.objects.remove(obj)
        rnd = random.Random(seed)
        floors = {
            "oak": kit.texture("oak_veneer_03", 0.8, rough=0.45),
            "carpet": kit.texture("dirty_carpet", 1.0, tint="#9a9a9a", rough=0.95),
            "tile": kit.paint("#cfcac0", 0.3),
            "concrete": kit.paint("#8a8a86", 0.8),
        }
        shell(kit, WALLS[paint], floors[floor])
        {"living": living, "office": office, "bedroom": bedroom, "kitchen": kitchen, "study": study, "store": store}[kind](kit, rnd, n)
        # Daylight through the window: a low sun from outside and the sky.
        sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
        sun.data.energy = 2.5
        sun.data.angle = math.radians(3)
        # A sun points down its -Z; tilting +X aims it through the window into the room (+Y).
        sun.rotation_euler = (math.radians(55), math.radians(rnd.uniform(-25, 25)), 0)
        s.collection.objects.link(sun)
        cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
        cam.data.sensor_fit = "HORIZONTAL"
        cam.data.angle = 2 * math.atan((W / 2) / c)
        cam.data.clip_start = 0.05
        cam.location = (0, -c, H / 2)
        cam.rotation_euler = (math.pi / 2, 0, 0)
        s.collection.objects.link(cam)
        s.camera = cam
        s.render.filepath = os.path.join(o.out, f"room_{n:02d}.png")
        bpy.ops.render.render(write_still=True)
        print(f"ROOM {n} {kind}", flush=True)
    print("ROOMS COMPLETE", flush=True)


main()
