import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { VEHICLE_KINDS, treeGeometry, vehicleGeometry, withPaintMask } from '../src/city/architecture';
import { foliageMaterial } from '../src/city/living';
import { withCover, withPaving, withTiles, type SurfaceUniforms } from '../src/city/shading';
import type { TreeKind } from '../src/city/themes';
import { SURFACE, SURFACE_LAYERS, SURFACE_TILE, neutralSurfaces } from '../src/city/walls';

/** Every tree kind; `satisfies` fails to compile if a kind is added or removed. */
const TREE_KINDS = Object.keys({ round: 1, plane: 1, oak: 1, blossom: 1, willow: 1, conifer: 1, pine: 1, cypress: 1 } satisfies Record<TreeKind, 1>) as TreeKind[];

/** Width, height and per-component sampling factors from a JPEG's frame header. */
function jpegFrame(bytes: Uint8Array) {
  let at = 2;
  while (at + 4 < bytes.length) {
    const marker = bytes[at + 1]!,
      length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
    if (marker >= 0xc0 && marker <= 0xc2) {
      const count = bytes[at + 9]!;
      return { height: (bytes[at + 5]! << 8) | bytes[at + 6]!, width: (bytes[at + 7]! << 8) | bytes[at + 8]!, sampling: Array.from({ length: count }, (_, i) => bytes[at + 11 + i * 3]!) };
    }
    at += 2 + length;
  }
  throw new Error('no frame header');
}

/** Run a material's onBeforeCompile on the stock Lambert shader and return the result. */
function compiled(material: THREE.Material) {
  const shader = { uniforms: {} as Record<string, THREE.IUniform>, vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader };
  material.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
  return shader;
}

describe('baked ground and roof surfaces (ADR-107)', () => {
  it('ships one square tile per surface, without chroma subsampling, in a small file', () => {
    const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL('../src/assets/surface-detail.jpg', import.meta.url))));
    const frame = jpegFrame(bytes);
    expect(frame.height).toBe(frame.width * SURFACE_LAYERS);
    expect(frame.sampling).toEqual([0x11, 0x11, 0x11]);
    expect(bytes.length).toBeLessThan(450 * 1024);
    expect(SURFACE_TILE).toHaveLength(SURFACE_LAYERS);
    expect(Object.values(SURFACE).sort()).toEqual(Array.from({ length: SURFACE_LAYERS }, (_, i) => i));
  });

  it('adds baked detail to paving, asphalt and roofs only when surfaces are given', () => {
    const detail = new THREE.DataTexture(new Uint8Array(4).fill(128), 1, 1);
    const surfaces: SurfaceUniforms = { atlasSurfaces: { value: neutralSurfaces() }, atlasSurfacesReady: { value: 0 } };
    for (const [apply, label] of [
      [(m: THREE.Material, s: SurfaceUniforms | null) => withPaving(m, 2, detail, s), 'paving'],
      [(m: THREE.Material, s: SurfaceUniforms | null) => withCover(m, detail, s), 'cover'],
      [(m: THREE.Material, s: SurfaceUniforms | null) => withTiles(m, 30, 44, s), 'tiles'],
    ] as const) {
      const plain = compiled(Object.assign(new THREE.MeshLambertMaterial(), {}));
      const without = new THREE.MeshLambertMaterial();
      apply(without, null);
      const baked = new THREE.MeshLambertMaterial();
      apply(baked, surfaces);
      const a = compiled(without),
        b = compiled(baked);
      expect(a.fragmentShader, label).not.toContain('atlasSurfaces');
      expect(b.fragmentShader, label).toContain('textureGrad(atlasSurfaces');
      // Relief tilts the shading normal after three.js has computed it.
      expect(b.fragmentShader.indexOf('#include <normal_fragment_maps>'), label).toBeGreaterThan(-1);
      expect(b.uniforms['atlasSurfacesReady'], label).toBe(surfaces.atlasSurfacesReady);
      expect(without.customProgramCacheKey(), label).not.toBe(baked.customProgramCacheKey());
      expect(plain.fragmentShader).toBe(THREE.ShaderLib.lambert.fragmentShader);
    }
    surfaces.atlasSurfaces.value.dispose();
    detail.dispose();
  });
});

