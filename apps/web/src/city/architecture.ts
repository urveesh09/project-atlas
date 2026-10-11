import * as THREE from 'three';
import { seedFromId, xorshift32, type CityBuilding, type CityData } from '@atlas/layout';

/**
 * Decorative architecture for the 3D city (plan §11.1, §11.5). Nothing here encodes data:
 * height stays code lines, facade colour stays the lens and the roof stays the role. The
 * archetype, footprint trim, window pattern and greenery are seeded from layout IDs, so a
 * plot keeps its look across frames and lenses, and Math.random() is never used.
 */

interface Tier {
  /** Fraction of the body span; the instance scales y to the building's height. */
  y0: number;
  y1: number;
  sides: 4 | 8 | 12;
  /** Half extents in plot cells (circumradius for 8/12 sides). */
  hx: number;
  hz: number;
  /** Top outline scale relative to the bottom. */
  taper: number;
  /** Brightness multiplier that keeps the lens hue. */
  shade: number;
}
const box = (y0: number, y1: number, hx: number, hz = hx, shade = 1, taper = 1): Tier => ({ y0, y1, sides: 4, hx, hz, taper, shade });
const ring = (y0: number, y1: number, sides: 8 | 12, r: number, shade = 1, taper = 1): Tier => ({ y0, y1, sides, hx: r, hz: r, taper, shade });

/** Body archetypes. Every tier is centred, so the role roof always sits on the top tier. */
export const ARCHETYPES: readonly { name: string; tiers: readonly Tier[] }[] = [
  { name: 'block', tiers: [box(0, 1, 0.44)] },
  { name: 'slab', tiers: [box(0, 1, 0.45, 0.3)] },
  { name: 'setback', tiers: [box(0, 0.5, 0.45, 0.45, 0.94), box(0.5, 0.8, 0.37), box(0.8, 1, 0.29, 0.29, 1.05)] },
  { name: 'podium', tiers: [box(0, 0.16, 0.46, 0.46, 0.88), ring(0.16, 1, 8, 0.42)] },
  { name: 'rotunda', tiers: [ring(0, 1, 12, 0.44, 1, 0.9)] },
  { name: 'tapered', tiers: [box(0, 1, 0.44, 0.44, 1, 0.74)] },
  { name: 'cornice', tiers: [box(0, 0.92, 0.4), box(0.92, 0.945, 0.45, 0.45, 0.84), box(0.945, 1, 0.37)] },
  { name: 'stepped', tiers: [box(0, 0.62, 0.44, 0.36), box(0.62, 1, 0.3, 0.36, 1.05)] },
];
/** Neighbourhood families: one per district, so blocks read as distinct quarters. */
const FAMILIES = [
  [0, 6, 2], // classic
  [1, 3, 4], // modern
  [2, 5, 6], // deco
  [0, 1, 4, 5], // mixed
] as const;
/** Fixed-height kiosk and declaration roles stay simple, low forms. */
const LOW = [0, 1, 7] as const;
const FOOTPRINTS = [0.92, 0.96, 1] as const;

export interface BuildingStyle {
  archetype: number;
  footprint: number;
  rotation: number;
  /** 0 punched, 1 ribbon, 2 vertical strips, 3 curtain grid. */
  windows: number;
  /** Stable [0, 1) value for per-window variation. */
  variant: number;
}

export function districtFamily(districtId: string): number {
  return xorshift32(seedFromId(districtId))() % FAMILIES.length;
}

export function buildingStyle(b: CityBuilding, family = districtFamily(b.districtId)): BuildingStyle {
  const next = xorshift32(b.seed);
  const tall = (b.role === 'source' || b.role === 'test') && b.parseStatus === 'parsed';
  const pool: readonly number[] = tall ? FAMILIES[family]! : LOW;
  const archetype = pool[next() % pool.length]!;
  const footprint = FOOTPRINTS[next() % FOOTPRINTS.length]!;
  const rotation = ((next() % 4) * Math.PI) / 2;
  const windows = next() % 4 === 0 ? next() % 4 : family;
  return { archetype, footprint, rotation, windows, variant: (next() % 1000) / 1000 };
}

/** Half extents of an archetype's top outline, for fitting the role roof. */
export function topExtent(archetype: number): [number, number] {
  const t = ARCHETYPES[archetype]!.tiers.at(-1)!;
  if (t.sides === 4) return [t.hx * t.taper, t.hz * t.taper];
  const apothem = t.hx * Math.cos(Math.PI / t.sides) * t.taper;
  return [apothem, apothem];
}

