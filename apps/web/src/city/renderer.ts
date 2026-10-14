import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { CityPaint } from './types';
import { districtColor, facadeColor, lensValue, type CityBuilding, type CityData, type CityLens } from '@atlas/layout';
import type { Rect } from '@atlas/schema';
import { EDGE_COLORS, edgeClass, type OverlayResult } from './overlay';
import {
  CORNER_PARTS,
  FIXED_PARTS,
  archetypeGeometry,
  bridgeGeometry,
  buildingStyle,
  cityDecor,
  cornerGeometry,
  depotEaveGeometry,
  districtFamily,
  facadeMaterial,
  gableGeometry,
  gateGeometry,
  groundLevel,
  lampGeometry,
  lotusGeometry,
  partGeometry,
  pavilionRoofGeometry,
  topExtent,
  treeGeometry,
  wallAt,
} from './architecture';
import { THEMES, type Archetype, type CityTheme, type PartKind, type ThemeSpec } from './themes';
import { mistTexture, sceneryGeometry, skyDome } from './atmosphere';
import { cloudLayer, foliageMaterial, waterMaterial, type Clock } from './living';
import { OCCLUDER_STRIDE, occlusionGrid, type OcclusionGrid } from './occlusion';
import { OcclusionBaker, type BakeWorker } from './baker';
import { PAVE, fieldUniforms, withOcclusion, withPaving, withTiles, type FieldUniforms, type PavingStyle } from './shading';

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
const PART_SHADE: Partial<Record<PartKind, number>> = { eave: 0.56, band: 0.8, crenel: 0.9, turret: 0.9, pinnacle: 0.85, chimney: 0.72 };
/** World height of each accent part. */
const PART_HEIGHT: Record<PartKind, number> = {
  eave: 0.26,
  band: 0.07,
  crenel: 0.3,
  platform: 0.2,
  terrace: 0.36,
  turret: 0.85,
  pinnacle: 0.55,
  chimney: 0.32,
  rooftop: 0.15,
};
/** Corner parts: inset of the corner (fraction of the top half-extent), footprint and base below the top. */
const CORNER_FIT: Partial<Record<PartKind, { inset: number; size: number; drop: number }>> = {
  turret: { inset: 0.92, size: 0.24, drop: 0.62 },
  pinnacle: { inset: 0.9, size: 0.12, drop: 0.06 },
  chimney: { inset: 0.7, size: 0.1, drop: 0.04 },
  rooftop: { inset: 0.8, size: 0.16, drop: 0.02 },
};
/** Ambient motion rate; camera interaction redraws at the display rate anyway. */
const IDLE_FPS = 24;
/** Most storey parts per building, so a 14-high tower stays bounded. */
const MAX_STOREY_PARTS = 14;
const PAVING: Record<CityTheme, PavingStyle> = { modern: 0, eastern: 1, western: 2 };
/** Remembered camera views for Back and Forward. */
const MAX_VIEWS = 40;
/** A camera still for this long (ms) counts as a settled view for Back/Forward. */
const SETTLE_MS = 160;
/**
 * Frame guard: over this many moving frames, a 75th-percentile frame interval above
 * GUARD_LATE_MS lowers the pixel ratio in proportion to the lateness (10-40% per step, to at
 * most half of full), at most once per GUARD_COOLDOWN_MS. Resizing a WebGL canvas stalls ANGLE, so the ratio never changes per
 * frame. The pixel count found sustainable carries over when the stage is resized.
 */
const GUARD_FRAMES = 60;
const GUARD_LATE_MS = 20;
const GUARD_COOLDOWN_MS = 1500;
const GUARD_FLOOR = 0.5;
/**
 * Calibrated resolution: GPU time of every SAMPLE_EVERY-th frame is read back (a timer query,
 * never blocking). On a resize, the pixel ratio is chosen so the predicted frame stays
 * within GPU_BUDGET_MS, leaving headroom for a GPU that slows down as it heats.
 */
const SAMPLE_EVERY = 15;
const GPU_BUDGET_MS = 11;

interface GpuTimer {
  gl: WebGL2RenderingContext;
  ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };
  query: WebGLQuery | null;
  pixels: number;
}

/** Dependency overlay sizes in screen pixels: stroke width, arrowhead at the target, midway chevron. */
const STROKE_PX = 3.4;
const ARROW_PX = 24;
const CHEVRON_PX = 13;
/** Most strokes, arrowheads and rings the dependency overlay draws (200 arcs at most). */
const MAX_STROKES = 5_200;
const MAX_ARROWS = 420;
const MAX_ENDPOINTS = 420;

/** Keyboard driving: a key's axis and direction; Shift turns arrows into turn and tilt. */
type DriveAxis = 'forward' | 'strafe' | 'turn' | 'tilt' | 'zoom';
function driveKey(code: string, shift: boolean): [DriveAxis, number] | null {
  switch (code) {
    case 'ArrowUp':
      return shift ? ['tilt', 1] : ['forward', 1];
    case 'ArrowDown':
      return shift ? ['tilt', -1] : ['forward', -1];
    case 'ArrowLeft':
      return shift ? ['turn', 1] : ['strafe', -1];
    case 'ArrowRight':
      return shift ? ['turn', -1] : ['strafe', 1];
    case 'KeyW':
      return ['forward', 1];
    case 'KeyS':
      return ['forward', -1];
    case 'KeyA':
      return ['strafe', -1];
    case 'KeyD':
      return ['strafe', 1];
    case 'KeyQ':
      return ['turn', 1];
    case 'KeyE':
      return ['turn', -1];
    case 'Equal':
    case 'NumpadAdd':
    case 'PageUp':
      return ['zoom', 1];
    case 'Minus':
    case 'NumpadSubtract':
    case 'PageDown':
      return ['zoom', -1];
    default:
      return null;
  }
}

/** Whether earlier or later camera views exist. */
export interface ViewHistory {
  back: boolean;
  forward: boolean;
}

/** An instanced batch that grows on demand; `styled` batches carry a per-instance style buffer. */
interface Growable {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  mesh: THREE.InstancedMesh;
  styled: boolean;
  /** Recoloured from the lens (false for stone and metal parts with fixed colours). */
  tinted: boolean;
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
  readonly camera: THREE.PerspectiveCamera;
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
  /** Shared time for waves, clouds and foliage; advances only when ambient motion is allowed. */
  private readonly clock: Clock = { value: 0 };
  private readonly animated: boolean;
  /** Low detail, chosen by the viewer or forced by a software renderer. */
  private readonly lite: boolean;
  private ambientFrame = 0;
  private lastAmbient = 0;
  /** Ambient frames yield to the rest of the page until this time (ms). */
  private uiBusyUntil = 0;
  private terminalKey: string | null = null;
  private terminalCity: CityData | null = null;
  private visible = true;
  private measuring = false;
  private visibility: IntersectionObserver | null = null;
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
  /** File dependency overlay: screen-width strokes, arrowheads, and rings on connected files. */
  private readonly strokes: THREE.InstancedMesh;
  private readonly arrows: THREE.InstancedMesh;
  private readonly endpointRings: THREE.InstancedMesh;
  private strokeList: { a: THREE.Vector3; b: THREE.Vector3; color: THREE.Color }[] = [];
  private arrowList: { tip: THREE.Vector3; direction: THREE.Vector3; px: number; color: THREE.Color }[] = [];
  /**
   * Buildings at the other end of the shown relationships, with their stroke colour and
   * whether the selection imports them (→), they import the selection (←), or both (↔).
   */
  private endpoints: { index: number; color: string; mark: string }[] = [];
  /** Keys held for driving, their eased axes, and the driving frame. */
  private readonly held = new Map<string, [DriveAxis, number]>();
  private readonly driven: Record<DriveAxis, number> = { forward: 0, strafe: 0, turn: 0, tilt: 0, zoom: 0 };
  private driveFrame = 0;
  private lastDrive = 0;
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
  private paint: CityPaint | null = null;
  private filter: (b: CityBuilding) => boolean = () => true;
  private width = 1;
  private height = 1;
  private frameTimes: number[] | null = null;
  private cancelMeasure: (() => void) | null = null;
  private readonly extent: number;
  private readonly origin: THREE.Vector3;
  /** Baked sky occlusion (full detail only): uniforms, grid, static occluders and the bake worker. */
  private readonly field: FieldUniforms | null;
  private readonly fieldGrid: OcclusionGrid;
  private staticOccluders = new Float32Array(0);
  private readonly baker: OcclusionBaker | null = null;
  private readonly selectionRings: THREE.InstancedMesh;
  private readonly ringMaterial: THREE.MeshBasicMaterial;
  /** Camera views for Back/Forward; the current one is at `viewIndex`. */
  private views: { position: THREE.Vector3; target: THREE.Vector3 }[] = [];
  private viewIndex = -1;
  private interacting = false;
  private readonly lastEye = new THREE.Vector3(Infinity, 0, 0);
  private readonly lastLook = new THREE.Vector3();
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Full pixel ratio, the ratio the frame guard currently allows, and its samples. */
  private readonly fullRatio: number;
  private ratio: number;
  private readonly late: number[] = [];
  private lastFrameAt = 0;
  private guardUntil = 0;
  /** Drawing-buffer pixels this GPU sustained once the guard engaged (Infinity until then). */
  private sustainable = Infinity;
  private readonly timer: GpuTimer | null = null;
  /** Measured GPU milliseconds per drawing-buffer pixel; the recent worst case. */
  private gpuPerPixel = 0;
  private frameCount = 0;

