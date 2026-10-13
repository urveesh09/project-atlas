import { describe, expect, it } from 'vitest';
import { compileWorkspaceGlob } from '../src/workspace.js';

/** The regular expression the matcher replaced (ADR-046), kept as the reference semantics. */
function referenceRegExp(glob: string): RegExp | null {
  const cleaned = glob.replace(/^\.\//, '').replace(/\/+$/, '');
  if (cleaned === '' || cleaned.includes('..') || cleaned.startsWith('/')) return null;
  let pattern = '';
  const segments = cleaned.split('/');
  segments.forEach((segment, index) => {
    if (segment === '**') pattern += index === segments.length - 1 ? '.*' : '(?:[^/]+/)*';
    else {
      pattern += segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*').replaceAll('?', '[^/]');
      if (index < segments.length - 1) pattern += '/';
    }
  });
  return new RegExp(`^${pattern.replace(/\/$/, '')}$`);
}

function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('workspace globs', () => {
  it('match exactly what the replaced regular expression matched', () => {
    const next = random(46);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
    const globParts = ['**', '*', '?', 'a', 'b', 'a*', '*b', 'a?b', '.', 'x.y', '', '*a*'];
    const pathParts = ['a', 'b', 'ab', 'aab', 'axb', 'x.y', 'xzy', '', 'ba', 'a\nb'];
    let compared = 0;
    for (let n = 0; n < 6000; n++) {
      const glob = Array.from({ length: 1 + Math.floor(next() * 4) }, () => pick(globParts)).join('/');
      const expected = referenceRegExp(glob);
      const actual = compileWorkspaceGlob(glob);
      expect(actual === null).toBe(expected === null);
      if (!expected || !actual) continue;
      for (let m = 0; m < 6; m++) {
        const dir = Array.from({ length: 1 + Math.floor(next() * 4) }, () => pick(pathParts)).join('/');
        expect(actual.test(dir), `${JSON.stringify(glob)} on ${JSON.stringify(dir)}`).toBe(expected.test(dir));
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(20_000);
  });

  it('keeps the documented cases', () => {
    const glob = (g: string) => compileWorkspaceGlob(g)!;
    expect(glob('packages/*').test('packages/core')).toBe(true);
    expect(glob('packages/*').test('packages/core/sub')).toBe(false);
    expect(glob('packages/**').test('packages/core/sub')).toBe(true);
    expect(glob('packages/**').test('packages')).toBe(false);
    expect(glob('**/pkg').test('pkg')).toBe(true);
    expect(glob('**/pkg').test('a/b/pkg')).toBe(true);
    expect(glob('./apps/*/').test('apps/web')).toBe(true);
    expect(compileWorkspaceGlob('../outside')).toBeNull();
  });

  it('stays fast on globs and paths built to make backtracking explode', () => {
    const hostile = `${'*a'.repeat(40)}*b/${'**/'.repeat(40)}x`;
    const dir = `${'a'.repeat(4000)}/${'s/'.repeat(200)}y`;
    const started = performance.now();
    expect(compileWorkspaceGlob(hostile)!.test(dir)).toBe(false);
    expect(compileWorkspaceGlob('*'.repeat(500) + 'b')!.test('a'.repeat(20_000))).toBe(false);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
