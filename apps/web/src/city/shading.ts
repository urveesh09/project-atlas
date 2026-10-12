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

/** District surfaces by kind: kerb (plain), street (asphalt) or plaza (paving). */
export const PAVE = { kerb: 0, street: 1, plaza: 2 } as const;
/** Paving per style: modern concrete squares, eastern staggered flagstones, western cobbles. */
export type PavingStyle = 0 | 1 | 2;

/**
 * Paving joints and per-slab tone on plazas, fine aggregate on streets. Patterns are in
 * world space, fade out before they would shimmer, and only touch upward faces.
 */
export function withPaving(material: THREE.Material, style: PavingStyle) {
  chain(material, `pave-${style}`, (shader) => {
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
