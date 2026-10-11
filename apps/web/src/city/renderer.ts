import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { districtColor, facadeColor, lensValue, type CityBuilding, type CityData, type CityLens } from '@atlas/layout';
import type { Rect } from '@atlas/schema';
import { EDGE_COLORS, edgeClass, type OverlayResult } from './overlay';
import {
  archetypeGeometry,
  buildingStyle,
  cityDecor,
  cornerGeometry,
  depotEaveGeometry,
  districtFamily,
  facadeMaterial,
  gableGeometry,
  groundLevel,
  lampGeometry,
  partGeometry,
  topExtent,
  treeGeometry,
  wallAt,
} from './architecture';
import { THEMES, type Archetype, type CityTheme, type CityView, type PartKind, type ThemeSpec } from './themes';
import { mistTexture, oceanMesh, sceneryGeometry, skyDome } from './atmosphere';

const center = (r: Rect) => new THREE.Vector3((r.x + r.width / 2) / 100, 0, (r.z + r.depth / 2) / 100);
const color = new THREE.Color();
const matrix = new THREE.Matrix4();
const rotation = new THREE.Matrix4();
const scaling = new THREE.Matrix4();
const white = new THREE.Color('#e9e4d7');
/** Bodies start inside the plinth so no block step leaves a gap; tops stay at 0.35 + height. */
const BODY_BASE = 0.06;
/** Key light direction; the sky's sun glow and the shadow map both follow it. */
const SUN = new THREE.Vector3(-30, 80, 50);
/** Cinematic lens and camera feel. */
const FOV = 42;
const FLIGHT_MS = 650;
type Shadows = 'none' | 'cast' | 'receive' | 'both';

const ROLES = ['source', 'test', 'declaration', 'config', 'asset', 'opaque'] as const;
/** Accent parts take a darker shade of the lens colour, so a whole building reads as one hue. */
const PART_SHADE: Record<Exclude<PartKind, 'platform'>, number> = { eave: 0.56, band: 0.8, crenel: 0.9 };
/** World thickness of each accent part. */
const PART_HEIGHT: Record<PartKind, number> = { eave: 0.26, band: 0.07, crenel: 0.3, platform: 0.2 };
/** Most storey parts per building, so a 14-high tower stays bounded. */
const MAX_STOREY_PARTS = 14;

/** An instanced batch that grows on demand; `styled` batches carry a per-instance style buffer. */
interface Growable {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  mesh: THREE.InstancedMesh;
  styled: boolean;
  used: number;
}

/** A compare mark on a fixed plot (plan §11.1): deleted = outlined ghost, added = marker. */
export interface CityGhost {
  rect: Rect;
  kind: 'deleted' | 'added';
  height: number;
}

/**
 * GPU owner. One renderer per mounted dataset: the island, districts and every batch are
 * created once with capacity for all union plots; `setCity` swaps a frame's presence,
 * heights and metrics in place, so the camera and WebGL context survive a snapshot change
 * (plan §11.7: history changes only height/color/presence on fixed plots).
 */
export class CityRenderer {
  readonly renderer: THREE.WebGLRenderer;
  /** Perspective in the cinematic view; orthographic in the isometric plan view. */
  readonly camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  readonly scene = new THREE.Scene();
  readonly controls: OrbitControls;
  readonly labels = document.createElement('canvas');
  private readonly geometry = new Set<THREE.BufferGeometry>();
  private readonly materials = new Set<THREE.Material>();
  private readonly textures = new Set<THREE.Texture>();
  private readonly instances = new Set<THREE.InstancedMesh>();
  private readonly roofs = new Map<(typeof ROLES)[number], THREE.InstancedMesh>();
  private readonly spec: ThemeSpec;
  private readonly archetypes: readonly Archetype[];
  private readonly facade: THREE.Material;
  private readonly platformMaterial: THREE.Material;
  private readonly bodies: Growable[] = [];
  /** Building index -> archetype batch and slot within it, rebuilt per frame. */
  private bodyBatch = new Uint8Array(0);
  private bodySlot = new Int32Array(0);
  /** Accent part batches by `kind-sides`, and per-frame part instances for recolouring. */
  private readonly parts = new Map<string, Growable>();
  private partList: Growable[] = [];
  private partOwner = new Int32Array(0);
  private partBatch = new Uint8Array(0);
  private partSlot = new Int32Array(0);
  private partShade = new Float32Array(0);
  private readonly families = new Map<string, number>();
  private readonly districtDepth: Map<string, number>;
  private readonly decorations: THREE.InstancedMesh[] = [];
  private readonly sun: THREE.DirectionalLight;
  private readonly sky: THREE.Mesh | null = null;
  private readonly cinematic: boolean;
  private readonly reducedMotion: boolean;
  private readonly shadowsOn: boolean;
  /** The shadow map renders only when buildings change, never per camera move. */
  private shadowDirty = true;
  private shadowCalls = 0;
  private drawCalls = 0;
  private flight: { cancel(): void } | null = null;
  private damping = false;
  private settling = false;
  private readonly missing: THREE.InstancedMesh;
  private readonly selection: THREE.InstancedMesh;
  private readonly marker: THREE.Mesh;
  private readonly terminals: THREE.InstancedMesh;
  private readonly packageLines: THREE.InstancedMesh;
  private packageSegments: { a: THREE.Vector3; b: THREE.Vector3; width: number }[] = [];
  private packageZoom = -1;
  private readonly overlayGroup = new THREE.Group();
  private readonly arcGeometries: THREE.BufferGeometry[] = [];
  private readonly ghosts: THREE.InstancedMesh;
  private readonly addedMarkers: THREE.InstancedMesh;
  private readonly pickCells = new Map<string, { bounds: THREE.Box3; indices: number[] }>();
  private boxes: THREE.Box3[] = [];
  private buildingIndex = new Map<string, number>();
  private styled: CityData | null = null;
  city: CityData;
  private readonly raycaster = new THREE.Raycaster();
  private readonly intersection = new THREE.Vector3();
  private readonly point = new THREE.Vector2();
  private readonly resizeObserver: ResizeObserver;
  private readonly abort = new AbortController();
  private frame = 0;
  private disposed = false;
  private lastHover = 0;
  private hoverId: string | null = null;
  private down: { x: number; y: number } | null = null;
  private selected = new Set<string>();
  private lens: CityLens = 'structure';
  private filter: (b: CityBuilding) => boolean = () => true;
  private width = 1;
  private height = 1;
  private baseZoom = 1;
  private frameTimes: number[] | null = null;
  private cancelMeasure: (() => void) | null = null;
  private readonly extent: number;
  private readonly origin: THREE.Vector3;

