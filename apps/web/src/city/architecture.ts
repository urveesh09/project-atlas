import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { seedFromId, xorshift32, type CityBuilding, type CityData } from '@atlas/layout';
import { THEMES, type Archetype, type CityTheme, type LampKind, type PartKind, type Tier, type TreeKind } from './themes';

/** Parts with their own fixed stone or metal colour; the rest take a shade of the lens colour. */
export const FIXED_PARTS: ReadonlySet<PartKind> = new Set(['platform', 'terrace', 'rooftop']);
/** Parts that stand at the corners of a square top rather than wrapping the wall. */
export const CORNER_PARTS: ReadonlySet<PartKind> = new Set(['turret', 'pinnacle', 'chimney', 'rooftop']);

/**
 * Decorative architecture for the 3D city (plan §11.1, §11.5; ADR-038, ADR-039). Nothing
 * here encodes data: height stays code lines, the facade keeps exactly one lens colour and the
 * roof stays the role. Archetype, footprint trim, window pattern, accent parts and greenery are
 * seeded from layout IDs, so a plot keeps its look across frames and lenses, and Math.random()
 * is never used.
 */

export interface BuildingStyle {
  archetype: number;
  footprint: number;
  rotation: number;
  /** Facade window pattern (see `WINDOW`). */
  windows: number;
  /** Stable [0, 1) value for per-window variation. */
  variant: number;
  /** Ground-storey treatment (see `BASE`). */
  base: number;
}

const FOOTPRINTS = [0.92, 0.96, 1] as const;

export function districtFamily(districtId: string, theme: CityTheme = 'modern'): number {
  return xorshift32(seedFromId(districtId))() % THEMES[theme].families.length;
}

export function buildingStyle(b: CityBuilding, family: number, theme: CityTheme = 'modern'): BuildingStyle {
  const spec = THEMES[theme];
  const next = xorshift32(b.seed);
  const tall = (b.role === 'source' || b.role === 'test') && b.parseStatus === 'parsed';
  const pool = tall ? spec.families[family]! : spec.low;
  const archetype = pool[next() % pool.length]!;
  const footprint = FOOTPRINTS[next() % FOOTPRINTS.length]!;
  const rotation = ((next() % 4) * Math.PI) / 2;
  const patterns = tall ? spec.windows[family]! : spec.lowWindows;
  const windows = patterns[next() % patterns.length]!;
  return { archetype, footprint, rotation, windows, variant: (next() % 1000) / 1000, base: spec.archetypes[archetype]!.base ?? 0 };
}

/** Outline of an archetype at a fraction of its height: sides and half extents. */
export function wallAt(a: Archetype, fraction: number): { sides: Tier['sides']; hx: number; hz: number } {
  const t = a.tiers.find((t) => fraction <= t.y1) ?? a.tiers.at(-1)!;
  const local = Math.min(1, Math.max(0, (fraction - t.y0) / (t.y1 - t.y0)));
  const scale = 1 + (t.taper - 1) * local;
  return { sides: t.sides, hx: t.hx * scale, hz: t.hz * scale };
}

/** Half extents of an archetype's top outline, for fitting the role roof. */
export function topExtent(a: Archetype): [number, number] {
  const t = a.tiers.at(-1)!;
  if (t.sides === 4) return [t.hx * t.taper, t.hz * t.taper];
  const apothem = t.hx * Math.cos(Math.PI / t.sides) * t.taper;
  return [apothem, apothem];
}

function outline(sides: Tier['sides'], hx: number, hz: number): [number, number][] {
  if (sides === 4)
    return [
      [hx, hz],
      [-hx, hz],
      [-hx, -hz],
      [hx, -hz],
    ];
  return Array.from({ length: sides }, (_, k) => {
    const a = Math.PI / sides + (2 * Math.PI * k) / sides;
    return [hx * Math.cos(a), hz * Math.sin(a)] as [number, number];
  });
}

const ZERO = [0, 0, 0, 0] as const;

/**
 * Index a triangle soup so corners are shaded once. Tens of thousands of instanced parts made
 * per-triangle vertices the fantasy cities' main GPU cost; parts drop their normals and are
 * flat-shaded per fragment instead (`flatShading` materials).
 */
function shared(g: THREE.BufferGeometry, keepNormals: boolean): THREE.BufferGeometry {
  if (!keepNormals) g.deleteAttribute('normal');
  const indexed = mergeVertices(g, 1e-5);
  g.dispose();
  return indexed;
}
const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Non-indexed triangle soup with flat normals, each triangle turned to face `towards`. */
class Mesher {
  readonly position: number[] = [];
  readonly normal: number[] = [];
  readonly face: number[] = [];
  readonly shade: number[] = [];
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly n = new THREE.Vector3();
  tri(
    v: readonly [THREE.Vector3, THREE.Vector3, THREE.Vector3],
    towards: THREE.Vector3,
    face: readonly (readonly [number, number, number, number])[] = [ZERO, ZERO, ZERO],
    shade = 1,
  ) {
    this.n.crossVectors(this.a.subVectors(v[1], v[0]), this.b.subVectors(v[2], v[0]));
    if (this.n.lengthSq() < 1e-12) return;
    this.n.normalize();
    const flip = this.n.dot(towards) < 0;
    if (flip) this.n.negate();
    for (const i of flip ? [0, 2, 1] : [0, 1, 2]) {
      this.position.push(v[i]!.x, v[i]!.y, v[i]!.z);
      this.normal.push(this.n.x, this.n.y, this.n.z);
      this.face.push(...face[i]!);
      this.shade.push(shade);
    }
  }
  quad(v: readonly [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3], towards: THREE.Vector3) {
    this.tri([v[0], v[1], v[2]], towards);
    this.tri([v[0], v[2], v[3]], towards);
  }
  geometry(withFacade: boolean): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry()
      .setAttribute('position', new THREE.Float32BufferAttribute(this.position, 3))
      .setAttribute('normal', new THREE.Float32BufferAttribute(this.normal, 3));
    if (withFacade)
      g.setAttribute('atlasFace', new THREE.Float32BufferAttribute(this.face, 4)).setAttribute(
        'atlasShade',
        new THREE.Float32BufferAttribute(this.shade, 1),
      );
    return g;
  }
}

