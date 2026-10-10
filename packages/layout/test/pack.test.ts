import { describe, expect, it } from 'vitest';
import { computeLayout, buildingHeight, seedFromId, xorshift32, type LayoutInput, type LayoutTreeNode } from '@atlas/layout';
import { districtId, lineageId, localRepositoryId, validateLayoutArtifact } from '@atlas/schema';

const repoId = localRepositoryId('3f2a9c4e-8b1d-4f6a-9c2e-7d5b1a0e4c3f');
const lin = (path: string) => lineageId(repoId, '0'.repeat(40), '0'.repeat(40), path);

function validate(input: LayoutInput) {
  const geometry = computeLayout(input);
  const result = validateLayoutArtifact({ ...geometry, frameState: [] });
  expect(result.ok ? [] : result.issues).toEqual([]);
  return geometry;
}

describe('square-shelf packing (hand-computed reference)', () => {
  it('places a three-file root package exactly', () => {
    const files = ['a.ts', 'b.ts', 'c.ts'].map(lin).sort();
    const geometry = validate({
      repoId,
      frameKey: 'k',
      externals: [],
      root: { kind: 'repository', path: '', files: [], children: [{ kind: 'package', path: '', files, children: [] }] },
    });
    // Grid 2x2 slots at pitch 2 -> 3x3 cells; package = 3 + 2*border, 3 + 2*border + header
    // = 5x7; repository = 7x11. Package sits at (1, 3); its grid at (2, 6).
    expect(geometry.root).toEqual({ x: 0, z: 0, width: 700, depth: 1100 });
    const pkg = geometry.districts.find((d) => d.id === districtId(repoId, 'package', ''))!;
    expect(pkg.rect).toEqual({ x: 100, z: 300, width: 500, depth: 700 });
    expect(geometry.plots.map((p) => [p.lineageId, p.rect.x, p.rect.z])).toEqual([
      [files[0], 200, 600],
      [files[1], 400, 600],
      [files[2], 200, 800],
    ]);
    expect(geometry.plots.every((p) => p.rect.width === 100 && p.rect.depth === 100)).toBe(true);
  });

  it('gives empty districts a 4x4 marker', () => {
    const geometry = validate({ repoId, frameKey: 'k', externals: [], root: { kind: 'repository', path: '', files: [], children: [] } });
    expect(geometry.root).toEqual({ x: 0, z: 0, width: 400, depth: 400 });
  });

  it('distributes external terminals around the perimeter in sorted order', () => {
    const geometry = validate({
      repoId,
      frameKey: 'k',
      externals: ['npm:b', 'builtin:fs', 'npm:a', 'npm:a', 'npm:c', 'npm:d'],
      root: { kind: 'repository', path: '', files: [], children: [] },
    });
    expect(geometry.externalAnchors.map((a) => a.canonicalName)).toEqual(['builtin:fs', 'npm:a', 'npm:b', 'npm:c', 'npm:d']);
    const [north, east, south, west, north2] = geometry.externalAnchors;
    expect(north!.z).toBeLessThan(0);
    expect(east!.x).toBeGreaterThan(geometry.root.width);
    expect(south!.z).toBeGreaterThan(geometry.root.depth);
    expect(west!.x).toBeLessThan(0);
    expect(north2!.z).toBe(north!.z);
    expect(geometry.externalAnchors.map((a) => [a.x, a.z])).toEqual([[133, -700], [1100, 200], [200, 1100], [-700, 200], [267, -700]]);
  });
  it('keeps 10,000 integer terminals bounded by the same island perimeter', () => {
    const geometry = validate({ repoId, frameKey: 'dense-ring', externals: Array.from({ length: 10_000 }, (_, i) => `npm:p${i}`), root: { kind: 'repository', path: '', files: [], children: [] } });
    expect(geometry.layoutVersion).toBe('atlas.layout/1.1.0');
    for (const a of geometry.externalAnchors) {
      expect(Number.isInteger(a.x) && Number.isInteger(a.z)).toBe(true);
      expect(a.x).toBeGreaterThanOrEqual(-700); expect(a.x).toBeLessThanOrEqual(1100);
      expect(a.z).toBeGreaterThanOrEqual(-700); expect(a.z).toBeLessThanOrEqual(1100);
    }
  });
});

