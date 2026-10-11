import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { computeLayout, type CityBuilding, type CityData, type LayoutTreeNode } from '@atlas/layout';
import { lineageId, localRepositoryId } from '@atlas/schema';
import { ARCHETYPES, archetypeGeometry, buildingStyle, cityDecor, topExtent } from '../src/city/architecture';

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

describe('decorative city architecture', () => {
  it('derives style only from layout seeds, never from height, metrics or lens data', () => {
    const base = buildingStyle(building());
    expect(buildingStyle(building({ height: 14, attention: 90, packageColor: '#cf91a0' }))).toEqual(base);
    expect(buildingStyle(building())).toEqual(base);
    const styles = geometry.plots.map((p) => buildingStyle(building({ seed: p.seed, districtId: p.districtId })));
    // Seeded variety: more than one archetype and window pattern across a small city.
    expect(new Set(styles.map((s) => s.archetype)).size).toBeGreaterThan(2);
    expect(new Set(styles.map((s) => s.windows)).size).toBeGreaterThan(1);
    for (const s of styles) {
      expect(s.footprint).toBeGreaterThan(0.9);
      expect(s.footprint).toBeLessThanOrEqual(1);
      expect(s.variant).toBeGreaterThanOrEqual(0);
      expect(s.variant).toBeLessThan(1);
    }
  });

  it('keeps fixed-height kiosk and declaration roles on simple low archetypes', () => {
    for (const p of geometry.plots)
      for (const role of ['config', 'asset', 'opaque', 'declaration'] as const)
        expect([0, 1, 7]).toContain(buildingStyle(building({ role, seed: p.seed, districtId: p.districtId })).archetype);
  });

  it('builds every archetype inside its 1×1 plot with a unit-height body and outward faces', () => {
    ARCHETYPES.forEach((_, k) => {
      const g = archetypeGeometry(k);
      const position = g.getAttribute('position'),
        normal = g.getAttribute('normal'),
        face = g.getAttribute('atlasFace');
      let top = 0;
      for (let i = 0; i < position.count; i++) {
        const x = position.getX(i),
          y = position.getY(i),
          z = position.getZ(i);
        expect(Math.abs(x)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(z)).toBeLessThanOrEqual(0.5);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(1);
        top = Math.max(top, y);
        const n = new THREE.Vector3(normal.getX(i), normal.getY(i), normal.getZ(i));
        if (n.y > 0.99) expect([face.getY(i), face.getW(i)]).toEqual([0, 0]);
        else {
          // Side faces point away from the body axis and carry a window grid.
          expect(n.x * x + n.z * z).toBeGreaterThan(0);
          expect(Math.abs(face.getY(i))).toBeGreaterThan(0);
          expect(face.getW(i)).toBeGreaterThan(0);
        }
      }
      expect(top).toBe(1);
      const [hx, hz] = topExtent(k);
      expect(hx).toBeGreaterThan(0.2);
      expect(hz).toBeGreaterThan(0.2);
      expect(Math.max(hx, hz)).toBeLessThanOrEqual(0.46);
      g.dispose();
    });
  });

  it('plants deterministic greenery only on free strips, never on a plot', () => {
    const decor = cityDecor(city);
    expect(cityDecor(city)).toEqual(decor);
    expect(decor.trees.length).toBeGreaterThan(20);
    expect(decor.lawns.length).toBe(city.districts.filter((d) => d.depth > 0).length);
    const clear = 0.35;
    for (const t of decor.trees)
      for (const p of geometry.plots) {
        const inside =
          t.x > p.rect.x / 100 - clear &&
          t.x < (p.rect.x + p.rect.width) / 100 + clear &&
          t.z > p.rect.z / 100 - clear &&
          t.z < (p.rect.z + p.rect.depth) / 100 + clear;
        expect(inside).toBe(false);
      }
    for (const l of decor.lawns)
      for (const p of geometry.plots) {
        const overlaps =
          Math.abs(l.x - (p.rect.x + p.rect.width / 2) / 100) < (l.width + p.rect.width / 100) / 2 &&
          Math.abs(l.z - (p.rect.z + p.rect.depth / 2) / 100) < (l.depth + p.rect.depth / 100) / 2;
        expect(overlaps).toBe(false);
      }
    // Trees in the green belt stay on land, inside the beach line.
    const r = geometry.root;
    for (const t of decor.trees) {
      expect(t.x).toBeGreaterThan(r.x / 100 - 5.5);
      expect(t.x).toBeLessThan((r.x + r.width) / 100 + 5.5);
      expect(t.z).toBeGreaterThan(r.z / 100 - 5.5);
      expect(t.z).toBeLessThan((r.z + r.depth) / 100 + 5.5);
    }
  });
});