  constructor(
    readonly host: HTMLElement,
    initial: CityData,
    readonly callbacks: { select(id: string): void; hover(id: string | null): void; fail(reason: string): void; views?(state: ViewHistory): void },
    readonly lowQuality: boolean,
    readonly theme: CityTheme = 'modern',
  ) {
    this.city = initial;
    const city = initial;
    this.spec = THEMES[theme];
    this.archetypes = this.spec.archetypes;
    this.reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const ground = this.spec.ground;
    const capacity = Math.max(1, city.plotCount, city.buildings.length);
    this.renderer = new THREE.WebGLRenderer({ antialias: !lowQuality, alpha: false, powerPreference: 'low-power' });
    // A software renderer (no GPU, e.g. CI's SwiftShader) gets the low-detail scene: shadows,
    // trees, clouds, waves and facade patterns cost CPU time that the rest of the page needs.
    const info = this.renderer.getContext().getExtension('WEBGL_debug_renderer_info');
    const gpu = info ? String(this.renderer.getContext().getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
    this.lite = lowQuality || /swiftshader|llvmpipe|software|microsoft basic/i.test(gpu);
    const lite = this.lite;
    this.shadowsOn = !lite;
    this.fullRatio = this.ratio = Math.min(devicePixelRatio || 1, lite ? 1 : 1.5);
    this.renderer.setPixelRatio(this.ratio);
    if (!lite) {
      const gl = this.renderer.getContext();
      const ext = gl instanceof WebGL2RenderingContext ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
      if (ext && gl instanceof WebGL2RenderingContext) this.timer = { gl, ext, query: null, pixels: 1 };
    }
    this.field = lite ? null : fieldUniforms();
    if (this.field)
      this.baker = new OcclusionBaker(
        (bytes) => this.applyField(bytes),
        () => new Worker(new URL('./occlusion.worker.ts', import.meta.url), { type: 'module', name: 'atlas-occlusion' }) as unknown as BakeWorker,
      );
    this.renderer.setClearColor(this.spec.sky.haze);
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
    this.fieldGrid = occlusionGrid(city.root.x / 100, city.root.z / 100, (city.root.x + city.root.width) / 100, (city.root.z + city.root.depth) / 100);
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 10_000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.minPolarAngle = 0.12;
    this.controls.maxTargetRadius = this.extent;
    this.controls.cursor.copy(this.origin);
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
    this.controls.addEventListener('change', this.invalidate);
    this.controls.addEventListener('change', this.noteInput);
    this.controls.addEventListener('start', () => {
      this.flight?.cancel();
      this.interacting = true;
    });
    this.controls.addEventListener('end', () => {
      this.interacting = false;
      this.invalidate();
    });
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
    // Ground in one mesh (plan §11.1 permits a decorative shoreline): beach, a green belt and
    // the perimeter road. The island sits in an open sea under a sky, with distant scenery.
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
    slab(6.5, -0.02, 0.6, ground.beach);
    slab(5.5, 0.03, 0.2, ground.belt);
    slab(3, 0.07, 0.2, ground.road);
    // Lawns and road markings are static flat quads, so they join the ground mesh: fewer draws.
    const decor = cityDecor(city, theme);
    const flat = (x: number, y: number, z: number, w: number, d: number, turn: number, tint: string) => {
      const g = new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2).rotateY(turn).translate(x, y, z).toNonIndexed();
      const c = new THREE.Color(tint),
        n = g.getAttribute('position').count,
        values = new Float32Array(n * 3);
      for (let k = 0; k < n; k++) values.set([c.r, c.g, c.b], k * 3);
      g.deleteAttribute('uv');
      slabs.push(g.setAttribute('color', new THREE.BufferAttribute(values, 3)));
    };
    for (const l of decor.lawns) flat(l.x, l.y, l.z, Math.max(0.1, l.width), l.depth, 0, ground.lawn);
    if (ground.marking) for (const m of decor.markings) flat(m.x, m.y, m.z, m.length, 0.07, m.rotation, ground.marking);
    const groundMaterial = this.ownMaterial(new THREE.MeshLambertMaterial({ vertexColors: true }));
    if (this.field) withOcclusion(groundMaterial, this.field);
    const groundMesh = new THREE.Mesh(this.ownGeometry(mergeGeometries(slabs)), groundMaterial);
    // Opaque ground draws after the districts and buildings that cover most of it, so its
    // hidden pixels fail the depth test before shading.
    groundMesh.renderOrder = 2;
    for (const g of slabs) g.dispose();
    groundMesh.receiveShadow = true;
    this.scene.add(groundMesh);
    // Ambient motion needs full detail on a GPU, and never runs under reduced motion.
    this.animated = !lite && !this.reducedMotion;
    this.scene.fog = new THREE.Fog(this.spec.sky.haze, this.extent * 3, this.extent * 9);
    this.sky = skyDome(this.spec.sky, SUN);
    this.ownGeometry(this.sky.geometry);
    this.ownMaterial(this.sky.material as THREE.Material);
    // A wave-lit sea with turquoise shallows and foam along the beach line.
    const beach = new THREE.Vector4(r.x / 100 - 6.5, r.z / 100 - 6.5, (r.x + r.width) / 100 + 6.5, (r.z + r.depth) / 100 + 6.5);
    const ocean = new THREE.Mesh(
      this.ownGeometry(new THREE.CircleGeometry(this.extent * 14, 96).rotateX(-Math.PI / 2)),
      this.ownMaterial(waterMaterial(this.spec.sky, this.clock, SUN, { island: beach, foam: 1, detail: !lite })),
    );
    ocean.position.set(this.origin.x, -0.1, this.origin.z);
    ocean.renderOrder = 3;
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
    if (!lite) {
      const clouds = cloudLayer(this.spec.clouds, this.origin, this.extent, this.clock, (r.width * 7919 + r.depth) >>> 0);
      this.ownGeometry(clouds.mesh.geometry);
      this.ownMaterial(clouds.mesh.material as THREE.Material);
      this.textures.add(clouds.texture);
      this.instances.add(clouds.mesh);
      this.scene.add(clouds.mesh);
    }
    // Districts as kerbed blocks: a darker kerb, an inset surface, nested blocks stepping up.
    // The repository block reads as the street grid between packages.
    // Kerbs stay plain; the street grid gets asphalt and district surfaces paving.
    const districtBox = this.ownGeometry(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0));
    // Upper (deeper) districts draw first and each surface before its kerb, so the levels
    // below fail the depth test instead of shading pixels that end up covered.
    const order = city.districts.map((d, i) => ({ d, i })).sort((a, b) => b.d.depth - a.d.depth || a.i - b.i);
    const paving = new Float32Array(city.districts.length * 2);
    order.forEach(({ d }, k) => (paving[k * 2] = d.depth === 0 ? PAVE.street : PAVE.plaza));
    districtBox.setAttribute('atlasPave', new THREE.InstancedBufferAttribute(paving, 1));
    const districtMaterial = this.ownMaterial(new THREE.MeshLambertMaterial());
    if (this.field) {
      withPaving(districtMaterial, PAVING[theme]);
      withOcclusion(districtMaterial, this.field);
    }
    const districtMesh = this.batch(districtBox, districtMaterial, city.districts.length * 2, 'receive');
    districtMesh.renderOrder = 1;
    order.forEach(({ d }, k) => {
      const top = groundLevel(d.depth),
        c = center(d.rect),
        w = d.rect.width / 100,
        dep = d.rect.depth / 100;
      const root = d.depth === 0,
        pkg = d.kind === 'package';
      matrix.makeScale(w, top, dep).setPosition(c.x, 0, c.z);
      districtMesh.setMatrixAt(k * 2 + 1, matrix);
      districtMesh.setColorAt(k * 2 + 1, color.set(root ? ground.rootKerb : pkg ? ground.packageKerb : ground.directoryKerb));
      matrix.makeScale(Math.max(0.1, w - 0.24), top + 0.015, Math.max(0.1, dep - 0.24)).setPosition(c.x, 0, c.z);
      districtMesh.setMatrixAt(k * 2, matrix);
      districtMesh.setColorAt(
        k * 2,
        color.set(root ? ground.rootSurface : pkg ? ground.packageSurface : ground.directory[d.depth % 2]!),
      );
    });
    this.finish(districtMesh);
    this.districtDepth = new Map(city.districts.map((d) => [d.id, d.depth]));
    const coloured = () => this.ownMaterial(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    const place = (mesh: THREE.InstancedMesh, list: readonly { x: number; y: number; z: number; rotation?: number }[], scale = 1) => {
      list.forEach((p, i) => mesh.setMatrixAt(i, matrix.makeRotationY(p.rotation ?? 0).scale(new THREE.Vector3(scale, scale, scale)).setPosition(p.x, p.y, p.z)));
      this.finish(mesh);
      return mesh;
    };
    if (!lite) {
      const foliage = this.ownMaterial(foliageMaterial(this.clock));
      this.spec.trees.forEach((kind, k) => {
        const list = decor.trees.filter((t) => t.kind === k);
        const mesh = this.batch(this.ownGeometry(treeGeometry(kind.kind)), foliage, list.length, 'cast');
        list.forEach((t, i) => {
          mesh.setMatrixAt(i, matrix.makeScale(t.scale, t.scale, t.scale).setPosition(t.x, t.y, t.z));
          mesh.setColorAt(i, color.set(kind.tints[t.tint]!));
        });
        this.finish(mesh);
        this.decorations.push(mesh);
      });
      this.decorations.push(place(this.batch(this.ownGeometry(lampGeometry(this.spec.lamp)), coloured(), decor.lamps.length, 'cast'), decor.lamps));
    }
    if (decor.ponds.length) {
      // Lotus ponds: still jade water, arched bridges and floating pads.
      const pond = this.ownMaterial(
        waterMaterial(this.spec.sky, this.clock, SUN, {
          island: new THREE.Vector4(1e6, 1e6, -1e6, -1e6),
          foam: 0,
          deep: '#3f7f6a',
          shallow: '#5e9d80',
          calm: 0.25,
        }),
      );
      const ponds = this.batch(plane, pond, decor.ponds.length);
      decor.ponds.forEach((w, i) => ponds.setMatrixAt(i, matrix.makeScale(w.width, 1, w.depth).setPosition(w.x, w.y, w.z)));
      this.finish(ponds);
      const bridges = this.batch(this.ownGeometry(bridgeGeometry()), coloured(), decor.bridges.length, 'both');
      decor.bridges.forEach((b, i) =>
        bridges.setMatrixAt(i, matrix.makeScale(1, 1, b.length).premultiply(rotation.makeRotationY(b.rotation)).setPosition(b.x, b.y, b.z)),
      );
      this.finish(bridges);
      if (!lite) place(this.batch(this.ownGeometry(lotusGeometry()), coloured(), decor.lotus.length), decor.lotus);
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
      } else if (!lite) {
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
      place(this.batch(this.ownGeometry(gateGeometry(this.spec.walls)), coloured(), decor.gates.length, 'both'), decor.gates);
    }
    if (this.field) {
      // Trees and town walls shade the ground around them too; they never move.
      const list: number[] = [];
      for (const t of decor.trees) list.push(t.x, t.z, 0.2 * t.scale, 0.2 * t.scale, 0.75 * t.scale, 0.35);
      for (const s of decor.walls) {
        const along = Math.abs(Math.cos(s.rotation)),
          across = Math.abs(Math.sin(s.rotation));
        list.push(s.x, s.z, (along * s.length) / 2 + across * 0.07, (across * s.length) / 2 + along * 0.07, 0.3, 0.45);
      }
      this.staticOccluders = new Float32Array(list);
    }
    // Seeded archetype batches share one facade material; each grows on demand. Accent
    // parts share one lens-shaded material per kind and outline.
    this.facade = this.ownMaterial(facadeMaterial(!lite, this.spec.sky));
    if (this.field) withOcclusion(this.facade, this.field, true);
    for (const a of this.archetypes) this.bodies.push(this.growable(this.ownGeometry(archetypeGeometry(a)), this.facade, true, 'both', true));
    // Lens-shaded accents (eaves, bands, battlements; corner parts carry dark caps per vertex),
    // stone bases and grey rooftop plant.
    const accent = this.ownMaterial(new THREE.MeshLambertMaterial({ flatShading: true }));
    const capped = this.ownMaterial(new THREE.MeshLambertMaterial({ flatShading: true, vertexColors: true }));
    const stone = this.ownMaterial(new THREE.MeshLambertMaterial({ color: this.spec.platform, flatShading: true }));
    const plant = this.ownMaterial(new THREE.MeshLambertMaterial({ flatShading: true, vertexColors: true }));
    for (const a of this.archetypes)
      for (const part of a.parts ?? []) {
        const single = FIXED_PARTS.has(part.kind) || CORNER_PARTS.has(part.kind);
        for (const sides of single ? ([4] as const) : ([...new Set(a.tiers.map((t) => t.sides))] as const)) {
          const key = `${part.kind}-${sides}`;
          if (this.parts.has(key)) continue;
          const material = part.kind === 'rooftop' ? plant : FIXED_PARTS.has(part.kind) ? stone : CORNER_PARTS.has(part.kind) ? capped : accent;
          this.parts.set(key, this.growable(this.ownGeometry(partGeometry(part.kind, sides)), material, false, 'both', !FIXED_PARTS.has(part.kind)));
        }
      }
    this.partList = [...this.parts.values()];
    // Role silhouettes share geometry; no per-building light, label or material.
    for (const role of ROLES) {
      const shape =
        role === 'source'
          ? this.spec.sourceRoof === 'pavilion'
            ? pavilionRoofGeometry()
            : new THREE.ConeGeometry(0.68, 0.44, 4)
          : role === 'test'
            ? new THREE.CylinderGeometry(0.45, 0.45, 0.24, 6)
            : role === 'asset'
              ? new THREE.ConeGeometry(0.46, 0.3, 8)
              : new THREE.BoxGeometry(
                  role === 'config' ? 0.6 : 0.93,
                  role === 'declaration' ? 0.08 : 0.16,
                  role === 'config' ? 0.6 : 0.93,
                );
      const roofMaterial = this.ownMaterial(
        new THREE.MeshLambertMaterial({
          color: role === 'test' ? this.spec.roofs.test : role === 'source' ? this.spec.roofs.source : this.spec.roofs.other,
        }),
      );
      if (role === 'source' && !lite) withTiles(roofMaterial, this.spec.sourceRoof === 'pavilion' ? 40 : 30, this.spec.sourceRoof === 'pavilion' ? 56 : 44);
      const roof = this.batch(this.ownGeometry(shape), roofMaterial, capacity, 'both');
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
    // A ring on the ground marks each selected building's base, so a selection reads from any angle.
    this.ringMaterial = this.ownMaterial(new THREE.MeshBasicMaterial({ color: '#2a7ab8', transparent: true, opacity: 0.85, depthWrite: false, fog: false }));
    this.selectionRings = this.batch(this.ownGeometry(new THREE.RingGeometry(0.6, 0.75, 48).rotateX(-Math.PI / 2)), this.ringMaterial, capacity);
    this.selectionRings.count = 0;
    this.selectionRings.renderOrder = 2;
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
    // Relationships of a selected file: strokes and arrowheads drawn over the city, rings on
    // the buildings at their other ends. One draw call each; colours per instance by kind.
    const overlayMaterial = (depthTest: boolean) =>
      this.ownMaterial(new THREE.MeshBasicMaterial({ depthTest, depthWrite: false, transparent: true, opacity: 0.95, fog: false }));
    this.strokes = this.batch(this.ownGeometry(new THREE.CylinderGeometry(1, 1, 1, 6, 1, true)), overlayMaterial(false), MAX_STROKES);
    this.arrows = this.batch(this.ownGeometry(new THREE.ConeGeometry(0.5, 1, 12)), overlayMaterial(false), MAX_ARROWS);
    this.endpointRings = this.batch(this.ownGeometry(new THREE.RingGeometry(0.58, 0.8, 40).rotateX(-Math.PI / 2)), overlayMaterial(true), MAX_ENDPOINTS);
    for (const mesh of [this.strokes, this.arrows, this.endpointRings]) mesh.count = 0;
    this.strokes.renderOrder = this.arrows.renderOrder = 12;
    this.endpointRings.renderOrder = 2;
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
    for (const type of ['pointerdown', 'pointermove', 'wheel'] as const) canvas.addEventListener(type, this.noteInput, { signal, passive: true });
    for (const type of ['keydown', 'pointerdown', 'input'] as const) document.addEventListener(type, this.notePage, { signal, capture: true, passive: true });
    if (this.animated) {
      // Pause when the city is scrolled away; the tab's own visibility is checked per frame.
      if (typeof IntersectionObserver === 'function') {
        this.visibility = new IntersectionObserver(([entry]) => {
          this.visible = entry?.isIntersecting ?? true;
          if (this.visible) this.invalidate();
        });
        this.visibility.observe(host);
      }
      this.ambientFrame = requestAnimationFrame(this.ambient);
    }
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
    this.applyStyle(this.lens, present, this.filter, this.paint);
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
    const occluders = this.field ? new Float32Array(buildings.length * OCCLUDER_STRIDE) : null;
    this.boxes = buildings.map((b, i) => {
      const p = center(b.rect);
      const h = b.height,
        style = styles[i]!,
        archetype = this.archetypes[style.archetype]!,
        body = this.bodies[style.archetype]!,
        slot = body.used++,
        f = style.footprint,
        // Depth scale: a seeded slab plan on square-planned bodies.
        d = f * style.aspect;
      rotation.makeRotationY(style.rotation);
      matrix
        .makeScale(f, 0.35 + h - BODY_BASE, d)
        .premultiply(rotation)
        .setPosition(p.x, BODY_BASE, p.z);
      body.mesh.setMatrixAt(slot, matrix);
      (body.geometry.getAttribute('atlasStyle') as THREE.InstancedBufferAttribute).setXYZW(slot, style.windows, style.variant, style.base, style.material);
      this.bodyBatch[i] = style.archetype;
      this.bodySlot[i] = slot;
      if (occluders) {
        const wall = wallAt(archetype, 0),
          half = Math.max(wall.hx, wall.hz) * f;
        occluders.set([p.x, p.z, half, half, 0.35 + h - groundLevel(this.districtDepth.get(b.districtId) ?? 1), 0.6], i * OCCLUDER_STRIDE);
      }
      // Accent parts follow the wall outline at their storey and turn with the body.
      for (const part of placements[i]!) {
        const batch = this.parts.get(part.key)!,
          n = batch.used++;
        // Corner parts sit at an offset on the top (keeping their own square plan); outline
        // parts follow the body's plan. Both turn with the body.
        const ox = part.ox * f,
          oz = part.oz * d,
          c = Math.cos(style.rotation),
          sn = Math.sin(style.rotation);
        matrix
          .makeScale(part.hx * f, PART_HEIGHT[part.kind], part.hz * (CORNER_PARTS.has(part.kind) ? f : d))
          .premultiply(rotation)
          .setPosition(p.x + ox * c + oz * sn, part.y, p.z - ox * sn + oz * c);
        batch.mesh.setMatrixAt(n, matrix);
        if (batch.tinted) {
          this.partOwner[partCount] = i;
          this.partBatch[partCount] = batchIndex.get(batch)!;
          this.partSlot[partCount] = n;
          this.partShade[partCount++] = PART_SHADE[part.kind] ?? 0.8;
        }
      }
      // The role roof is fitted to the archetype's top outline and turns with the body.
      const roof = this.roofs.get(b.role)!;
      const n = roofCounts.get(b.role) ?? 0;
      const [tx, tz] = topExtent(archetype),
        fit = (archetype.roof ?? 1) * f;
      matrix
        .makeRotationY(b.role === 'source' ? Math.PI / 4 : ((b.seed % 4) * Math.PI) / 2)
        .premultiply(scaling.makeScale((tx * fit) / 0.44, 1, (tz * fit * style.aspect) / 0.44))
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
    if (occluders) this.bakeField(occluders);
  }

  /**
   * Re-bake the sky-occlusion field for this frame's buildings; the previous field stays on
   * screen until the new one lands, and only the latest request is applied.
   */
  private bakeField(buildings: Float32Array) {
    if (!this.baker) return;
    const occluders = new Float32Array(this.staticOccluders.length + buildings.length);
    occluders.set(this.staticOccluders);
    occluders.set(buildings, this.staticOccluders.length);
    this.baker.bake(this.fieldGrid, occluders);
  }

  /** Upload a baked field, reusing the texture while the grid is unchanged. */
  private applyField(bytes: Uint8Array) {
    const field = this.field,
      grid = this.fieldGrid;
    if (!field || this.disposed) return;
    const current = field.atlasAO.value;
    if (current instanceof THREE.DataTexture && current.image.width === grid.width && current.image.height === grid.depth) {
      current.image.data = bytes;
      current.needsUpdate = true;
    } else {
      const texture = new THREE.DataTexture(bytes, grid.width, grid.depth, THREE.RedFormat, THREE.UnsignedByteType);
      texture.unpackAlignment = 1;
      // Mipmaps: a wide view reads a coarse level instead of thrashing the texture cache
      // (5 ms of a 20 ms frame on a GT 730 without them).
      texture.generateMipmaps = true;
      texture.magFilter = THREE.LinearFilter;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.needsUpdate = true;
      current.dispose();
      field.atlasAO.value = texture;
      field.atlasAORect.value.set(grid.minX, grid.minZ, 1 / (grid.width * grid.texel), 1 / (grid.depth * grid.texel));
    }
    this.invalidate();
  }

  /**
   * Accent parts of one building: a base platform, storey eaves or bands at a fixed world
   * spacing (so taller files gain storeys), and a top eave or battlement. Low detail keeps
   * only base and top parts.
   */
  private storeyParts(b: CityBuilding, archetype: number) {
    const a = this.archetypes[archetype]!;
    const list: { key: string; kind: PartKind; y: number; hx: number; hz: number; ox: number; oz: number }[] = [];
    if (!a.parts) return list;
    const top = 0.35 + b.height,
      span = top - BODY_BASE,
      ground = groundLevel(this.districtDepth.get(b.districtId) ?? 1);
    for (const part of a.parts) {
      if (part.kind === 'platform' || part.kind === 'terrace') {
        const wall = wallAt(a, 0),
          reach = part.kind === 'terrace' ? 1.55 : 1.4,
          cap = part.kind === 'terrace' ? 0.7 : 0.66;
        list.push({ key: `${part.kind}-4`, kind: part.kind, y: ground - 0.02, hx: Math.min(cap, wall.hx * reach), hz: Math.min(cap, wall.hz * reach), ox: 0, oz: 0 });
        continue;
      }
      const fit = CORNER_FIT[part.kind];
      if (fit) {
        // Corner furniture needs a square top; a diagonal pair or all four corners.
        const wall = wallAt(a, 1);
        if (wall.sides !== 4) continue;
        const corners = part.corners === 2 ? [[1, 1], [-1, -1]] : [[1, 1], [-1, 1], [-1, -1], [1, -1]];
        for (const [sx, sz] of corners)
          list.push({
            key: `${part.kind}-4`,
            kind: part.kind,
            y: top - fit.drop,
            hx: fit.size,
            hz: fit.size,
            ox: sx! * wall.hx * fit.inset,
            oz: sz! * wall.hz * fit.inset,
          });
        continue;
      }
      const heights: number[] = [];
      if (part.every && !this.lite)
        for (let y = ground + (part.from ?? part.every); y < top - 0.45 && heights.length < MAX_STOREY_PARTS; y += part.every)
          heights.push(y);
      if (part.top) heights.push(top - (part.kind === 'crenel' ? 0.12 : 0.2));
      for (const y of heights) {
        const wall = wallAt(a, (y - BODY_BASE) / span);
        // Eave outlines meet the wall at 0.7 of their reach; bands and crenels overhang slightly.
        const reach = part.kind === 'eave' ? 1 / 0.7 : (part.overhang ?? (part.kind === 'crenel' ? 1.04 : 1.08));
        list.push({ key: `${part.kind}-${wall.sides}`, kind: part.kind, y, hx: wall.hx * reach, hz: wall.hz * reach, ox: 0, oz: 0 });
      }
    }
    return list;
  }

  private growable(geometry: THREE.BufferGeometry, material: THREE.Material, styled: boolean, shadows: Shadows, tinted: boolean): Growable {
    const mesh = this.batch(geometry, material, 1, shadows);
    mesh.count = 0;
    return { geometry, material, mesh, styled, tinted, used: 0 };
  }

  /** Grow a batch (and a styled batch's per-instance style buffer) to hold `needed` instances. */
  private grow(g: Growable, needed: number) {
    const style = g.geometry.getAttribute('atlasStyle') as THREE.InstancedBufferAttribute | undefined;
    if (g.styled ? style && style.count >= needed : g.mesh.instanceMatrix.count >= needed && g.mesh.instanceMatrix.count > 1) return;
    const capacity = Math.max(16, Math.ceil(needed * 1.25));
    if (g.styled) {
      // Disposing releases the old GPU buffers; the next render uploads the larger ones.
      g.geometry.dispose();
      g.geometry.setAttribute('atlasStyle', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4));
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
    // Depots cast shadows, so the shadow map re-renders only when the set shown changes,
    // not on every selection's overlay.
    const key = terminals.map((t) => t.nodeId).join('|');
    if (key === this.terminalKey && this.city === this.terminalCity) return;
    this.terminalKey = key;
    this.terminalCity = this.city;
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
    // A new stage size (e.g. expanding the city) gets the ratio its predicted GPU time and the
    // pixel count this GPU sustained allow, and returns to the full ratio where that fits.
    const full = this.width * this.height * this.fullRatio * this.fullRatio;
    const predicted = this.gpuPerPixel * full;
    const budget = predicted > GPU_BUDGET_MS ? Math.sqrt(GPU_BUDGET_MS / predicted) : 1;
    const ratio = Math.max(
      this.fullRatio * GUARD_FLOOR,
      Math.min(this.fullRatio * budget, Math.sqrt(this.sustainable / (this.width * this.height))),
    );
    if (ratio !== this.ratio) {
      this.ratio = ratio;
      this.renderer.setPixelRatio(ratio);
      this.late.length = 0;
    }
    this.renderer.setSize(this.width, this.height, false);
    this.labels.width = Math.round(this.width);
    this.labels.height = Math.round(this.height);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  };
  /** Screen pixels per world unit at the orbit target; level of detail and overlay widths use it. */
  pixelsPerUnit(): number {
    const distance = this.camera.position.distanceTo(this.controls.target);
    return this.height / (2 * distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
  }
  /**
   * Ambient motion (waves, clouds, foliage) at a calm rate. Camera motion already redraws
   * every frame, so the scene stays alive while orbiting. It pauses while the city is hidden
   * or measured, and yields to typing and clicking elsewhere on the page so search, selection
   * and the inspector never wait on decorative frames.
   */
  private readonly ambient = (now: number) => {
    if (this.disposed) return;
    this.ambientFrame = requestAnimationFrame(this.ambient);
    if (!this.visible || document.hidden || this.measuring || now < this.uiBusyUntil) return;
    if (now - this.lastAmbient >= 1000 / IDLE_FPS) {
      this.lastAmbient = now;
      this.invalidate();
    }
  };
  private readonly noteInput = () => {
    this.lastAmbient = performance.now();
  };
  private readonly notePage = (event: Event) => {
    if (event.target !== this.renderer.domElement) this.uiBusyUntil = performance.now() + 1500;
  };
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
    const now = performance.now();
    // A view is remembered once the camera has been still for a moment; the check is one
    // timer, never an extra frame.
    const moving = !this.camera.position.equals(this.lastEye) || !this.controls.target.equals(this.lastLook);
    this.lastEye.copy(this.camera.position);
    this.lastLook.copy(this.controls.target);
    this.guardFrames(moving, now);
    if (moving) {
      if (this.settleTimer) clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => {
        this.settleTimer = null;
        if (!this.disposed && !this.flight && !this.measuring && this.camera.position.equals(this.lastEye) && this.controls.target.equals(this.lastLook)) this.recordView();
      }, SETTLE_MS);
    }
    const ppu = this.pixelsPerUnit();
    if (this.animated) this.clock.value = now / 1000;
    if (this.animated && this.selectionRings.count) this.ringMaterial.opacity = 0.62 + 0.25 * Math.sin(this.clock.value * 2.6);
    this.frameAtmosphere(this.camera);
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
      this.layoutStrokes(ppu);
      this.packageZoom = ppu;
    }
    // Level of detail counts rendered pixels: a frame-guarded (lower) pixel ratio sheds
    // detail as well as fill. Perspective shows near roofs large even when the target is
    // far, so it keeps them.
    const rendered = ppu * this.ratio;
    const near = rendered >= 2;
    for (const roof of this.roofs.values()) roof.visible = near;
    // Below ~1.5 px per cell trees are speckle; the facade shader fades windows by itself.
    for (const mesh of this.decorations) mesh.visible = rendered >= 1.5;
    const shadowFrame = this.shadowsOn && this.shadowDirty;
    if (shadowFrame) {
      this.renderer.shadowMap.needsUpdate = true;
      this.shadowDirty = false;
    }
    const timed = this.sampleGpu(shadowFrame);
    this.renderer.render(this.scene, this.camera);
    if (timed) this.timer!.gl.endQuery(this.timer!.ext.TIME_ELAPSED_EXT);
    // Report steady-state draw calls; a shadow update's extra pass is recorded separately and
    // followed by an ordinary frame.
    if (shadowFrame) {
      this.shadowCalls = this.renderer.info.render.calls;
      this.invalidate();
    } else this.drawCalls = this.renderer.info.render.calls;
    this.drawLabels(this.labels, this.camera, this.width, this.height);
  }
  /**
   * Read a finished GPU timing if one is ready, and start timing this frame every
   * SAMPLE_EVERY frames (never a shadow-map frame). Returns whether this frame is timed.
   */
  private sampleGpu(shadowFrame: boolean): boolean {
    const t = this.timer;
    if (!t) return false;
    const { gl, ext } = t;
    if (t.query) {
      if (!gl.getQueryParameter(t.query, gl.QUERY_RESULT_AVAILABLE)) return false;
      if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) {
        const perPixel = gl.getQueryParameter(t.query, gl.QUERY_RESULT) / 1e6 / t.pixels;
        // Rise at once, fall slowly: a heavy view is remembered for a while.
        this.gpuPerPixel = Math.max(perPixel, this.gpuPerPixel * 0.97);
      }
      gl.deleteQuery(t.query);
      t.query = null;
    }
    if (shadowFrame || ++this.frameCount % SAMPLE_EVERY !== 0) return false;
    t.query = gl.createQuery();
    t.pixels = Math.max(1, gl.drawingBufferWidth * gl.drawingBufferHeight);
    gl.beginQuery(ext.TIME_ELAPSED_EXT, t.query);
    return true;
  }
  /** Lower the pixel ratio after sustained late frames while the camera moves (see GUARD_FRAMES). */
  private guardFrames(moving: boolean, now: number) {
    const interval = now - this.lastFrameAt;
    this.lastFrameAt = now;
    if (!moving || interval > 120) return;
    this.late.push(interval);
    if (this.late.length < GUARD_FRAMES) return;
    const sorted = this.late.sort((a, b) => a - b),
      p75 = sorted[Math.floor(sorted.length * 0.75)]!;
    this.late.length = 0;
    if (p75 <= GUARD_LATE_MS || now < this.guardUntil || this.ratio <= this.fullRatio * GUARD_FLOOR + 1e-6) return;
    // Pixels scale with the square of the ratio: aim the next frame at the display interval.
    const step = THREE.MathUtils.clamp(Math.sqrt(16.7 / p75) * 0.95, 0.6, 0.9);
    this.ratio = Math.max(this.fullRatio * GUARD_FLOOR, this.ratio * step);
    this.sustainable = this.width * this.height * this.ratio * this.ratio;
    this.guardUntil = now + GUARD_COOLDOWN_MS;
    this.renderer.setPixelRatio(this.ratio);
  }
  /** Remember a settled camera view for Back/Forward, unless it repeats the current one. */
  private recordView() {
    const position = this.camera.position.clone(),
      target = this.controls.target.clone();
    const current = this.views[this.viewIndex];
    const tolerance = Math.max(0.05, position.distanceTo(target) * 0.02);
    if (current && current.position.distanceTo(position) < tolerance && current.target.distanceTo(target) < tolerance) return;
    this.views = this.views.slice(0, this.viewIndex + 1);
    this.views.push({ position, target });
    if (this.views.length > MAX_VIEWS) this.views.shift();
    this.viewIndex = this.views.length - 1;
    this.notifyViews();
  }
  private notifyViews() {
    this.callbacks.views?.({ back: this.viewIndex > 0, forward: this.viewIndex < this.views.length - 1 });
  }
  /** Fly to the previous (-1) or next (+1) remembered view. */
  travel(step: -1 | 1) {
    const next = this.views[this.viewIndex + step];
    if (!next) return;
    this.viewIndex += step;
    this.notifyViews();
    this.setView(next.position.clone(), next.target.clone(), true);
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
  /**
   * Labels on a 2D canvas over the city. The hovered or singly selected building is always
   * named, with a leader to its roof. Package names follow by priority (the selection's
   * package, then the largest on screen), skip places another label already holds, and
   * fade with distance, so a crowded view stays readable.
   */
  private drawLabels(canvas: HTMLCanvasElement, camera: THREE.Camera, width: number, height: number) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    ctx.textAlign = 'center';
    const taken: number[] = [];
    const free = (x0: number, y0: number, x1: number, y1: number) => {
      for (let k = 0; k < taken.length; k += 4) if (x0 < taken[k + 2]! && x1 > taken[k]! && y0 < taken[k + 3]! && y1 > taken[k + 1]!) return false;
      return true;
    };
    const project = (p: THREE.Vector3) => {
      const v = p.project(camera);
      if (v.z < -1 || v.z > 1) return null;
      const x = ((v.x + 1) / 2) * width,
        y = ((1 - v.y) / 2) * height;
      return x < 0 || x > width || y < 0 || y > height ? null : { x, y };
    };
    const pill = (text: string, at: { x: number; y: number }, o: { swatch?: string | null; strong?: boolean; alpha?: number; force?: boolean }) => {
      const safe = text.length > 42 ? `${text.slice(0, 39)}…` : text;
      ctx.font = o.strong ? '650 13px system-ui' : '600 12px system-ui';
      const inset = o.swatch ? 12 : 0,
        w = ctx.measureText(safe).width + 18 + inset,
        h = o.strong ? 23 : 21,
        top = at.y - 12;
      if (!o.force && !free(at.x - w / 2 - 4, top - 3, at.x + w / 2 + 4, top + h + 3)) return false;
      taken.push(at.x - w / 2 - 4, top - 3, at.x + w / 2 + 4, top + h + 3);
      ctx.globalAlpha = o.alpha ?? 1;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(at.x - w / 2, top, w, h, h / 2);
      else ctx.rect(at.x - w / 2, top, w, h);
      ctx.fillStyle = o.strong ? 'rgba(24, 35, 49, 0.92)' : 'rgba(249, 247, 240, 0.94)';
      ctx.shadowColor = 'rgba(24, 35, 49, 0.18)';
      ctx.shadowBlur = 4;
      ctx.shadowOffsetY = 1;
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.strokeStyle = 'rgba(38, 51, 68, 0.16)';
      ctx.stroke();
      if (o.swatch) {
        ctx.beginPath();
        ctx.arc(at.x - w / 2 + 12, top + h / 2, 4, 0, Math.PI * 2);
        ctx.fillStyle = o.swatch;
        ctx.fill();
      }
      ctx.fillStyle = o.strong ? '#f4f6f9' : '#263344';
      ctx.fillText(safe, at.x + inset / 2, top + h / 2 + 4);
      ctx.globalAlpha = 1;
      return true;
    };
    const focusIndex =
      this.hoverId !== null
        ? this.buildingIndex.get(this.hoverId)
        : this.selected.size === 1
          ? this.buildingIndex.get(this.selected.values().next().value!)
          : undefined;
    const focus = focusIndex === undefined ? null : this.city.buildings[focusIndex]!;
    let home: CityData['districts'][number] | null = null;
    if (focus) {
      const roof = project(center(focus.rect).setY(focus.height + 0.55));
      const at = project(center(focus.rect).setY(focus.height + 1.6));
      if (roof && at) {
        ctx.beginPath();
        ctx.moveTo(roof.x, roof.y);
        ctx.lineTo(at.x, at.y + 10);
        ctx.strokeStyle = 'rgba(24, 35, 49, 0.75)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        pill(focus.path, at, { strong: true, force: true });
      }
      const fx = focus.rect.x + focus.rect.width / 2,
        fz = focus.rect.z + focus.rect.depth / 2;
      for (const d of this.city.districts)
        if (d.kind === 'package' && fx >= d.rect.x && fx <= d.rect.x + d.rect.width && fz >= d.rect.z && fz <= d.rect.z + d.rect.depth && (!home || d.depth > home.depth))
          home = d;
    }
    const eye = camera.position,
      distance = Math.max(1e-3, eye.distanceTo(this.controls.target));
    // Files at the other end of the shown relationships, nearest first, with their line colour.
    const ends = this.endpoints
      .map(({ index, color, mark }) => {
        const b = this.city.buildings[index];
        if (!b) return null;
        const p = center(b.rect).setY(b.height + 0.9);
        return { b, p, color, mark, away: eye.distanceTo(p) };
      })
      .filter((e) => e !== null)
      .sort((x, y) => x.away - y.away);
    let named = 0;
    for (const e of ends) {
      if (named >= 16) break;
      if (focus && e.b.nodeId === focus.nodeId) continue;
      const at = project(e.p.clone());
      const name = e.b.path.split('/').at(-1) ?? e.b.path;
      if (at && pill(e.mark ? `${e.mark} ${name}` : name, at, { swatch: e.color })) named++;
    }
    const candidates = this.city.districts
      .filter((d) => d.kind === 'package')
      .map((d) => {
        const p = new THREE.Vector3((d.rect.x + d.rect.width / 2) / 100, groundLevel(d.depth), (d.rect.z + 70) / 100);
        const away = eye.distanceTo(p);
        return { d, p, away, rank: d === home ? Infinity : Math.hypot(d.rect.width, d.rect.depth) / 100 / Math.max(away, 1e-3) };
      })
      .sort((a, b) => b.rank - a.rank);
    let shown = 0;
    for (const c of candidates) {
      if (shown >= 24) break;
      const at = project(c.p);
      if (!at) continue;
      const alpha = THREE.MathUtils.clamp(1.35 - (0.4 * c.away) / distance, 0.45, 1);
      // The swatch repeats the facade colour only while the structure lens shows package colour.
      if (pill(c.d.label, at, { swatch: this.lens === 'structure' && !this.paint ? districtColor(c.d.id) : null, alpha: c.d === home ? 1 : alpha })) shown++;
    }
  }
  applyStyle(lens: CityLens, selected: ReadonlySet<string>, filter: (b: CityBuilding) => boolean, paint: CityPaint | null = null) {
    const recolor =
      this.lens !== lens ||
      (this.paint?.key ?? null) !== (paint?.key ?? null) ||
      this.filter !== filter ||
      this.styled !== this.city ||
      [...this.bodies, ...this.partList].some((g) => g.mesh.count > 0 && !g.mesh.instanceColor && g.tinted);
    this.styled = this.city;
    this.lens = lens;
    this.paint = paint;
    this.selected = new Set(selected);
    this.filter = filter;
    let count = 0,
      unknown = 0;
    const tones = recolor ? new Float32Array(this.city.buildings.length * 3) : null;
    if (recolor)
      this.city.buildings.forEach((b, i) => {
        color.set(paint ? paint.color(b) : facadeColor(b, lens));
        if (!filter(b)) color.lerp(white, 0.8);
        this.bodies[this.bodyBatch[i]!]!.mesh.setColorAt(this.bodySlot[i]!, color);
        tones!.set([color.r, color.g, color.b], i * 3);
        const p = center(b.rect);
        if ((paint ? paint.unknown(b) : lens !== 'structure' && lensValue(b, lens) === null) || b.parseStatus !== 'parsed') {
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
      this.selection.setMatrixAt(count, matrix);
      matrix.makeTranslation(p.x, groundLevel(this.districtDepth.get(b.districtId) ?? 1) + 0.03, p.z);
      this.selectionRings.setMatrixAt(count++, matrix);
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
    this.selectionRings.count = count;
    this.finish(this.selectionRings);
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
    this.strokeList = [];
    this.arrowList = [];
    this.packageZoom = -1;
    const terminals = result.promotedTerminal
      ? [...this.city.terminals.slice(0, 49), result.promotedTerminal]
      : this.city.terminals;
    this.placeTerminals(terminals);
    const ends = new Map<number, { color: string; imports: boolean; consumes: boolean }>();
    for (const arc of result.arcs) {
      const points = arc.points.map((p) => new THREE.Vector3(...p));
      const curve = points.length === 3 ? new THREE.QuadraticBezierCurve3(points[0]!, points[1]!, points[2]!) : null;
      const samples = curve ? curve.getPoints(24) : points;
      if (arc.kind === 'package') {
        for (let i = 0; i + 1 < samples.length; i++)
          this.packageSegments.push({ a: samples[i]!, b: samples[i + 1]!, width: Math.min(6, 1 + Math.log2(1 + arc.count)) });
        continue;
      }
      const key = edgeClass(arc.kind),
        tint = new THREE.Color(EDGE_COLORS[key]);
      // Weaker kinds are dashed: type-only every other segment, dynamic two on and one off.
      const period = key === 'type' ? 2 : key === 'dynamic' ? 3 : 0;
      for (let i = 0; i + 1 < samples.length; i++)
        if (!period || i % period !== period - 1) this.strokeList.push({ a: samples[i]!, b: samples[i + 1]!, color: tint });
      // Arrowheads point at the imported target: one at the end, a smaller chevron midway.
      const last = samples.length - 1;
      if (last >= 1) this.arrowList.push({ tip: samples[last]!, direction: samples[last]!.clone().sub(samples[last - 1]!), px: ARROW_PX, color: tint });
      const mid = Math.floor(last / 2);
      if (last >= 4) this.arrowList.push({ tip: samples[mid + 1]!, direction: samples[mid + 1]!.clone().sub(samples[mid - 1]!), px: CHEVRON_PX, color: tint });
      for (const id of [arc.sourceId, arc.targetId]) {
        const index = id === result.selectionId ? undefined : this.buildingIndex.get(id);
        if (index === undefined) continue;
        const end = ends.get(index) ?? { color: EDGE_COLORS[key], imports: false, consumes: false };
        if (arc.sourceId === result.selectionId) end.imports = true;
        if (arc.targetId === result.selectionId) end.consumes = true;
        ends.set(index, end);
      }
    }
    this.strokeList.length = Math.min(this.strokeList.length, MAX_STROKES);
    this.arrowList.length = Math.min(this.arrowList.length, MAX_ARROWS);
    this.endpoints = [...ends]
      .slice(0, MAX_ENDPOINTS)
      .map(([index, e]) => ({ index, color: e.color, mark: e.imports && e.consumes ? '↔' : e.imports ? '→' : e.consumes ? '←' : '' }));
    this.endpoints.forEach(({ index, color: hex }, n) => {
      const b = this.city.buildings[index]!,
        p = center(b.rect);
      this.endpointRings.setMatrixAt(n, matrix.makeTranslation(p.x, groundLevel(this.districtDepth.get(b.districtId) ?? 1) + 0.035, p.z));
      this.endpointRings.setColorAt(n, color.set(hex));
    });
    this.endpointRings.count = this.endpoints.length;
    this.finish(this.endpointRings);
    this.invalidate();
  }
  /** Size strokes and arrowheads in screen pixels at the current zoom. */
  private layoutStrokes(ppu: number) {
    const turn = new THREE.Quaternion(),
      direction = new THREE.Vector3(),
      up = new THREE.Vector3(0, 1, 0),
      size = new THREE.Vector3(),
      at = new THREE.Vector3();
    const radius = STROKE_PX / (2 * ppu);
    this.strokeList.forEach((stroke, i) => {
      direction.copy(stroke.b).sub(stroke.a);
      const length = direction.length();
      turn.setFromUnitVectors(up, direction.normalize());
      matrix.compose(at.copy(stroke.a).add(stroke.b).multiplyScalar(0.5), turn, size.set(radius, length, radius));
      this.strokes.setMatrixAt(i, matrix);
      this.strokes.setColorAt(i, stroke.color);
    });
    this.strokes.count = this.strokeList.length;
    this.finish(this.strokes);
    this.arrowList.forEach((arrow, i) => {
      turn.setFromUnitVectors(up, direction.copy(arrow.direction).normalize());
      const length = THREE.MathUtils.clamp(arrow.px / ppu, 0.12, 6);
      // The tip sits on the end point; the cone's centre is half a length behind it.
      matrix.compose(at.copy(arrow.tip).addScaledVector(direction, -length / 2), turn, size.set(length * 0.75, length, length * 0.75));
      this.arrows.setMatrixAt(i, matrix);
      this.arrows.setColorAt(i, arrow.color);
    });
    this.arrows.count = this.arrowList.length;
    this.finish(this.arrows);
  }
  /**
   * Keyboard driving: arrows or W A S D move over the ground, Q and E (or Shift with the side
   * arrows) turn, Shift with up and down tilts, + and - (or Page Up/Down) zoom. Movement
   * eases in and out and scales with the distance to the ground target. Returns whether the
   * key drives the city.
   */
  keyDown(code: string, shift: boolean): boolean {
    const axis = driveKey(code, shift);
    if (!axis) return false;
    this.flight?.cancel();
    this.held.set(code, axis);
    if (!this.driveFrame) {
      this.lastDrive = 0;
      this.driveFrame = requestAnimationFrame(this.steer);
    }
    return true;
  }
  keyUp(code: string) {
    this.held.delete(code);
  }
  releaseKeys() {
    this.held.clear();
  }
  private readonly steer = (now: number) => {
    this.driveFrame = 0;
    if (this.disposed) return;
    const dt = this.lastDrive ? Math.min(0.05, (now - this.lastDrive) / 1000) : 1 / 60;
    this.lastDrive = now;
    const wanted: Record<DriveAxis, number> = { forward: 0, strafe: 0, turn: 0, tilt: 0, zoom: 0 };
    for (const [axis, sign] of this.held.values()) wanted[axis] = THREE.MathUtils.clamp(wanted[axis] + sign, -1, 1);
    // Eased start and stop; reduced motion responds directly, without glide.
    const ease = this.reducedMotion ? 1 : 1 - Math.exp(-dt * 9);
    let active = false;
    for (const axis of Object.keys(wanted) as DriveAxis[]) {
      this.driven[axis] += (wanted[axis] - this.driven[axis]) * ease;
      if (Math.abs(this.driven[axis]) < 0.003) this.driven[axis] = 0;
      else active = true;
    }
    if (!active) return;
    const d = this.driven,
      target = this.controls.target,
      offset = this.camera.position.clone().sub(target);
    const distance = offset.length();
    const forward = new THREE.Vector3(-offset.x, 0, -offset.z);
    if (forward.lengthSq() < 1e-8) forward.set(0, 0, -1);
    forward.normalize();
    const right = new THREE.Vector3(-forward.z, 0, forward.x);
    // Faster when high above the city, never so fast that a tap skips a district.
    const step = THREE.MathUtils.clamp(distance, 1.5, 40) * 0.7 * dt;
    const move = forward.multiplyScalar(d.forward * step).addScaledVector(right, d.strafe * step);
    target.add(move);
    if (d.turn) offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), d.turn * 1.5 * dt);
    if (d.tilt) {
      const spherical = new THREE.Spherical().setFromVector3(offset);
      spherical.phi = THREE.MathUtils.clamp(spherical.phi - d.tilt * 0.9 * dt, this.controls.minPolarAngle, this.controls.maxPolarAngle);
      offset.setFromSpherical(spherical);
    }
    if (d.zoom) offset.setLength(THREE.MathUtils.clamp(distance * Math.exp(-d.zoom * 1.5 * dt), this.controls.minDistance, this.controls.maxDistance));
    this.camera.position.copy(target).add(offset);
    this.controls.update();
    this.invalidate();
    this.driveFrame = requestAnimationFrame(this.steer);
  };
  /**
   * The establishing shot: the whole island. Cinematic views look in at a three-quarter
   * angle under the sky; the isometric view fits the projected island bounds.
   */
  reset(animate = false) {
    const maxHeight = this.city.buildings.reduce((max, b) => Math.max(max, b.height + 1.6), 1);
    const r = this.city.root;
    // A low three-quarter view: the island fills the lower frame, the horizon and sky the top.
    const radius = Math.hypot(r.width / 200 + 7, r.depth / 200 + 7, maxHeight / 2);
    const polar = 1.25,
      azimuth = Math.PI / 4;
    const direction = new THREE.Vector3(Math.sin(polar) * Math.sin(azimuth), Math.cos(polar), Math.sin(polar) * Math.cos(azimuth));
    const ground = new THREE.Vector3(direction.x, 0, direction.z).normalize();
    const target = this.origin.clone().setY(Math.min(maxHeight * 0.2, 2)).addScaledVector(ground, -radius * 0.28);
    // A bounding sphere fits loosely; trimming it frames the island without wasted margin.
    const distance = Math.min(this.controls.maxDistance, this.fitDistance(radius) * 0.7);
    this.setView(target.clone().addScaledVector(direction, distance), target, animate);
  }
  zoom(factor: number) {
    this.flight?.cancel();
    // Dolly towards the target; perspective zoom keeps depth natural.
    const offset = this.camera.position.clone().sub(this.controls.target);
    const distance = THREE.MathUtils.clamp(offset.length() / factor, this.controls.minDistance, this.controls.maxDistance);
    this.camera.position.copy(this.controls.target).addScaledVector(offset.normalize(), distance);
    this.controls.update();
    this.invalidate();
  }
  north() {
    const distance = this.camera.position.distanceTo(this.controls.target);
    this.setView(this.controls.target.clone().add(new THREE.Vector3(0, distance * 0.9, distance * 0.4)), this.controls.target.clone(), true);
  }
  fit(bounds?: THREE.Box3, animate = false) {
    if (!bounds) {
      this.reset(animate);
      return;
    }
    const size = bounds.getSize(new THREE.Vector3()),
      target = bounds.getCenter(new THREE.Vector3());
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    // Architectural framing: keep the bearing, settle at a low but readable elevation.
    const spherical = new THREE.Spherical().setFromVector3(direction);
    spherical.phi = THREE.MathUtils.clamp(spherical.phi, 0.75, 1.12);
    spherical.radius = 1;
    const distance = THREE.MathUtils.clamp(
      this.fitDistance(Math.max(2.5, size.length() / 2)) * 1.25,
      this.controls.minDistance,
      this.controls.maxDistance,
    );
    this.setView(target.clone().add(new THREE.Vector3().setFromSpherical(spherical).multiplyScalar(distance)), target, animate);
  }
  /** Distance at which a sphere of `radius` fills the narrower field of view. */
  private fitDistance(radius: number) {
    const vertical = THREE.MathUtils.degToRad(this.camera.fov);
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * (this.width / this.height));
    return radius / Math.sin(Math.min(vertical, horizontal) / 2);
  }
  /**
   * Move the camera, gliding along an eased path unless the viewer asked for reduced motion
   * (plan §11.7). Any pointer interaction cancels a flight where it is.
   */
  private setView(position: THREE.Vector3, target: THREE.Vector3, animate: boolean) {
    this.flight?.cancel();
    const apply = (t: number, from: { position: THREE.Vector3; target: THREE.Vector3 }) => {
      this.camera.position.lerpVectors(from.position, position, t);
      this.controls.target.lerpVectors(from.target, target, t);
      this.controls.update();
      this.camera.updateMatrixWorld();
      this.invalidate();
    };
    const from = { position: this.camera.position.clone(), target: this.controls.target.clone() };
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
      paint: this.paint?.key ?? null,
      theme: this.theme,
      animated: this.animated,
      lite: this.lite,
      cameraMoving: this.flight !== null || this.settling,
      occlusion: this.baker ? (this.baker.ready ? 'ready' : 'baking') : 'off',
      pixelRatio: this.ratio,
      overlay: { strokes: this.strokes.count, arrows: this.arrows.count, endpoints: this.endpointRings.count },
      gpuMsPerMegapixel: this.gpuPerPixel * 1e6,
      views: { count: this.views.length, index: this.viewIndex },
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
    this.controls.update();
    this.invalidate();
  }
  cameraState() {
    return { position: this.camera.position.toArray(), target: this.controls.target.toArray(), zoom: this.camera.zoom };
  }
  measureFrames(count: number): Promise<number[]> {
    this.cancelMeasure?.();
    this.flight?.cancel();
    // Ambient frames pause while measuring, so each sample is exactly one render.
    this.measuring = true;
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
        this.measuring = false;
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
        // update() emits 'change', which queues an ordinary frame; this sample is that frame,
        // so cancel the queued one (it used to render a second time per sample, ADR-042).
        if (this.frame) {
          cancelAnimationFrame(this.frame);
          this.frame = 0;
        }
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
    cancelAnimationFrame(this.ambientFrame);
    if (this.settleTimer) clearTimeout(this.settleTimer);
    if (this.timer?.query) this.timer.gl.deleteQuery(this.timer.query);
    this.visibility?.disconnect();
    this.baker?.dispose();
    this.field?.atlasAO.value.dispose();
    this.abort.abort();
    this.resizeObserver.disconnect();
    this.controls.removeEventListener('change', this.invalidate);
    this.controls.removeEventListener('change', this.noteInput);
    this.controls.dispose();
    cancelAnimationFrame(this.driveFrame);
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
