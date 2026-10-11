import * as THREE from 'three';
import { xorshift32 } from '@atlas/layout';
import type { ThemeSpec } from './themes';

/**
 * The living surroundings (ADR-041): a wave-lit sea, drifting clouds and foliage that sways.
 * All of it reads one shared `time` uniform. The renderer advances it only when ambient motion
 * is allowed (not reduced motion, low detail or software rendering), so everything here also
 * renders correctly frozen at time zero. None of it is pickable or encodes data.
 */
export type Clock = { value: number };

/**
 * Procedural sea. Normals come from a sum of directional waves (long swell to fine ripples),
 * each faded before it would alias. The surface reflects the sky with Fresnel weighting, glints
 * where the sun's half-vector meets a wave, shades from turquoise shallows to deep water away
 * from `island`, and laps foam on the island's beach line. `foam` 0 makes a still pond.
 */
export function waterMaterial(
  sky: ThemeSpec['sky'],
  time: Clock,
  sun: THREE.Vector3,
  options: { island: THREE.Vector4; foam: number; deep?: string; shallow?: string; calm?: number },
): THREE.ShaderMaterial {
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      deep: { value: new THREE.Color(options.deep ?? sky.deep) },
      shallow: { value: new THREE.Color(options.shallow ?? sky.shallow) },
      horizon: { value: new THREE.Color(sky.horizon) },
      zenith: { value: new THREE.Color(sky.zenith) },
      sunColor: { value: new THREE.Color(sky.sun) },
      sunDirection: { value: sun.clone().normalize() },
      island: { value: options.island },
      foam: { value: options.foam },
      calm: { value: options.calm ?? 1 },
    },
  ]);
  uniforms['time'] = time;
  return new THREE.ShaderMaterial({
    uniforms,
    fog: true,
    vertexShader: `#include <common>
#include <fog_pars_vertex>
varying vec3 vWorld;
void main() {
#ifdef USE_INSTANCING
  vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
#else
  vec4 world = modelMatrix * vec4(position, 1.0);
#endif
  vWorld = world.xyz;
  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`,
    fragmentShader: `#include <common>
#include <fog_pars_fragment>
uniform float time;
uniform vec3 deep; uniform vec3 shallow; uniform vec3 horizon; uniform vec3 zenith;
uniform vec3 sunColor; uniform vec3 sunDirection; uniform vec4 island; uniform float foam; uniform float calm;
varying vec3 vWorld;
// Arithmetic hash (no sin): cheap and stable on every GPU.
vec2 atlasHash2(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.103, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return -1.0 + 2.0 * fract((q.xx + q.yz) * q.zy);
}
// Gradient noise and its analytic slope (quintic interpolation).
vec2 atlasNoiseSlope(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  vec2 ga = atlasHash2(i), gb = atlasHash2(i + vec2(1.0, 0.0)), gc = atlasHash2(i + vec2(0.0, 1.0)), gd = atlasHash2(i + vec2(1.0, 1.0));
  float va = dot(ga, f), vb = dot(gb, f - vec2(1.0, 0.0)), vc = dot(gc, f - vec2(0.0, 1.0)), vd = dot(gd, f - vec2(1.0, 1.0));
  return ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd) + du * (u.yx * (va - vb - vc + vd) + vec2(vb, vc) - va);
}
// One drifting octave of short-crested sea, faded out as its features near a pixel.
vec2 atlasOctave(vec2 p, float freq, float amp, vec2 drift, float px) {
  float fade = 1.0 - smoothstep(0.06, 0.22, freq * px);
  // Distant water skips octaves it cannot show (a coherent branch across the far sea).
  if (fade <= 0.0) return vec2(0.0);
  return atlasNoiseSlope(p * freq + drift * time) * freq * amp * fade;
}
void main() {
  vec2 p = vWorld.xz;
  float px = length(fwidth(p));
  // Short-crested sea: rotated octaves drifting in different directions, plus a faint swell.
  mat2 turn = mat2(0.8, -0.6, 0.6, 0.8);
  vec2 g = atlasOctave(p, 0.11, 1.1, vec2(0.05, 0.03), px);
  g += atlasOctave(turn * p, 0.24, 0.55, vec2(-0.08, 0.05), px);
  g += atlasOctave(p.yx, 0.53, 0.26, vec2(0.11, -0.09), px);
  g += atlasOctave(turn * p.yx, 1.17, 0.12, vec2(-0.16, -0.12), px);
  g += atlasOctave(p * vec2(1.0, -1.0), 2.6, 0.055, vec2(0.24, 0.2), px);
  float swell = 1.0 - smoothstep(0.03, 0.12, 0.09 * px);
  g += vec2(0.94, 0.33) * 0.016 * cos(dot(vec2(0.94, 0.33), p) * 0.09 + time * 0.5) * swell;
  g *= 0.55 * calm;
  vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
  vec3 v = normalize(cameraPosition - vWorld);
  float fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
  vec3 r = reflect(-v, n);
  vec3 reflected = mix(horizon, zenith, smoothstep(0.02, 0.6, r.y));
  vec2 outside = max(max(island.xy - p, p - island.zw), 0.0);
  float shore = length(outside);
  vec3 body = mix(shallow, deep, smoothstep(0.0, 22.0, shore));
  // Light scattering through the near side of each swell.
  body += shallow * 0.22 * clamp(dot(g, normalize(v.xz + 1e-4)) * 3.0, 0.0, 1.0);
  vec3 colour = mix(body, reflected, clamp(fresnel * 0.92, 0.0, 1.0));
  vec3 h = normalize(sunDirection + v);
  float nh = max(dot(n, h), 0.0);
  colour += sunColor * (pow(nh, 420.0) * 2.4 + pow(nh, 48.0) * 0.07);
  // Foam laps the beach and thins away from it.
  float edge = 1.0 - smoothstep(0.0, 0.3, shore);
  float band = 1.0 - smoothstep(0.0, 1.8, shore);
  float lap = 0.5 + 0.5 * sin(shore * 4.6 - time * 1.3 + sin(p.x * 0.83) * 1.4 + cos(p.y * 0.71) * 1.4);
  float spray = foam * max(edge * 0.75, band * smoothstep(0.55, 0.97, lap) * 0.65);
  colour = mix(colour, vec3(0.95, 0.97, 0.96), spray);
  gl_FragColor = vec4(colour, 1.0);
  #include <colorspace_fragment>
  #include <fog_fragment>
}`,
  });
}

