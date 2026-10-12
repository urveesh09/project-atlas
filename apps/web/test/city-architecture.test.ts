import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { computeLayout, type CityBuilding, type CityData, type LayoutTreeNode } from '@atlas/layout';
import { lineageId, localRepositoryId } from '@atlas/schema';
import {
  CORNER_PARTS,
  archetypeGeometry,
  bridgeGeometry,
  buildingStyle,
  cityDecor,
  cornerGeometry,
  districtFamily,
  gateGeometry,
  lampGeometry,
  lotusGeometry,
  MAX_WALLED_PACKAGES,
  partGeometry,
  pavilionRoofGeometry,
  topExtent,
  treeGeometry,
  wallAt,
} from '../src/city/architecture';
import { CITY_THEMES, THEMES } from '../src/city/themes';
import { sceneryGeometry, skyDome } from '../src/city/atmosphere';

const repoId = localRepositoryId('3f2a9c4e-8b1d-4f6a-9c2e-7d5b1a0e4c3f');
const file = (path: string) => lineageId(repoId, '0'.repeat(40), '0'.repeat(40), path);
const tree: LayoutTreeNode = {
  kind: 'repository',
  path: '',
  files: [file('package.json')],
  children: Array.from({ length: 3 }, (_, p) => ({
    kind: 'package' as const,
    path: `packages/p${p}`,
    files: [file(`packages/p${p}/index.ts`)],
    children: Array.from({ length: 3 }, (_, d) => ({
      kind: 'directory' as const,
      path: `packages/p${p}/d${d}`,
      files: Array.from({ length: 4 + d * 5 }, (_, f) => file(`packages/p${p}/d${d}/f${f}.ts`)),
      children:
        d === 0
          ? [{ kind: 'directory' as const, path: `packages/p${p}/d0/deep`, files: [file(`packages/p${p}/d0/deep/x.ts`)], children: [] }]
          : [],
    })),
  })),
};
const geometry = computeLayout({ repoId, frameKey: 'architecture', externals: [], root: tree });
const byId = new Map(geometry.districts.map((d) => [d.id, d]));
const depthOf = (id: string): number => {
  const parent = byId.get(id)!.parentId;
  return parent ? depthOf(parent) + 1 : 0;
};
const city: CityData = {
  root: geometry.root,
  plotCount: geometry.plots.length,
  buildings: [],
  districts: geometry.districts.map((d) => ({
    id: d.id,
    rect: d.rect,
    depth: depthOf(d.id),
    path: d.anchorPath,
    nodeId: null,
    kind: /^packages\/p\d$/.test(d.anchorPath) ? 'package' : depthOf(d.id) === 0 ? 'repository' : 'directory',
    label: d.anchorPath,
  })),
  terminals: [],
  allTerminals: [],
  terminalOmitted: 0,
};
const building = (overrides: Partial<CityBuilding> = {}): CityBuilding => ({
  nodeId: 'file_a',
  lineageId: geometry.plots[0]!.lineageId,
  districtId: geometry.plots[0]!.districtId,
  path: 'src/a.ts',
  role: 'source',
  parseStatus: 'parsed',
  rect: geometry.plots[0]!.rect,
  height: 3,
  seed: geometry.plots[0]!.seed,
  packageId: null,
  packageColor: '#78a9ac',
  metric: null,
  attention: null,
  ...overrides,
});
/** Every vertex of `g` (scaled) stays within `limit` of the plot centre and within [0, 1] height. */
function expectInside(g: THREE.BufferGeometry, limit: number, height = 1) {
  const position = g.getAttribute('position');
  for (let i = 0; i < position.count; i++) {
    expect(Math.abs(position.getX(i))).toBeLessThanOrEqual(limit + 1e-6);
    expect(Math.abs(position.getZ(i))).toBeLessThanOrEqual(limit + 1e-6);
    expect(position.getY(i)).toBeGreaterThanOrEqual(-1e-6);
    expect(position.getY(i)).toBeLessThanOrEqual(height + 1e-6);
  }
}