describe('city cars from the Kenney Car Kit (ADR-107)', () => {
  it('builds every model at city scale, on the ground, facing +x, with a painted body', () => {
    expect(VEHICLE_KINDS).toBeGreaterThanOrEqual(3);
    for (let kind = 0; kind < VEHICLE_KINDS; kind++) {
      const car = vehicleGeometry(false, kind);
      const triangles = (car.index ? car.index.count : car.getAttribute('position').count) / 3;
      expect(triangles).toBeLessThanOrEqual(700);
      car.computeBoundingBox();
      const box = car.boundingBox!;
      expect(box.max.x - box.min.x).toBeLessThanOrEqual(0.45);
      expect(box.max.z - box.min.z).toBeLessThanOrEqual(0.2);
      expect(box.max.y).toBeLessThanOrEqual(0.21);
      expect(Math.abs(box.min.y)).toBeLessThan(0.002);
      // About a third of the body takes the paint; glass, lights, trim and tyres do not.
      const paint = car.getAttribute('atlasPaint'),
        color = car.getAttribute('color'),
        position = car.getAttribute('position');
      expect(paint.count).toBe(position.count);
      let painted = 0,
        amber = 0,
        amberX = 0,
        red = 0,
        redX = 0;
      const c = new THREE.Color();
      for (let i = 0; i < paint.count; i++) {
        if (paint.getX(i) > 0.5) {
          painted++;
          continue;
        }
        c.setRGB(color.getX(i), color.getY(i), color.getZ(i)).convertLinearToSRGB();
        if (c.r > 0.78 && c.g > 0.55 && c.b < 0.51) (amber++, (amberX += position.getX(i)));
        else if (c.r > 0.59 && c.g < 0.39 && c.b < 0.39) (red++, (redX += position.getX(i)));
      }
      expect(painted / paint.count).toBeGreaterThan(0.1);
      expect(painted / paint.count).toBeLessThan(0.6);
      // Headlights at the front (+x, the direction the circuit shader drives); tail lights,
      // where they are not the body's own red (the sedan's are, so they take the paint), behind.
      expect(amber).toBeGreaterThan(0);
      expect(amberX / amber).toBeGreaterThan(0.1);
      if (red) expect(redX / red).toBeLessThan(-0.1);
      car.dispose();
    }
  });

  it('adds a contact shadow under moving cars and paints only where the mask says', () => {
    const parked = vehicleGeometry(false, 0),
      moving = vehicleGeometry(true, 0);
    expect(moving.getAttribute('position').count).toBeGreaterThanOrEqual(parked.getAttribute('position').count);
    moving.computeBoundingBox();
    expect(moving.boundingBox!.max.x).toBeLessThanOrEqual(0.22);
    const shader = compiled(withPaintMask(new THREE.MeshLambertMaterial({ vertexColors: true })));
    expect(shader.vertexShader).toContain('attribute float atlasPaint;');
    expect(shader.vertexShader).toContain('mix( vec3( 1.0 ), instanceColor.rgb, atlasPaint )');
    expect(shader.vertexShader).not.toContain('#include <color_vertex>');
    for (const g of [parked, moving]) g.dispose();
  });
});