function outline(t: Tier): [number, number][] {
  if (t.sides === 4)
    return [
      [t.hx, t.hz],
      [-t.hx, t.hz],
      [-t.hx, -t.hz],
      [t.hx, -t.hz],
    ];
  return Array.from({ length: t.sides }, (_, k) => {
    const a = Math.PI / t.sides + (2 * Math.PI * k) / t.sides;
    return [t.hx * Math.cos(a), t.hx * Math.sin(a)] as [number, number];
  });
}

/**
 * Flat-shaded tiered prism in a unit-height body. `atlasFace` carries, per side face, the
 * position across the face, the face width (signed by axis), the position up the tier and
 * the tier height, so the facade shader fits whole windows to any instance scale.
 */
export function archetypeGeometry(archetype: number): THREE.BufferGeometry {
  const position: number[] = [],
    normal: number[] = [],
    face: number[] = [],
    shade: number[] = [];
  const a = new THREE.Vector3(),
    b = new THREE.Vector3(),
    n = new THREE.Vector3();
  const emit = (
    verts: readonly THREE.Vector3[],
    attrs: readonly (readonly [number, number, number, number])[],
    outward: THREE.Vector3,
    s: number,
  ) => {
    n.crossVectors(a.subVectors(verts[1]!, verts[0]!), b.subVectors(verts[2]!, verts[0]!)).normalize();
    const order = n.dot(outward) < 0 ? [0, 2, 1] : [0, 1, 2];
    if (n.dot(outward) < 0) n.negate();
    for (const i of order) {
      position.push(verts[i]!.x, verts[i]!.y, verts[i]!.z);
      normal.push(n.x, n.y, n.z);
      face.push(...attrs[i]!);
      shade.push(s);
    }
  };
  for (const t of ARCHETYPES[archetype]!.tiers) {
    const bottom = outline(t);
    const top = bottom.map(([x, z]) => [x * t.taper, z * t.taper] as const);
    const height = t.y1 - t.y0;
    for (let i = 0; i < bottom.length; i++) {
      const j = (i + 1) % bottom.length;
      const b0 = new THREE.Vector3(bottom[i]![0], t.y0, bottom[i]![1]),
        b1 = new THREE.Vector3(bottom[j]![0], t.y0, bottom[j]![1]),
        t1 = new THREE.Vector3(top[j]![0], t.y1, top[j]![1]),
        t0 = new THREE.Vector3(top[i]![0], t.y1, top[i]![1]);
      const dx = b1.x - b0.x,
        dz = b1.z - b0.z;
      const width = Math.hypot(dx, dz) * (t.sides === 4 && Math.abs(dz) > Math.abs(dx) ? -1 : 1);
      const outward = new THREE.Vector3((b0.x + b1.x) / 2, 0, (b0.z + b1.z) / 2);
      const f = (u: number, v: number) => [u, width, v, height] as const;
      emit([b0, b1, t1], [f(0, 0), f(1, 0), f(1, 1)], outward, t.shade);
      emit([b0, t1, t0], [f(0, 0), f(1, 1), f(0, 1)], outward, t.shade);
    }
    const centre = new THREE.Vector3(0, t.y1, 0),
      up = new THREE.Vector3(0, 1, 0),
      cap = [0, 0, 0, 0] as const;
    for (let i = 0; i < top.length; i++) {
      const j = (i + 1) % top.length;
      emit(
        [centre, new THREE.Vector3(top[i]![0], t.y1, top[i]![1]), new THREE.Vector3(top[j]![0], t.y1, top[j]![1])],
        [cap, cap, cap],
        up,
        t.shade,
      );
    }
  }
  return new THREE.BufferGeometry()
    .setAttribute('position', new THREE.Float32BufferAttribute(position, 3))
    .setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3))
    .setAttribute('atlasFace', new THREE.Float32BufferAttribute(face, 4))
    .setAttribute('atlasShade', new THREE.Float32BufferAttribute(shade, 1));
}

/**
 * Lens-coloured facade. Windows are a darker tint of the facade colour, drawn only where a
 * window spans several pixels, so far views keep the exact lens colour. A soft base
 * gradient stands in for ambient occlusion. `detail` false compiles the windows out.
 */
export function facadeMaterial(detail: boolean): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial();
  material.defines = { ATLAS_WINDOWS: detail ? 1 : 0 };
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec4 atlasFace;
attribute float atlasShade;
attribute vec2 atlasStyle;
varying vec4 vAtlasFace;
varying float vAtlasShade;
varying float vAtlasY;
varying vec2 vAtlasStyle;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
#ifdef USE_INSTANCING
  vec3 atlasScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