/** Soft cumulus texture: overlapping puffs with a shaded underside. */
function cloudTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  const next = xorshift32(0x5eed);
  const rand = () => (next() % 10_000) / 10_000;
  for (let i = 0; i < 26; i++) {
    const x = 40 + rand() * 176,
      y = 52 + rand() * 40 - Math.abs(x - 128) * 0.18,
      r = 18 + rand() * 30;
    const g = ctx.createRadialGradient(x, y - r * 0.25, r * 0.1, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.6, 'rgba(244,246,250,0.5)');
    g.addColorStop(1, 'rgba(230,234,242,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Billboarded clouds drifting slowly over the outer sea. They sit in a ring beyond the
 * camera's reach, so they never pass between the camera and the city.
 */
export function cloudLayer(tint: string, centre: THREE.Vector3, extent: number, time: Clock, seed: number) {
  const texture = cloudTexture();
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { tint: { value: new THREE.Color(tint) } }]);
  uniforms['time'] = time;
  uniforms['map'] = { value: texture };
  const material = new THREE.ShaderMaterial({
    uniforms,
    fog: true,
    transparent: true,
    depthWrite: false,
    vertexShader: `#include <common>
#include <fog_pars_vertex>
uniform float time;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec3 centre = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float size = length(instanceMatrix[0].xyz);
  centre.x += sin(time * 0.012 + centre.z * 0.01) * size * 0.6;
  centre.z += cos(time * 0.009 + centre.x * 0.01) * size * 0.3;
  vec4 mvPosition = viewMatrix * vec4(centre, 1.0) + vec4(position.x * size, position.y * size * 0.5, 0.0, 0.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`,
    fragmentShader: `#include <common>
#include <fog_pars_fragment>
uniform sampler2D map; uniform vec3 tint;
varying vec2 vUv;
void main() {
  vec4 t = texture2D(map, vUv);
  vec3 colour = tint * mix(0.82, 1.0, vUv.y) * t.rgb;
  gl_FragColor = vec4(colour, t.a * 0.92);
  #include <colorspace_fragment>
  #include <fog_fragment>
}`,
  });
  const next = xorshift32(seed || 1);
  const rand = () => (next() % 10_000) / 10_000;
  const count = 30;
  const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material, count);
  const m = new THREE.Matrix4();
  for (let i = 0; i < count; i++) {
    const angle = rand() * Math.PI * 2,
      distance = extent * (3.1 + rand() * 2.2),
      size = extent * (0.35 + rand() * 0.45);
    m.makeScale(size, size, size).setPosition(
      centre.x + Math.cos(angle) * distance,
      extent * (0.28 + rand() * 0.3),
      centre.z + Math.sin(angle) * distance,
    );
    mesh.setMatrixAt(i, m);
  }
  mesh.frustumCulled = false;
  return { mesh, texture };
}

/**
 * Foliage: Lambert with vertex colours, plus a gentle wind sway that grows with height above
 * the trunk and varies per tree. The static shadow map keeps the rest pose.
 */
export function foliageMaterial(time: Clock): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  material.onBeforeCompile = (shader) => {
    shader.uniforms['time'] = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float time;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
#ifdef USE_INSTANCING
  vec3 atlasRoot = instanceMatrix[3].xyz;
#else
  vec3 atlasRoot = vec3(0.0);
#endif
  float atlasBend = max(position.y - 0.18, 0.0);
  float atlasSway = sin(time * 1.25 + atlasRoot.x * 0.71 + atlasRoot.z * 0.93) * 0.05 + sin(time * 2.9 + atlasRoot.x * 1.7) * 0.012;
  transformed.x += atlasSway * atlasBend;
  transformed.z += atlasSway * 0.55 * atlasBend;`,
      );
  };
  material.customProgramCacheKey = () => 'atlas-foliage-1';
  return material;
}
