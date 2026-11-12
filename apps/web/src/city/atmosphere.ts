import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { xorshift32, type CityData } from '@atlas/layout';
import type { ThemeSpec } from './themes';

/**
 * Cinematic surroundings (ADR-040): a sky dome, an ocean to the horizon and seeded scenery
 * far beyond the island. None of it is pickable or encodes data; it sits outside every plot,
 * district and terminal ring, and fog blends it into the sky as aerial perspective.
 */

/** Sky gradient with a sun glow in the key light's direction; drawn first, never fogged. */
export function skyDome(sky: ThemeSpec['sky'], sun: THREE.Vector3): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      zenith: { value: new THREE.Color(sky.zenith) },
      horizon: { value: new THREE.Color(sky.horizon) },
      haze: { value: new THREE.Color(sky.haze) },
      sunColor: { value: new THREE.Color(sky.sun) },
      sunDirection: { value: sun.clone().normalize() },
    },
    vertexShader: `varying vec3 vDirection;
void main() {
  vDirection = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`,
    fragmentShader: `uniform vec3 zenith; uniform vec3 horizon; uniform vec3 haze; uniform vec3 sunColor; uniform vec3 sunDirection;
varying vec3 vDirection;
void main() {
  vec3 d = normalize(vDirection);
  float up = clamp(d.y, -1.0, 1.0);
  // Rayleigh-like falloff: pale at the horizon, saturating quickly, deepest overhead.
  vec3 colour = mix(horizon, zenith, pow(smoothstep(0.0, 0.9, up), 0.55));
  colour *= 1.0 - 0.2 * smoothstep(0.3, 1.0, up);
  float glow = max(dot(d, sunDirection), 0.0);
  // The air below the sun scatters its light forward: a warm band along that horizon.
  float low = 1.0 - smoothstep(0.0, 0.4, up);
  colour = mix(colour, sunColor, low * pow(glow, 3.0) * 0.38);
  colour = mix(colour, haze, 1.0 - smoothstep(-0.05, 0.1, up));
  colour += sunColor * (smoothstep(0.99955, 0.99975, glow) * 1.4 + pow(glow, 700.0) * 0.7 + pow(glow, 22.0) * 0.2);
  gl_FragColor = vec4(colour, 1.0);
  #include <colorspace_fragment>
}`,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), material);
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;
  return mesh;
}

type Paint = (y: number, height: number) => THREE.Color;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const step = THREE.MathUtils.smoothstep;