describe('trees (ADR-107)', () => {
  it('builds every kind within budget, standing on the ground, with brown bark and tinted foliage', () => {
    for (const kind of TREE_KINDS) {
      const tree = treeGeometry(kind);
      const position = tree.getAttribute('position'),
        color = tree.getAttribute('color'),
        paint = tree.getAttribute('atlasPaint');
      // Half as many trees as before ADR-107, so each may cost up to about twice as much.
      expect((tree.index ? tree.index.count : position.count) / 3, kind).toBeLessThanOrEqual(700);
      tree.computeBoundingBox();
      expect(tree.boundingBox!.min.y, kind).toBeGreaterThan(-0.01);
      expect(tree.boundingBox!.max.y, kind).toBeLessThan(0.9);
      expect(paint.count, kind).toBe(position.count);
      let bark = 0,
        leaves = 0,
        barkTop = 0,
        leafTop = 0;
      for (let i = 0; i < paint.count; i++) {
        if (paint.getX(i) > 0.5) {
          leaves++;
          leafTop = Math.max(leafTop, position.getY(i));
          continue;
        }
        bark++;
        barkTop = Math.max(barkTop, position.getY(i));
        // Unpainted vertices are the trunk and limbs: brown, never tinted green.
        expect(color.getX(i), kind).toBeGreaterThan(color.getY(i));
        expect(color.getY(i), kind).toBeGreaterThan(color.getZ(i));
      }
      expect(bark, kind).toBeGreaterThan(0);
      expect(leaves / paint.count, kind).toBeGreaterThan(0.6);
      // Wood ends inside the crown: no limb or leader pokes out of the top.
      expect(barkTop, kind).toBeLessThan(leafTop - 0.08);
      // Seeded: every load builds the same tree.
      const again = treeGeometry(kind);
      expect(Array.from(again.getAttribute('position').array as Float32Array), kind).toEqual(Array.from(position.array as Float32Array));
      expect(Array.from(again.getAttribute('color').array as Float32Array), kind).toEqual(Array.from(color.array as Float32Array));
      for (const g of [tree, again]) g.dispose();
    }
  });

  it('lights foliage with wrapped Lambert and tints only the leaves', () => {
    const material = withPaintMask(foliageMaterial({ value: 0 }));
    const shader = compiled(material);
    expect(shader.fragmentShader).not.toContain('#include <lights_lambert_pars_fragment>');
    expect(shader.fragmentShader).toContain('saturate( ( dot( geometryNormal, directLight.direction ) + 0.35 ) / 1.35 )');
    expect(shader.vertexShader).toContain('mix( vec3( 1.0 ), instanceColor.rgb, atlasPaint )');
    // The wind sway is still there, carried into each tree's own frame.
    expect(shader.vertexShader).toContain('vec3 atlasWind = (vec4(1.0, 0.0, 0.55, 0.0) * instanceMatrix).xyz / dot(instanceMatrix[0].xyz, instanceMatrix[0].xyz);');
    expect(shader.vertexShader).toContain('transformed += atlasWind * atlasSway * atlasBend;');
    expect(material.customProgramCacheKey()).toContain('atlas-foliage-3');
    material.dispose();
  });

  it('blows the wind the same way for every turned and stretched tree', () => {
    // The shader's `vec4(w, 0) * instanceMatrix` is the transpose times w; dividing by the
    // squared width scale and drawing through the instance matrix must give w back.
    const wind = new THREE.Vector3(1, 0, 0.55);
    for (const [turn, width, height] of [
      [0, 1, 1],
      [1.1, 0.8, 0.9],
      [4.2, 1.2, 1.3],
    ] as const) {
      const m = new THREE.Matrix4().makeRotationY(turn).scale(new THREE.Vector3(width, width * height, width)).setPosition(3, 0.2, -5);
      const e = m.elements;
      const local = new THREE.Vector3(e[0]! * wind.x + e[1]! * wind.y + e[2]! * wind.z, e[4]! * wind.x + e[5]! * wind.y + e[6]! * wind.z, e[8]! * wind.x + e[9]! * wind.y + e[10]! * wind.z).divideScalar(e[0]! ** 2 + e[1]! ** 2 + e[2]! ** 2);
      const world = local.clone().applyMatrix3(new THREE.Matrix3().setFromMatrix4(m));
      expect(world.x).toBeCloseTo(wind.x, 6);
      expect(world.y).toBeCloseTo(wind.y, 6);
      expect(world.z).toBeCloseTo(wind.z, 6);
    }
  });
});
