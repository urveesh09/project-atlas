import { describe, expect, it } from 'vitest';
import { distribution, evenStops, invalidStops, percentile } from '../src/app/bands';

describe('lens bands (ADR-052)', () => {
  it('accepts only five ascending whole-number starts from zero', () => {
    expect(invalidStops([0, 5, 10, 20, 40])).toBeNull();
    expect(invalidStops([0, 5, 10, 20])).toMatch(/Five/);
    expect(invalidStops([1, 5, 10, 20, 40])).toMatch(/first band/);
    expect(invalidStops([0, 5, 5, 20, 40])).toMatch(/above/);
    expect(invalidStops([0, 5, 10.5, 20, 40])).toMatch(/whole/);
    expect(invalidStops([0, 5, 10, 20, NaN])).toMatch(/whole/);
    expect(invalidStops([0, 5, 10, 20, 2e6])).toMatch(/whole/);
  });

  it('counts every value in exactly one band and keeps unknowns apart', () => {
    const values = [0, 1, 4, 5, 9, 10, 19, 20, 39, 40, 400, null, null];
    const d = distribution(values, [0, 5, 10, 20, 40]);
    expect(d.counts).toEqual([3, 2, 2, 2, 2]);
    expect(d.unknown).toBe(2);
    expect(d.known).toBe(11);
    expect(d.max).toBe(400);
    expect(d.median).toBe(10);
    expect(distribution([null], [0, 1, 2, 3, 4])).toMatchObject({ known: 0, median: null, max: null });
  });

  it('splits evenly into valid bands, even with heavy ties', () => {
    let seed = 5;
    const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    for (let round = 0; round < 300; round++) {
      const n = 1 + Math.floor(next() * 400);
      const ties = next() < 0.3;
      const values = Array.from({ length: n }, () => (ties ? Math.floor(next() * 3) : Math.floor(next() ** 3 * 2000)));
      const stops = evenStops(values);
      expect(invalidStops(stops)).toBeNull();
      if (!ties && n >= 50) {
        // No band holds more than half the files when values are spread.
        const counts = distribution(values, stops).counts;
        expect(Math.max(...counts)).toBeLessThanOrEqual(Math.ceil(n / 2));
      }
    }
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([], 50)).toBe(0);
  });
});
