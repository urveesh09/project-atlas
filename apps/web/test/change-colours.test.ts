import { describe, expect, it } from 'vitest';
import type { CityBuilding } from '@atlas/layout';
import { metricDeltas, type FrameComparison } from '@atlas/graph';
import type { NodeMetrics } from '@atlas/schema';
import { CHANGE_BANDS, CHANGE_COLORS, CHANGE_METRICS, bandOf, changeBandLabel, changePaint, formatChange } from '../src/city/change';

const metrics = (values: Partial<Record<string, number | null>>): NodeMetrics => ({ ...values }) as unknown as NodeMetrics;
const building = (lineageId: string, metric: NodeMetrics | null): CityBuilding => ({ lineageId, nodeId: `n-${lineageId}`, path: `src/${lineageId}.ts`, metric }) as unknown as CityBuilding;
const comparison = (parts: Partial<FrameComparison>): FrameComparison =>
  ({
    fromSnapshotId: 'a',
    toSnapshotId: 'b',
    added: [],
    deleted: [],
    renamed: [],
    moved: [],
    modified: [],
    roleChanged: [],
    metricChanges: [],
    edgesAdded: [],
    edgesRemoved: [],
    ...parts,
  }) as FrameComparison;

describe('change colouring (ADR-050)', () => {
  it('bands signed changes, keeps unknowns unknown and marks new files', () => {
    const buildings = [
      building('grew', metrics({ codeLines: 160 })),
      building('grew-a-little', metrics({ codeLines: 12 })),
      building('shrank', metrics({ codeLines: 10 })),
      building('shrank-a-little', metrics({ codeLines: 30 })),
      building('same', metrics({ codeLines: 40 })),
      building('lost-metrics', metrics({ codeLines: null })),
      building('no-metrics', null),
      building('fresh', metrics({ codeLines: 7 })),
    ];
    const result = comparison({
      added: [{ lineageId: 'fresh', path: 'src/fresh.ts', role: 'source' }],
      metricChanges: [
        { lineageId: 'grew', path: 'src/grew.ts', deltas: metricDeltas(metrics({ codeLines: 100 }), metrics({ codeLines: 160 })) },
        { lineageId: 'grew-a-little', path: 'src/grew-a-little.ts', deltas: metricDeltas(metrics({ codeLines: 10 }), metrics({ codeLines: 12 })) },
        { lineageId: 'shrank', path: 'src/shrank.ts', deltas: metricDeltas(metrics({ codeLines: 90 }), metrics({ codeLines: 10 })) },
        { lineageId: 'shrank-a-little', path: 'src/shrank-a-little.ts', deltas: metricDeltas(metrics({ codeLines: 31 }), metrics({ codeLines: 30 })) },
        { lineageId: 'lost-metrics', path: 'src/lost-metrics.ts', deltas: metricDeltas(metrics({ codeLines: 20 }), metrics({ codeLines: null })) },
      ],
    });
    const paint = changePaint(result, buildings, 'codeLines');
    const band = (id: string) => paint.of(buildings.find((b) => b.lineageId === id)!).band;
    expect(band('grew')).toBe('much-more');
    expect(band('grew-a-little')).toBe('more');
    expect(band('shrank')).toBe('much-less');
    expect(band('shrank-a-little')).toBe('less');
    expect(band('same')).toBe('same');
    expect(band('lost-metrics')).toBe('unknown');
    expect(band('no-metrics')).toBe('unknown');
    expect(band('fresh')).toBe('new');
    expect(Object.values(paint.counts).reduce((a, b) => a + b, 0)).toBe(buildings.length);
    expect(paint.counts).toEqual({ 'much-less': 1, less: 1, same: 1, more: 1, 'much-more': 1, new: 1, unknown: 2 });
    for (const b of buildings) {
      expect(paint.color(b)).toBe(CHANGE_COLORS[paint.of(b).band]);
      expect(paint.unknown(b)).toBe(paint.of(b).band === 'unknown');
    }
    expect(formatChange(paint.of(buildings[0]!))).toBe('+60 (100 → 160)');
    expect(formatChange(paint.of(buildings[2]!))).toBe('−80 (90 → 10)');
    expect(formatChange(paint.of(buildings[4]!))).toBe('±0 (40 → 40)');
    expect(formatChange(paint.of(buildings[5]!))).toBe('unknown (20 → unknown)');
    expect(formatChange(paint.of(buildings[7]!))).toBe('new (7)');
    expect(changePaint(result, buildings, 'fanIn').key).not.toBe(paint.key);
  });

  it('agrees with the comparison on every known delta, for every metric', () => {
    let seed = 11;
    const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const value = () => (next() < 0.1 ? null : Math.floor(next() * 120));
    for (const metric of CHANGE_METRICS) {
      const buildings: CityBuilding[] = [];
      const metricChanges: FrameComparison['metricChanges'] = [];
      const truth = new Map<string, { from: number | null; to: number | null }>();
      for (let i = 0; i < 400; i++) {
        const id = `f${i}`;
        const from = value(),
          to = next() < 0.3 ? from : value();
        const a = metrics({ [metric]: from }),
          b = metrics({ [metric]: to });
        buildings.push(building(id, b));
        truth.set(id, { from, to });
        const deltas = metricDeltas(a, b).filter((d) => d.metric === metric);
        if (deltas.length) metricChanges.push({ lineageId: id, path: `src/${id}.ts`, deltas });
      }
      const paint = changePaint(comparison({ metricChanges }), buildings, metric);
      for (const b of buildings) {
        const { from, to } = truth.get(b.lineageId)!;
        const change = paint.of(b);
        if (from === null || to === null) expect(change.band).toBe('unknown');
        else {
          expect(change.delta).toBe(to - from);
          expect(change.band).toBe(bandOf(to - from, metric));
        }
      }
    }
  });

  it('labels every band with its threshold', () => {
    expect(CHANGE_BANDS.map((b) => changeBandLabel(b, 'codeLines'))).toEqual(['−50 or less', '−49 to −1', 'unchanged', '+1 to +49', '+50 or more', 'new file', 'unknown']);
    expect(changeBandLabel('less', 'maxCyclomatic')).toBe('−4 to −1');
  });
});
