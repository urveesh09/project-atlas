import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { generateSyntheticCity, type SyntheticCity } from './synthetic';

/**
 * P0.4 instancing spike: one InstancedMesh for every building and one for district bases,
 * ID picking through instanceId, measured frame times, and an HTML fallback on WebGL
 * absence or context loss. The production renderer (P3.2) builds on these findings.
 */
const params = new URLSearchParams(location.search);
const FILE_COUNT = Math.min(20_000, Math.max(1, Number(params.get('n') ?? 10_000)));
const VIEW: 'iso' | 'top' = params.get('view') === 'top' ? 'top' : 'iso';
const FORCE_NO_WEBGL = params.get('nowebgl') === '1';
const HEIGHT_SCALE = 0.45;

const PALETTE = ['#e8d9b5', '#d9c79b', '#cdb889', '#c2a978', '#b79b6a'].map((c) => new THREE.Color(c));
const BUILDING = new THREE.Color('#5f7fa6');
const BUILDING_TALL = new THREE.Color('#2f4f78');
const SELECTED = new THREE.Color('#f2a541');

export interface SpikeStats {
  fileCount: number;
  districtCount: number;
  drawCalls: number;
  triangles: number;
  layoutMs: number;
  renderer: string;
  heapUsedBytes: number | null;
}

declare global {
  interface Window {
    __atlasSpike?: {
      ready: boolean;
      stats(): SpikeStats;
      measureFrames(frames: number): Promise<number[]>;
      screenPointOf(index: number): { x: number; y: number } | null;
      pickAt(clientX: number, clientY: number): string | null;
      lineageAt(index: number): string;
      loseContext(): boolean;
      fallbackVisible(): boolean;
    };
  }
}

function webglAvailable(): boolean {
  if (FORCE_NO_WEBGL) return false;
  try {
    return document.createElement('canvas').getContext('webgl2') !== null;
  } catch {
    return false;
  }
}