/** Tiered prism sides and top caps; bodies omit the bottom cap because they stand in a plinth. */
function prism(m: Mesher, tiers: readonly Tier[], bottomCap = false) {
  for (const t of tiers) {
    const bottom = outline(t.sides, t.hx, t.hz);
    const top = bottom.map(([x, z]) => [x * t.taper, z * t.taper] as const);
    const height = t.y1 - t.y0;
    for (let i = 0; i < bottom.length; i++) {
      const j = (i + 1) % bottom.length;
      const b0 = v3(bottom[i]![0], t.y0, bottom[i]![1]),
        b1 = v3(bottom[j]![0], t.y0, bottom[j]![1]),
        t1 = v3(top[j]![0], t.y1, top[j]![1]),
        t0 = v3(top[i]![0], t.y1, top[i]![1]);
      const dx = b1.x - b0.x,
        dz = b1.z - b0.z;
      // The face width is signed by axis so the shader scales it by the right instance axis.
      const width = Math.hypot(dx, dz) * (t.sides === 4 && Math.abs(dz) > Math.abs(dx) ? -1 : 1);
      const out = v3((b0.x + b1.x) / 2, 0, (b0.z + b1.z) / 2);
      const f = (u: number, v: number) => [u, width, v, height] as const;
      m.tri([b0, b1, t1], out, [f(0, 0), f(1, 0), f(1, 1)], t.shade);
      m.tri([b0, t1, t0], out, [f(0, 0), f(1, 1), f(0, 1)], t.shade);
    }
    for (let i = 0; i < top.length; i++) {
      const j = (i + 1) % top.length;
      m.tri([v3(0, t.y1, 0), v3(top[i]![0], t.y1, top[i]![1]), v3(top[j]![0], t.y1, top[j]![1])], UP, undefined, t.shade);
      if (bottomCap)
        m.tri([v3(0, t.y0, 0), v3(bottom[i]![0], t.y0, bottom[i]![1]), v3(bottom[j]![0], t.y0, bottom[j]![1])], DOWN, undefined, t.shade);
    }
  }
}

/**
 * Flat-shaded tiered prism in a unit-height body. `atlasFace` carries, per side face, the
 * position across the face, the face width (signed by axis), the position up the tier and
 * the tier height, so the facade shader fits whole windows to any instance scale.
 */
export function archetypeGeometry(a: Archetype): THREE.BufferGeometry {
  const m = new Mesher();
  prism(m, a.tiers);
  // Facade corners share a face's normal and window coordinates, so they index cleanly.
  return shared(m.geometry(true), true);
}

/**
 * Accent part in a unit outline (corners at ±1 for 4 sides, circumradius 1 otherwise) and
 * unit height; the renderer scales it to the wall at the storey where it sits.
 */
export function partGeometry(kind: PartKind, sides: Tier['sides']): THREE.BufferGeometry {
  const m = new Mesher();
  const unit = (y0: number, y1: number, h: number): Tier => ({ y0, y1, sides: 4, hx: h, hz: h, taper: 1, shade: 1 });
  switch (kind) {
    case 'band':
      prism(m, [{ y0: 0, y1: 1, sides, hx: 1, hz: 1, taper: 1, shade: 1 }], true);
      break;
    case 'platform':
      prism(m, [unit(0, 0.55, 1), unit(0.55, 1, 0.84)], true);
      break;
    case 'terrace':
      // Three marble tiers, the top one ringed by a low balustrade.
      prism(m, [unit(0, 0.3, 1), unit(0.3, 0.6, 0.9), unit(0.6, 0.86, 0.8)], true);
      shell(m, 4, 0.8, 0.75, 0.86, 1.06);
      break;
    case 'eave':
      eave(m, sides);
      break;
    case 'crenel': {
      prism(m, [{ y0: 0, y1: 0.45, sides, hx: 1, hz: 1, taper: 1, shade: 1 }], true);
      const band = m.geometry(false),
        teeth = merlons(sides);
      const merged = mergeFlat([band, teeth]);
      band.dispose();
      teeth.dispose();
      return merged;
    }
    default:
      return cornerPartGeometry(kind);
  }
  return shared(m.geometry(false), false);
}

/** A ring wall between two square outlines (balustrades, parapets). */
function shell(m: Mesher, sides: Tier['sides'], outer: number, inner: number, y0: number, y1: number) {
  const a = outline(sides, outer, outer),
    b = outline(sides, inner, inner);
  for (let i = 0; i < a.length; i++) {
    const j = (i + 1) % a.length;
    const out = v3((a[i]![0] + a[j]![0]) / 2, 0, (a[i]![1] + a[j]![1]) / 2);
    m.quad([v3(a[i]![0], y0, a[i]![1]), v3(a[j]![0], y0, a[j]![1]), v3(a[j]![0], y1, a[j]![1]), v3(a[i]![0], y1, a[i]![1])], out);
    m.quad([v3(b[i]![0], y0, b[i]![1]), v3(b[j]![0], y0, b[j]![1]), v3(b[j]![0], y1, b[j]![1]), v3(b[i]![0], y1, b[i]![1])], out.clone().negate());
    m.quad([v3(a[i]![0], y1, a[i]![1]), v3(a[j]![0], y1, a[j]![1]), v3(b[j]![0], y1, b[j]![1]), v3(b[i]![0], y1, b[i]![1])], UP);
  }
}

/**
 * Corner furniture in a unit cell standing on y = 0, coloured per vertex (white takes the
 * instance's lens shade; dark caps stay dark): castle turrets, gothic pinnacles, chimneys and
 * modern rooftop plant.
 */
function cornerPartGeometry(kind: PartKind): THREE.BufferGeometry {
  const body = new THREE.Color('#ffffff'),
    cap = new THREE.Color('#5a5f66'),
    soot = new THREE.Color('#6b5d55');
  let parts: [THREE.BufferGeometry, THREE.Color][];
  if (kind === 'turret')
    parts = [
      [new THREE.CylinderGeometry(0.42, 0.46, 0.72, 10).translate(0, 0.36, 0), body],
      [new THREE.CylinderGeometry(0.5, 0.5, 0.06, 10).translate(0, 0.73, 0), body],
      [new THREE.ConeGeometry(0.52, 0.42, 10).translate(0, 0.97, 0), cap],
    ];
  else if (kind === 'pinnacle')
    parts = [
      [new THREE.BoxGeometry(0.5, 0.32, 0.5).translate(0, 0.16, 0), body],
      [new THREE.ConeGeometry(0.3, 0.68, 6).translate(0, 0.66, 0), body],
    ];
  else if (kind === 'chimney')
    parts = [
      [new THREE.BoxGeometry(0.6, 0.86, 0.6).translate(0, 0.43, 0), body],
      [new THREE.BoxGeometry(0.76, 0.14, 0.76).translate(0, 0.93, 0), soot],
    ];
  else
    parts = [
      [new THREE.BoxGeometry(1, 0.62, 0.8).translate(0, 0.31, 0), new THREE.Color('#a3a8ab')],
      [new THREE.CylinderGeometry(0.3, 0.3, 0.12, 10).translate(0.18, 0.68, 0), new THREE.Color('#7d8488')],
    ];
  const merged = mergeFlat(
    parts.map(([g]) => g),
    parts.map(([, c]) => c),
  );
  for (const [g] of parts) g.dispose();
  return merged;
}

