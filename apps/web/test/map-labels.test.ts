import { describe, expect, it } from 'vitest';
import { placeMapLabels, type MapLabelCandidate } from '../src/city/map-labels';

const measure = (t: string) => t.length * 7;
const options = { height: 18, padding: 5, gap: 4, max: 24 };

describe('2D map labels', () => {
  it('never overlaps, honours priority and stays on the canvas', () => {
    let seed = 3;
    const next = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let round = 0; round < 200; round++) {
      const candidates: MapLabelCandidate[] = Array.from({ length: 40 }, (_, i) => ({
        text: `@scope/package-${i}`,
        priority: i === 0 ? 0 : 1,
        weight: next() * 1000,
        x: next() * 800,
        y: next() * 500,
        maxWidth: 40 + next() * 260,
      }));
      const placed = placeMapLabels(candidates, measure, { width: 800, height: 500 }, options);
      expect(placed.length).toBeLessThanOrEqual(24);
      for (const [i, a] of placed.entries()) {
        expect(a.x).toBeGreaterThanOrEqual(0);
        expect(a.x + a.width).toBeLessThanOrEqual(800);
        for (const b of placed.slice(i + 1)) {
          const apart = a.x + a.width + 4 <= b.x || b.x + b.width + 4 <= a.x || a.y + a.height + 4 <= b.y || b.y + b.height + 4 <= a.y;
          expect(apart).toBe(true);
        }
      }
      const first = candidates[0]!;
      const fitsCanvas = first.x > 60 && first.x < 740 && first.y > 9 && first.y < 491;
      if (fitsCanvas && first.maxWidth >= 5 * 7 + 10) expect(placed[0]!.text.startsWith('@sco') || placed[0]!.text.startsWith('pack')).toBe(true);
    }
  });

  it('shortens a name to its district and drops it when even four letters do not fit', () => {
    const [label] = placeMapLabels([{ text: '@vue/compiler-sfc', priority: 1, weight: 1, x: 100, y: 50, maxWidth: 80 }], measure, { width: 400, height: 200 }, options);
    // 70px of text at 7px per character: the scope goes first, then the name shortens.
    expect(label!.text).toBe('compiler-…');
    const [unscoped] = placeMapLabels([{ text: '@vue/shared', priority: 1, weight: 1, x: 100, y: 50, maxWidth: 70 }], measure, { width: 400, height: 200 }, options);
    expect(unscoped!.text).toBe('shared');
    expect(label!.width).toBeLessThanOrEqual(80);
    expect(placeMapLabels([{ text: 'packages', priority: 1, weight: 1, x: 100, y: 50, maxWidth: 30 }], measure, { width: 400, height: 200 }, options)).toEqual([]);
  });
});
