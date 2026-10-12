import { describe, expect, it } from 'vitest';
import { OcclusionBaker, type BakeWorker } from '../src/city/baker';
import { OCCLUDER_STRIDE, bakeOcclusion, occlusionGrid } from '../src/city/occlusion';

/** One occluder: centre, half extents, height and strength. */
const box = (x: number, z: number, height: number, half = 0.4, strength = 0.6) => [x, z, half, half, height, strength];
const at = (grid: ReturnType<typeof occlusionGrid>, field: Uint8Array, x: number, z: number) =>
  field[Math.floor((z - grid.minZ) / grid.texel) * grid.width + Math.floor((x - grid.minX) / grid.texel)]!;

describe('baked sky-occlusion field', () => {
  it('covers the island with a margin at the finest texel that fits, never past 3072 texels a side', () => {
    const small = occlusionGrid(0, 0, 40, 20);
    expect(small.texel).toBeCloseTo(0.14);
    expect(small.minX).toBe(-2);
    expect(small.width * small.texel).toBeGreaterThanOrEqual(44);
    const large = occlusionGrid(0, 0, 600, 450);
    expect(Math.max(large.width, large.depth)).toBeLessThanOrEqual(3072);
    expect(large.width * large.texel).toBeGreaterThanOrEqual(604);
  });

  it('is open sky everywhere without occluders', () => {
    const grid = occlusionGrid(0, 0, 10, 10);
    expect(bakeOcclusion(grid, new Float32Array(0)).every((v) => v === 255)).toBe(true);
  });

  it('darkens the ground at a building and fades to open sky within its reach', () => {
    const grid = occlusionGrid(0, 0, 20, 20);
    const field = bakeOcclusion(grid, new Float32Array(box(10, 10, 4)));
    const foot = at(grid, field, 10.5, 10);
    const near = at(grid, field, 11, 10);
    const far = at(grid, field, 16, 10);
    expect(foot).toBeLessThan(near);
    expect(near).toBeLessThan(255);
    expect(foot).toBeLessThan(150);
    expect(far).toBe(255);
  });

  it('shades more beside taller buildings, and most between two of them', () => {
    const grid = occlusionGrid(0, 0, 20, 20);
    const short = bakeOcclusion(grid, new Float32Array(box(10, 10, 1)));
    const tall = bakeOcclusion(grid, new Float32Array(box(10, 10, 6)));
    expect(at(grid, tall, 11.2, 10)).toBeLessThan(at(grid, short, 11.2, 10));
    const pair = bakeOcclusion(grid, new Float32Array([...box(10, 10, 6), ...box(12.4, 10, 6)]));
    expect(at(grid, pair, 11.2, 10)).toBeLessThan(at(grid, tall, 11.2, 10));
  });

  it('is deterministic and ignores empty or flat occluders', () => {
    const grid = occlusionGrid(0, 0, 30, 30);
    const occluders = new Float32Array([...box(5, 5, 3), ...box(20, 8, 7), ...box(12, 25, 0), ...box(14, 14, 2, 0.4, 0)]);
    expect(occluders.length).toBe(4 * OCCLUDER_STRIDE);
    const a = bakeOcclusion(grid, occluders);
    expect(bakeOcclusion(grid, occluders)).toEqual(a);
    expect(at(grid, a, 12.6, 25)).toBe(255);
    expect(at(grid, a, 14.6, 14)).toBe(255);
  });
});

describe('occlusion bake scheduling', () => {
  /** A stand-in worker that records posts and fails or answers on demand. */
  const harness = () => {
    const posted: number[] = [];
    const applied: Uint8Array[] = [];
    const deferred: (() => void)[] = [];
    let spawned = 0;
    const worker: BakeWorker = {
      postMessage: (m) => void posted.push(m.id),
      terminate: () => {},
      onmessage: null,
      onerror: null,
    };
    const baker = new OcclusionBaker(
      (field) => applied.push(field),
      () => {
        spawned++;
        return worker;
      },
      (run) => void deferred.push(run),
    );
    const flush = () => deferred.splice(0).forEach((run) => run());
    return { baker, worker, posted, applied, flush, spawned: () => spawned };
  };
  const grid = occlusionGrid(0, 0, 20, 20);
  const snapshotA = new Float32Array(box(5, 5, 4));
  const snapshotB = new Float32Array(box(14, 12, 6));

  it('falls back to the latest snapshot when the worker fails after a snapshot change', () => {
    const h = harness();
    h.baker.bake(grid, snapshotA);
    h.baker.bake(grid, snapshotB);
    expect(h.posted).toEqual([1, 2]);
    h.worker.onerror!(new Event('error'));
    h.flush();
    expect(h.applied).toHaveLength(1);
    expect(h.applied[0]).toEqual(bakeOcclusion(grid, snapshotB));
    expect(h.baker.ready).toBe(true);
  });

  it('applies only the latest worker result and bakes inline after a failure', () => {
    const h = harness();
    h.baker.bake(grid, snapshotA);
    h.baker.bake(grid, snapshotB);
    h.worker.onmessage!({ data: { id: 1, field: new Uint8Array([1]) } });
    expect(h.applied).toHaveLength(0);
    expect(h.baker.ready).toBe(false);
    h.worker.onmessage!({ data: { id: 2, field: new Uint8Array([2]) } });
    expect(h.applied).toEqual([new Uint8Array([2])]);
    h.worker.onerror!(new Event('error'));
    h.baker.bake(grid, snapshotA);
    h.baker.bake(grid, snapshotB);
    h.flush();
    // Two inline requests, one bake: the newer one replaced the older before it ran.
    expect(h.applied).toHaveLength(2);
    expect(h.applied[1]).toEqual(bakeOcclusion(grid, snapshotB));
    expect(h.spawned()).toBe(1);
  });

  it('bakes inline when a worker cannot start', () => {
    const applied: Uint8Array[] = [];
    const deferred: (() => void)[] = [];
    const baker = new OcclusionBaker(
      (field) => applied.push(field),
      () => {
        throw new Error('no workers here');
      },
      (run) => void deferred.push(run),
    );
    baker.bake(grid, snapshotA);
    deferred.splice(0).forEach((run) => run());
    expect(applied[0]).toEqual(bakeOcclusion(grid, snapshotA));
  });
});