/** Flared hip skirt whose corners turn up: the eave of a pagoda storey. */
function eave(m: Mesher, sides: Tier['sides']) {
  const corners = outline(sides, 1, 1);
  // Subdivide only as much as the upturned corners need: tens of thousands of eaves are drawn.
  const steps = sides === 4 ? 3 : sides === 8 ? 2 : 1;
  const lift = sides === 12 ? 0 : 0.55;
  const ringOf = (radius: number, y: number, curl: boolean) => {
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < corners.length; i++) {
      const [ax, az] = corners[i]!,
        [bx, bz] = corners[(i + 1) % corners.length]!;
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        const up = curl ? lift * (2 * t - 1) ** 4 : 0;
        points.push(v3((ax + (bx - ax) * t) * radius, y + up, (az + (bz - az) * t) * radius));
      }
    }
    return points;
  };
  const outer = ringOf(1, 0, true),
    top = ringOf(0.7, 1, false),
    under = ringOf(0.7, 0.42, false);
  for (let i = 0; i < outer.length; i++) {
    const j = (i + 1) % outer.length;
    m.quad([outer[i]!, outer[j]!, top[j]!, top[i]!], UP);
    m.quad([outer[i]!, outer[j]!, under[j]!, under[i]!], DOWN);
    m.tri([v3(0, 1, 0), top[i]!, top[j]!], UP);
  }
}

/** Battlement merlons on a unit outline, from y 0.45 to 1. */
function merlons(sides: Tier['sides']): THREE.BufferGeometry {
  const corners = outline(sides, 1, 1);
  const parts: THREE.BufferGeometry[] = [];
  const along = sides === 4 ? [1 / 6, 0.5, 5 / 6] : [0.5];
  const place = new THREE.Matrix4(),
    q = new THREE.Quaternion();
  for (let i = 0; i < corners.length; i++) {
    const [ax, az] = corners[i]!,
      [bx, bz] = corners[(i + 1) % corners.length]!;
    const angle = Math.atan2(-(bz - az), bx - ax);
    for (const t of along) {
      const x = ax + (bx - ax) * t,
        z = az + (bz - az) * t;
      place.compose(v3(x * 0.9, 0.725, z * 0.9), q.setFromAxisAngle(UP, angle), v3(sides === 4 ? 0.36 : 0.3, 0.55, 0.2));
      parts.push(new THREE.BoxGeometry(1, 1, 1).applyMatrix4(place));
    }
  }
  const merged = mergeFlat(parts);
  for (const p of parts) p.dispose();
  return merged;
}

/** Merge geometries as flat position + normal (+ colour) triangle soup. */
function mergeFlat(parts: THREE.BufferGeometry[], colours?: readonly THREE.Color[]): THREE.BufferGeometry {
  const flat = parts.map((p, i) => {
    const g = p.index ? p.toNonIndexed() : p.clone();
    for (const name of Object.keys(g.attributes)) if (name !== 'position') g.deleteAttribute(name);
    g.computeVertexNormals();
    if (colours) {
      const c = colours[i]!,
        n = g.getAttribute('position').count,
        values = new Float32Array(n * 3);
      for (let k = 0; k < n; k++) values.set([c.r, c.g, c.b], k * 3);
      g.setAttribute('color', new THREE.BufferAttribute(values, 3));
    }
    return g;
  });
  const merged = mergeGeometries(flat)!;
  for (const g of flat) g.dispose();
  return shared(merged, false);
}

/**
 * Lens-coloured facade. Windows, lattices, timber and masonry are tints of the facade colour,
 * drawn only where a cell spans several pixels, so far views keep the exact lens colour. A
 * soft base gradient stands in for ambient occlusion. `detail` false compiles patterns out.
 */
export function facadeMaterial(detail: boolean, sky: { zenith: string; horizon: string } = { zenith: '#9fbfe0', horizon: '#e6ecef' }): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial();
  material.defines = { ATLAS_WINDOWS: detail ? 1 : 0 };
  // Glass reflects this sky by viewing angle (Fresnel), and the street below it.
  const reflection = {
    atlasSkyZenith: { value: new THREE.Color(sky.zenith) },
    atlasSkyHorizon: { value: new THREE.Color(sky.horizon) },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, reflection);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec4 atlasFace;