function Buildings({ city, selected, onSelect }: { city: SyntheticCity; selected: number | null; onSelect: (i: number) => void }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const geometry = useMemo(() => new THREE.BoxGeometry(0.78, 1, 0.78).translate(0, 0.5, 0), []);
  const material = useMemo(() => new THREE.MeshLambertMaterial(), []);
  useLayoutEffect(() => {
    const m = mesh.current!;
    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();
    city.buildings.forEach((b, i) => {
      matrix.makeScale(1, b.height * HEIGHT_SCALE, 1).setPosition(b.x, 0.15, b.z);
      m.setMatrixAt(i, matrix);
      m.setColorAt(i, i === selected ? SELECTED : color.copy(BUILDING).lerp(BUILDING_TALL, Math.min(1, (b.height - 1) / 8)));
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
    m.computeBoundingBox();
  }, [city, selected]);
  useEffect(() => () => {
    geometry.dispose();
    material.dispose();
  }, [geometry, material]);
  return (
    <instancedMesh
      ref={mesh}
      args={[geometry, material, city.buildings.length]}
      onPointerDown={(e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation();
        if (e.instanceId !== undefined) onSelect(e.instanceId);
      }}
    />
  );
}

function Districts({ city }: { city: SyntheticCity }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const geometry = useMemo(() => new THREE.BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0.5), []);
  const material = useMemo(() => new THREE.MeshLambertMaterial(), []);
  useLayoutEffect(() => {
    const m = mesh.current!;
    const matrix = new THREE.Matrix4();
    const u = city.geometry.unitsPerCell;
    city.geometry.districts.forEach((d, i) => {
      const depth = city.districtDepth.get(d.id) ?? 0;
      matrix.makeScale(d.rect.width / u, 0.05, d.rect.depth / u).setPosition(d.rect.x / u, depth * 0.03, d.rect.z / u);
      m.setMatrixAt(i, matrix);
      m.setColorAt(i, PALETTE[depth % PALETTE.length]!);
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
  }, [city]);
  useEffect(() => () => {
    geometry.dispose();
    material.dispose();
  }, [geometry, material]);
  return <instancedMesh ref={mesh} args={[geometry, material, city.geometry.districts.length]} raycast={() => null} />;
}

function Probe({ city, layoutMs, buildingsRef }: { city: SyntheticCity; layoutMs: number; buildingsRef: React.RefObject<THREE.Group | null> }) {
  const { gl, camera, scene, invalidate, size } = useThree();
  const frameWaiters = useRef<{ remaining: number; times: number[]; last: number; resolve: (t: number[]) => void } | null>(null);
  const center = useMemo(() => new THREE.Vector3(city.geometry.root.width / 200, 0, city.geometry.root.depth / 200), [city]);
  const orbit = useRef(0);

  useFrame(() => {
    const w = frameWaiters.current;
    if (!w) return;
    orbit.current += 0.01;
    const radius = Math.max(city.geometry.root.width, city.geometry.root.depth) / 100;
    camera.position.set(center.x + Math.cos(orbit.current) * radius, radius * 0.9, center.z + Math.sin(orbit.current) * radius);
    camera.lookAt(center);
    const now = performance.now();
    if (w.last > 0) w.times.push(now - w.last);
    w.last = now;
    if (--w.remaining <= 0) {
      frameWaiters.current = null;
      w.resolve(w.times);
    } else invalidate();
  });

  useEffect(() => {
    const raycaster = new THREE.Raycaster();
    const debugInfo = gl.getContext().getExtension('WEBGL_debug_renderer_info');
    const rendererName = debugInfo ? String(gl.getContext().getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)) : 'unknown';
    const mesh = () => buildingsRef.current?.children.find((c): c is THREE.InstancedMesh => (c as THREE.InstancedMesh).isInstancedMesh) ?? null;
    window.__atlasSpike = {
      ready: true,
      stats: () => ({
        fileCount: city.buildings.length,
        districtCount: city.geometry.districts.length,
        drawCalls: gl.info.render.calls,
        triangles: gl.info.render.triangles,
        layoutMs,
        renderer: rendererName,
        heapUsedBytes: (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null,
      }),
      measureFrames: (frames) =>
        new Promise((resolve) => {
          frameWaiters.current = { remaining: frames, times: [], last: 0, resolve };
          invalidate();
        }),
      screenPointOf: (index) => {
        const b = city.buildings[index];
        if (!b) return null;
        const v = new THREE.Vector3(b.x, 0.15 + b.height * HEIGHT_SCALE, b.z).project(camera);
        const rect = gl.domElement.getBoundingClientRect();
        return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
      },
      pickAt: (clientX, clientY) => {
        const target = mesh();
        if (!target) return null;
        const rect = gl.domElement.getBoundingClientRect();
        const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
        raycaster.setFromCamera(ndc, camera);
        const hit = raycaster.intersectObject(target, false)[0];
        return hit?.instanceId === undefined ? null : city.buildings[hit.instanceId]!.lineageId;
      },
      lineageAt: (index) => city.buildings[index]!.lineageId,
      loseContext: () => {
        const ext = gl.getContext().getExtension('WEBGL_lose_context');
        ext?.loseContext();
        return ext !== null;
      },
      fallbackVisible: () => document.querySelector('[data-testid="fallback"]') !== null,
    };
    gl.render(scene, camera);
  }, [gl, camera, scene, city, layoutMs, invalidate, size, buildingsRef]);
  return null;
}

function FallbackTable({ city, reason }: { city: SyntheticCity; reason: string }) {
  const top = useMemo(() => [...city.buildings].sort((a, b) => b.height - a.height).slice(0, 25), [city]);
  return (
    <section data-testid="fallback" className="fallback">
      <p role="status">{reason} The same data is available as a table.</p>
      <table>
        <caption>Tallest synthetic buildings ({city.buildings.length.toLocaleString()} total)</caption>
        <thead>
          <tr>
            <th scope="col">Lineage</th>
            <th scope="col">Height</th>
          </tr>
        </thead>
        <tbody>
          {top.map((b) => (
            <tr key={b.lineageId}>
              <td>
                <code>{b.lineageId.slice(0, 16)}…</code>
              </td>
              <td>{b.height.toFixed(3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function SpikeApp() {
  const [city, layoutMs] = useMemo(() => {
    const started = performance.now();
    const generated = generateSyntheticCity(FILE_COUNT);
    return [generated, performance.now() - started] as const;
  }, []);
  const [selected, setSelected] = useState<number | null>(null);
  const [fallback, setFallback] = useState<string | null>(webglAvailable() ? null : '3D view unavailable: WebGL 2 is not supported here.');
  const buildingsRef = useRef<THREE.Group>(null);
  const width = city.geometry.root.width / 100;
  const depth = city.geometry.root.depth / 100;
  const extent = Math.max(width, depth);

  useEffect(() => {
    if (fallback) {
      window.__atlasSpike = { ...(window.__atlasSpike as NonNullable<Window['__atlasSpike']>), ready: true, fallbackVisible: () => true };
    }
  }, [fallback]);

  return (
    <main>
      <header className="bar">
        <strong>ATLAS · P0.4 instancing spike</strong>
        <span>
          {city.buildings.length.toLocaleString()} buildings · {city.geometry.districts.length.toLocaleString()} districts · layout {layoutMs.toFixed(0)} ms
        </span>
        <span aria-live="polite">{selected === null ? 'Click a building' : `Selected ${city.buildings[selected]!.lineageId.slice(0, 20)}…`}</span>
      </header>
      {fallback ? (
        <FallbackTable city={city} reason={fallback} />
      ) : (
        <Canvas
          orthographic
          frameloop="demand"
          dpr={[1, 1.5]}
          gl={{ antialias: true, powerPreference: 'high-performance' }}
          camera={{
            zoom: 900 / extent,
            near: -10_000,
            far: 10_000,
            position: VIEW === 'top' ? [width / 2, 500, depth / 2] : [width / 2 + extent * 0.7, extent * 0.8, depth / 2 + extent * 0.7],
            up: VIEW === 'top' ? [0, 0, -1] : [0, 1, 0],
          }}
          onCreated={({ gl, camera }) => {
            camera.lookAt(width / 2, 0, depth / 2);
            camera.updateProjectionMatrix();
            gl.domElement.addEventListener('webglcontextlost', (event) => {
              event.preventDefault();
              setFallback('The 3D view lost its graphics context.');
            });
          }}
        >
          <color attach="background" args={['#f4efe4']} />
          <ambientLight intensity={1.6} />
          <directionalLight position={[extent, extent * 2, extent * 0.5]} intensity={1.8} />
          <Districts city={city} />
          <group ref={buildingsRef}>
            <Buildings city={city} selected={selected} onSelect={setSelected} />
          </group>
          <Probe city={city} layoutMs={layoutMs} buildingsRef={buildingsRef} />
        </Canvas>
      )}
    </main>
  );
}
