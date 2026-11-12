import * as THREE from 'three';

/**
 * Shader patches that add surface realism without geometry or extra passes (ADR-042):
 * the baked sky-occlusion field on the ground and lower walls, paving and asphalt on the
 * district surfaces, and tile courses on the pitched source roofs. Each patch is a few
 * arithmetic operations or one texture read per pixel.
 */

/** Shared uniforms of the sky-occlusion field; the texture is replaced when a bake lands. */
export interface FieldUniforms {
  atlasAO: { value: THREE.Texture };
  atlasAORect: { value: THREE.Vector4 };
}

/** Starts fully open (white), so nothing darkens before the first bake arrives. */
export function fieldUniforms(): FieldUniforms {
  const open = new THREE.DataTexture(new Uint8Array([255]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
  open.needsUpdate = true;
  return { atlasAO: { value: open }, atlasAORect: { value: new THREE.Vector4(0, 0, 1, 1) } };
}

/** Chain a patch onto a material, keeping an earlier patch and giving each variant its own program. */
function chain(material: THREE.Material, key: string, patch: (shader: THREE.WebGLProgramParametersWithUniforms) => void) {
  const before = material.onBeforeCompile;
  const custom = material.customProgramCacheKey !== THREE.Material.prototype.customProgramCacheKey;
  const previous = custom ? material.customProgramCacheKey.bind(material) : () => '';
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    patch(shader);
  };
  material.customProgramCacheKey = () => `${previous()}|${key}`;
}

/**
 * Darken a Lambert material by the field: sky (indirect) light fully, sun light slightly,
 * which reads as bounce light lost in a street canyon. Walls sample the ground just in
 * front of them and fade up the storeys; denser blocks reach higher.
 */
export function withOcclusion(material: THREE.Material, uniforms: FieldUniforms, wall = false) {
  chain(material, `ao${wall ? '-wall' : ''}`, (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec4 atlasAORect;
varying vec2 vAtlasAOUv;
${wall ? 'varying float vAtlasAOHeight;' : ''}`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
{
  vec4 atlasW = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  atlasW = instanceMatrix * atlasW;
#endif
  atlasW = modelMatrix * atlasW;
  vec2 atlasXZ = atlasW.xz;
${
  wall
    ? `  vec3 atlasN = objectNormal;
#ifdef USE_INSTANCING
  atlasN = mat3(instanceMatrix) * atlasN;
#endif
  atlasN = mat3(modelMatrix) * atlasN;
  float atlasSide = length(atlasN.xz);
  atlasXZ += atlasSide > 0.2 * length(atlasN) ? atlasN.xz / atlasSide * 0.14 : vec2(0.0);
  vAtlasAOHeight = atlasW.y;`
    : ''
}
  vAtlasAOUv = (atlasXZ - atlasAORect.xy) * atlasAORect.zw;
}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2D atlasAO;
varying vec2 vAtlasAOUv;
${wall ? 'varying float vAtlasAOHeight;' : ''}`,
      )
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
{
  float atlasOpen = texture2D(atlasAO, vAtlasAOUv).r;
${wall ? '  atlasOpen = mix(atlasOpen, 1.0, smoothstep(0.05, 0.5 + 2.5 * (1.0 - atlasOpen), vAtlasAOHeight));' : ''}
  // Squared: open ground stays bright, the foot of a wall and a narrow street darken clearly.
  float atlasSky = atlasOpen * atlasOpen;
  reflectedLight.indirectDiffuse *= atlasSky;
  reflectedLight.directDiffuse *= mix(1.0, atlasSky, 0.55);
}`,
      );
  });
}

/**
 * One small tiling texture gives every surface its irregularity, the way a game's detail
 * map does: red is fine grain, green is soft blotches, blue is fine grain drawn out into
 * vertical streaks. It is seeded, so every load is identical, and mipmapped, so grain
 * averages away with distance instead of shimmering.
 */
export function detailTexture(size = 256): THREE.DataTexture {
  const hash = (x: number, y: number, seed: number) => {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2147483647)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  // Value noise on a lattice that wraps after `period` cells, so the texture tiles.
  const noise = (x: number, y: number, period: number, seed: number) => {
    const xi = Math.floor(x),
      yi = Math.floor(y),
      fx = x - xi,
      fy = y - yi;
    const u = fx * fx * (3 - 2 * fx),
      v = fy * fy * (3 - 2 * fy);
    const at = (i: number, j: number) => hash(((i % period) + period) % period, ((j % period) + period) % period, seed);
    const top = at(xi, yi) + (at(xi + 1, yi) - at(xi, yi)) * u,
      bottom = at(xi, yi + 1) + (at(xi + 1, yi + 1) - at(xi, yi + 1)) * u;
    return top + (bottom - top) * v;
  };
  const fractal = (x: number, y: number, period: number, octaves: number, seed: number) => {
    let sum = 0,
      weight = 0;
    for (let o = 0, amplitude = 1, scale = 1; o < octaves; o++, amplitude *= 0.5, scale *= 2) {
      sum += amplitude * noise(x * period * scale, y * period * scale, period * scale, seed + o);
      weight += amplitude;
    }
    return sum / weight;
  };
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = x / size,
        v = y / size,
        at = (y * size + x) * 4;
      data[at] = Math.round(255 * fractal(u, v, 48, 2, 11));
      // Stretch the contrast: averaged octaves cluster around the middle.
      data[at + 1] = Math.round(255 * Math.min(1, Math.max(0, (fractal(u, v, 5, 4, 23) - 0.5) * 1.9 + 0.5)));
      data[at + 2] = Math.round(255 * fractal(u * 6, v, 8, 3, 37));
      data[at + 3] = 255;
    }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/** Ground cover of the island's own surfaces: bare (markings), grass, sand or asphalt. */
export const COVER = { none: 0, grass: 1, sand: 2, asphalt: 3 } as const;

/**
 * Texture for the open ground, from the detail map in world space. Grass drifts between
 * lush and dry in broad patches over a fine blade grain; sand carries ripples; asphalt has
 * aggregate and the lighter and darker panels of old repairs.
 */
export function withCover(material: THREE.Material, detail: THREE.Texture) {
  chain(material, 'cover', (shader) => {
    shader.uniforms['atlasDetail'] = { value: detail };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float atlasCover;
varying vec3 vAtlasCover;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vAtlasCover = vec3((modelMatrix * vec4(transformed, 1.0)).xz, normal.y > 0.5 ? atlasCover : 0.0);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2D atlasDetail;
varying vec3 vAtlasCover;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  float kind = floor(vAtlasCover.z + 0.5);
  if (kind > 0.5) {
    vec3 broad = texture2D(atlasDetail, vAtlasCover.xy * 0.037).rgb;
    vec3 grain = texture2D(atlasDetail, vAtlasCover.xy * 0.71).rgb;
    float mottle = texture2D(atlasDetail, vAtlasCover.yx * 0.19 + 0.61).g;
    if (kind < 1.5) {
      // Dry, yellower patches where the second, slower field runs high.
      float dry = smoothstep(0.5, 0.82, texture2D(atlasDetail, vAtlasCover.yx * 0.0113 + 0.37).g);
      // Turf grows in clumps: the fine channel again, at the size of a tuft.
      float tuft = texture2D(atlasDetail, vAtlasCover.xy * 0.16 + 0.23).r;
      diffuseColor.rgb *= (0.8 + 0.38 * broad.g) * (0.86 + 0.28 * mottle) * (0.8 + 0.4 * tuft) * (0.88 + 0.24 * grain.r);
      diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.16, 1.05, 0.7), dry * 0.7);
    } else if (kind < 2.5) {
      diffuseColor.rgb *= (0.9 + 0.2 * broad.g) * (0.93 + 0.14 * mottle) * (0.9 + 0.2 * grain.b);
    } else {
      diffuseColor.rgb *= (0.88 + 0.24 * broad.g) * (0.85 + 0.3 * mottle) * (0.86 + 0.28 * grain.r);
    }
  }
}`,
      );
  });
}

