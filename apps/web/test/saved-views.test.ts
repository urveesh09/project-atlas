import { describe, expect, it } from 'vitest';
import { mergeSavedViews, parseSavedView, parseSavedViewsFile, serializeSavedViews, type SavedView } from '../src/app/saved-views';

const view: SavedView = {
  name: 'Runtime hotspots',
  savedAt: '2026-10-13T08:00:00.000Z',
  lens: 'hotspot',
  mode: '3d',
  filter: 'source',
  direction: 'both',
  includeTypes: false,
  pattern: 'packages/runtime-*/**, !*.test.ts',
  selectedPath: 'packages/runtime-core/src/renderer.ts',
  theme: 'western',
  camera: { position: [1, 2, 3], target: [0, 0, 0], zoom: 1 },
};

describe('saved views', () => {
  it('round-trip through an exported file', () => {
    const text = serializeSavedViews('vuejs/core', [view]);
    expect(parseSavedViewsFile(text)).toEqual({ views: [view], skipped: 0, repository: 'vuejs/core' });
  });

  it('treat imported files as untrusted: bad entries are skipped, never coerced into code', () => {
    const hostile = {
      format: 'atlas.views/1',
      repository: 'x',
      views: [
        { ...view, lens: 'eval' },
        { ...view, name: '' },
        { ...view, name: 'a'.repeat(81) },
        { ...view, name: 'bell\u0007' },
        { ...view, selectedPath: 42 },
        { ...view, camera: { position: [1, 2, 'x'], target: [0, 0, 0], zoom: 1 } },
        { ...view, name: 'kept', theme: '<script>', camera: { position: [Infinity, 0, 0], target: [0, 0, 0], zoom: 1 } },
        '__proto__',
      ],
    };
    const parsed = parseSavedViewsFile(JSON.stringify(hostile));
    expect(parsed.skipped).toBe(6);
    expect(parsed.views).toHaveLength(2);
    expect(parsed.views[0]!.camera).toBeNull();
    const kept = parsed.views.find((v) => v.name === 'kept')!;
    expect(kept.theme).toBeNull();
    expect(kept.camera).toBeNull();
    expect(() => parseSavedViewsFile('{"format":"other","views":[]}')).toThrow('not an ATLAS views file');
    expect(() => parseSavedViewsFile('not json')).toThrow('not JSON');
    expect(() => parseSavedViewsFile(' '.repeat(600 * 1024))).toThrow('larger than 512 KiB');
    expect(parseSavedView({ ...view, mode: 'vr' })).toBeNull();
  });

  it('merge by name, newest first, and stay bounded', () => {
    const older = { ...view, name: 'A', savedAt: '2026-01-01T00:00:00.000Z' };
    const newer = { ...view, name: 'A', savedAt: '2026-02-01T00:00:00.000Z', lens: 'churn' as const };
    expect(mergeSavedViews([older], [newer])).toEqual([newer]);
    const many = Array.from({ length: 150 }, (_, i) => ({ ...view, name: `v${i}`, savedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() }));
    const merged = mergeSavedViews([], many);
    expect(merged).toHaveLength(100);
    expect(merged[0]!.name).toBe('v149');
  });
});