  constructor(
    readonly host: HTMLElement,
    initial: CityData,
    readonly callbacks: { select(id: string): void; hover(id: string | null): void; fail(reason: string): void },
    readonly lowQuality: boolean,
    readonly theme: CityTheme = 'modern',
    readonly view: CityView = 'cinematic',
  ) {
    this.city = initial;
    const city = initial;
    this.spec = THEMES[theme];
    this.archetypes = this.spec.archetypes;
    this.cinematic = view === 'cinematic';
    this.reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.shadowsOn = !lowQuality;
    const ground = this.spec.ground;
    const capacity = Math.max(1, city.plotCount, city.buildings.length);
    this.renderer = new THREE.WebGLRenderer({ antialias: !lowQuality, alpha: false, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, lowQuality ? 1 : 1.5));
    this.renderer.setClearColor(this.cinematic ? this.spec.sky.haze : '#e9e4d7');
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    if (this.shadowsOn) {
      this.renderer.shadowMap.enabled = true;
      // Hardware 2x2 PCF: soft-PCF sampling in every pixel cost 2-3x frame time on fantasy cities.
      this.renderer.shadowMap.type = THREE.PCFShadowMap;
      this.renderer.shadowMap.autoUpdate = false;
    }
    this.renderer.domElement.setAttribute('aria-hidden', 'true');
    this.renderer.domElement.className = 'city-canvas';
    this.labels.className = 'city-labels';
    this.labels.setAttribute('aria-hidden', 'true');
    host.append(this.renderer.domElement, this.labels);
    this.extent = Math.max(city.root.width, city.root.depth) / 100 + 18;
    this.origin = center(city.root);
    this.camera = this.cinematic
      ? new THREE.PerspectiveCamera(FOV, 1, 0.1, 10_000)
      : new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100_000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.minPolarAngle = 0.12;
    this.controls.maxTargetRadius = this.extent;
    this.controls.cursor.copy(this.origin);
    if (this.cinematic) {
      // Smooth, map-like navigation: damped orbit, zoom towards the cursor, pan on the ground.
      this.damping = !this.reducedMotion;
      this.controls.enableDamping = this.damping;
      this.controls.dampingFactor = 0.09;
      this.controls.zoomToCursor = true;
      this.controls.screenSpacePanning = false;
      this.controls.maxPolarAngle = 1.36;
      this.controls.minDistance = 1.5;
      this.controls.maxDistance = this.extent * 2.8;
      this.controls.zoomSpeed = 1.1;
    } else {
      this.controls.enableDamping = false;
      this.controls.maxPolarAngle = Math.PI / 2.6;
      this.controls.minZoom = 0.2;
      this.controls.maxZoom = 100;
    }
    this.controls.addEventListener('change', this.invalidate);
    this.controls.addEventListener('start', () => this.flight?.cancel());
    this.scene.add(new THREE.HemisphereLight('#f6f8ff', '#9d9a8b', this.shadowsOn ? 2.05 : 1.9));
    this.sun = new THREE.DirectionalLight('#fff3df', 2.5);
    this.sun.position.copy(this.origin).add(SUN.clone().normalize().multiplyScalar(this.extent * 2));
    this.sun.target.position.copy(this.origin);
    this.scene.add(this.sun, this.sun.target);
    if (this.shadowsOn) {
      // One static shadow map over the island; it re-renders only when buildings change.
      const half = Math.hypot(city.root.width, city.root.depth) / 200 + 8;
      const max = this.renderer.capabilities.maxTextureSize;
      this.sun.castShadow = true;
      this.sun.shadow.mapSize.setScalar(Math.min(max, half > 90 ? 4096 : 2048));
      Object.assign(this.sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 1, far: this.extent * 4 + 40 });
      this.sun.shadow.camera.updateProjectionMatrix();
      this.sun.shadow.bias = -0.0004;
      this.sun.shadow.normalBias = 0.03;
      // Shaded sides stay readable: shadow darkens, never blacks out, the lens colour.
      this.sun.shadow.intensity = 0.62;
    }
    const fill = new THREE.DirectionalLight('#d9e6ff', 0.45);
    fill.position.set(40, 30, -20);
    this.scene.add(fill);
    // Base-anchored unit box: y spans [0, 1], so scale.y is a top height.
    const box = this.ownGeometry(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0));
    const plane = this.ownGeometry(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
    const matte = this.ownMaterial(new THREE.MeshLambertMaterial());
    // Ground in one mesh (plan §11.1 permits a decorative shoreline): beach, a green belt and
    // the perimeter road, plus the diorama's earth and water in the isometric view. The
    // cinematic view puts the island in an open sea under a sky, with distant scenery.
    const r = city.root;
    const slabs: THREE.BufferGeometry[] = [];
    const slab = (margin: number, top: number, thickness: number, tint: string) => {
      const g = new THREE.BoxGeometry(r.width / 100 + margin * 2, thickness, r.depth / 100 + margin * 2)
        .translate(this.origin.x, top - thickness / 2, this.origin.z)
        .toNonIndexed();
      const c = new THREE.Color(tint),
        n = g.getAttribute('position').count,
        values = new Float32Array(n * 3);
      for (let k = 0; k < n; k++) values.set([c.r, c.g, c.b], k * 3);
      g.deleteAttribute('uv');
      slabs.push(g.setAttribute('color', new THREE.BufferAttribute(values, 3)));
    };
    if (!this.cinematic) {
      slab(12.4, -0.16, 1.2, ground.earth);
      slab(12, -0.1, 0.06, ground.water);
    }
    slab(6.5, -0.02, this.cinematic ? 0.6 : 0.2, ground.beach);
    slab(5.5, 0.03, 0.2, ground.belt);
    slab(3, 0.07, 0.2, ground.road);
    const groundMesh = new THREE.Mesh(
      this.ownGeometry(mergeGeometries(slabs)),
      this.ownMaterial(new THREE.MeshLambertMaterial({ vertexColors: true })),
    );
    for (const g of slabs) g.dispose();
    groundMesh.receiveShadow = true;
    this.scene.add(groundMesh);
    if (this.cinematic) {
      this.scene.fog = new THREE.Fog(this.spec.sky.haze, this.extent * 3, this.extent * 9);
      this.sky = skyDome(this.spec.sky, SUN);
      this.ownGeometry(this.sky.geometry);
      this.ownMaterial(this.sky.material as THREE.Material);
      const ocean = oceanMesh(this.spec.sky, this.origin, this.extent * 14);
      this.ownGeometry(ocean.geometry);
      this.ownMaterial(ocean.material as THREE.Material);
      const scenery = sceneryGeometry(this.spec, city, this.extent);
      const backdrop = new THREE.Mesh(
        this.ownGeometry(scenery.geometry),
        this.ownMaterial(new THREE.MeshLambertMaterial({ vertexColors: true })),
      );
      this.scene.add(this.sky, ocean, backdrop);
      // Keep the camera inside the scenery ring so mountains never stand between it and the city.
      this.controls.maxDistance = Math.min(this.controls.maxDistance, scenery.innerRadius);
      if (scenery.mist.length) {
        const texture = mistTexture();
        this.textures.add(texture);
        const mist = this.batch(
          plane,
          this.ownMaterial(new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, opacity: 0.75 })),
          scenery.mist.length,
        );
        scenery.mist.forEach((m, i) => mist.setMatrixAt(i, matrix.makeScale(m.size, 1, m.size * 0.6).setPosition(m.x, m.y, m.z)));
        this.finish(mist);
      }
    }
    // Districts as kerbed blocks: a darker kerb, an inset surface, nested blocks stepping up.
    // The repository block reads as the street grid between packages.
    const districtMesh = this.batch(box, matte, city.districts.length * 2, 'receive');
    city.districts.forEach((d, i) => {
      const top = groundLevel(d.depth),
        c = center(d.rect),
        w = d.rect.width / 100,
        dep = d.rect.depth / 100;
      const root = d.depth === 0,
        pkg = d.kind === 'package';
      matrix.makeScale(w, top, dep).setPosition(c.x, 0, c.z);
      districtMesh.setMatrixAt(i * 2, matrix);
      districtMesh.setColorAt(i * 2, color.set(root ? ground.rootKerb : pkg ? ground.packageKerb : ground.directoryKerb));
      matrix.makeScale(Math.max(0.1, w - 0.24), top + 0.015, Math.max(0.1, dep - 0.24)).setPosition(c.x, 0, c.z);
      districtMesh.setMatrixAt(i * 2 + 1, matrix);
      districtMesh.setColorAt(
        i * 2 + 1,
        color.set(root ? ground.rootSurface : pkg ? ground.packageSurface : ground.directory[d.depth % 2]!),
      );
    });
    this.finish(districtMesh);
    this.districtDepth = new Map(city.districts.map((d) => [d.id, d.depth]));
    const decor = cityDecor(city, theme);
    const lawns = this.batch(plane, this.ownMaterial(new THREE.MeshLambertMaterial({ color: ground.lawn })), decor.lawns.length, 'receive');
    decor.lawns.forEach((l, i) => {
      matrix.makeScale(Math.max(0.1, l.width), 1, l.depth).setPosition(l.x, l.y, l.z);
      lawns.setMatrixAt(i, matrix);
    });
    this.finish(lawns);
    const coloured = () => this.ownMaterial(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    const place = (mesh: THREE.InstancedMesh, list: readonly { x: number; y: number; z: number; rotation?: number }[], scale = 1) => {
      list.forEach((p, i) => mesh.setMatrixAt(i, matrix.makeRotationY(p.rotation ?? 0).scale(new THREE.Vector3(scale, scale, scale)).setPosition(p.x, p.y, p.z)));
      this.finish(mesh);
      return mesh;
    };
    if (!lowQuality) {
      this.spec.trees.forEach((kind, k) => {
        const list = decor.trees.filter((t) => t.kind === k);
        const mesh = this.batch(this.ownGeometry(treeGeometry(kind.kind)), coloured(), list.length, 'cast');
        list.forEach((t, i) => {
          mesh.setMatrixAt(i, matrix.makeScale(t.scale, t.scale, t.scale).setPosition(t.x, t.y, t.z));
          mesh.setColorAt(i, color.set(kind.tints[t.tint]!));
        });
        this.finish(mesh);
        this.decorations.push(mesh);
      });
      this.decorations.push(place(this.batch(this.ownGeometry(lampGeometry(this.spec.lamp)), coloured(), decor.lamps.length, 'cast'), decor.lamps));
    }
    if (decor.markings.length && ground.marking) {
      const marks = this.batch(plane, this.ownMaterial(new THREE.MeshLambertMaterial({ color: ground.marking })), decor.markings.length, 'receive');
      decor.markings.forEach((m, i) =>
        marks.setMatrixAt(i, matrix.makeScale(m.length, 1, 0.07).premultiply(rotation.makeRotationY(m.rotation)).setPosition(m.x, m.y, m.z)),
      );
      this.finish(marks);
    }
    // Fantasy styles wall each package like a town: segments, a cap or merlons, corner towers.
    if (this.spec.walls !== 'none') {
      const eastern = this.spec.walls === 'eastern';
      const wallHeight = eastern ? 0.26 : 0.3;
      const segments = this.batch(
        box,
        this.ownMaterial(new THREE.MeshLambertMaterial({ color: eastern ? '#b4553f' : '#b5ad9d' })),
        decor.walls.length,
        'both',
      );
      decor.walls.forEach((s, i) =>
        segments.setMatrixAt(i, matrix.makeScale(s.length, wallHeight, 0.13).premultiply(rotation.makeRotationY(s.rotation)).setPosition(s.x, s.y, s.z)),
      );
      this.finish(segments);
      if (eastern) {
        const caps = this.batch(box, this.ownMaterial(new THREE.MeshLambertMaterial({ color: '#c8a24e' })), decor.walls.length, 'both');
        decor.walls.forEach((s, i) =>
          caps.setMatrixAt(i, matrix.makeScale(s.length + 0.06, 0.05, 0.22).premultiply(rotation.makeRotationY(s.rotation)).setPosition(s.x, s.y + wallHeight, s.z)),
        );
        this.finish(caps);
      } else if (!lowQuality) {
        const teeth: { x: number; y: number; z: number; rotation: number }[] = [];
        for (const s of decor.walls) {
          // Merlons are bounded too; walls past the budget keep a plain parapet.
          if (teeth.length > 5_000) break;
          const n = Math.floor(s.length / 0.42),
            dx = Math.cos(s.rotation),
            dz = -Math.sin(s.rotation);
          for (let k = 0; k < n; k++) {
            const t = (k + 0.5) * (s.length / n) - s.length / 2;
            teeth.push({ x: s.x + dx * t, y: s.y + wallHeight, z: s.z + dz * t, rotation: s.rotation });
          }
        }
        const merlons = this.batch(box, this.ownMaterial(new THREE.MeshLambertMaterial({ color: '#b5ad9d' })), teeth.length, 'cast');
        teeth.forEach((m, i) =>
          merlons.setMatrixAt(i, matrix.makeScale(0.17, 0.1, 0.15).premultiply(rotation.makeRotationY(m.rotation)).setPosition(m.x, m.y, m.z)),
        );
        this.finish(merlons);
      }
      place(this.batch(this.ownGeometry(cornerGeometry(this.spec.walls)), coloured(), decor.corners.length, 'both'), decor.corners);
    }
    // Seeded archetype batches share one facade material; each grows on demand. Accent
    // parts share one lens-shaded material per kind and outline.
    this.facade = this.ownMaterial(facadeMaterial(!lowQuality));
    for (const a of this.archetypes) this.bodies.push(this.growable(this.ownGeometry(archetypeGeometry(a)), this.facade, true, 'both'));
    const accent = this.ownMaterial(new THREE.MeshLambertMaterial({ flatShading: true }));
    this.platformMaterial = this.ownMaterial(new THREE.MeshLambertMaterial({ color: this.spec.platform, flatShading: true }));
    for (const a of this.archetypes)
      for (const part of a.parts ?? [])
        for (const sides of part.kind === 'platform' ? ([4] as const) : ([...new Set(a.tiers.map((t) => t.sides))] as const)) {
          const key = `${part.kind}-${sides}`;
          if (!this.parts.has(key))
            this.parts.set(
              key,
              this.growable(this.ownGeometry(partGeometry(part.kind, sides)), part.kind === 'platform' ? this.platformMaterial : accent, false, 'both'),
            );
        }
    this.partList = [...this.parts.values()];
    // Role silhouettes share geometry; no per-building light, label or material.
    for (const role of ROLES) {
      const shape =
        role === 'source'
          ? new THREE.ConeGeometry(0.68, 0.44, 4)
          : role === 'test'
            ? new THREE.CylinderGeometry(0.45, 0.45, 0.24, 6)
            : role === 'asset'
              ? new THREE.ConeGeometry(0.46, 0.3, 8)
              : new THREE.BoxGeometry(
                  role === 'config' ? 0.6 : 0.93,
                  role === 'declaration' ? 0.08 : 0.16,
                  role === 'config' ? 0.6 : 0.93,
                );
      const roof = this.batch(
        this.ownGeometry(shape),
        this.ownMaterial(
          new THREE.MeshLambertMaterial({
            color: role === 'test' ? this.spec.roofs.test : role === 'source' ? this.spec.roofs.source : this.spec.roofs.other,
          }),
        ),
        capacity,
        'both',
      );
      roof.count = 0;
      this.roofs.set(role, roof);
    }
    // Evidence marks keep the centred unit box they were positioned for.
    const centred = this.ownGeometry(new THREE.BoxGeometry(1, 1, 1));
    // Evidence marks are never fogged, so they read at any distance.
    this.missing = this.batch(centred, this.ownMaterial(new THREE.MeshBasicMaterial({ color: '#242d38', fog: false })), capacity * 2);
    const wire = this.ownMaterial(new THREE.MeshBasicMaterial({ color: '#174664', wireframe: true, depthTest: false, fog: false }));
    this.selection = this.batch(centred, wire, capacity);
    this.selection.count = 0;
    // Compare marks: deleted plots as outlined ghosts, added files with a raised marker.
    this.ghosts = this.batch(centred, this.ownMaterial(new THREE.MeshBasicMaterial({ color: '#7a4f2a', wireframe: true, fog: false })), capacity);
    this.ghosts.count = 0;
    this.addedMarkers = this.batch(
      this.ownGeometry(new THREE.OctahedronGeometry(0.32)),
      this.ownMaterial(new THREE.MeshBasicMaterial({ color: '#1f6b45', depthTest: false, fog: false })),
      capacity,
    );
    this.addedMarkers.count = 0;
    this.marker = new THREE.Mesh(
      this.ownGeometry(new THREE.ConeGeometry(0.25, 0.6, 4)),
      this.ownMaterial(new THREE.MeshBasicMaterial({ color: '#174664', depthTest: false, fog: false })),
    );
    this.marker.rotation.z = Math.PI;
    this.marker.visible = false;
    this.scene.add(this.marker, this.overlayGroup);
    // Terminal anchors are fixed harbour depots; which packages a frame imports decides
    // which are shown.
    this.terminals = this.batch(this.ownGeometry(this.depotGeometry()), coloured(), 51, 'both');
    this.packageLines = this.batch(
      this.ownGeometry(new THREE.CylinderGeometry(1, 1, 1, 6)),
      this.ownMaterial(new THREE.MeshBasicMaterial({ color: EDGE_COLORS.package, depthTest: false, fog: false })),
      1000,
    );
    this.packageLines.count = 0;
    this.overlayGroup.add(this.packageLines);
    this.layoutBuildings();
    this.applyStyle('structure', new Set(), () => true);
    const { signal } = this.abort;
    const canvas = this.renderer.domElement;
    canvas.addEventListener(
      'webglcontextlost',
      (e) => {
        e.preventDefault();
        callbacks.fail('The 3D graphics context was lost. The same city is available as a map and table.');
      },
      { signal },
    );
    canvas.addEventListener(
      'pointerdown',
      (e) => {
        this.down = { x: e.clientX, y: e.clientY };
      },
      { signal },
    );
    canvas.addEventListener(
      'pointerup',
      (e) => {
        if (e.button === 0 && this.down && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) < 5) {
          const hit = this.pickAt(e.clientX, e.clientY);
          if (hit) callbacks.select(hit);
        }
        this.down = null;
      },
      { signal },
    );
    canvas.addEventListener(
      'pointermove',
      (e) => {
        if (e.buttons || performance.now() - this.lastHover < 34) return;
        this.lastHover = performance.now();
        const id = this.pickAt(e.clientX, e.clientY);
        if (id !== this.hoverId) {
          this.hoverId = id;
          callbacks.hover(id);
          this.invalidate();
        }
      },
      { signal },
    );
    canvas.addEventListener(
      'pointerleave',
      () => {
        this.hoverId = null;
        callbacks.hover(null);
        this.invalidate();
      },
      { signal },
    );
    canvas.addEventListener(
      'dblclick',
      (e) => {
        const id = this.pickAt(e.clientX, e.clientY);
        const index = id ? this.buildingIndex.get(id) : undefined;
        if (index !== undefined) this.fit(this.boxes[index], true);
      },
      { signal },
    );
    document.addEventListener('visibilitychange', this.invalidate, { signal });
    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(host);
    this.resize();
    this.reset();
  }

  /** Swap the displayed frame. Plots, districts, camera and GPU context are unchanged. */
  setCity(city: CityData) {
    if (this.disposed || city === this.city) return;
    if (city.plotCount > this.city.plotCount || city.root.width !== this.city.root.width || city.root.depth !== this.city.root.depth)
      throw new Error('A frame from a different layout cannot reuse this renderer');
    this.city = city;
    this.layoutBuildings();
    const present = new Set([...this.selected].filter((id) => this.buildingIndex.has(id)));
    this.applyStyle(this.lens, present, this.filter);
  }

  /** Mark deleted (ghost) and added plots for an A -> B comparison; [] clears them. */
  setGhosts(ghosts: readonly CityGhost[]) {
    let deleted = 0,
      added = 0;
    for (const ghost of ghosts) {
      const p = center(ghost.rect);
      if (ghost.kind === 'deleted') {
        const h = Math.max(0.6, ghost.height);
        matrix.makeScale(0.92, h, 0.92).setPosition(p.x, 0.35 + h / 2, p.z);
        this.ghosts.setMatrixAt(deleted++, matrix);
      } else {
        matrix.makeScale(1, 1.4, 1).setPosition(p.x, ghost.height + 1.9, p.z);
        this.addedMarkers.setMatrixAt(added++, matrix);
      }
    }
    this.ghosts.count = deleted;
    this.addedMarkers.count = added;
    this.finish(this.ghosts);
    this.finish(this.addedMarkers);
    this.invalidate();
  }

  /** Per-frame instance data: bodies, roofs, shadows, terminals and the pick index. */
  private layoutBuildings() {
    const { buildings } = this.city;
    this.buildingIndex = new Map(buildings.map((b, i) => [b.nodeId, i]));
    this.pickCells.clear();
    const styles = buildings.map((b) => {
      let family = this.families.get(b.districtId);
      if (family === undefined) this.families.set(b.districtId, (family = districtFamily(b.districtId, this.theme)));
      return buildingStyle(b, family, this.theme);
    });
    // Size every batch first: bodies by archetype, parts by kind and outline at each storey.
    const placements = buildings.map((b, i) => this.storeyParts(b, styles[i]!.archetype));
    for (const g of [...this.bodies, ...this.partList]) g.used = 0;
    for (const style of styles) this.bodies[style.archetype]!.used++;
    for (const list of placements) for (const part of list) this.parts.get(part.key)!.used++;
    for (const g of [...this.bodies, ...this.partList]) {
      this.grow(g, g.used);
      g.used = 0;
    }
    const partTotal = placements.reduce((sum, list) => sum + list.length, 0);
    this.partOwner = new Int32Array(partTotal);
    this.partBatch = new Uint8Array(partTotal);
    this.partSlot = new Int32Array(partTotal);
    this.partShade = new Float32Array(partTotal);
    const batchIndex = new Map(this.partList.map((g, k) => [g, k]));
    let partCount = 0;
    this.bodyBatch = new Uint8Array(buildings.length);
    this.bodySlot = new Int32Array(buildings.length);
    const roofCounts = new Map<string, number>();
    this.boxes = buildings.map((b, i) => {
      const p = center(b.rect);
      const h = b.height,
        style = styles[i]!,
        archetype = this.archetypes[style.archetype]!,
        body = this.bodies[style.archetype]!,
        slot = body.used++,
        f = style.footprint;
      rotation.makeRotationY(style.rotation);
      matrix
        .makeScale(f, 0.35 + h - BODY_BASE, f)
        .premultiply(rotation)
        .setPosition(p.x, BODY_BASE, p.z);
      body.mesh.setMatrixAt(slot, matrix);
      (body.geometry.getAttribute('atlasStyle') as THREE.InstancedBufferAttribute).setXY(slot, style.windows, style.variant);
      this.bodyBatch[i] = style.archetype;
      this.bodySlot[i] = slot;
      // Accent parts follow the wall outline at their storey and turn with the body.
      for (const part of placements[i]!) {
        const batch = this.parts.get(part.key)!,
          n = batch.used++;
        matrix
          .makeScale(part.hx * f, PART_HEIGHT[part.kind], part.hz * f)
          .premultiply(rotation)
          .setPosition(p.x, part.y, p.z);
        batch.mesh.setMatrixAt(n, matrix);
        if (part.kind !== 'platform') {
          this.partOwner[partCount] = i;
          this.partBatch[partCount] = batchIndex.get(batch)!;
          this.partSlot[partCount] = n;
          this.partShade[partCount++] = PART_SHADE[part.kind];
        }
      }
      // The role roof is fitted to the archetype's top outline and turns with the body.
      const roof = this.roofs.get(b.role)!;
      const n = roofCounts.get(b.role) ?? 0;
      const [tx, tz] = topExtent(archetype),
        fit = (archetype.roof ?? 1) * f;
      matrix
        .makeRotationY(b.role === 'source' ? Math.PI / 4 : ((b.seed % 4) * Math.PI) / 2)
        .premultiply(scaling.makeScale((tx * fit) / 0.44, 1, (tz * fit) / 0.44))
        .premultiply(rotation)
        .setPosition(p.x, h + 0.45, p.z);
      roof.setMatrixAt(n, matrix);
      roofCounts.set(b.role, n + 1);
      const bounds = new THREE.Box3(new THREE.Vector3(p.x - 0.44, 0.35, p.z - 0.44), new THREE.Vector3(p.x + 0.44, h + 0.8, p.z + 0.44));
      const key = `${Math.floor(p.x / 8)}:${Math.floor(p.z / 8)}`;
      let cell = this.pickCells.get(key);
      if (!cell) {
        cell = { bounds: bounds.clone(), indices: [] };
        this.pickCells.set(key, cell);
      }
      cell.bounds.union(bounds);
      cell.indices.push(i);
      return bounds;
    });
    this.partOwner = this.partOwner.subarray(0, partCount);
    for (const g of [...this.bodies, ...this.partList]) {
      g.mesh.count = g.used;
      if (g.styled) (g.geometry.getAttribute('atlasStyle') as THREE.InstancedBufferAttribute).needsUpdate = true;
      this.finish(g.mesh);
    }
    for (const [role, roof] of this.roofs) {
      roof.count = roofCounts.get(role) ?? 0;
      this.finish(roof);
    }
    this.placeTerminals(this.city.terminals);
    this.shadowDirty = true;
  }

  /**
   * Accent parts of one building: a base platform, storey eaves or bands at a fixed world
   * spacing (so taller files gain storeys), and a top eave or battlement. Low detail keeps
   * only base and top parts.
   */
  private storeyParts(b: CityBuilding, archetype: number) {
    const a = this.archetypes[archetype]!;
    const list: { key: string; kind: PartKind; y: number; hx: number; hz: number }[] = [];
    if (!a.parts) return list;
    const top = 0.35 + b.height,
      span = top - BODY_BASE,
      ground = groundLevel(this.districtDepth.get(b.districtId) ?? 1);
    for (const part of a.parts) {
      if (part.kind === 'platform') {
        const wall = wallAt(a, 0);
        list.push({ key: 'platform-4', kind: 'platform', y: ground - 0.02, hx: Math.min(0.66, wall.hx * 1.4), hz: Math.min(0.66, wall.hz * 1.4) });
        continue;
      }
      const heights: number[] = [];
      if (part.every && !this.lowQuality)
        for (let y = ground + (part.from ?? part.every); y < top - 0.45 && heights.length < MAX_STOREY_PARTS; y += part.every)
          heights.push(y);
      if (part.top) heights.push(top - (part.kind === 'crenel' ? 0.12 : 0.2));
      for (const y of heights) {
        const wall = wallAt(a, (y - BODY_BASE) / span);
        // Eave outlines meet the wall at 0.7 of their reach; bands and crenels overhang slightly.
        const reach = part.kind === 'eave' ? 1 / 0.7 : (part.overhang ?? (part.kind === 'crenel' ? 1.04 : 1.08));
        list.push({ key: `${part.kind}-${wall.sides}`, kind: part.kind, y, hx: wall.hx * reach, hz: wall.hz * reach });
      }
    }
    return list;
  }

  private growable(geometry: THREE.BufferGeometry, material: THREE.Material, styled: boolean, shadows: Shadows): Growable {
    const mesh = this.batch(geometry, material, 1, shadows);
    mesh.count = 0;
    return { geometry, material, mesh, styled, used: 0 };
  }

  /** Grow a batch (and a styled batch's per-instance style buffer) to hold `needed` instances. */
  private grow(g: Growable, needed: number) {
    const style = g.geometry.getAttribute('atlasStyle') as THREE.InstancedBufferAttribute | undefined;
    if (g.styled ? style && style.count >= needed : g.mesh.instanceMatrix.count >= needed && g.mesh.instanceMatrix.count > 1) return;
    const capacity = Math.max(16, Math.ceil(needed * 1.25));
    if (g.styled) {
      // Disposing releases the old GPU buffers; the next render uploads the larger ones.
      g.geometry.dispose();
      g.geometry.setAttribute('atlasStyle', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2));
    }
    const shadows: Shadows = g.mesh.castShadow ? (g.mesh.receiveShadow ? 'both' : 'cast') : g.mesh.receiveShadow ? 'receive' : 'none';
    this.scene.remove(g.mesh);
    this.instances.delete(g.mesh);
    g.mesh.dispose();
    g.mesh = this.batch(g.geometry, g.material, capacity, shadows);
    g.mesh.count = 0;
  }

  /** One harbour depot in local space: a pier into the water, a shed and its roof. */
  private depotGeometry(): THREE.BufferGeometry {
    const depot = this.spec.terminal;
    const roof = depot.eaved
      ? depotEaveGeometry().scale(0.78, 0.34, 0.56).translate(0, 0.42, 0)
      : gableGeometry().scale(1.25, 0.3, 0.9).translate(0, 0.52, 0);
    const parts: [THREE.BufferGeometry, string][] = [
      [new THREE.BoxGeometry(1.4, 0.14, 1.9).translate(0, -0.05, 0), depot.pier],
      [new THREE.BoxGeometry(1.15, 0.5, 0.8).translate(0, 0.27, 0), depot.shed],
      [roof, depot.roof],
    ];
    const flat = parts.map(([g, tint]) => {
      const f = g.index ? g.toNonIndexed() : g.clone();
      g.dispose();
      for (const name of Object.keys(f.attributes)) if (name !== 'position') f.deleteAttribute(name);
      f.computeVertexNormals();
      const c = new THREE.Color(tint),
        n = f.getAttribute('position').count,
        values = new Float32Array(n * 3);
      for (let k = 0; k < n; k++) values.set([c.r, c.g, c.b], k * 3);
      return f.setAttribute('color', new THREE.BufferAttribute(values, 3));
    });
    const merged = mergeGeometries(flat);
    for (const f of flat) f.dispose();
    return merged;
  }

  /** Harbour depots at the external terminals, each facing the island. */
  private placeTerminals(terminals: CityData['terminals']) {
    const r = this.city.root;
    terminals.forEach((t, i) => {
      // North/south terminals face the island across z; east/west across x.
      rotation.makeRotationY(t.z < r.z || t.z > r.z + r.depth ? 0 : Math.PI / 2);
      this.terminals.setMatrixAt(i, matrix.copy(rotation).setPosition(t.x / 100, 0, t.z / 100));
    });
    this.terminals.count = terminals.length;
    this.finish(this.terminals);
    this.shadowDirty = true;
  }

  private ownGeometry<T extends THREE.BufferGeometry>(g: T): T {
    this.geometry.add(g);
    return g;
  }
  private ownMaterial<T extends THREE.Material>(m: T): T {
    this.materials.add(m);
    return m;
  }
  private batch(g: THREE.BufferGeometry, m: THREE.Material, count: number, shadows: Shadows = 'none') {
    const mesh = new THREE.InstancedMesh(g, m, Math.max(1, count));
    mesh.count = count;
    mesh.castShadow = this.shadowsOn && (shadows === 'cast' || shadows === 'both');
    mesh.receiveShadow = this.shadowsOn && (shadows === 'receive' || shadows === 'both');
    this.instances.add(mesh);
    this.scene.add(mesh);
    return mesh;
  }
  private finish(mesh: THREE.InstancedMesh) {
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
  }
  private readonly resize = () => {
    const bounds = this.host.getBoundingClientRect();
    this.width = Math.max(1, bounds.width);
    this.height = Math.max(1, bounds.height);
    this.renderer.setSize(this.width, this.height, false);
    this.labels.width = Math.round(this.width);
    this.labels.height = Math.round(this.height);
    if (this.camera instanceof THREE.PerspectiveCamera) this.camera.aspect = this.width / this.height;
    else {
      this.camera.left = -this.width / 2;
      this.camera.right = this.width / 2;
      this.camera.top = this.height / 2;
      this.camera.bottom = -this.height / 2;
    }
    this.camera.updateProjectionMatrix();
    this.invalidate();
  };
  /**
   * Screen pixels per world unit at the orbit target: the orthographic zoom, or its
   * perspective equivalent. Level of detail and overlay widths use it in both views.
   */
  pixelsPerUnit(): number {
    if (this.camera instanceof THREE.OrthographicCamera) return this.camera.zoom;
    const distance = this.camera.position.distanceTo(this.controls.target);
    return this.height / (2 * distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
  }
  readonly invalidate = () => {
    if (this.disposed || this.frame || document.hidden) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (!this.disposed) this.render();
    });
  };
  private render() {
    // Damped orbiting keeps moving after the pointer lifts; keep drawing until it settles.
    this.settling = this.damping && this.controls.update();
    if (this.settling) this.invalidate();
    const ppu = this.pixelsPerUnit();
    if (this.camera instanceof THREE.PerspectiveCamera) this.frameAtmosphere(this.camera);
    if (Math.abs(this.packageZoom - ppu) > ppu * 0.02) {
      const rotation = new THREE.Quaternion(),
        direction = new THREE.Vector3(),
        y = new THREE.Vector3(0, 1, 0),
        scale = new THREE.Vector3(),
        midpoint = new THREE.Vector3();
      this.packageSegments.forEach((segment, i) => {
        direction.copy(segment.b).sub(segment.a);
        const length = direction.length();
        direction.normalize();
        rotation.setFromUnitVectors(y, direction);
        midpoint.copy(segment.a).add(segment.b).multiplyScalar(0.5);
        const radius = segment.width / (2 * ppu);
        scale.set(radius, length, radius);
        matrix.compose(midpoint, rotation, scale);
        this.packageLines.setMatrixAt(i, matrix);
      });
      this.packageLines.count = this.packageSegments.length;
      this.finish(this.packageLines);
      this.packageZoom = ppu;
    }
    // Perspective shows near roofs large even when the target is far, so it keeps them.
    const near = this.cinematic ? ppu >= 2 : ppu >= 6;
    for (const roof of this.roofs.values()) roof.visible = near;
    // Below ~1.5 px per cell trees are speckle; the facade shader fades windows by itself.
    for (const mesh of this.decorations) mesh.visible = ppu >= 1.5;
    const shadowFrame = this.shadowsOn && this.shadowDirty;
    if (shadowFrame) {
      this.renderer.shadowMap.needsUpdate = true;
      this.shadowDirty = false;
    }
    this.renderer.render(this.scene, this.camera);
    // Report steady-state draw calls; a shadow update's extra pass is recorded separately and
    // followed by an ordinary frame.
    if (shadowFrame) {
      this.shadowCalls = this.renderer.info.render.calls;
      this.invalidate();
    } else this.drawCalls = this.renderer.info.render.calls;
    this.drawLabels(this.labels, this.camera, this.width, this.height);
  }
  /**
   * Fog, clipping planes and the sky follow the camera: the island stays crisp, the distant
   * scenery fades into the haze, and depth precision is spent where the camera looks.
   */
  private frameAtmosphere(camera: THREE.PerspectiveCamera) {
    const distance = camera.position.distanceTo(this.controls.target);
    camera.near = THREE.MathUtils.clamp(distance * 0.015, 0.05, 40);
    camera.far = distance + this.extent * 10;
    camera.updateProjectionMatrix();
    if (this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.near = distance + this.extent * 0.6;
      this.scene.fog.far = distance + this.extent * 7.5;
    }
    if (this.sky) {
      this.sky.position.copy(camera.position);
      this.sky.scale.setScalar(camera.far * 0.9);
    }
  }
  private drawLabels(canvas: HTMLCanvasElement, camera: THREE.Camera, width: number, height: number) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    ctx.font = '600 12px system-ui';
    ctx.textAlign = 'center';
    const label = (text: string, p: THREE.Vector3, swatch: string | null = null) => {
      const v = p.project(camera);
      if (v.z < -1 || v.z > 1) return;
      const x = ((v.x + 1) / 2) * width,
        y = ((1 - v.y) / 2) * height;
      if (x < 0 || x > width || y < 0 || y > height) return;
      const safe = text.length > 42 ? `${text.slice(0, 39)}…` : text;
      const inset = swatch ? 12 : 0;
      const w = ctx.measureText(safe).width + 18 + inset;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x - w / 2, y - 12, w, 21, 10.5);
      else ctx.rect(x - w / 2, y - 12, w, 21);
      ctx.fillStyle = 'rgba(249, 247, 240, 0.94)';
      ctx.shadowColor = 'rgba(24, 35, 49, 0.18)';
      ctx.shadowBlur = 4;
      ctx.shadowOffsetY = 1;
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.strokeStyle = 'rgba(38, 51, 68, 0.16)';
      ctx.stroke();
      if (swatch) {
        ctx.beginPath();
        ctx.arc(x - w / 2 + 12, y - 1.5, 4, 0, Math.PI * 2);
        ctx.fillStyle = swatch;
        ctx.fill();
      }
      ctx.fillStyle = '#263344';
      ctx.fillText(safe, x + inset / 2, y + 3);
    };
    // The swatch repeats the facade colour only while the structure lens shows package colour.
    for (const d of this.city.districts.filter((d) => d.kind === 'package').slice(0, 20))
      label(
        d.label,
        new THREE.Vector3((d.rect.x + d.rect.width / 2) / 100, groundLevel(d.depth), (d.rect.z + 70) / 100),
        this.lens === 'structure' ? districtColor(d.id) : null,
      );
    const b = this.city.buildings.find(
      (b) =>
        b.nodeId === this.hoverId || (this.hoverId === null && this.selected.size === 1 && this.selected.has(b.nodeId)),
    );
    if (b) label(b.path, center(b.rect).setY(b.height + 1.6));
  }
  applyStyle(lens: CityLens, selected: ReadonlySet<string>, filter: (b: CityBuilding) => boolean) {
    const recolor =
      this.lens !== lens ||
      this.filter !== filter ||
      this.styled !== this.city ||
      [...this.bodies, ...this.partList].some((g) => g.mesh.count > 0 && !g.mesh.instanceColor && g.material !== this.platformMaterial);
    this.styled = this.city;
    this.lens = lens;
    this.selected = new Set(selected);
    this.filter = filter;
    let count = 0,
      unknown = 0;
    const tones = recolor ? new Float32Array(this.city.buildings.length * 3) : null;
    if (recolor)
      this.city.buildings.forEach((b, i) => {
        color.set(facadeColor(b, lens));
        if (!filter(b)) color.lerp(white, 0.8);
        this.bodies[this.bodyBatch[i]!]!.mesh.setColorAt(this.bodySlot[i]!, color);
        tones!.set([color.r, color.g, color.b], i * 3);
        const p = center(b.rect);
        if ((lens !== 'structure' && lensValue(b, lens) === null) || b.parseStatus !== 'parsed') {
          for (const angle of [Math.PI / 4, -Math.PI / 4]) {
            matrix
              .makeRotationY(angle)
              .scale(new THREE.Vector3(0.65, 0.04, 0.07))
              .setPosition(p.x, b.height + 0.75, p.z);
            this.missing.setMatrixAt(unknown++, matrix);
          }
        }
      });
    for (const id of selected) {
      const i = this.buildingIndex.get(id);
      if (i === undefined) continue;
      const b = this.city.buildings[i]!,
        p = center(b.rect);
      matrix.makeScale(1.04, b.height + 0.5, 1.04).setPosition(p.x, 0.35 + b.height / 2, p.z);
      this.selection.setMatrixAt(count++, matrix);
    }
    if (tones) {
      // Accent parts carry a darker shade of their building's facade colour.
      for (let k = 0; k < this.partOwner.length; k++) {
        const o = this.partOwner[k]! * 3,
          s = this.partShade[k]!;
        color.setRGB(tones[o]! * s, tones[o + 1]! * s, tones[o + 2]! * s);
        this.partList[this.partBatch[k]!]!.mesh.setColorAt(this.partSlot[k]!, color);
      }
      for (const g of [...this.bodies, ...this.partList]) if (g.mesh.instanceColor) g.mesh.instanceColor.needsUpdate = true;
    }
    this.selection.count = count;
    this.finish(this.selection);
    if (recolor) {
      this.missing.count = unknown;
      this.finish(this.missing);
    }
    const b = selected.size === 1 ? this.city.buildings.find((b) => selected.has(b.nodeId)) : null;
    this.marker.visible = Boolean(b);
    if (b) this.marker.position.copy(center(b.rect).setY(b.height + 1.2));
    this.invalidate();
  }
  setOverlay(result: OverlayResult) {
    this.overlayGroup.clear();
    this.overlayGroup.add(this.packageLines);
    this.packageSegments = [];
    this.packageZoom = -1;
    const terminals = result.promotedTerminal
      ? [...this.city.terminals.slice(0, 49), result.promotedTerminal]
      : this.city.terminals;
    this.placeTerminals(terminals);
    for (const g of this.arcGeometries) g.dispose();
    this.arcGeometries.length = 0;
    // One line/arrow batch per kind: bounded draw calls even for a dense selection.
    for (const key of Object.keys(EDGE_COLORS) as (keyof typeof EDGE_COLORS)[]) {
      const positions: number[] = [],
        arrows: number[] = [];
      for (const arc of result.arcs.filter((a) => edgeClass(a.kind) === key)) {
        const points = arc.points.map((p) => new THREE.Vector3(...p));
        const curve = points.length === 3 ? new THREE.QuadraticBezierCurve3(points[0]!, points[1]!, points[2]!) : null;
        const samples = curve ? curve.getPoints(20) : points;
        for (let i = 0; i + 1 < samples.length; i++) {
          if (arc.kind === 'package')
            this.packageSegments.push({
              a: samples[i]!,
              b: samples[i + 1]!,
              width: Math.min(6, 1 + Math.log2(1 + arc.count)),
            });
          else positions.push(...samples[i]!.toArray(), ...samples[i + 1]!.toArray());
        }
        const end = samples.at(-1)!,
          prev = samples.at(-2)!;
        const direction = end.clone().sub(prev).normalize();
        const side = new THREE.Vector3()
          .crossVectors(direction, new THREE.Vector3(0, 1, 0))
          .normalize()
          .multiplyScalar(0.25);
        const back = end.clone().addScaledVector(direction, -0.55);
        arrows.push(
          ...end.toArray(),
          ...back.clone().add(side).toArray(),
          ...end.toArray(),
          ...back.clone().sub(side).toArray(),
        );
      }
      if (!positions.length && !arrows.length) continue;
      const g = new THREE.BufferGeometry().setAttribute(
        'position',
        new THREE.Float32BufferAttribute([...positions, ...arrows], 3),
      );
      this.arcGeometries.push(g);
      const materialKey = `edge:${key}`;
      let material = [...this.materials].find((m) => m.name === materialKey) as THREE.LineBasicMaterial | undefined;
      if (!material) {
        material = this.ownMaterial(
          key === 'type' || key === 'dynamic'
            ? new THREE.LineDashedMaterial({
                color: EDGE_COLORS[key],
                depthTest: false,
                dashSize: key === 'type' ? 0.5 : 0.2,
                gapSize: 0.2,
              })
            : new THREE.LineBasicMaterial({ color: EDGE_COLORS[key], depthTest: false }),
        );
        material.name = materialKey;
      }
      const lines = new THREE.LineSegments(g, material);
      lines.computeLineDistances();
      this.overlayGroup.add(lines);
    }
    this.invalidate();
  }
  /**
   * The establishing shot: the whole island. Cinematic views look in at a three-quarter
   * angle under the sky; the isometric view fits the projected island bounds.
   */
  reset(animate = false) {
    const maxHeight = this.city.buildings.reduce((max, b) => Math.max(max, b.height + 1.6), 1);
    const r = this.city.root;
    if (this.camera instanceof THREE.PerspectiveCamera) {
      // A low three-quarter view: the island fills the lower frame, the horizon and sky the top.
      const radius = Math.hypot(r.width / 200 + 7, r.depth / 200 + 7, maxHeight / 2);
      const polar = 1.25,
        azimuth = Math.PI / 4;
      const direction = new THREE.Vector3(Math.sin(polar) * Math.sin(azimuth), Math.cos(polar), Math.sin(polar) * Math.cos(azimuth));
      const ground = new THREE.Vector3(direction.x, 0, direction.z).normalize();
      const target = this.origin.clone().setY(Math.min(maxHeight * 0.2, 2)).addScaledVector(ground, -radius * 0.28);
      // A bounding sphere fits loosely; trimming it frames the island without wasted margin.
      const distance = Math.min(this.controls.maxDistance, this.fitDistance(radius) * 0.7);
      this.setView(target.clone().addScaledVector(direction, distance), target, undefined, animate);
      return;
    }
    const target = this.origin.clone().setY(maxHeight / 2);
    const position = target.clone().add(new THREE.Vector3(this.extent, this.extent * 1.15, this.extent));
    const camera = this.camera;
    // Fit projected island bounds, rather than a square estimate that wastes the viewport on long repositories.
    const probe = camera.clone();
    probe.position.copy(position);
    probe.lookAt(target);
    probe.updateMatrixWorld();
    const bounds = new THREE.Box3(
      new THREE.Vector3(r.x / 100 - 11, 0, r.z / 100 - 11),
      new THREE.Vector3((r.x + r.width) / 100 + 11, maxHeight, (r.z + r.depth) / 100 + 11),
    );
    const projected = bounds.clone().applyMatrix4(probe.matrixWorldInverse).getSize(new THREE.Vector3());
    this.baseZoom = THREE.MathUtils.clamp(
      Math.min(this.width / (projected.x * 1.15), this.height / (projected.y * 1.15)),
      this.controls.minZoom,
      this.controls.maxZoom,
    );
    this.setView(position, target, this.baseZoom, animate);
  }
  zoom(factor: number) {
    this.flight?.cancel();
    if (this.camera instanceof THREE.PerspectiveCamera) {
      // Dolly towards the target; perspective zoom keeps depth natural.
      const offset = this.camera.position.clone().sub(this.controls.target);
      const distance = THREE.MathUtils.clamp(offset.length() / factor, this.controls.minDistance, this.controls.maxDistance);
      this.camera.position.copy(this.controls.target).addScaledVector(offset.normalize(), distance);
      this.controls.update();
    } else {
      this.camera.zoom = THREE.MathUtils.clamp(this.camera.zoom * factor, this.controls.minZoom, this.controls.maxZoom);
      this.camera.updateProjectionMatrix();
    }
    this.invalidate();
  }
  north() {
    const distance = this.camera.position.distanceTo(this.controls.target);
    this.setView(
      this.controls.target.clone().add(new THREE.Vector3(0, distance * 0.9, distance * 0.4)),
      this.controls.target.clone(),
      undefined,
      true,
    );
  }
  fit(bounds?: THREE.Box3, animate = false) {
    if (!bounds) {
      this.reset(animate);
      return;
    }
    const size = bounds.getSize(new THREE.Vector3()),
      target = bounds.getCenter(new THREE.Vector3());
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    if (this.camera instanceof THREE.PerspectiveCamera) {
      // Architectural framing: keep the bearing, settle at a low but readable elevation.
      const spherical = new THREE.Spherical().setFromVector3(direction);
      spherical.phi = THREE.MathUtils.clamp(spherical.phi, 0.75, 1.12);
      spherical.radius = 1;
      const distance = THREE.MathUtils.clamp(
        this.fitDistance(Math.max(2.5, size.length() / 2)) * 1.25,
        this.controls.minDistance,
        this.controls.maxDistance,
      );
      this.setView(target.clone().add(new THREE.Vector3().setFromSpherical(spherical).multiplyScalar(distance)), target, undefined, animate);
      return;
    }
    const zoom = Math.min(60, Math.min(this.width, this.height) / Math.max(8, Math.max(size.x, size.y, size.z) * 2));
    this.setView(target.clone().addScaledVector(direction, this.extent * 2), target, zoom, animate);
  }
  /** Distance at which a sphere of `radius` fills the narrower field of view. */
  private fitDistance(radius: number) {
    const camera = this.camera as THREE.PerspectiveCamera;
    const vertical = THREE.MathUtils.degToRad(camera.fov);
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * (this.width / this.height));
    return radius / Math.sin(Math.min(vertical, horizontal) / 2);
  }
  /**
   * Move the camera, gliding along an eased path unless the viewer asked for reduced motion
   * (plan §11.7). Any pointer interaction cancels a flight where it is.
   */
  private setView(position: THREE.Vector3, target: THREE.Vector3, zoom: number | undefined, animate: boolean) {
    this.flight?.cancel();
    const apply = (t: number, from: { position: THREE.Vector3; target: THREE.Vector3; zoom: number }) => {
      this.camera.position.lerpVectors(from.position, position, t);
      this.controls.target.lerpVectors(from.target, target, t);
      if (zoom !== undefined) this.camera.zoom = from.zoom + (zoom - from.zoom) * t;
      this.camera.updateProjectionMatrix();
      this.controls.update();
      this.camera.updateMatrixWorld();
      this.invalidate();
    };
    const from = { position: this.camera.position.clone(), target: this.controls.target.clone(), zoom: this.camera.zoom };
    if (!animate || this.reducedMotion || from.position.distanceTo(position) < 1e-6) {
      apply(1, from);
      return;
    }
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / FLIGHT_MS);
      apply(t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2, from);
      if (t < 1 && !this.disposed) frame = requestAnimationFrame(step);
      else this.flight = null;
    };
    frame = requestAnimationFrame(step);
    this.flight = {
      cancel: () => {
        cancelAnimationFrame(frame);
        this.flight = null;
      },
    };
  }
  focus(ids: ReadonlySet<string>) {
    const box = new THREE.Box3();
    this.city.buildings.forEach((b, i) => {
      if (ids.has(b.nodeId)) box.union(this.boxes[i]!);
    });
    this.fit(box.isEmpty() ? undefined : box, true);
  }
  screenPointOf(id: string) {
    const b = this.city.buildings.find((b) => b.nodeId === id);
    if (!b) return null;
    const v = center(b.rect)
      .setY(b.height + 0.6)
      .project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }
  pickAt(x: number, y: number): string | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.point.set(((x - r.left) / r.width) * 2 - 1, 1 - ((y - r.top) / r.height) * 2);
    this.raycaster.setFromCamera(this.point, this.camera);
    let distance = Infinity,
      hit: number | null = null;
    for (const cell of this.pickCells.values()) {
      if (!this.raycaster.ray.intersectsBox(cell.bounds)) continue;
      for (const i of cell.indices) {
        const intersection = this.raycaster.ray.intersectBox(this.boxes[i]!, this.intersection);
        if (!intersection) continue;
        const d = this.raycaster.ray.origin.distanceTo(intersection);
        if (d < distance) {
          distance = d;
          hit = i;
        }
      }
    }
    return hit === null ? null : this.city.buildings[hit]!.nodeId;
  }
  stats() {
    const ctx = this.renderer.getContext(),
      ext = ctx.getExtension('WEBGL_debug_renderer_info');
    return {
      drawCalls: this.drawCalls,
      /** Extra calls of the last shadow-map update, which runs only when buildings change. */
      shadowDrawCalls: this.shadowCalls,
      geometries: this.renderer.info.memory.geometries,
      textures: this.renderer.info.memory.textures,
      buildings: this.city.buildings.length,
      pickCells: this.pickCells.size,
      ghosts: this.ghosts.count,
      added: this.addedMarkers.count,
      lens: this.lens,
      theme: this.theme,
      view: this.view,
      cameraMoving: this.flight !== null || this.settling,
      zoom: this.pixelsPerUnit(),
      renderer: ext ? String(ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown',
      heapBytes: (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null,
    };
  }
  /** Return to a view saved by `cameraState`, e.g. after switching city style or detail. */
  restoreCamera(state: { position: number[]; target: number[]; zoom: number }) {
    this.flight?.cancel();
    this.camera.position.fromArray(state.position);
    this.controls.target.fromArray(state.target);
    if (this.camera instanceof THREE.OrthographicCamera)
      this.camera.zoom = THREE.MathUtils.clamp(state.zoom, this.controls.minZoom, this.controls.maxZoom);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.invalidate();
  }
  cameraState() {
    return { position: this.camera.position.toArray(), target: this.controls.target.toArray(), zoom: this.camera.zoom };
  }
  measureFrames(count: number): Promise<number[]> {
    this.cancelMeasure?.();
    this.flight?.cancel();
    return new Promise((resolve) => {
      const values: number[] = [];
      let last = 0,
        frame = 0;
      const original = this.camera.position.clone();
      const finish = () => {
        cancelAnimationFrame(frame);
        this.camera.position.copy(original);
        this.controls.update();
        this.cancelMeasure = null;
        resolve(values);
      };
      this.cancelMeasure = finish;
      const tick = (now: number) => {
        if (this.disposed) {
          finish();
          return;
        }
        if (last) values.push(now - last);
        last = now;
        const offset = this.camera.position
          .clone()
          .sub(this.controls.target)
          .applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.01);
        this.camera.position.copy(this.controls.target).add(offset);
        this.controls.update();
        this.render();
        if (values.length >= Math.min(240, count)) finish();
        else frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    });
  }
  async exportPng(): Promise<Blob> {
    const scale = Math.min(2048 / this.width, 2048 / this.height, Math.sqrt(4_000_000 / (this.width * this.height)));
    const w = Math.max(1, Math.floor(this.width * scale)),
      h = Math.max(1, Math.floor(this.height * scale));
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const ctx = out.getContext('2d');
    if (!ctx) throw new Error('PNG export needs a 2D canvas');
    const ratio = this.renderer.getPixelRatio();
    try {
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(w, h, false);
      this.renderer.render(this.scene, this.camera);
      ctx.drawImage(this.renderer.domElement, 0, 0, w, h);
      const labels = document.createElement('canvas');
      labels.width = w;
      labels.height = h;
      this.drawLabels(labels, this.camera, w, h);
      ctx.drawImage(labels, 0, 0);
      return await new Promise<Blob>((resolve, reject) =>
        out.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG encoding failed'))), 'image/png'),
      );
    } finally {
      this.renderer.setPixelRatio(ratio);
      this.renderer.setSize(this.width, this.height, false);
      this.invalidate();
    }
  }
  loseContext() {
    this.renderer.getContext().getExtension('WEBGL_lose_context')?.loseContext();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelMeasure?.();
    this.flight?.cancel();
    cancelAnimationFrame(this.frame);
    this.abort.abort();
    this.resizeObserver.disconnect();
    this.controls.removeEventListener('change', this.invalidate);
    this.controls.dispose();
    for (const g of this.arcGeometries) g.dispose();
    for (const mesh of this.instances) mesh.dispose();
    for (const g of this.geometry) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.labels.remove();
  }
}
