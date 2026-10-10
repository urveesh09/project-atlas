import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { facadeColor, lensValue, type CityBuilding, type CityData, type CityLens } from '@atlas/layout';
import type { Rect } from '@atlas/schema';
import { EDGE_COLORS, edgeClass, type OverlayResult } from './overlay';

const center = (r: Rect) => new THREE.Vector3((r.x + r.width / 2) / 100, 0, (r.z + r.depth / 2) / 100);
const color = new THREE.Color();
const matrix = new THREE.Matrix4();
const white = new THREE.Color('#e9e4d7');

const ROLES = ['source', 'test', 'declaration', 'config', 'asset', 'opaque'] as const;

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
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100_000);
  readonly scene = new THREE.Scene();
  readonly controls: OrbitControls;
  readonly labels = document.createElement('canvas');
  private readonly geometry = new Set<THREE.BufferGeometry>();
  private readonly materials = new Set<THREE.Material>();
  private readonly instances = new Set<THREE.InstancedMesh>();
  private readonly roofs = new Map<(typeof ROLES)[number], THREE.InstancedMesh>();
  private readonly bodies: THREE.InstancedMesh;
  private readonly windows: THREE.InstancedMesh;
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
  ) {
    this.city = initial;
    const city = initial;
    const capacity = Math.max(1, city.plotCount, city.buildings.length);
    this.renderer = new THREE.WebGLRenderer({ antialias: !lowQuality, alpha: false, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, lowQuality ? 1 : 1.5));
    this.renderer.setClearColor('#e9e4d7');
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.setAttribute('aria-hidden', 'true');
    this.renderer.domElement.className = 'city-canvas';
    this.labels.className = 'city-labels';
    this.labels.setAttribute('aria-hidden', 'true');
    host.append(this.renderer.domElement, this.labels);
    this.extent = Math.max(city.root.width, city.root.depth) / 100 + 18;
    this.origin = center(city.root);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.minPolarAngle = 0.15;
    this.controls.maxPolarAngle = Math.PI / 2.6;
    this.controls.minZoom = 0.2;
    this.controls.maxZoom = 100;
    this.controls.maxTargetRadius = this.extent;
    this.controls.cursor.copy(this.origin);
    this.controls.addEventListener('change', this.invalidate);
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#a0a39b', 2.1));
    const light = new THREE.DirectionalLight('#fff6e2', 2.2);
    light.position.set(-30, 80, 50);
    this.scene.add(light);
    const box = this.ownGeometry(new THREE.BoxGeometry(1, 1, 1));
    const matte = this.ownMaterial(new THREE.MeshLambertMaterial());
    const shore = new THREE.Mesh(box, this.ownMaterial(new THREE.MeshLambertMaterial({ color: '#789c9f' })));
    shore.scale.set(city.root.width / 100 + 14, 0.7, city.root.depth / 100 + 14);
    shore.position.copy(this.origin).setY(-0.5);
    this.scene.add(shore);
    const base = new THREE.Mesh(box, this.ownMaterial(new THREE.MeshLambertMaterial({ color: '#bac1ac' })));
    base.scale.set(city.root.width / 100 + 6, 0.3, city.root.depth / 100 + 6);
    base.position.copy(this.origin).setY(-0.02);
    this.scene.add(base);
    const districtMesh = this.batch(box, matte, city.districts.length);
    city.districts.forEach((d, i) => {
      matrix
        .makeScale(d.rect.width / 100, 0.04, d.rect.depth / 100)
        .setPosition(center(d.rect).setY(0.16 + Math.min(d.depth, 20) * 0.015));
      districtMesh.setMatrixAt(i, matrix);
      districtMesh.setColorAt(i, color.set(d.kind === 'package' ? '#d1d0bc' : d.depth % 2 ? '#e4dec9' : '#d8d5c2'));
    });
    this.finish(districtMesh);
    this.bodies = this.batch(box, matte, capacity);
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
        this.ownMaterial(new THREE.MeshLambertMaterial({ color: role === 'test' ? '#456471' : '#626d75' })),
        capacity,
      );
      roof.count = 0;
      this.roofs.set(role, roof);
    }
    const glass = this.ownMaterial(new THREE.MeshBasicMaterial({ color: '#f1deaa' }));
    this.windows = this.batch(box, glass, capacity * 2);
    this.missing = this.batch(box, this.ownMaterial(new THREE.MeshBasicMaterial({ color: '#242d38' })), capacity * 2);
    const wire = this.ownMaterial(new THREE.MeshBasicMaterial({ color: '#174664', wireframe: true, depthTest: false }));
    this.selection = this.batch(box, wire, capacity);
    this.selection.count = 0;
    // Compare marks: deleted plots as outlined ghosts, added files with a raised marker.
    this.ghosts = this.batch(box, this.ownMaterial(new THREE.MeshBasicMaterial({ color: '#7a4f2a', wireframe: true })), capacity);
    this.ghosts.count = 0;
    this.addedMarkers = this.batch(
      this.ownGeometry(new THREE.OctahedronGeometry(0.32)),
      this.ownMaterial(new THREE.MeshBasicMaterial({ color: '#1f6b45', depthTest: false })),
      capacity,
    );
    this.addedMarkers.count = 0;
    this.marker = new THREE.Mesh(
      this.ownGeometry(new THREE.ConeGeometry(0.25, 0.6, 4)),
      this.ownMaterial(new THREE.MeshBasicMaterial({ color: '#174664', depthTest: false })),
    );
    this.marker.rotation.z = Math.PI;
    this.marker.visible = false;
    this.scene.add(this.marker, this.overlayGroup);
    // Terminal anchors are fixed; which packages a frame imports decides which are shown.
    this.terminals = this.batch(box, this.ownMaterial(new THREE.MeshLambertMaterial({ color: '#687e85' })), 51);
    this.packageLines = this.batch(
      this.ownGeometry(new THREE.CylinderGeometry(1, 1, 1, 6)),
      this.ownMaterial(new THREE.MeshBasicMaterial({ color: EDGE_COLORS.package, depthTest: false })),
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
        if (index !== undefined) this.fit(this.boxes[index]);
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

  /** Per-frame instance data: bodies, roofs, windows, terminals and the pick index. */
  private layoutBuildings() {
    const { buildings } = this.city;
    this.buildingIndex = new Map(buildings.map((b, i) => [b.nodeId, i]));
    this.pickCells.clear();
    this.boxes = buildings.map((b, i) => {
      const p = center(b.rect);
      const h = b.height;
      matrix.makeScale(0.88, h, 0.88).setPosition(p.x, 0.35 + h / 2, p.z);
      this.bodies.setMatrixAt(i, matrix);
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
    this.bodies.count = buildings.length;
    this.finish(this.bodies);
    const roofCounts = new Map<string, number>();
    for (const b of buildings) {
      const roof = this.roofs.get(b.role)!;
      const n = roofCounts.get(b.role) ?? 0;
      const p = center(b.rect);
      matrix.makeRotationY(b.role === 'source' ? Math.PI / 4 : ((b.seed % 4) * Math.PI) / 2).setPosition(p.x, b.height + 0.45, p.z);
      roof.setMatrixAt(n, matrix);
      roofCounts.set(b.role, n + 1);
    }
    for (const [role, roof] of this.roofs) {
      roof.count = roofCounts.get(role) ?? 0;
      this.finish(roof);
    }
    buildings.forEach((b, i) => {
      const p = center(b.rect);
      for (let w = 0; w < 2; w++) {
        matrix.makeScale(0.15, Math.min(0.35, b.height * 0.3), 0.012).setPosition(p.x + (w ? 0.2 : -0.2), 0.45 + b.height * 0.58, p.z + 0.445);
        this.windows.setMatrixAt(i * 2 + w, matrix);
      }
    });
    this.windows.count = buildings.length * 2;
    this.finish(this.windows);
    this.city.terminals.forEach((t, i) => {
      matrix.makeScale(1.3, 0.8, 1.3).setPosition(t.x / 100, 0.45, t.z / 100);
      this.terminals.setMatrixAt(i, matrix);
    });
    this.terminals.count = this.city.terminals.length;
    this.finish(this.terminals);
  }

  private ownGeometry<T extends THREE.BufferGeometry>(g: T): T {
    this.geometry.add(g);
    return g;
  }
  private ownMaterial<T extends THREE.Material>(m: T): T {
    this.materials.add(m);
    return m;
  }
  private batch(g: THREE.BufferGeometry, m: THREE.Material, count: number) {
    const mesh = new THREE.InstancedMesh(g, m, Math.max(1, count));
    mesh.count = count;
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
    this.camera.left = -this.width / 2;
    this.camera.right = this.width / 2;
    this.camera.top = this.height / 2;
    this.camera.bottom = -this.height / 2;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  };
  readonly invalidate = () => {
    if (this.disposed || this.frame || document.hidden) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (!this.disposed) this.render();
    });
  };
  private render() {
    if (this.packageZoom !== this.camera.zoom) {
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
        const radius = segment.width / (2 * this.camera.zoom);
        scale.set(radius, length, radius);
        matrix.compose(midpoint, rotation, scale);
        this.packageLines.setMatrixAt(i, matrix);
      });
      this.packageLines.count = this.packageSegments.length;
      this.finish(this.packageLines);
      this.packageZoom = this.camera.zoom;
    }
    const near = this.camera.zoom >= 6;
    for (const roof of this.roofs.values()) roof.visible = near;
    this.windows.visible = near && !this.lowQuality && this.camera.zoom >= 12;
    this.renderer.render(this.scene, this.camera);
    this.drawLabels(this.labels, this.camera, this.width, this.height);
  }
  private drawLabels(canvas: HTMLCanvasElement, camera: THREE.Camera, width: number, height: number) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    ctx.font = '600 12px system-ui';
    ctx.textAlign = 'center';
    const label = (text: string, p: THREE.Vector3) => {
      const v = p.project(camera);
      if (v.z < -1 || v.z > 1) return;
      const x = ((v.x + 1) / 2) * width,
        y = ((1 - v.y) / 2) * height;
      if (x < 0 || x > width || y < 0 || y > height) return;
      const safe = text.length > 42 ? `${text.slice(0, 39)}…` : text;
      const w = ctx.measureText(safe).width + 14;
      ctx.fillStyle = '#f9f7f0';
      ctx.fillRect(x - w / 2, y - 12, w, 20);
      ctx.fillStyle = '#263344';
      ctx.fillText(safe, x, y + 2);
    };
    for (const d of this.city.districts.filter((d) => d.kind === 'package').slice(0, 20))
      label(d.label, new THREE.Vector3((d.rect.x + d.rect.width / 2) / 100, 0.35, (d.rect.z + 70) / 100));
    const b = this.city.buildings.find(
      (b) =>
        b.nodeId === this.hoverId || (this.hoverId === null && this.selected.size === 1 && this.selected.has(b.nodeId)),
    );
    if (b) label(b.path, center(b.rect).setY(b.height + 1.6));
  }
  applyStyle(lens: CityLens, selected: ReadonlySet<string>, filter: (b: CityBuilding) => boolean) {
    const recolor = this.lens !== lens || this.filter !== filter || this.styled !== this.city || !this.bodies.instanceColor;
    this.styled = this.city;
    this.lens = lens;
    this.selected = new Set(selected);
    this.filter = filter;
    let count = 0,
      unknown = 0;
    if (recolor)
      this.city.buildings.forEach((b, i) => {
        color.set(facadeColor(b, lens));
        if (!filter(b)) color.lerp(white, 0.8);
        this.bodies.setColorAt(i, color);
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
    if (recolor) this.bodies.instanceColor!.needsUpdate = true;
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
    terminals.forEach((t, i) => {
      matrix.makeScale(1.3, 0.8, 1.3).setPosition(t.x / 100, 0.45, t.z / 100);
      this.terminals.setMatrixAt(i, matrix);
    });
    this.terminals.count = terminals.length;
    this.finish(this.terminals);
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
  reset() {
    const maxHeight = this.city.buildings.reduce((max, b) => Math.max(max, b.height + 1.6), 1);
    const target = this.origin.clone().setY(maxHeight / 2);
    this.controls.target.copy(target);
    this.camera.position.copy(target).add(new THREE.Vector3(this.extent, this.extent * 1.15, this.extent));
    this.camera.zoom = 1;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.camera.updateMatrixWorld();
    // Fit projected island bounds, rather than a square estimate that wastes the viewport on long repositories.
    const r = this.city.root,
      bounds = new THREE.Box3(
        new THREE.Vector3(r.x / 100 - 7, 0, r.z / 100 - 7),
        new THREE.Vector3((r.x + r.width) / 100 + 7, maxHeight, (r.z + r.depth) / 100 + 7),
      );
    const projected = bounds.clone().applyMatrix4(this.camera.matrixWorldInverse).getSize(new THREE.Vector3());
    this.baseZoom = THREE.MathUtils.clamp(
      Math.min(this.width / (projected.x * 1.15), this.height / (projected.y * 1.15)),
      this.controls.minZoom,
      this.controls.maxZoom,
    );
    this.camera.zoom = this.baseZoom;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }
  zoom(factor: number) {
    this.camera.zoom = THREE.MathUtils.clamp(this.camera.zoom * factor, this.controls.minZoom, this.controls.maxZoom);
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }
  north() {
    const distance = this.camera.position.distanceTo(this.controls.target);
    this.camera.position.copy(this.controls.target).add(new THREE.Vector3(0, distance * 0.9, distance * 0.4));
    this.controls.update();
    this.invalidate();
  }
  fit(bounds?: THREE.Box3) {
    if (!bounds) {
      this.reset();
      return;
    }
    const size = bounds.getSize(new THREE.Vector3()),
      target = bounds.getCenter(new THREE.Vector3());
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.copy(target);
    this.camera.position.copy(target).addScaledVector(direction, this.extent * 2);
    this.camera.zoom = Math.min(
      60,
      Math.min(this.width, this.height) / Math.max(8, Math.max(size.x, size.y, size.z) * 2),
    );
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.invalidate();
  }
  focus(ids: ReadonlySet<string>) {
    const box = new THREE.Box3();
    this.city.buildings.forEach((b, i) => {
      if (ids.has(b.nodeId)) box.union(this.boxes[i]!);
    });
    this.fit(box.isEmpty() ? undefined : box);
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
      drawCalls: this.renderer.info.render.calls,
      geometries: this.renderer.info.memory.geometries,
      textures: this.renderer.info.memory.textures,
      buildings: this.city.buildings.length,
      pickCells: this.pickCells.size,
      ghosts: this.ghosts.count,
      added: this.addedMarkers.count,
      lens: this.lens,
      zoom: this.camera.zoom,
      renderer: ext ? String(ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown',
      heapBytes: (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null,
    };
  }
  cameraState() {
    return { position: this.camera.position.toArray(), target: this.controls.target.toArray(), zoom: this.camera.zoom };
  }
  measureFrames(count: number): Promise<number[]> {
    this.cancelMeasure?.();
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
    cancelAnimationFrame(this.frame);
    this.abort.abort();
    this.resizeObserver.disconnect();
    this.controls.removeEventListener('change', this.invalidate);
    this.controls.dispose();
    for (const g of this.arcGeometries) g.dispose();
    for (const mesh of this.instances) mesh.dispose();
    for (const g of this.geometry) g.dispose();
    for (const m of this.materials) m.dispose();
    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.labels.remove();
  }
}
