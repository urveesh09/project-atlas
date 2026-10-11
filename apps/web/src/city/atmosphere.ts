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
  vec3 colour = mix(horizon, zenith, pow(smoothstep(0.0, 0.9, up), 0.7));
  colour = mix(colour, haze, 1.0 - smoothstep(-0.05, 0.12, up));
  float glow = max(dot(d, sunDirection), 0.0);
  colour += sunColor * (pow(glow, 900.0) * 0.9 + pow(glow, 24.0) * 0.18);
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

/** A broad sea whose specular glint moves with the viewer; fog fades it into the horizon. */
export function oceanMesh(sky: ThemeSpec['sky'], centre: THREE.Vector3, radius: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 64).rotateX(-Math.PI / 2),
    new THREE.MeshPhongMaterial({ color: sky.ocean, specular: '#d9e6ee', shininess: 70 }),
  );
  mesh.position.set(centre.x, -0.1, centre.z);
  mesh.receiveShadow = true;
  return mesh;
}

type Paint = (y: number, height: number) => THREE.Color;

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
        const rock = new THREE.CylinderGeometry(radius * 0.75, radius, height, 7).translate(0, height / 2, 0);
        const crown = new THREE.IcosahedronGeometry(radius * 0.95, 0).scale(1, 0.55, 1).translate(0, height, 0);
        const paint: Paint = (y, h) =>
          y > h * 0.93 ? tint('#5f8a5a', haze, fade) : tint('#6f7a72', '#a7ab9c', y / h).lerp(new THREE.Color(haze), fade);
        add(mergeGeometries([rock.toNonIndexed(), crown.toNonIndexed()])!, x, -0.1, z, height, paint);
        rock.dispose();
        crown.dispose();
        if (next() % 5 === 0) {
          const pagoda = mergeGeometries([
            new THREE.BoxGeometry(radius * 0.6, radius * 0.5, radius * 0.6).translate(0, radius * 0.25, 0),
            new THREE.ConeGeometry(radius * 0.6, radius * 0.45, 4).rotateY(Math.PI / 4).translate(0, radius * 0.72, 0),
          ].map((g) => g.toNonIndexed()))!;
          add(pagoda, x, -0.1 + height * 1.02, z, radius, (y, h) => (y > h * 0.5 ? tint('#4a3c37', haze, fade) : tint('#b4553f', haze, fade)));
        }
      }
      mist.push({ x: at(angle, distance)[0], y: extent * 0.04, z: at(angle, distance)[1], size: extent * (0.5 + rand() * 0.4) });
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
      const peak = new THREE.ConeGeometry(radius, height, 7 + (next() % 3), 2).translate(0, height / 2, 0);
      add(peak, x, -0.1, z, height, (y, h) =>
        y > h * 0.66 ? tint('#f4f4f2', haze, fade * 0.6) : tint('#6e7f6a', '#8d8f86', y / (h * 0.66)).lerp(new THREE.Color(haze), fade),
      );
      if (next() % 2 === 0) {
        const hill = new THREE.IcosahedronGeometry(radius * 0.7, 1).scale(1.4, 0.32, 1.1).translate(0, 0, 0);
        const [hx, hz] = at(angle + 0.06, distance - extent * 0.35);
        add(hill, hx, -0.1, hz, radius * 0.22, () => tint('#7f9a66', haze, fade));
      }
    }
    const angle = rand() * Math.PI * 2,
      [x, z] = at(angle, inner * 0.9);
    const s = extent * 0.06;
    add(new THREE.IcosahedronGeometry(s * 3, 1).scale(1.5, 0.45, 1.2), x, -0.1, z, s, () => tint('#86a06c', haze, 0.1));
    const keep: THREE.BufferGeometry[] = [new THREE.BoxGeometry(s * 1.6, s * 1.4, s * 1.2).translate(0, s * 1.9, 0)];
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
      add(new THREE.IcosahedronGeometry(radius, 1).scale(1.3, 0.28 + rand() * 0.2, 1), x, -0.1, z, radius * 0.4, (y, h) =>
        tint('#76966a', '#9aae84', y / h).lerp(new THREE.Color(haze), fade),
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
  return { geometry: paintAndMerge(parts), mist, innerRadius: inner * 0.82 };
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