attribute float atlasShade;
attribute vec3 atlasStyle;
varying vec4 vAtlasFace;
flat varying vec2 vAtlasFaceSize;
varying float vAtlasShade;
varying float vAtlasY;
flat varying vec3 vAtlasStyle;`,
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
  // Face size is constant per face: flat, so window counts and seeds never flicker between pixels.
  vAtlasFaceSize = vAtlasFace.yw;
  vAtlasShade = atlasShade;
  vAtlasY = position.y * atlasScale.y;
  vAtlasStyle = atlasStyle;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec4 vAtlasFace;
flat varying vec2 vAtlasFaceSize;
varying float vAtlasShade;
varying float vAtlasY;
flat varying vec3 vAtlasStyle;
uniform vec3 atlasSkyZenith;
uniform vec3 atlasSkyHorizon;
float atlasHash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
float atlasBox(vec2 f, vec2 fw, vec2 lo, vec2 hi) {
  vec2 m = smoothstep(lo - fw, lo + fw, f) * (1.0 - smoothstep(hi - fw, hi + fw, f));
  return m.x * m.y;
}
float atlasLine(float d, float width, float fw) { return 1.0 - smoothstep(width - fw, width + fw, d); }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
float atlasGlassMask = 0.0;
{
  vec3 atlasWall = diffuseColor.rgb * vAtlasShade;
#if ATLAS_WINDOWS
  float style = floor(vAtlasStyle.x + 0.5);
  vec2 size = style == 1.0 ? vec2(0.34, 0.3) : style == 2.0 ? vec2(0.15, 0.3) : style == 3.0 ? vec2(0.13, 0.22)
    : style == 4.0 ? vec2(0.24, 0.42) : style == 5.0 ? vec2(0.2, 0.4) : style == 6.0 ? vec2(0.24, 0.36)
    : style == 7.0 ? vec2(0.16, 0.26) : style == 8.0 ? vec2(0.18, 0.34) : style == 9.0 ? vec2(0.26, 0.36) : vec2(0.2, 0.3);
  vec2 count = max(vec2(1.0), floor(vec2(vAtlasFaceSize.x, vAtlasFaceSize.y) / size + 0.5));
  vec2 cell = vec2(vAtlasFace.x, vAtlasFace.z) * count;
  vec2 f = fract(cell);
  vec2 fw = max(fwidth(cell), vec2(1e-4));
  vec2 fine = fract(cell * vec2(4.0, 3.0));
  vec2 fineFw = fw * vec2(4.0, 3.0);
  float facade = step(1e-4, vAtlasFaceSize.x) * step(1e-4, vAtlasFaceSize.y);
  float fade = facade * (1.0 - smoothstep(0.3, 0.55, max(fw.x, fw.y)));
  float fineFade = 1.0 - smoothstep(0.35, 0.6, max(fineFw.x, fineFw.y));
  // Far away the pattern has faded out entirely: skip it (a uniform branch over a distant
  // block), which keeps wide views cheap. Derivatives are all taken above this line.
  if (fade > 0.001) {
  float course = atlasLine(fract(cell.y * 3.0), 0.06, fw.y * 3.0);
  float glass = 0.0, dark = 0.0, light = 0.0;
  if (style == 1.0) glass = atlasBox(f, fw, vec2(0.03, 0.3), vec2(0.97, 0.8));
  else if (style == 2.0) glass = atlasBox(f, fw, vec2(0.3, 0.1), vec2(0.7, 0.96));
  else if (style == 3.0) glass = atlasBox(f, fw, vec2(0.12, 0.16), vec2(0.88, 0.86));
  else if (style == 4.0) {
    // Lattice screens between dark timber pillars, with a lintel under each eave.
    float panel = atlasBox(f, fw, vec2(0.12, 0.14), vec2(0.88, 0.8));
    glass = panel * mix(1.0, atlasBox(fine, fineFw, vec2(0.2, 0.2), vec2(0.8, 0.8)), fineFade);
    dark = 1.0 - atlasBox(f, fw, vec2(0.06, -1.0), vec2(0.94, 0.9));
  } else if (style == 5.0) {
    // Round-arched windows in coursed stone.
    vec2 p = (f - vec2(0.5, 0.0)) * size;
    float px = max(fw.x * size.x, fw.y * size.y);
    float spring = 0.62 * size.y;
    float rect = max(abs(p.x) - 0.045, max(0.15 * size.y - p.y, p.y - spring));
    float arch = length(vec2(p.x, p.y - spring)) - 0.045;
    glass = 1.0 - smoothstep(-px, px, min(rect, arch));
    dark = 0.3 * course;
  } else if (style == 6.0) {
    // Half-timbering: lightened plaster, dark posts, sill beams and alternating braces.
    float window = atlasBox(f, fw, vec2(0.32, 0.45), vec2(0.68, 0.8));
    float d = mod(floor(cell.x), 2.0) < 0.5 ? abs(f.x - f.y) : abs(f.x - (1.0 - f.y));
    float posts = 1.0 - atlasBox(f, fw, vec2(0.07, 0.08), vec2(0.93, 2.0));
    dark = max(posts, atlasLine(d, 0.05, max(fw.x, fw.y)) * (1.0 - window));
    glass = window;
    light = 1.0;
  } else if (style == 7.0) glass = atlasBox(f, fw, vec2(0.05, 0.16), vec2(0.95, 1.01));
  else if (style == 8.0) {
    // Arrow slits on alternate columns of coursed stone.
    glass = atlasBox(f, fw, vec2(0.44, 0.28), vec2(0.56, 0.8)) * step(0.5, mod(floor(cell.x), 2.0));
    dark = 0.3 * course;
  } else if (style == 9.0) {
    // Tall sash windows between painted shutters, over a sill line.
    glass = atlasBox(f, fw, vec2(0.36, 0.22), vec2(0.64, 0.82));
    dark = 0.55 * (atlasBox(f, fw, vec2(0.22, 0.22), vec2(0.35, 0.82)) + atlasBox(f, fw, vec2(0.65, 0.22), vec2(0.78, 0.82)));
    dark += 0.35 * atlasBox(f, fw, vec2(0.3, 0.16), vec2(0.7, 0.2));
  } else glass = atlasBox(f, fw, vec2(0.24, 0.3), vec2(0.76, 0.8));
  // Interpolated per-instance values wobble in the last bits; quantise before hashing so each
  // window decides once instead of per pixel (which showed as speckle).
  float atlasNoise = atlasHash(vec3(floor(cell), floor(vAtlasStyle.y * 997.0 + 0.5) + floor(vAtlasFaceSize.x * 64.0 + 0.5) * 7.0));
  vec3 atlasGlass = mix(atlasWall * 0.5, vec3(0.15, 0.2, 0.27), 0.4) * (0.85 + 0.3 * atlasNoise);
  if (style == 7.0) atlasGlass = mix(atlasWall * 0.62, vec3(0.5, 0.64, 0.78), 0.28) * (0.78 + 0.32 * vAtlasFace.z) * (0.92 + 0.16 * atlasNoise);
  if (style == 4.0) atlasGlass = mix(atlasWall * 0.4, vec3(0.3, 0.16, 0.1), 0.3);
  float atlasLit = step(style == 4.0 ? 0.9 : 0.95, atlasNoise);
  atlasGlass = mix(atlasGlass, vec3(1.0, 0.86, 0.58), atlasLit * 0.75);
  atlasWall = mix(atlasWall, mix(atlasWall, vec3(0.95, 0.92, 0.85), 0.28), light * fade);
  atlasWall = mix(atlasWall, atlasWall * 0.42, clamp(dark, 0.0, 1.0) * fade);
  atlasWall = mix(atlasWall, atlasGlass, glass * fade);
  // Paper screens barely reflect; lit windows glow instead of mirroring the sky.
  atlasGlassMask = glass * fade * (style == 4.0 ? 0.25 : 1.0) * (1.0 - 0.85 * atlasLit);
  totalEmissiveRadiance += vec3(0.5, 0.4, 0.22) * atlasLit * glass * fade;
  }
  // Ground storey (world units along the face and above the body base): a glass lobby, an
  // open colonnade, an arcade of round arches, or a front door with a step.
  float baseKind = floor(vAtlasStyle.z + 0.5);
  vec2 bp = vec2(vAtlasFace.x * vAtlasFaceSize.x, vAtlasY);
  vec2 bfw = max(fwidth(bp), vec2(1e-4));
  float band = facade * (1.0 - smoothstep(0.56 - bfw.y, 0.56 + bfw.y, bp.y));
  float baseFade = band * (1.0 - smoothstep(0.012, 0.03, max(bfw.x, bfw.y)));
  if (baseKind == 1.0) {
    float m = fract(bp.x / 0.24);
    float pane = smoothstep(0.07 - bfw.x / 0.24, 0.07 + bfw.x / 0.24, m) * (1.0 - smoothstep(0.93 - bfw.x / 0.24, 0.93 + bfw.x / 0.24, m));
    pane *= 1.0 - smoothstep(0.47 - bfw.y, 0.47 + bfw.y, bp.y);
    vec3 lobby = mix(atlasWall * 0.42, vec3(0.86, 0.8, 0.66), 0.42);
    atlasWall = mix(atlasWall, mix(atlasWall * 0.6, lobby, pane), baseFade);
  } else if (baseKind == 2.0) {
    float m = fract(bp.x / 0.19);
    float pillar = 1.0 - smoothstep(0.26, 0.26 + bfw.x / 0.19 * 2.0, abs(m - 0.5) * 2.0);
    float lintel = smoothstep(0.44, 0.44 + bfw.y, bp.y);
    vec3 recess = atlasWall * 0.3;
    atlasWall = mix(atlasWall, mix(recess, atlasWall * 0.92, max(1.0 - pillar, lintel)), baseFade);
  } else if (baseKind == 3.0) {
    float m = fract(bp.x / 0.24) - 0.5;
    float x = m * 0.24;
    float spring = 0.3;
    float d = bp.y < spring ? abs(x) - 0.075 : length(vec2(x, bp.y - spring)) - 0.075;
    float opening = 1.0 - smoothstep(-bfw.x, bfw.x, d);
    atlasWall = mix(atlasWall, mix(atlasWall * 0.9, atlasWall * 0.28, opening), baseFade);
  } else if (baseKind == 4.0) {
    float x = abs(vAtlasFace.x - 0.5) * vAtlasFaceSize.x;
    float door = (1.0 - smoothstep(0.065, 0.065 + bfw.x, x)) * (1.0 - smoothstep(0.4, 0.4 + bfw.y, bp.y));
    float frame = (1.0 - smoothstep(0.085, 0.085 + bfw.x, x)) * (1.0 - smoothstep(0.43, 0.43 + bfw.y, bp.y)) - door;
    atlasWall = mix(atlasWall, atlasWall * 0.75, clamp(frame, 0.0, 1.0) * baseFade);
    atlasWall = mix(atlasWall, vec3(0.24, 0.17, 0.12), door * baseFade);
  }
#endif
  diffuseColor.rgb = atlasWall * mix(0.76, 1.0, smoothstep(0.08, 0.9, vAtlasY));
}`,
      )
      .replace(
        '#include <envmap_fragment>',
        `#if ATLAS_WINDOWS
if (atlasGlassMask > 0.001) {
  // Fresnel sky reflection: glass seen edge-on mirrors the sky (or the street when it
  // faces down), seen head-on it shows its dark interior.
  vec3 atlasView = normalize(vViewPosition);
  float atlasFacing = clamp(dot(normal, atlasView), 0.0, 1.0);
  float atlasFresnel = 0.08 + 0.92 * pow(1.0 - atlasFacing, 5.0);
  vec3 atlasRay = inverseTransformDirection(reflect(-atlasView, normal), viewMatrix);
  vec3 atlasMirror = atlasRay.y > 0.0
    ? mix(atlasSkyHorizon, atlasSkyZenith, smoothstep(0.0, 0.7, atlasRay.y))
    : mix(atlasSkyHorizon * 0.55, vec3(0.22, 0.21, 0.2), smoothstep(0.0, 0.3, -atlasRay.y));
  outgoingLight = mix(outgoingLight, atlasMirror, atlasGlassMask * clamp(atlasFresnel * 0.85 + 0.1, 0.0, 0.72));
}
#endif
#include <envmap_fragment>`,
      );
  };
  material.customProgramCacheKey = () => `atlas-facade-5-${detail ? 1 : 0}`;
  return material;
}

