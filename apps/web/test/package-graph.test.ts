import { describe, expect, it } from 'vitest';
import type { PackageRollup } from '@atlas/graph';
import { buildPackageGraph, packageMeta, type PackageInput } from '../src/app/package-graph';

const pkg = (id: string): PackageInput => ({ id, label: id, path: `packages/${id}`, files: 3 });
const roll = (s: string, t: string, pairs = 1): PackageRollup => ({ sourcePackageId: s, targetPackageId: t, uniqueFilePairs: pairs, observations: pairs * 2, kinds: ['imports-value'] });

describe('package dependency view (ADR-054)', () => {
  it('sizes each node for the longer of its name and its counts line (ADR-059)', () => {
    // A short name with many files: the counts line, not the name, sets the width.
    const g = buildPackageGraph([{ id: 'ui', label: 'ui', path: 'packages/ui', files: 1234 }], [roll('ui', 'ui', 5678)], (l) => l.length * 7, (m) => m.length * 6.2);
    expect(packageMeta(1234, 5678)).toBe('1234 files, 5678 internal');
    expect(g.nodes[0]!.width).toBe(Math.ceil('1234 files, 5678 internal'.length * 6.2) + 28);
    expect(packageMeta(3, 0)).toBe('3 files');
  });
  it('layers dependencies below dependents and flags the edges that close a cycle', () => {
    const g = buildPackageGraph(['app', 'ui', 'core', 'utils', 'docs'].map(pkg), [
      roll('app', 'ui', 4),
      roll('app', 'core', 2),
      roll('ui', 'core', 3),
      roll('core', 'utils'),
      roll('utils', 'core'),
      roll('app', 'app', 7),
    ]);
    const n = new Map(g.nodes.map((x) => [x.id, x]));
    expect(n.get('core')!.layer).toBe(n.get('utils')!.layer);
    expect(n.get('ui')!.layer).toBeGreaterThan(n.get('core')!.layer);
    expect(n.get('app')!.layer).toBeGreaterThan(n.get('ui')!.layer);
    expect(n.get('docs')!.layer).toBe(0);
    expect(n.get('app')!.internalPairs).toBe(7);
    expect(g.cycles).toEqual([['core', 'utils']]);
    expect(g.edges.filter((e) => e.cyclic).map((e) => `${e.source}>${e.target}`).sort()).toEqual(['core>utils', 'utils>core']);
    expect(g.edges.some((e) => e.source === e.target)).toBe(false);
    expect(g.edges[0]).toMatchObject({ source: 'app', target: 'ui', pairs: 4 });
    // Higher layers are drawn higher up.
    expect(n.get('app')!.y).toBeLessThan(n.get('ui')!.y);
  });

  it('keeps every invariant on random graphs, and does not depend on input order', () => {
    let seed = 7;
    const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    for (let round = 0; round < 150; round++) {
      const count = 1 + Math.floor(next() * 40);
      const ids = Array.from({ length: count }, (_, i) => `p${i}`);
      const rollups: PackageRollup[] = [];
      for (const s of ids) for (const t of ids) if (next() < 2.5 / count) rollups.push(roll(s, t, 1 + Math.floor(next() * 9)));
      const g = buildPackageGraph(ids.map(pkg), rollups);
      const n = new Map(g.nodes.map((x) => [x.id, x]));
      expect(g.nodes).toHaveLength(count);
      for (const e of g.edges) {
        if (e.cyclic) expect(n.get(e.source)!.component).toBe(n.get(e.target)!.component);
        else {
          expect(n.get(e.source)!.layer).toBeGreaterThan(n.get(e.target)!.layer);
          // A dependency is always drawn below its dependent.
          expect(n.get(e.source)!.y).toBeLessThan(n.get(e.target)!.y);
        }
      }
      for (const a of g.nodes)
        for (const b of g.nodes) {
          if (a === b || a.y !== b.y) continue;
          expect(a.x + a.width <= b.x || b.x + b.width <= a.x).toBe(true);
        }
      for (const a of g.nodes) {
        expect(a.y + 36).toBeLessThanOrEqual(g.height);
        expect(g.nodes.filter((b) => b.y === a.y).length).toBeLessThanOrEqual(6);
        expect(a.x).toBeGreaterThanOrEqual(0);
        expect(a.x + a.width).toBeLessThanOrEqual(g.width);
      }
      const shuffled = buildPackageGraph([...ids].reverse().map(pkg), [...rollups].reverse());
      expect(shuffled).toEqual(g);
    }
  });
});