/** Seeded fractal value noise in 0..1, for terrain shape and ground cover. */
function fractal(seed: number) {
  const hash = (x: number, z: number) => {
    let h = (Math.imul(x, 374761393) + Math.imul(z, 668265263) + seed) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const smooth = (x: number, z: number) => {
    const xi = Math.floor(x),
      zi = Math.floor(z),
      fx = x - xi,
      fz = z - zi;
    const u = fx * fx * (3 - 2 * fx),
      v = fz * fz * (3 - 2 * fz);
    return lerp(lerp(hash(xi, zi), hash(xi + 1, zi), u), lerp(hash(xi, zi + 1), hash(xi + 1, zi + 1), u), v);
  };
  return (x: number, z: number, octaves: number) => {
    let sum = 0,
      weight = 0;
    for (let o = 0, amplitude = 0.5, frequency = 1; o < octaves; o++, amplitude *= 0.5, frequency *= 2.03) {
      sum += amplitude * smooth(x * frequency, z * frequency);
      weight += amplitude;
    }
    return sum / weight;
  };
}
type Fractal = ReturnType<typeof fractal>;

/** Ground cover from relative altitude (0 shore, 1 summit), steepness (0 flat, 1 cliff) and a 0..1 patch value. */
type Cover = (altitude: number, steep: number, patch: number) => THREE.Color;

interface Landform {
  x: number;
  z: number;
  /** Half extents of the footprint and the summit height. */
  rx: number;
  rz: number;
  height: number;
  turn: number;
  /** 0 is a rolling headland, 1 a ridged alpine massif. */
  sharp: number;
  cover: Cover;
  /** Aerial perspective: how far the colours have already faded into the haze. */
  fade: number;
}

/** The sea is at -0.1; terrain rims sit below it so no edge shows. */
const SEABED = -0.35;

/** Indexed rings of vertices, smooth normals, then colour from the shaded shape. */
function shaded(position: Float32Array, index: number[], colour: (v: number, normalY: number) => THREE.Color): THREE.BufferGeometry {
  const indexed = new THREE.BufferGeometry();
  indexed.setAttribute('position', new THREE.BufferAttribute(position, 3));
  indexed.setIndex(index);
  indexed.computeVertexNormals();
  const normal = indexed.getAttribute('normal');
  const colours = new Float32Array(position.length);
  for (let v = 0; v < position.length / 3; v++) {
    const c = colour(v, normal.getY(v));
    colours.set([c.r, c.g, c.b], v * 3);
  }
  indexed.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  const g = indexed.toNonIndexed();
  indexed.dispose();
  return g;
}

/**
 * A hill or mountain as a smooth-shaded height field over an irregular footprint. Ridged
 * noise carves spurs and gullies, and ground cover follows altitude and slope, so the
 * distant land reads as terrain under sunlight; the rim sits below the sea.
 */
function landform(noise: Fractal, haze: THREE.Color, l: Landform, rings = 10, sectors = 28): THREE.BufferGeometry {
  const position = new Float32Array((rings + 1) * sectors * 3);
  const index: number[] = [];
  const cos = Math.cos(l.turn),
    sin = Math.sin(l.turn);
  const grain = 2.6 / Math.max(l.rx, l.rz);
  for (let i = 0; i <= rings; i++) {
    const rho = i / rings;
    for (let k = 0; k < sectors; k++) {
      const theta = (k / sectors) * Math.PI * 2;
      const reach = rho * (0.7 + 0.6 * noise(l.x * 0.013 + Math.cos(theta) * 1.4 + 11, l.z * 0.013 + Math.sin(theta) * 1.4, 2));
      const px = Math.cos(theta) * reach * l.rx,
        pz = Math.sin(theta) * reach * l.rz;
      const x = l.x + px * cos - pz * sin,
        z = l.z + px * sin + pz * cos;
      const rolling = (1 - rho * rho) ** 1.5 * (0.55 + 0.9 * noise(x * grain, z * grain, 3));
      const ridge = 1 - Math.abs(2 * noise(x * grain * 1.3 + 31, z * grain * 1.3, 4) - 1);
      const massif = (1 - rho) ** 1.15 * (0.3 + 0.95 * ridge * ridge);
      const at = (i * sectors + k) * 3;
      position[at] = x;
      position[at + 1] = SEABED + l.height * (i === rings ? 0 : lerp(rolling, massif, l.sharp));
      position[at + 2] = z;
      if (i < rings) {
        const a = i * sectors + k,
          b = i * sectors + ((k + 1) % sectors);
        index.push(a, b, a + sectors, b, b + sectors, a + sectors);
      }
    }
  }
  return shaded(position, index, (v, normalY) =>
    l
      .cover(
        THREE.MathUtils.clamp((position[v * 3 + 1]! - SEABED) / l.height, 0, 1),
        1 - Math.max(0, normalY),
        noise(position[v * 3]! * grain * 2.2 + 5, position[v * 3 + 2]! * grain * 2.2 + 9, 2),
      )
      .lerp(haze, l.fade),
  );
}

/** Wooded hills with meadow clearings, bare rock where steep and a pale shore. */
const woodland =
  (dark: string, light: string, rock: string, shore: string): Cover =>
  (altitude, steep, patch) =>
    tint(dark, light, step(patch, 0.3, 0.75))
      .lerp(new THREE.Color(rock), step(steep, 0.38, 0.62) * 0.8)
      .lerp(new THREE.Color(shore), 1 - step(altitude, 0.015, 0.07));

/** Forest below, scree and rock above, snow on the high ground that is flat enough to hold it. */
const alpine: Cover = (altitude, steep, patch) => {
  const land = tint('#4f6f4c', '#7c9468', step(patch, 0.3, 0.8)).lerp(tint('#7b7d78', '#9a968c', patch), Math.max(step(altitude, 0.24, 0.42), step(steep, 0.4, 0.6)));
  const snow = step(altitude + (patch - 0.5) * 0.16, 0.46, 0.6) * (1 - 0.75 * step(steep, 0.52, 0.8));
  return land.lerp(new THREE.Color('#f7f8fa'), snow).lerp(new THREE.Color('#cfc5a8'), 1 - step(altitude, 0.01, 0.04));
};

/**
 * A limestone tower: a weathered column that bulges and narrows with height, streaked
 * rock on its faces and vegetation on the dome and the ledges.
 */
function pillar(noise: Fractal, haze: THREE.Color, x: number, z: number, radius: number, height: number, fade: number): THREE.BufferGeometry {
  const rings = 8,
    sides = 11;
  const position = new Float32Array((rings + 1) * sides * 3);
  const index: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    // Straight flanks, then a dome over the last quarter.
    const dome = t > 0.75 ? Math.sqrt(Math.max(0, 1 - ((t - 0.75) / 0.25) ** 2)) : 1;
    for (let k = 0; k < sides; k++) {
      const theta = (k / sides) * Math.PI * 2;
      const r = radius * (1 - 0.22 * t) * dome * (0.74 + 0.5 * noise(x * 0.07 + Math.cos(theta) * 1.1 + t * 2.4, z * 0.07 + Math.sin(theta) * 1.1 + t * 1.7, 3));
      const at = (i * sides + k) * 3;
      position[at] = x + Math.cos(theta) * r;
      position[at + 1] = SEABED + height * t;
      position[at + 2] = z + Math.sin(theta) * r;
      if (i < rings) {
        const a = i * sides + k,
          b = i * sides + ((k + 1) % sides);
        index.push(a, a + sides, b, b, a + sides, b + sides);
      }
    }
  }
  return shaded(position, index, (v, normalY) => {
    const t = (position[v * 3 + 1]! - SEABED) / height;
    const patch = noise(position[v * 3]! * 0.5, position[v * 3 + 2]! * 0.5 + t * 3, 2);
    const green = Math.max(step(normalY, 0.25, 0.6), step(t + patch * 0.2, 0.78, 0.9));
    return tint('#6d766c', '#b3b4a4', patch).lerp(tint('#4f7d4f', '#7aa268', patch), green).lerp(haze, fade);
  });
}