/** Top of a district plinth: nested blocks step up gently, capped so towers stay legible. */
export const groundLevel = (depth: number) => 0.1 + Math.min(depth, 4) * 0.05;

export interface Tree {
  x: number;
  y: number;
  z: number;
  /** Index into the theme's tree kinds. */
  kind: number;
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
export interface Placed {
  x: number;
  y: number;
  z: number;
  /** Y rotation. */
  rotation: number;
}
export interface WallSegment extends Placed {
  length: number;
}
export interface Decor {
  trees: Tree[];
  lawns: Lawn[];
  lamps: Placed[];
  walls: WallSegment[];
  corners: Placed[];
  markings: WallSegment[];
  /** Lotus ponds in header strips, each crossed by an arched bridge. */
  ponds: Lawn[];
  bridges: WallSegment[];
  lotus: Placed[];
  /** Gates set into the town walls. */
  gates: Placed[];
}
const MAX_TREES = 8_000;
const MAX_LAMPS = 4_000;
/**
 * Town walls go to the largest packages only: a repository with hundreds of packages would
 * otherwise become a maze of walls costing more GPU time than its buildings.
 */
export const MAX_WALLED_PACKAGES = 48;

/**
 * Layout-stable decoration. Lawns, trees, lamps and walls use only space the packer leaves
 * free: each district's 2-cell header strip, the 1-cell border of package districts and the
 * belt beyond the perimeter road. They never sit on a plot.
 */
export function cityDecor(city: CityData, theme: CityTheme = 'modern'): Decor {
  const spec = THEMES[theme];
  const decor: Decor = { trees: [], lawns: [], lamps: [], walls: [], corners: [], markings: [], ponds: [], bridges: [], lotus: [], gates: [] };
  const total = spec.trees.reduce((sum, t) => sum + t.weight, 0);
  const plant = (next: () => number, x: number, y: number, z: number) => {
    if (decor.trees.length >= MAX_TREES) return;
    let roll = next() % total,
      kind = 0;
    while (roll >= spec.trees[kind]!.weight) roll -= spec.trees[kind++]!.weight;
    decor.trees.push({
      x: x + ((next() % 21) - 10) * 0.012,
      y,
      z: z + ((next() % 21) - 10) * 0.012,
      kind,
      scale: 0.8 + (next() % 9) * 0.05,
      tint: next() % spec.trees[kind]!.tints.length,
    });
  };
  const lamp = (x: number, y: number, z: number, rotation: number) => {
    if (decor.lamps.length < MAX_LAMPS) decor.lamps.push({ x, y, z, rotation });
  };
  const walled = new Set(
    city.districts
      .filter((d) => d.kind === 'package' && d.depth > 0 && d.rect.width >= 300 && d.rect.depth >= 500)
      .sort((a, b) => b.rect.width * b.rect.depth - a.rect.width * a.rect.depth || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, MAX_WALLED_PACKAGES)
      .map((d) => d.id),
  );
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
    decor.lawns.push({ x: x + w / 2, y, z: z + 2, width: w - 2.3, depth: 1.7 });
    if (spec.ponds > 0 && w >= 6 && next() % 100 < spec.ponds) {
      // A lotus pond fills the strip; a bridge crosses it and trees stand on its banks.
      const pw = w - 3.1;
      decor.ponds.push({ x: x + w / 2, y: y + 0.018, z: z + 2, width: pw, depth: 1.22 });
      const bx = x + 1.55 + pw * (0.3 + (next() % 40) / 100);
      decor.bridges.push({ x: bx, y, z: z + 2, rotation: 0, length: 1.6 });
      for (let k = 0, n = 2 + Math.floor(pw / 1.4); k < n; k++) {
        const lx = x + 1.75 + ((next() % 1000) / 1000) * (pw - 0.4);
        if (Math.abs(lx - bx) > 0.3) decor.lotus.push({ x: lx, y: y + 0.024, z: z + 1.55 + ((next() % 1000) / 1000) * 0.9, rotation: (next() % 628) / 100 });
      }
      plant(next, x + 1.3, y, z + 2);
      plant(next, x + w - 1.3, y, z + 2);
    } else
      for (let tx = x + 1.75; tx <= x + w - 1.75; tx += 1.5) {
        const roll = next() % 100;
        if (roll < 30) continue;
        if (roll < 42) lamp(tx, y, z + 2, 0);
        else plant(next, tx, y, z + 2);
      }
    if (d.kind !== 'package') continue;
    for (let tz = z + 3.5; tz <= z + depth - 1; tz += 2) {
      if (next() % 100 >= 40) plant(next, x + 0.5, y, tz);
      if (next() % 100 >= 40) plant(next, x + w - 0.5, y, tz);
    }
    for (let tx = x + 1.5; tx <= x + w - 1.5; tx += 2) if (next() % 100 >= 40) plant(next, tx, y, z + depth - 0.5);
    if (spec.walls !== 'none' && walled.has(d.id)) {
      // A town wall on the package's outer border cell, with a tower at each corner.
      const base = groundLevel(d.depth),
        inset = 0.12;
      // The south wall opens on a gate: a paifang archway or a castle gatehouse.
      const gap = 0.7,
        half = (w - 2 * inset) / 2 - gap;
      decor.walls.push(
        { x: x + w / 2, y: base, z: z + inset, rotation: 0, length: w - 2 * inset },
        { x: x + inset + half / 2, y: base, z: z + depth - inset, rotation: 0, length: half },
        { x: x + w - inset - half / 2, y: base, z: z + depth - inset, rotation: 0, length: half },
        { x: x + inset, y: base, z: z + depth / 2, rotation: Math.PI / 2, length: depth - 2 * inset },
        { x: x + w - inset, y: base, z: z + depth / 2, rotation: Math.PI / 2, length: depth - 2 * inset },
      );
      decor.gates.push({ x: x + w / 2, y: base, z: z + depth - inset, rotation: 0 });
      for (const [cx, cz] of [
        [x + 0.3, z + 0.3],
        [x + w - 0.3, z + 0.3],
        [x + 0.3, z + depth - 0.3],
        [x + w - 0.3, z + depth - 0.3],
      ] as const)
        decor.corners.push({ x: cx, y: base, z: cz, rotation: 0 });
    }
  }
  // Belt between the perimeter road (3 cells) and the beach (5.5 cells): lamps along the
  // road's outer edge, trees in the middle of the green.
  const r = city.root,
    rx0 = r.x / 100,
    rz0 = r.z / 100,
    rx1 = (r.x + r.width) / 100,
    rz1 = (r.z + r.depth) / 100;
  const next = xorshift32(seedFromId(`root_${(r.width * 31 + r.depth).toString(16).padStart(8, '0')}`));
  const ring = (offset: number, step: number, place: (x: number, z: number, rotation: number) => void) => {
    for (let t = rx0 - offset; t <= rx1 + offset; t += step) {
      place(t, rz0 - offset, 0);
      place(t, rz1 + offset, Math.PI);
    }
    for (let t = rz0 - offset + step; t <= rz1 + offset - step; t += step) {
      place(rx0 - offset, t, -Math.PI / 2);
      place(rx1 + offset, t, Math.PI / 2);
    }
  };
  ring(4.25, 2, (x, z) => {
    if (next() % 100 >= 35) plant(next, x, 0.03, z);
  });
  ring(3.3, 4, (x, z, rotation) => lamp(x, 0.03, z, rotation));
  // Dashed centre line on the perimeter road, modern style only.
  if (spec.ground.marking)
    ring(1.5, 1, (x, z, rotation) =>
      decor.markings.push({ x, y: 0.085, z, rotation: rotation % Math.PI === 0 ? 0 : Math.PI / 2, length: 0.45 }),
    );
  return decor;
}