#else
  vec3 atlasScale = vec3(1.0);
#endif
  vAtlasFace = vec4(atlasFace.x, atlasFace.y >= 0.0 ? atlasFace.y * atlasScale.x : -atlasFace.y * atlasScale.z, atlasFace.z, atlasFace.w * atlasScale.y);
  vAtlasShade = atlasShade;
  vAtlasY = position.y * atlasScale.y;
  vAtlasStyle = atlasStyle;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec4 vAtlasFace;
varying float vAtlasShade;
varying float vAtlasY;
varying vec2 vAtlasStyle;
float atlasHash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  vec3 atlasWall = diffuseColor.rgb * vAtlasShade;
#if ATLAS_WINDOWS
  float style = floor(vAtlasStyle.x + 0.5);
  vec2 size = style == 1.0 ? vec2(0.34, 0.3) : style == 2.0 ? vec2(0.15, 0.3) : style == 3.0 ? vec2(0.13, 0.22) : vec2(0.2, 0.3);
  vec2 lo = style == 1.0 ? vec2(0.03, 0.3) : style == 2.0 ? vec2(0.3, 0.1) : style == 3.0 ? vec2(0.12, 0.16) : vec2(0.24, 0.3);
  vec2 hi = style == 1.0 ? vec2(0.97, 0.8) : style == 2.0 ? vec2(0.7, 0.96) : style == 3.0 ? vec2(0.88, 0.86) : vec2(0.76, 0.8);
  vec2 count = max(vec2(1.0), floor(vec2(vAtlasFace.y, vAtlasFace.w) / size + 0.5));
  vec2 cell = vec2(vAtlasFace.x, vAtlasFace.z) * count;
  vec2 f = fract(cell);
  vec2 fw = max(fwidth(cell), vec2(1e-4));
  vec2 inside = smoothstep(lo - fw, lo + fw, f) * (1.0 - smoothstep(hi - fw, hi + fw, f));
  float facade = step(1e-4, vAtlasFace.y) * step(1e-4, vAtlasFace.w);
  float fade = 1.0 - smoothstep(0.3, 0.55, max(fw.x, fw.y));
  float atlasWindow = inside.x * inside.y * facade * fade;
  float atlasNoise = atlasHash(vec3(floor(cell), vAtlasStyle.y * 97.0 + vAtlasFace.y * 13.0));
  vec3 atlasGlass = mix(atlasWall * 0.5, vec3(0.15, 0.2, 0.27), 0.4) * (0.85 + 0.3 * atlasNoise);
  float atlasLit = step(0.95, atlasNoise);
  atlasGlass = mix(atlasGlass, vec3(1.0, 0.86, 0.58), atlasLit * 0.75);
  atlasWall = mix(atlasWall, atlasGlass, atlasWindow);
  totalEmissiveRadiance += vec3(0.5, 0.4, 0.22) * atlasLit * atlasWindow;