describe.each(CITY_THEMES)('decorative city architecture: %s', (theme) => {
  const spec = THEMES[theme];
  it('derives style only from layout seeds, never from height, metrics or lens data', () => {
    const family = districtFamily(geometry.plots[0]!.districtId, theme);
    const base = buildingStyle(building(), family, theme);
    expect(buildingStyle(building({ height: 14, attention: 90, packageColor: '#cf91a0' }), family, theme)).toEqual(base);
    const styles = geometry.plots.map((p) =>
      buildingStyle(building({ seed: p.seed, districtId: p.districtId }), districtFamily(p.districtId, theme), theme),
    );
    // Seeded variety: more than one archetype across a small city.
    expect(new Set(styles.map((s) => s.archetype)).size).toBeGreaterThan(1);
    for (const s of styles) {
      expect(s.archetype).toBeLessThan(spec.archetypes.length);
      expect(s.footprint).toBeGreaterThan(0.9);
      expect(s.footprint).toBeLessThanOrEqual(1);
      expect(s.variant).toBeGreaterThanOrEqual(0);
      expect(s.variant).toBeLessThan(1);
      expect(s.windows).toBeGreaterThanOrEqual(0);
      expect(s.windows).toBeLessThanOrEqual(9);
      expect(s.base).toBe(spec.archetypes[s.archetype]!.base ?? 0);
      // Slab plans only narrow a square-planned body, so it stays inside its plot.
      expect(s.aspect).toBeGreaterThan(0.7);
      expect(s.aspect).toBeLessThanOrEqual(1);
      if (spec.archetypes[s.archetype]!.tiers.some((t) => t.sides !== 4)) expect(s.aspect).toBe(1);
      expect(spec.materials).toContain(s.material);
    }
  });

  it('keeps fixed-height kiosk and declaration roles on the low archetypes', () => {
    for (const p of geometry.plots)
      for (const role of ['config', 'asset', 'opaque', 'declaration'] as const)
        expect(spec.low).toContain(
          buildingStyle(building({ role, seed: p.seed, districtId: p.districtId }), districtFamily(p.districtId, theme), theme).archetype,
        );
  });

  it('builds every body inside its 1×1 plot, with unit height and outward faces', () => {
    for (const a of spec.archetypes) {
      const g = archetypeGeometry(a);
      expectInside(g, 0.5);
      const position = g.getAttribute('position'),
        normal = g.getAttribute('normal'),
        face = g.getAttribute('atlasFace');
      let top = 0;
      for (let i = 0; i < position.count; i++) {
        const x = position.getX(i),
          z = position.getZ(i);
        top = Math.max(top, position.getY(i));
        if (normal.getY(i) > 0.99) expect([face.getY(i), face.getW(i)]).toEqual([0, 0]);
        else {
          // Side faces point away from the body axis and carry a window grid.
          expect(normal.getX(i) * x + normal.getZ(i) * z).toBeGreaterThan(0);
          expect(Math.abs(face.getY(i))).toBeGreaterThan(0);
          expect(face.getW(i)).toBeGreaterThan(0);
        }
      }
      expect(top).toBe(1);
      const [hx, hz] = topExtent(a);
      expect(Math.min(hx, hz)).toBeGreaterThan(0.2);
      expect(Math.max(hx, hz) * (a.roof ?? 1)).toBeLessThanOrEqual(0.46);
      g.dispose();
    }
  });

  it('keeps accent parts clear of neighbouring plots at every storey', () => {
    for (const a of spec.archetypes)
      for (const part of a.parts ?? []) {
        if (CORNER_PARTS.has(part.kind)) {
          // Corner furniture: inset on the top, at most a quarter-cell across, unit cell geometry.
          const top = wallAt(a, 1);
          const reach = Math.max(top.hx, top.hz) * 0.92 + 0.24 * 0.62;
          expect(reach).toBeLessThanOrEqual(0.7);
          const g = partGeometry(part.kind, 4);
          expectInside(g, 0.65, 1.25);
          expect(g.getAttribute('position').count).toBeGreaterThan(0);
          g.dispose();
          continue;
        }
        for (let fraction = 0; fraction <= 1; fraction += 0.05) {
          const wall = wallAt(a, fraction);
          const base = part.kind === 'platform' || part.kind === 'terrace';
          const reach = part.kind === 'eave' ? 1 / 0.7 : part.kind === 'terrace' ? 1.55 : part.kind === 'platform' ? 1.4 : (part.overhang ?? 1.08);
          // Plot centres are 2 cells apart: 0.7 leaves a clear gap to any neighbour.
          if (base) expect(Math.min(0.7, Math.max(wall.hx, wall.hz) * reach)).toBeLessThanOrEqual(0.7);
          else expect(Math.max(wall.hx, wall.hz) * reach).toBeLessThanOrEqual(0.7);
        }
        const sides = part.kind === 'platform' || part.kind === 'terrace' ? [4 as const] : [...new Set(a.tiers.map((t) => t.sides))];
        for (const s of sides) {
          const g = partGeometry(part.kind, s);
          // Unit outlines: corners at ±1 (4 sides) or circumradius 1; a terrace's balustrade rises a little.
          expectInside(g, 1, part.kind === 'terrace' ? 1.06 : 1);
          expect(g.getAttribute('position').count).toBeGreaterThan(0);
          g.dispose();
        }
      }
  });

  it('places deterministic decoration only on free strips, never on a plot', () => {
    const decor = cityDecor(city, theme);
    expect(cityDecor(city, theme)).toEqual(decor);
    expect(decor.trees.length).toBeGreaterThan(20);
    expect(decor.lamps.length).toBeGreaterThan(4);
    expect(decor.lawns.length).toBe(city.districts.filter((d) => d.depth > 0).length);
    const packages = city.districts.filter((d) => d.kind === 'package').length;
    const walled = Math.min(packages, MAX_WALLED_PACKAGES);
    // Four walls, the south one split around its gate.
    expect(decor.walls.length).toBe(spec.walls === 'none' ? 0 : walled * 5);
    expect(decor.corners.length).toBe(spec.walls === 'none' ? 0 : walled * 4);
    expect(decor.gates.length).toBe(spec.walls === 'none' ? 0 : walled);
    expect(decor.bridges.length).toBe(decor.ponds.length);
    if (spec.ponds === 0) expect(decor.ponds.length + decor.lotus.length).toBe(0);
    expect(decor.markings.length > 0).toBe(spec.ground.marking !== null);
    for (const t of decor.trees) expect(t.kind).toBeLessThan(spec.trees.length);
    const clear = (x: number, z: number, margin: number) => {
      for (const p of geometry.plots) {
        const inside =
          x > p.rect.x / 100 - margin &&
          x < (p.rect.x + p.rect.width) / 100 + margin &&
          z > p.rect.z / 100 - margin &&
          z < (p.rect.z + p.rect.depth) / 100 + margin;
        expect(inside).toBe(false);
      }
    };
    for (const t of decor.trees) clear(t.x, t.z, 0.35);
    for (const l of decor.lamps) clear(l.x, l.z, 0.2);
    for (const c of decor.corners) clear(c.x, c.z, 0.35);
    // Gates are 1.4 wide and 0.4 deep on the wall line; ponds, bridges and lotus stay in the header strip.
    for (const g of decor.gates) for (const dx of [-0.7, 0, 0.7]) clear(g.x + dx, g.z - 0.2, 0.15);
    for (const l of decor.lotus) clear(l.x, l.z, 0.1);
    for (const b of decor.bridges) for (const dz of [-0.8, 0, 0.8]) clear(b.x, b.z + dz, 0.15);
    for (const w of decor.ponds)
      for (const p of geometry.plots) {
        const overlaps =
          Math.abs(w.x - (p.rect.x + p.rect.width / 2) / 100) < (w.width + p.rect.width / 100) / 2 &&
          Math.abs(w.z - (p.rect.z + p.rect.depth / 2) / 100) < (w.depth + p.rect.depth / 100) / 2;
        expect(overlaps).toBe(false);
      }
    for (const w of decor.walls) {
      // Sample along each wall segment.
      const dx = Math.cos(w.rotation),
        dz = -Math.sin(w.rotation);
      for (let t = -w.length / 2; t <= w.length / 2; t += 0.25) clear(w.x + dx * t, w.z + dz * t, 0.2);
    }
    for (const l of decor.lawns)
      for (const p of geometry.plots) {
        const overlaps =
          Math.abs(l.x - (p.rect.x + p.rect.width / 2) / 100) < (l.width + p.rect.width / 100) / 2 &&
          Math.abs(l.z - (p.rect.z + p.rect.depth / 2) / 100) < (l.depth + p.rect.depth / 100) / 2;
        expect(overlaps).toBe(false);
      }
    // Trees and lamps in the belt stay on land, inside the beach line.
    const r = geometry.root;
    for (const t of [...decor.trees, ...decor.lamps]) {
      expect(t.x).toBeGreaterThan(r.x / 100 - 5.5);
      expect(t.x).toBeLessThan((r.x + r.width) / 100 + 5.5);
      expect(t.z).toBeGreaterThan(r.z / 100 - 5.5);
      expect(t.z).toBeLessThan((r.z + r.depth) / 100 + 5.5);
    }
  });

  it('builds its trees, lamps and wall towers as coloured meshes', () => {
    const meshes = [
      ...spec.trees.map((t) => treeGeometry(t.kind)),
      lampGeometry(spec.lamp),
      ...(spec.walls === 'none' ? [] : [cornerGeometry(spec.walls), gateGeometry(spec.walls)]),
      bridgeGeometry(),
      lotusGeometry(),
    ];
    for (const g of meshes) {
      expect(g.getAttribute('position').count).toBeGreaterThan(0);
      expect(g.getAttribute('color').count).toBe(g.getAttribute('position').count);
      g.computeBoundingBox();
      // Small street furniture: below the 0.8 minimum building height plus its roof.
      expect(g.boundingBox!.max.y).toBeLessThan(1.1);
      g.dispose();
    }
  });

  it('places cinematic scenery deterministically, beyond the island and its water ring', () => {
    const extent = Math.max(geometry.root.width, geometry.root.depth) / 100 + 18;
    const a = sceneryGeometry(spec, city, extent),
      b = sceneryGeometry(spec, city, extent);
    expect(Array.from(a.geometry.getAttribute('position').array)).toEqual(Array.from(b.geometry.getAttribute('position').array));
    expect(a.mist).toEqual(b.mist);
    expect(a.mist.length > 0).toBe(spec.scenery === 'karst');
    const r = geometry.root,
      cx = (r.x + r.width / 2) / 100,
      cz = (r.z + r.depth / 2) / 100;
    // The island, its belt, beach and the 12-cell water ring all lie inside this radius.
    const shore = Math.hypot(r.width / 200 + 12, r.depth / 200 + 12);
    const position = a.geometry.getAttribute('position');
    let nearest = Infinity;
    for (let i = 0; i < position.count; i++) nearest = Math.min(nearest, Math.hypot(position.getX(i) - cx, position.getZ(i) - cz));
    expect(nearest).toBeGreaterThan(shore);
    // The camera is held inside the scenery ring, so scenery never stands in front of the city.
    expect(a.innerRadius).toBeLessThan(nearest);
    expect(a.innerRadius).toBeGreaterThan(shore);
    expect(a.geometry.getAttribute('color').count).toBe(position.count);
    a.geometry.dispose();
    b.geometry.dispose();
    const sky = skyDome(spec.sky, new THREE.Vector3(-30, 80, 50));
    expect((sky.material as THREE.ShaderMaterial).fog).toBe(false);
    expect((sky.material as THREE.ShaderMaterial).depthTest).toBe(false);
  });
});