/**
 * Trees with soft foliage. Canopies are clusters of rounded blobs whose normals bend towards
 * the canopy's centre, so light wraps them like real foliage instead of lighting facets. Vertex
 * colours darken the underside and speckle the leaves; the instance colour tints the species.
 */
export function treeGeometry(kind: TreeKind): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const bark = new THREE.Color('#6b5641');
  const trunk = (r: number, h: number, lean = 0) => {
    const g = new THREE.CylinderGeometry(r * 0.65, r, h, 6).translate(0, h / 2, 0);
    if (lean) g.applyMatrix4(new THREE.Matrix4().makeRotationZ(lean));
    return paint(g, () => bark);
  };
  const canopy = (blobs: readonly (readonly [number, number, number, number, number?])[], detail = 1, speckle = 0.07) => {
    const centre = new THREE.Vector3();
    for (const [x, y, z] of blobs) centre.add(v3(x, y, z));
    centre.divideScalar(blobs.length).y -= 0.06;
    const top = Math.max(...blobs.map(([, y, , r, sy]) => y + r * (sy ?? 1))),
      bottom = Math.min(...blobs.map(([, y, , r, sy]) => y - r * (sy ?? 1)));
    for (const [x, y, z, r, sy] of blobs) {
      const g = mergeVertices(new THREE.IcosahedronGeometry(r, detail).deleteAttribute('normal').deleteAttribute('uv'));
      g.scale(1, sy ?? 1, 1).translate(x, y, z);
      const position = g.getAttribute('position'),
        normal = new Float32Array(position.count * 3),
        p = new THREE.Vector3(),
        own = new THREE.Vector3();
      for (let i = 0; i < position.count; i++) {
        p.fromBufferAttribute(position, i);
        own.set(p.x - x, (p.y - y) / (sy ?? 1), p.z - z).normalize();
        p.sub(centre).normalize().lerp(own, 0.35).normalize();
        normal.set([p.x, p.y, p.z], i * 3);
      }
      g.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
      parts.push(
        paint(g, (vy, vx, vz) => {
          const light = 0.6 + 0.4 * Math.min(1, Math.max(0, (vy - bottom) / (top - bottom)));
          const n = Math.sin(vx * 91.7 + vy * 47.3 + vz * 63.1) * 43758.5453;
          return new THREE.Color().setScalar(light * (1 - speckle + (n - Math.floor(n)) * speckle * 2));
        }),
      );
    }
  };
  switch (kind) {
    case 'round':
      parts.push(trunk(0.045, 0.32));
      canopy([[0, 0.47, 0, 0.24], [0.1, 0.57, 0.06, 0.17], [-0.1, 0.53, -0.05, 0.16]]);
      break;
    case 'plane':
      // A tall street tree with a broad, layered crown.
      parts.push(trunk(0.04, 0.4));
      canopy([[0, 0.56, 0, 0.25, 0.8], [0.15, 0.6, 0.05, 0.18, 0.85], [-0.14, 0.58, -0.06, 0.18, 0.85], [0.01, 0.71, 0, 0.16, 0.8]]);
      break;
    case 'oak':
      parts.push(trunk(0.06, 0.3), trunk(0.025, 0.22, 0.7).translate(0.02, 0.2, 0), trunk(0.025, 0.2, -0.75).translate(-0.02, 0.2, 0));
      canopy([[0, 0.5, 0, 0.27, 0.85], [0.17, 0.54, 0.08, 0.2], [-0.16, 0.53, -0.07, 0.2], [0.02, 0.67, -0.02, 0.18]]);
      break;
    case 'blossom':
      parts.push(trunk(0.04, 0.26, 0.08));
      canopy([[0, 0.45, 0, 0.22, 0.85], [0.14, 0.5, 0.06, 0.16], [-0.13, 0.48, -0.06, 0.16], [0.02, 0.6, 0, 0.14]], 1, 0.16);
      break;
    case 'willow': {
      // A weeping crown: a small dome over a drooping curtain of leaves.
      parts.push(trunk(0.045, 0.42, 0.06));
      canopy([[0, 0.55, 0, 0.2, 0.7]], 1);
      const curtain = new THREE.CylinderGeometry(0.2, 0.3, 0.42, 10, 3, true).translate(0, 0.32, 0);
      const pos = curtain.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        const a = Math.atan2(pos.getZ(i), pos.getX(i));
        const sway = 1 + 0.12 * Math.sin(a * 5);
        pos.setXYZ(i, pos.getX(i) * sway, pos.getY(i) - (pos.getY(i) < 0.2 ? 0.04 * Math.sin(a * 7) : 0), pos.getZ(i) * sway);
      }
      curtain.deleteAttribute('uv');
      curtain.computeVertexNormals();
      parts.push(paint(curtain, (vy) => new THREE.Color().setScalar(0.62 + 0.38 * Math.min(1, Math.max(0, (vy - 0.1) / 0.45)))));
      break;
    }
    case 'conifer':
      parts.push(trunk(0.04, 0.16));
      for (const [y, r, h] of [
        [0.14, 0.25, 0.34],
        [0.33, 0.2, 0.3],
        [0.5, 0.13, 0.26],
      ] as const) {
        const cone = new THREE.ConeGeometry(r, h, 8).translate(0, y + h / 2, 0);
        cone.deleteAttribute('uv');
        parts.push(paint(cone, (vy) => new THREE.Color().setScalar(0.58 + 0.42 * Math.min(1, Math.max(0, (vy - y) / h)))));
      }
      break;
    case 'pine':
      // A wind-shaped pine: layered flat canopies offset from a leaning trunk.
      parts.push(trunk(0.04, 0.5, 0.12));
      for (const [x, y, z, r] of [
        [0.05, 0.3, 0, 0.26],
        [-0.06, 0.42, 0.03, 0.2],
        [0.0, 0.53, -0.02, 0.13],
      ] as const) {
        const pad = new THREE.CylinderGeometry(r, r * 0.82, 0.07, 9).translate(x, y, z);
        pad.deleteAttribute('uv');
        parts.push(paint(pad, (vy) => new THREE.Color().setScalar(vy > y ? 1 : 0.62)));
      }
      break;
    case 'cypress':
      parts.push(trunk(0.035, 0.12));
      canopy([[0, 0.5, 0, 0.14, 3]], 1);
      break;
  }
  const indexed = parts.map((g) => (g.index ? g : mergeVertices(g)));
  for (const g of indexed) if (!g.getAttribute('normal')) g.computeVertexNormals();
  const merged = mergeGeometries(indexed)!;
  for (const g of [...parts, ...indexed]) g.dispose();
  return merged;
}