/** District surfaces by kind: kerb (plain), street (asphalt) or plaza (paving). */
export const PAVE = { kerb: 0, street: 1, plaza: 2 } as const;
/** Paving per style: modern concrete squares, eastern staggered flagstones, western cobbles. */
export type PavingStyle = 0 | 1 | 2;

/**
 * Paving joints and per-slab tone on plazas, fine aggregate on streets. Patterns are in
 * world space, fade out before they would shimmer, and only touch upward faces.
 */
export function withPaving(material: THREE.Material, style: PavingStyle, detail: THREE.Texture) {
  chain(material, `pave-${style}`, (shader) => {
    shader.uniforms['atlasDetail'] = { value: detail };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float atlasPave;
varying vec3 vAtlasPave;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
{
  vec4 atlasP = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  atlasP = instanceMatrix * atlasP;
#endif
  atlasP = modelMatrix * atlasP;
  vAtlasPave = vec3(atlasP.xz, normal.y > 0.5 ? atlasPave : 0.0);
}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vAtlasPave;
uniform sampler2D atlasDetail;
float atlasPaveHash(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  float kind = floor(vAtlasPave.z + 0.5);
  if (kind > 0.5) {
    bool plaza = kind > 1.5;
    vec2 size = plaza ? ${style === 0 ? 'vec2(0.5, 0.5)' : style === 1 ? 'vec2(0.46, 0.3)' : 'vec2(0.17, 0.13)'} : vec2(0.22);
    vec2 uv = vAtlasPave.xy / size;
    if (plaza && ${style === 0 ? 'false' : 'true'}) uv.x += 0.5 * mod(floor(uv.y), 2.0);
    vec2 cell = floor(uv);
    vec2 f = fract(uv);
    vec2 fw = max(fwidth(uv), vec2(1e-4));
    float fade = 1.0 - smoothstep(0.18, 0.45, max(fw.x, fw.y));
    float tone = atlasPaveHash(cell + (plaza ? 0.0 : 17.0)) - 0.5;
    float joint = 0.0;
    if (plaza) {
      vec2 e = min(f, 1.0 - f);
      vec2 j = 1.0 - smoothstep(vec2(${style === 2 ? '0.08' : '0.035'}) - fw, vec2(${style === 2 ? '0.08' : '0.035'}) + fw, e);
      joint = max(j.x, j.y);
    }
    float shade = 1.0 + (plaza ? ${style === 2 ? '0.11' : '0.06'} : 0.05) * tone - (plaza ? ${style === 2 ? '0.2' : '0.12'} : 0.0) * joint;
    diffuseColor.rgb *= mix(1.0, shade, fade);
    // Weather: asphalt matches the island's roads; plazas stain in broad, soft patches.
    float broad = texture2D(atlasDetail, vAtlasPave.xy * 0.037).g;
    float mottle = texture2D(atlasDetail, vAtlasPave.yx * 0.19 + 0.61).g;
    diffuseColor.rgb *= plaza
      ? (0.9 + 0.2 * broad) * (0.92 + 0.16 * mottle)
      : (0.88 + 0.24 * broad) * (0.85 + 0.3 * mottle) * (0.86 + 0.28 * texture2D(atlasDetail, vAtlasPave.xy * 0.71).r);
  }
}`,
      );
  });
}

/** Tile courses and ridge seams on pitched roofs, from their object-space shape. */
export function withTiles(material: THREE.Material, courses: number, ridges: number) {
  chain(material, `tiles-${courses}-${ridges}`, (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vAtlasRoof;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvAtlasRoof = position;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vAtlasRoof;`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  vec2 t = vec2(atan(vAtlasRoof.z, vAtlasRoof.x) * ${(ridges / (2 * Math.PI)).toFixed(4)}, vAtlasRoof.y * ${courses.toFixed(1)});
  vec2 f = fract(t);
  vec2 fw = max(fwidth(t), vec2(1e-4));
  float fade = 1.0 - smoothstep(0.2, 0.45, max(fw.x, fw.y));
  float course = smoothstep(0.0, 0.7, f.y);
  float seam = 1.0 - smoothstep(0.0, 0.12 + fw.x, min(f.x, 1.0 - f.x));
  diffuseColor.rgb *= mix(1.0, (0.8 + 0.2 * course) * (1.0 - 0.18 * seam), fade);
}`,
      );
  });
}