/** Merge parts as flat triangle soup with per-vertex colour from a height-based paint. */
function paintAndMerge(parts: { geometry: THREE.BufferGeometry; paint: Paint; base: number; height: number }[]): THREE.BufferGeometry {
  const flat = parts.map(({ geometry, paint, base, height }) => {
    const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    geometry.dispose();
    for (const name of Object.keys(g.attributes)) if (name !== 'position') g.deleteAttribute(name);
    g.computeVertexNormals();
    const position = g.getAttribute('position'),
      colour = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++) {
      const c = paint(position.getY(i) - base, height);
      colour.set([c.r, c.g, c.b], i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(colour, 3));
    return g;
  });
  const merged = mergeGeometries(flat)!;
  for (const g of flat) g.dispose();
  return merged;
}

const tint = (a: string, b: string, t: number) => new THREE.Color(a).lerp(new THREE.Color(b), Math.min(1, Math.max(0, t)));

export interface Scenery {
  geometry: THREE.BufferGeometry;
  /** Eastern mist banks: centre, size and height, as horizontal planes. */
  mist: { x: number; y: number; z: number; size: number }[];
  /** Nearest scenery from the island centre, so the camera can be kept inside the ring. */
  innerRadius: number;
}

/**
 * Seeded distant scenery around the island. Sizes scale with the city (`extent` is the
 * renderer's island extent) so every repository gets a proportionate backdrop.
 */