/** Give a geometry per-vertex colours from a function of its position. */
function paint(g: THREE.BufferGeometry, colour: (y: number, x: number, z: number) => THREE.Color): THREE.BufferGeometry {
  const position = g.getAttribute('position'),
    values = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    const c = colour(position.getY(i), position.getX(i), position.getZ(i));
    values.set([c.r, c.g, c.b], i * 3);
  }
  if (g.getAttribute('uv')) g.deleteAttribute('uv');
  return g.setAttribute('color', new THREE.BufferAttribute(values, 3));
}

/** Street furniture with vertex colours, standing on y = 0. */
export function lampGeometry(kind: LampKind): THREE.BufferGeometry {
  const dark = new THREE.Color('#3d434a'),
    glow = new THREE.Color('#fff0c2'),
    stone = new THREE.Color('#b9b2a4');
  let parts: [THREE.BufferGeometry, THREE.Color][];
  if (kind === 'street')
    parts = [
      [new THREE.CylinderGeometry(0.014, 0.02, 0.62, 5).translate(0, 0.31, 0), dark],
      [new THREE.BoxGeometry(0.15, 0.018, 0.018).translate(0.07, 0.61, 0), dark],
      [new THREE.BoxGeometry(0.08, 0.025, 0.05).translate(0.14, 0.595, 0), glow],
    ];
  else if (kind === 'lantern')
    parts = [
      [new THREE.BoxGeometry(0.13, 0.05, 0.13).translate(0, 0.025, 0), stone],
      [new THREE.CylinderGeometry(0.03, 0.035, 0.14, 6).translate(0, 0.12, 0), stone],
      [new THREE.BoxGeometry(0.11, 0.09, 0.11).translate(0, 0.235, 0), glow],
      [new THREE.ConeGeometry(0.11, 0.07, 4).rotateY(Math.PI / 4).translate(0, 0.315, 0), new THREE.Color('#6b6458')],
    ];
  else
    parts = [
      [new THREE.CylinderGeometry(0.014, 0.022, 0.45, 5).translate(0, 0.225, 0), dark],
      [new THREE.BoxGeometry(0.06, 0.08, 0.06).translate(0, 0.49, 0), glow],
      [new THREE.ConeGeometry(0.055, 0.05, 4).rotateY(Math.PI / 4).translate(0, 0.555, 0), dark],
    ];
  const merged = mergeFlat(
    parts.map(([g]) => g),
    parts.map(([, c]) => c),
  );
  for (const [g] of parts) g.dispose();
  return merged;
}

/** Corner tower of a package's town wall, standing on y = 0. */
export function cornerGeometry(walls: 'eastern' | 'western'): THREE.BufferGeometry {
  let parts: [THREE.BufferGeometry, THREE.Color][];
  if (walls === 'eastern') {
    const roof = new Mesher();
    eave(roof, 4);
    parts = [
      [new THREE.BoxGeometry(0.44, 0.36, 0.44).translate(0, 0.18, 0), new THREE.Color('#b4553f')],
      [roof.geometry(false).scale(0.34, 0.2, 0.34).translate(0, 0.34, 0), new THREE.Color('#c8a24e')],
      [new THREE.ConeGeometry(0.16, 0.14, 4).rotateY(Math.PI / 4).translate(0, 0.6, 0), new THREE.Color('#c8a24e')],
    ];
  } else
    parts = [
      [new THREE.CylinderGeometry(0.28, 0.3, 0.6, 10).translate(0, 0.3, 0), new THREE.Color('#b3ab9b')],
      [new THREE.ConeGeometry(0.34, 0.42, 10).translate(0, 0.81, 0), new THREE.Color('#4d5967')],
    ];
  const merged = mergeFlat(
    parts.map(([g]) => g),
    parts.map(([, c]) => c),
  );
  for (const [g] of parts) g.dispose();
  return merged;
}

/** Unit eave for harbour depots (4 sides): outline ±1, height 1. */
export function depotEaveGeometry(): THREE.BufferGeometry {
  const m = new Mesher();
  eave(m, 4);
  return shared(m.geometry(false), false);
}

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

