import { describe, expect, it } from 'vitest';
import { compileScope, normalizeFocus, NO_SCOPE } from '../src/app/scope';

const paths = [
  'README.md',
  'packages/core/src/index.ts',
  'packages/core/src/index.test.ts',
  'packages/core/dist/index.js',
  'packages/core-extra/src/a.ts',
  'packages/ui/src/button.tsx',
  'scripts/build.mjs',
  'tools/scripts/x.ts',
];
const shown = (focus: string | null, hide: string) => paths.filter(compileScope({ focus, hide }).visible);

describe('scope (ADR-051)', () => {
  it('shows everything without a scope', () => {
    const s = compileScope(NO_SCOPE);
    expect(s.active).toBe(false);
    expect(paths.every(s.visible)).toBe(true);
  });

  it('focuses on a folder without catching its look-alike siblings', () => {
    expect(shown('packages/core', '')).toEqual(['packages/core/src/index.ts', 'packages/core/src/index.test.ts', 'packages/core/dist/index.js']);
    expect(shown('/packages/core/', '')).toEqual(shown('packages/core', ''));
    expect(compileScope({ focus: '', hide: '' }).active).toBe(false);
  });

  it('hides by pattern, anchored folders stay anchored, and ! makes exceptions', () => {
    expect(shown(null, '**/dist/**, *.test.ts')).toEqual(paths.filter((p) => !p.includes('/dist/') && !p.endsWith('.test.ts')));
    // A leading slash anchors: /scripts hides the root folder only, not tools/scripts.
    expect(shown(null, '/scripts')).toEqual(paths.filter((p) => !p.startsWith('scripts/')));
    expect(shown(null, 'packages/core, !packages/core/src/index.ts')).toEqual(paths.filter((p) => !p.startsWith('packages/core/') || p === 'packages/core/src/index.ts'));
    // Exceptions alone hide nothing.
    expect(compileScope({ focus: null, hide: '!packages/core' }).active).toBe(false);
    expect(shown('packages', '**/dist/**, /packages/ui')).toEqual(['packages/core/src/index.ts', 'packages/core/src/index.test.ts', 'packages/core-extra/src/a.ts']);
  });

  it('reports invalid patterns instead of hiding anything', () => {
    const s = compileScope({ focus: null, hide: Array.from({ length: 40 }, (_, i) => `a${i}`).join(',') });
    expect(s.error).toMatch(/At most 32/);
    expect(paths.every(s.visible)).toBe(true);
    expect(normalizeFocus('//a/b//')).toBe('a/b');
    expect(normalizeFocus('/')).toBeNull();
  });
});