export function sceneryGeometry(spec: ThemeSpec, city: CityData, extent: number): Scenery {
  const r = city.root;
  const cx = (r.x + r.width / 2) / 100,
    cz = (r.z + r.depth / 2) / 100;
  const next = xorshift32(((r.width * 2654435761) ^ (r.depth * 40503) ^ spec.scenery.length) >>> 0 || 1);
  const rand = () => (next() % 10_000) / 10_000;
  const inner = extent * 3.4,
    outer = extent * 5;
  const haze = spec.sky.haze;
  const noise = fractal((next() % 65_521) + 1);
  const hazeColour = new THREE.Color(haze);
  /** Smooth-shaded terrain, already coloured; merged with the flat-shaded parts at the end. */
  const land: THREE.BufferGeometry[] = [];
  const parts: { geometry: THREE.BufferGeometry; paint: Paint; base: number; height: number }[] = [];
  const mist: Scenery['mist'] = [];
  const at = (angle: number, distance: number) => [cx + Math.cos(angle) * distance, cz + Math.sin(angle) * distance] as const;
  // Farther scenery is pre-tinted towards the haze, so the fog reads as depth, not as a wall.
  const aerial = (distance: number) => (distance - inner) / (outer - inner) * 0.35;
  const add = (geometry: THREE.BufferGeometry, x: number, base: number, z: number, height: number, paint: Paint) => {
    parts.push({ geometry: geometry.translate(x, base, z), paint, base, height });
  };
  if (spec.scenery === 'karst') {
    // Towering limestone pillars in clusters, green-crowned, some bearing a tiny pagoda; a few
    // islands float above the sea.
    for (let cluster = 0; cluster < 14; cluster++) {
      const angle = (cluster / 14) * Math.PI * 2 + rand() * 0.3,
        distance = inner + rand() * (outer - inner);
      for (let k = 0; k < 3 + (next() % 4); k++) {
        const [x, z] = at(angle + (rand() - 0.5) * 0.18, distance + (rand() - 0.5) * extent * 0.5);
        const height = extent * (0.12 + rand() * 0.26),
          radius = extent * (0.025 + rand() * 0.03);
        const fade = aerial(Math.hypot(x - cx, z - cz));
        land.push(pillar(noise, hazeColour, x, z, radius * 1.15, height, fade));
        if (next() % 5 === 0) {
          const pagoda = mergeGeometries([
            new THREE.BoxGeometry(radius * 0.6, radius * 0.5, radius * 0.6).translate(0, radius * 0.25, 0),
            new THREE.ConeGeometry(radius * 0.6, radius * 0.45, 4).rotateY(Math.PI / 4).translate(0, radius * 0.72, 0),
          ].map((g) => g.toNonIndexed()))!;
          add(pagoda, x, SEABED + height * 0.985, z, radius, (y, h) => (y > h * 0.5 ? tint('#4a3c37', haze, fade) : tint('#b4553f', haze, fade)));
        }
      }
      const [sx, sz] = at(angle, distance);
      land.push(
        landform(
          noise,
          hazeColour,
          {
            x: sx,
            z: sz,
            rx: extent * (0.3 + rand() * 0.2),
            rz: extent * (0.2 + rand() * 0.12),
            height: extent * (0.035 + rand() * 0.03),
            turn: angle + Math.PI / 2,
            sharp: 0.15,
            cover: woodland('#4c7a4e', '#86a86e', '#9c9f90', '#d6ccae'),
            fade: aerial(distance),
          },
          7,
          20,
        ),
      );
      mist.push({ x: sx, y: extent * 0.04, z: sz, size: extent * (0.5 + rand() * 0.4) });
    }
    for (let k = 0; k < 4; k++) {
      const [x, z] = at(rand() * Math.PI * 2, inner * (0.85 + rand() * 0.3));
      const radius = extent * (0.05 + rand() * 0.04),
        lift = extent * (0.22 + rand() * 0.18);
      const underside = new THREE.ConeGeometry(radius, radius * 1.6, 7).rotateX(Math.PI).translate(0, -radius * 0.8, 0);
      const top = new THREE.CylinderGeometry(radius, radius * 0.96, radius * 0.18, 7).translate(0, radius * 0.09, 0);
      const fade = aerial(Math.hypot(x - cx, z - cz)) * 0.6;
      add(
        mergeGeometries([underside.toNonIndexed(), top.toNonIndexed()])!,
        x,
        lift,
        z,
        radius,
        (y) => (y > 0 ? tint('#6b9a5e', haze, fade) : tint('#7a7468', haze, fade + 0.1)),
      );
      underside.dispose();
      top.dispose();
      const pagoda = mergeGeometries([
        new THREE.BoxGeometry(radius * 0.3, radius * 0.35, radius * 0.3).translate(0, radius * 0.35, 0),
        new THREE.ConeGeometry(radius * 0.32, radius * 0.25, 4).rotateY(Math.PI / 4).translate(0, radius * 0.65, 0),
      ].map((g) => g.toNonIndexed()))!;
      add(pagoda, x, lift, z, radius, (y, h) => (y > h * 0.5 ? tint('#4a3c37', haze, fade) : tint('#b4553f', haze, fade)));
    }
  } else if (spec.scenery === 'alps') {
    // Snow-capped ranges with foothills, and a castle on a hill across the water.
    for (let k = 0; k < 34; k++) {
      const angle = (k / 34) * Math.PI * 2 + rand() * 0.15,
        distance = inner + rand() * (outer - inner);
      const [x, z] = at(angle, distance);
      const height = extent * (0.14 + rand() * 0.22),
        radius = height * (0.75 + rand() * 0.35);
      const fade = aerial(distance);
      const foothills = woodland('#55784f', '#8fa970', '#8d8f86', '#cfc5a8');
      land.push(
        landform(
          noise,
          hazeColour,
          { x, z, rx: radius * (1.25 + rand() * 0.5), rz: radius * (0.95 + rand() * 0.3), height: height * 1.25, turn: angle + Math.PI / 2 + (rand() - 0.5), sharp: 1, cover: alpine, fade },
          12,
          30,
        ),
      );
      if (next() % 2 === 0) {
        const [hx, hz] = at(angle + 0.06, distance - extent * 0.35);
        land.push(landform(noise, hazeColour, { x: hx, z: hz, rx: radius * 1.1, rz: radius * 0.8, height: radius * 0.24, turn: angle, sharp: 0.1, cover: foothills, fade }, 8, 22));
      }
    }
    const angle = rand() * Math.PI * 2,
      [x, z] = at(angle, inner * 0.9);
    const s = extent * 0.06;
    // The castle's hill: broad enough to carry the keep, which is sunk into its crown.
    land.push(
      landform(noise, hazeColour, { x, z, rx: s * 5.2, rz: s * 4.2, height: s * 1.9, turn: angle, sharp: 0, cover: woodland('#55784f', '#8fa970', '#8d8f86', '#cfc5a8'), fade: 0.1 }, 9, 24),
    );
    const keep: THREE.BufferGeometry[] = [new THREE.BoxGeometry(s * 1.6, s * 2.6, s * 1.2).translate(0, s * 1.3, 0)];
    for (const [ox, oz] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as const)
      keep.push(
        new THREE.CylinderGeometry(s * 0.28, s * 0.3, s * 2.2, 8).translate(ox * s * 0.9, s * 2.2, oz * s * 0.7),
        new THREE.ConeGeometry(s * 0.36, s * 0.7, 8).translate(ox * s * 0.9, s * 3.65, oz * s * 0.7),
      );
    add(
      mergeGeometries(keep.map((g) => g.toNonIndexed()))!,
      x,
      -0.1,
      z,
      s * 4,
      (y, h) => (y > h * 0.82 ? tint('#4d5967', haze, 0.12) : tint('#c2baa8', haze, 0.12)),
    );
  } else {
    // Rolling headlands, and a neighbouring skyline across the bay.
    for (let k = 0; k < 26; k++) {
      const angle = (k / 26) * Math.PI * 2 + rand() * 0.2,
        distance = inner + rand() * (outer - inner);
      const [x, z] = at(angle, distance);
      const radius = extent * (0.25 + rand() * 0.3);
      const fade = aerial(distance);
      land.push(
        landform(noise, hazeColour, {
          x,
          z,
          rx: radius * 1.35,
          rz: radius * (0.8 + rand() * 0.3),
          height: radius * (0.2 + rand() * 0.16),
          turn: angle + Math.PI / 2 + (rand() - 0.5) * 0.8,
          sharp: 0.22,
          cover: woodland('#4a7449', '#8aa86c', '#8f8d7e', '#dccfa6'),
          fade,
        }),
      );
    }
    const towers: THREE.BufferGeometry[] = [];
    const angle = rand() * Math.PI * 2;
    for (let k = 0; k < 46; k++) {
      const [x, z] = at(angle + (rand() - 0.5) * 0.55, inner * (0.95 + rand() * 0.12));
      const h = extent * (0.03 + rand() ** 2 * 0.16),
        w = extent * (0.012 + rand() * 0.014);
      towers.push(new THREE.BoxGeometry(w, h, w).translate(x, h / 2 - 0.1, z).toNonIndexed());
    }
    add(mergeGeometries(towers)!, 0, 0, 0, extent * 0.2, () => tint('#8a9db3', haze, 0.35));
  }
  const flat = paintAndMerge(parts);
  const geometry = mergeGeometries([flat, ...land])!;
  flat.dispose();
  for (const g of land) g.dispose();
  // Terrain footprints are irregular, so the camera limit follows the land actually built.
  const position = geometry.getAttribute('position');
  let nearest = Infinity;
  for (let i = 0; i < position.count; i++) nearest = Math.min(nearest, Math.hypot(position.getX(i) - cx, position.getZ(i) - cz));
  return { geometry, mist, innerRadius: Math.min(inner * 0.82, nearest * 0.96) };
}

/** Soft radial puff for mist banks (one small texture shared by all banks). */
export function mistTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