/** An arched footbridge one unit long (along z), deck in stone, vermilion rails. */
export function bridgeGeometry(): THREE.BufferGeometry {
  const parts: [THREE.BufferGeometry, THREE.Color][] = [];
  const deck = new THREE.Color('#d8d0c0'),
    rail = new THREE.Color('#b4553f');
  const steps = 8;
  for (let i = 0; i < steps; i++) {
    const t0 = i / steps,
      t1 = (i + 1) / steps;
    const z0 = t0 - 0.5,
      z1 = t1 - 0.5,
      y0 = 0.03 + 0.15 * Math.sin(Math.PI * t0),
      y1 = 0.03 + 0.15 * Math.sin(Math.PI * t1);
    const length = Math.hypot(z1 - z0, y1 - y0),
      angle = Math.atan2(y1 - y0, z1 - z0),
      cz = (z0 + z1) / 2,
      cy = (y0 + y1) / 2;
    const at = (g: THREE.BufferGeometry, x: number, lift: number) =>
      g.applyMatrix4(new THREE.Matrix4().makeRotationX(-angle).setPosition(x, cy + lift, cz));
    parts.push([at(new THREE.BoxGeometry(0.26, 0.035, length + 0.01), 0, 0), deck]);
    parts.push([at(new THREE.BoxGeometry(0.02, 0.02, length + 0.01), 0.12, 0.07), rail]);
    parts.push([at(new THREE.BoxGeometry(0.02, 0.02, length + 0.01), -0.12, 0.07), rail]);
  }
  for (const z of [-0.5, -0.25, 0, 0.25, 0.5])
    for (const x of [0.12, -0.12]) {
      const y = 0.03 + 0.15 * Math.sin(Math.PI * (z + 0.5));
      parts.push([new THREE.BoxGeometry(0.025, 0.08, 0.025).translate(x, y + 0.04, z), rail]);
    }
  const merged = mergeFlat(
    parts.map(([g]) => g),
    parts.map(([, c]) => c),
  );
  for (const [g] of parts) g.dispose();
  return merged;
}

/** A floating lotus pad with a pink bud. */
export function lotusGeometry(): THREE.BufferGeometry {
  const parts: [THREE.BufferGeometry, THREE.Color][] = [
    [new THREE.CylinderGeometry(0.07, 0.07, 0.006, 9, 1, false, 0.4, Math.PI * 1.8), new THREE.Color('#4f8a4b')],
    [new THREE.SphereGeometry(0.022, 6, 4).scale(1, 1.3, 1).translate(0.02, 0.022, 0.01), new THREE.Color('#f1a9bd')],
  ];
  const merged = mergeFlat(
    parts.map(([g]) => g),
    parts.map(([, c]) => c),
  );
  for (const [g] of parts) g.dispose();
  return merged;
}

/** A gate in a package's south wall: an eastern paifang, or a western gatehouse. */
export function gateGeometry(walls: 'eastern' | 'western'): THREE.BufferGeometry {
  let parts: [THREE.BufferGeometry, THREE.Color][];
  if (walls === 'eastern') {
    const red = new THREE.Color('#b4553f'),
      gold = new THREE.Color('#c8a24e'),
      teal = new THREE.Color('#2f5d62');
    const roof = (w: number, y: number) => {
      const m = new Mesher();
      eave(m, 4);
      return shared(m.geometry(false), false).scale(w, 0.1, 0.12).translate(0, y, 0);
    };
    parts = [];
    for (const x of [-0.55, -0.2, 0.2, 0.55]) parts.push([new THREE.BoxGeometry(0.05, x * x < 0.1 ? 0.5 : 0.38, 0.05).translate(x, x * x < 0.1 ? 0.25 : 0.19, 0), red]);
    parts.push([new THREE.BoxGeometry(0.5, 0.06, 0.07).translate(0, 0.44, 0), teal], [new THREE.BoxGeometry(1.2, 0.05, 0.07).translate(0, 0.33, 0), teal]);
    parts.push([roof(0.3, 0.5), gold], [roof(0.22, 0.38).translate(-0.38, 0, 0), gold], [roof(0.22, 0.38).translate(0.38, 0, 0), gold]);
  } else {
    const stone = new THREE.Color('#b5ad9d'),
      slate = new THREE.Color('#4d5967'),
      dark = new THREE.Color('#3a332c');
    parts = [
      [new THREE.BoxGeometry(0.62, 0.42, 0.3).translate(0, 0.21, 0), stone],
      [new THREE.BoxGeometry(0.2, 0.28, 0.32).translate(0, 0.14, 0), dark],
    ];
    for (const x of [-0.45, 0.45])
      parts.push(
        [new THREE.CylinderGeometry(0.17, 0.19, 0.62, 10).translate(x, 0.31, 0), stone],
        [new THREE.ConeGeometry(0.21, 0.32, 10).translate(x, 0.78, 0), slate],
      );
    for (const x of [-0.24, -0.08, 0.08, 0.24]) parts.push([new THREE.BoxGeometry(0.09, 0.07, 0.3).translate(x, 0.455, 0), stone]);
  }
  const merged = mergeFlat(
    parts.map(([g]) => g),
    parts.map(([, c]) => c),
  );
  for (const [g] of parts) g.dispose();
  return merged;
}

/**
 * The eastern role roof for source files: still a four-sided pointed roof (the legend's △),
 * but with concave slopes, upturned corners and a finial, like a pavilion's. Its footprint and
 * height match the plain pyramid (half 0.48, 0.44 high), turned to sit as the pyramid does.
 */
export function pavilionRoofGeometry(): THREE.BufferGeometry {
  const m = new Mesher();
  const corners = outline(4, 1, 1);
  const rings = [
    { r: 0.5, y: -0.22, lift: 0.07 },
    { r: 0.36, y: -0.1, lift: 0.025 },
    { r: 0.2, y: 0.04, lift: 0 },
    { r: 0.07, y: 0.16, lift: 0 },
  ];
  const steps = 3;
  const ringPoints = rings.map(({ r, y, lift }) => {
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < 4; i++) {
      const [ax, az] = corners[i]!,
        [bx, bz] = corners[(i + 1) % 4]!;
      for (let k = 0; k < steps; k++) {
        const t = k / steps;
        points.push(v3((ax + (bx - ax) * t) * r, y + lift * (2 * t - 1) ** 4, (az + (bz - az) * t) * r));
      }
    }
    return points;
  });
  for (let k = 0; k + 1 < ringPoints.length; k++) {
    const a = ringPoints[k]!,
      b = ringPoints[k + 1]!;
    for (let i = 0; i < a.length; i++) {
      const j = (i + 1) % a.length;
      m.quad([a[i]!, a[j]!, b[j]!, b[i]!], UP);
    }
  }
  const last = ringPoints.at(-1)!;
  for (let i = 0; i < last.length; i++) m.tri([v3(0, 0.2, 0), last[i]!, last[(i + 1) % last.length]!], UP);
  const roof = shared(m.geometry(false), false).applyMatrix4(new THREE.Matrix4().makeRotationY(-Math.PI / 4));
  const finial = new THREE.SphereGeometry(0.035, 6, 4).translate(0, 0.22, 0);
  finial.deleteAttribute('uv');
  finial.deleteAttribute('normal');
  const merged = mergeGeometries([roof, mergeVertices(finial)])!;
  roof.dispose();
  finial.dispose();
  return merged;
}