describe('town walls', () => {
  it('wall only the largest packages, deterministically', () => {
    const many: CityData = {
      ...city,
      districts: [
        city.districts.find((d) => d.depth === 0)!,
        ...Array.from({ length: 60 }, (_, i) => ({
          id: `dst_${i.toString(16).padStart(64, '0')}`,
          rect: { x: (i % 10) * 2000, z: Math.floor(i / 10) * 2000, width: 600 + i * 100, depth: 800 },
          depth: 1,
          path: `packages/p${i}`,
          nodeId: null,
          kind: 'package',
          label: `p${i}`,
        })),
      ],
    };
    const decor = cityDecor(many, 'western');
    expect(decor.walls.length).toBe(MAX_WALLED_PACKAGES * 5);
    expect(decor.gates.length).toBe(MAX_WALLED_PACKAGES);
    // The largest 48 (indices 12…59) are walled; the smallest are not.
    const xs = new Set(decor.corners.map((c) => Math.round((c.x - 0.3) * 100)));
    expect(xs.has(59 % 10 * 2000)).toBe(true);
    expect(decor).toEqual(cityDecor(many, 'western'));
  });
});

describe('pavilion roof', () => {
  it('keeps the source role a pointed four-sided roof with the pyramid footprint and height', () => {
    const g = pavilionRoofGeometry();
    g.computeBoundingBox();
    const b = g.boundingBox!;
    // The plain pyramid spans y -0.22…0.22 and, turned by the renderer's π/4, half 0.48.
    expect(b.min.y).toBeGreaterThan(-0.23);
    expect(b.max.y).toBeLessThan(0.27);
    const turned = g.clone().applyMatrix4(new THREE.Matrix4().makeRotationY(Math.PI / 4));
    turned.computeBoundingBox();
    expect(turned.boundingBox!.max.x).toBeLessThanOrEqual(0.51);
    expect(turned.boundingBox!.max.x).toBeGreaterThan(0.45);
    g.dispose();
    turned.dispose();
  });
});