function randomTree(seed: number, maxFiles: number): { root: LayoutTreeNode; count: number } {
  const next = xorshift32(seed);
  let count = 0;
  let serial = 0;
  const make = (kind: LayoutTreeNode['kind'], path: string, depth: number): LayoutTreeNode => {
    const node: LayoutTreeNode = { kind, path, files: [], children: [] };
    const fileCount = next() % 7;
    for (let i = 0; i < fileCount && count < maxFiles; i++, count++) node.files.push(lin(`${path}/f${serial++}`));
    const childCount = depth > 4 ? 0 : next() % 4;
    for (let i = 0; i < childCount && count < maxFiles; i++) node.children.push(make('directory', `${path || 'root'}/d${serial++}`, depth + 1));
    return node;
  };
  const packages = 1 + (next() % 4);
  const root: LayoutTreeNode = { kind: 'repository', path: '', files: [], children: [] };
  for (let p = 0; p < packages; p++) root.children.push(make('package', p === 0 ? '' : `packages/p${p}`, 1));
  return { root, count };
}

function shuffleTree(node: LayoutTreeNode, next: () => number): LayoutTreeNode {
  const shuffle = <T>(items: T[]) => {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = next() % (i + 1);
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    return copy;
  };
  return { ...node, files: shuffle(node.files), children: shuffle(node.children.map((c) => shuffleTree(c, next))) };
}

describe('layout invariants on randomized trees', () => {
  it('never overlaps, always contains, plots every lineage once, and ignores input order', () => {
    for (let seed = 1; seed <= 150; seed++) {
      const { root, count } = randomTree(seed, 400);
      const input: LayoutInput = { repoId, frameKey: `seed-${seed}`, externals: [], root };
      const geometry = validate(input);
      expect(geometry.plots).toHaveLength(count);
      expect(new Set(geometry.plots.map((p) => p.lineageId)).size).toBe(count);
      const shuffled = computeLayout({ ...input, root: shuffleTree(root, xorshift32(seed * 7919)) });
      expect(shuffled).toEqual(geometry);
    }
  });

  it('packs a 20,000-plot union within the 2 s budget', () => {
    const files = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => lin(`${prefix}/${i}`));
    const packages: LayoutTreeNode[] = Array.from({ length: 20 }, (_, p) => ({
      kind: 'package',
      path: `packages/p${p}`,
      files: files(50, `p${p}`),
      children: Array.from({ length: 19 }, (_, d) => ({ kind: 'directory' as const, path: `packages/p${p}/d${d}`, files: files(50, `p${p}d${d}`), children: [] })),
    }));
    const input: LayoutInput = { repoId, frameKey: 'large', externals: [], root: { kind: 'repository', path: '', files: [], children: packages } };
    const timings: number[] = [];
    let geometry;
    for (let run = 0; run < 5; run++) {
      const started = performance.now();
      geometry = computeLayout(input);
      timings.push(performance.now() - started);
    }
    expect(geometry!.plots).toHaveLength(20_000);
    expect(validateLayoutArtifact({ ...geometry!, frameState: [] }).ok).toBe(true);
    const worst = Math.max(...timings);
    console.info(`[P0.4 evidence] 20,000-plot layout: ${timings.map((t) => t.toFixed(1)).join(', ')} ms`);
    expect(worst).toBeLessThan(2_000);
  });
});

describe('height and seeds', () => {
  it('encodes code lines logarithmically and clamps', () => {
    expect(buildingHeight('source', 'parsed', 0)).toBe(1);
    expect(buildingHeight('source', 'parsed', 25)).toBe(2.5);
    expect(buildingHeight('source', 'parsed', 75)).toBe(4);
    expect(buildingHeight('test', 'parsed', 1_000_000)).toBe(14);
    expect(buildingHeight('source', 'failed', 500)).toBe(0.8);
    expect(buildingHeight('config', 'unsupported', null)).toBe(0.8);
    expect(buildingHeight('declaration', 'parsed', 900)).toBe(0.6);
  });

  it('derives stable nonzero seeds and a reproducible sequence', () => {
    expect(seedFromId(`lin_${'0'.repeat(64)}`)).not.toBe(0);
    expect(seedFromId(`lin_deadbeef${'0'.repeat(56)}`)).toBe(0xdeadbeef);
    const a = xorshift32(42);
    const b = xorshift32(42);
    const seq = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(seq);
    // Reference values for xorshift32(42), computed independently by hand-iterating the recurrence.
    expect(seq[0]).toBe(11355432);
  });
});