#endif
  diffuseColor.rgb = atlasWall * mix(0.76, 1.0, smoothstep(0.08, 0.9, vAtlasY));
}`,
      );
  };
  material.customProgramCacheKey = () => `atlas-facade-${detail ? 1 : 0}`;
  return material;
}

/** Top of a district plinth: nested blocks step up gently, capped so towers stay legible. */
export const groundLevel = (depth: number) => 0.1 + Math.min(depth, 4) * 0.05;

export interface Tree {
  x: number;
  y: number;
  z: number;
  kind: 0 | 1;
  scale: number;
  tint: number;
}
export interface Lawn {
  x: number;
  y: number;
  z: number;
  width: number;
  depth: number;
}
const MAX_TREES = 15_000;

/**
 * Layout-stable greenery. Lawns and trees use only space the packer leaves free: each
 * district's 2-cell header strip, the 1-cell border of package districts and the green belt
 * beyond the perimeter road. They never sit on a plot.
 */
export function cityDecor(city: CityData): { trees: Tree[]; lawns: Lawn[] } {
  const trees: Tree[] = [],
    lawns: Lawn[] = [];
  const plant = (next: () => number, x: number, y: number, z: number, conifer: number) => {
    if (trees.length >= MAX_TREES) return;
    trees.push({
      x: x + ((next() % 21) - 10) * 0.012,
      y,
      z: z + ((next() % 21) - 10) * 0.012,
      kind: next() % 100 < conifer ? 1 : 0,
      scale: 0.8 + (next() % 9) * 0.05,
      tint: next() % 5,
    });
  };
  for (const d of city.districts) {
    if (d.depth === 0) continue;
    const x = d.rect.x / 100,
      z = d.rect.z / 100,
      w = d.rect.width / 100,
      depth = d.rect.depth / 100;
    // Empty-district markers have no header strip.
    if (w < 3 || depth < 5) continue;
    const next = xorshift32(seedFromId(d.id));
    const y = groundLevel(d.depth) + 0.03;
    const conifer = d.kind === 'package' ? 15 : 35;
    lawns.push({ x: x + w / 2, y, z: z + 2, width: w - 2.3, depth: 1.7 });
    for (let tx = x + 1.75; tx <= x + w - 1.75; tx += 1.5) if (next() % 100 >= 30) plant(next, tx, y, z + 2, conifer);
    if (d.kind !== 'package') continue;
    for (let tz = z + 3.5; tz <= z + depth - 1; tz += 2) {
      if (next() % 100 >= 40) plant(next, x + 0.5, y, tz, conifer);
      if (next() % 100 >= 40) plant(next, x + w - 0.5, y, tz, conifer);
    }
    for (let tx = x + 1.5; tx <= x + w - 1.5; tx += 2) if (next() % 100 >= 40) plant(next, tx, y, z + depth - 0.5, conifer);
  }
  // Green belt between the perimeter road (3 cells) and the beach (5.5 cells).
  const r = city.root,
    x0 = r.x / 100 - 4.25,
    z0 = r.z / 100 - 4.25,
    x1 = (r.x + r.width) / 100 + 4.25,
    z1 = (r.z + r.depth) / 100 + 4.25;
  const next = xorshift32(seedFromId(`root_${(r.width * 31 + r.depth).toString(16).padStart(8, '0')}`));
  for (let t = x0; t <= x1; t += 2) {
    if (next() % 100 >= 35) plant(next, t, 0.03, z0, 50);
    if (next() % 100 >= 35) plant(next, t, 0.03, z1, 50);
  }
  for (let t = z0 + 2; t <= z1 - 2; t += 2) {
    if (next() % 100 >= 35) plant(next, x0, 0.03, t, 50);
    if (next() % 100 >= 35) plant(next, x1, 0.03, t, 50);
  }
  return { trees, lawns };
}

/** Low-poly trees with vertex colours; instance colour varies the foliage tint. */
export function treeGeometry(kind: 0 | 1): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.035, 0.05, 0.22, 5).translate(0, 0.11, 0);
  const crown =
    kind === 0
      ? new THREE.IcosahedronGeometry(0.26, 0).scale(1, 0.95, 1).translate(0, 0.42, 0)
      : new THREE.ConeGeometry(0.22, 0.62, 6).translate(0, 0.5, 0);
  const parts = [trunk.toNonIndexed(), crown.toNonIndexed()];
  trunk.dispose();
  crown.dispose();
  const colours = [new THREE.Color('#7b6248'), new THREE.Color('#ffffff')];
  const position: number[] = [],
    normal: number[] = [],
    color: number[] = [];
  parts.forEach((g, i) => {
    g.computeVertexNormals();
    position.push(...g.getAttribute('position').array);
    normal.push(...g.getAttribute('normal').array);
    for (let v = 0; v < g.getAttribute('position').count; v++) color.push(colours[i]!.r, colours[i]!.g, colours[i]!.b);
    g.dispose();
  });
  return new THREE.BufferGeometry()
    .setAttribute('position', new THREE.Float32BufferAttribute(position, 3))
    .setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3))
    .setAttribute('color', new THREE.Float32BufferAttribute(color, 3));
}
export const TREE_TINTS = ['#6f9a5c', '#7fa866', '#5f8d58', '#8aaf6a', '#6a9468'] as const;

/** Unit gable roof: ridge along x at y = 1, eaves on z = ±0.5. */
export function gableGeometry(): THREE.BufferGeometry {
  const v = [
    // slopes
    [-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 1, 0], [-0.5, 0, 0.5], [0.5, 1, 0], [-0.5, 1, 0],
    [0.5, 0, -0.5], [-0.5, 0, -0.5], [-0.5, 1, 0], [0.5, 0, -0.5], [-0.5, 1, 0], [0.5, 1, 0],
    // gables
    [0.5, 0, 0.5], [0.5, 0, -0.5], [0.5, 1, 0], [-0.5, 0, -0.5], [-0.5, 0, 0.5], [-0.5, 1, 0],
  ].flat();
  const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}
