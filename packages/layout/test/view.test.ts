import { describe, expect, it } from 'vitest';
import { buildHandcraftedArtifact } from '@atlas/test-fixtures';
import {
  prepareCity,
  facadeColor,
  lensValue,
  districtGate,
  routeDependency,
  UNKNOWN_COLOR,
  METRIC_PALETTE,
} from '@atlas/layout';

describe('canonical city projection and visual grammar', () => {
  it('retains the independently authored coordinates, IDs, heights and package membership', () => {
    const { graph, layout } = buildHandcraftedArtifact(),
      city = prepareCity(graph, layout);
    expect(city.buildings).toHaveLength(5);
    for (const b of city.buildings) {
      expect(b.rect).toEqual(layout.plots.find((p) => p.lineageId === b.lineageId)!.rect);
      expect(b.height).toBe(layout.frameState[0]!.files.find((f) => f.nodeId === b.nodeId)!.height);
    }
    expect(city.buildings.find((b) => b.path === 'src/main.ts')!.packageId).toBe(
      graph.nodes.find((n) => n.kind === 'package' && n.path === '')!.id,
    );
    expect(city.terminals.map((t) => t.name)).toEqual(['builtin:fs', 'npm:lodash']);
  });
  it('treats null as unknown, zero as measured, and uses exact numeric stops', () => {
    const { graph, layout } = buildHandcraftedArtifact(),
      b = prepareCity(graph, layout).buildings.find((b) => b.path === 'src/main.ts')!;
    const missing = { ...b, metric: null };
    expect(facadeColor(missing, 'complexity')).toBe(UNKNOWN_COLOR);
    expect(lensValue(missing, 'fan-in')).toBeNull();
    const metric = graph.metrics.find((m) => m.nodeId === b.nodeId)!;
    expect(facadeColor({ ...b, metric: { ...metric, maxCyclomatic: 0 } }, 'complexity')).toBe(METRIC_PALETTE[0]);
    expect(facadeColor({ ...b, metric: { ...metric, maxCyclomatic: 20 } }, 'complexity')).toBe(METRIC_PALETTE[3]);
    expect(facadeColor({ ...b, metric: { ...metric, fanIn: 25 } }, 'fan-in')).toBe(METRIC_PALETTE[4]);
    expect(facadeColor(missing, 'structure')).toBe(b.packageColor);
  });
  it('does not mutate or reorder canonical data when lenses change', () => {
    const fixture = buildHandcraftedArtifact(),
      before = JSON.stringify(fixture),
      city = prepareCity(fixture.graph, fixture.layout);
    for (const lens of ['structure', 'complexity', 'fan-in'] as const)
      for (const b of city.buildings) facadeColor(b, lens);
    expect(JSON.stringify(fixture)).toBe(before);
    expect(prepareCity(fixture.graph, fixture.layout)).toEqual(city);
  });
  it('keeps package colors when a new snapshot changes occurrence IDs on the same layout', () => {
    const fixture = buildHandcraftedArtifact();
    const before = prepareCity(fixture.graph, fixture.layout);
    const pkg = fixture.graph.nodes.find((n) => n.kind === 'package' && n.path === '')!;
    const nextId = `node_${'f'.repeat(64)}`;
    const graph = {
      ...fixture.graph,
      nodes: fixture.graph.nodes.map((n) => ({
        ...n,
        id: n.id === pkg.id ? nextId : n.id,
        parentId: n.parentId === pkg.id ? nextId : n.parentId,
      })),
    };
    const layout = {
      ...fixture.layout,
      frameState: fixture.layout.frameState.map((f) => ({
        ...f,
        containers: f.containers.map((c) => ({
          ...c,
          graphNodeId: c.graphNodeId === pkg.id ? nextId : c.graphNodeId,
        })),
      })),
    };
    const after = prepareCity(graph, layout);
    expect(after.buildings.map((b) => b.packageColor)).toEqual(before.buildings.map((b) => b.packageColor));
    expect(after.buildings.find((b) => b.path === 'src/main.ts')!.packageId).toBe(nextId);
  });
  it('refuses absent frame membership', () => {
    const f = buildHandcraftedArtifact();
    expect(() => prepareCity(f.graph, { ...f.layout, frameState: [] })).toThrow('membership');
  });
});

describe('dependency routing independent reference coordinates', () => {
  const root = { x: 0, z: 0, width: 2000, depth: 2000 },
    district = { x: 100, z: 300, width: 400, depth: 600 };
  it('chooses cardinal gates with documented ties', () => {
    expect(districtGate(district, { x: 600, z: 300 })).toEqual({ x: 300, z: 300, side: 'north' });
    expect(districtGate(district, { x: 700, z: 600 })).toEqual({ x: 500, z: 600, side: 'east' });
    expect(districtGate(district, { x: 300, z: 1200 }).side).toBe('south');
    expect(districtGate(district, { x: -300, z: 600 }).side).toBe('west');
  });
  it('routes same-district source→target with a raised control point', () => {
    const points = routeDependency(
      root,
      { x: 200, z: 400, height: 1, districtId: 'a' },
      { x: 400, z: 600, height: 2, districtId: 'a' },
      new Map([['a', district]]),
    );
    expect(points).toEqual([
      [2, 1.45, 4],
      [3, 4.45, 5],
      [4, 2.45, 6],
    ]);
  });
  it('routes cross-district edges through gates and a fixed root corridor', () => {
    const points = routeDependency(
      root,
      { x: 200, z: 400, height: 1, districtId: 'a' },
      { x: 1000, z: 1000, height: 2, districtId: 'b' },
      new Map([
        ['a', district],
        ['b', { x: 900, z: 900, width: 200, depth: 200 }],
      ]),
    );
    expect(points[0]).toEqual([2, 1.45, 4]);
    expect(points.at(-1)).toEqual([10, 2.45, 10]);
    expect(points[2]![2]).toBe(-3);
    expect(points[3]![2]).toBe(-3);
  });
  it('retains visible self-import loops instead of a zero-length line', () => {
    const point = { x: 200, z: 400, height: 1, districtId: 'a' };
    const route = routeDependency(root, point, point, new Map());
    expect(route[0]).toEqual(route.at(-1));
    expect(new Set(route.map((p) => p.join(','))).size).toBeGreaterThan(3);
  });
});
