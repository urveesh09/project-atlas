import { describe, expect, it } from 'vitest';
import { compilePathPattern } from '../src/app/path-pattern';

const files = [
  'README.md',
  'src/index.ts',
  'src/util/strings.ts',
  'src/util/strings.test.ts',
  'packages/core/src/a.ts',
  'packages/core/test/a.test.ts',
  'packages/web/src/b.tsx',
  'packages/web/fixtures/c.ts',
  'tools/fixtures/d.js',
];
const match = (pattern: string) => files.filter((f) => compilePathPattern(pattern)!.test(f));

describe('path patterns', () => {
  it('follow .gitignore conventions for names, anchors, folders and globstars', () => {
    expect(match('*.test.ts')).toEqual(['src/util/strings.test.ts', 'packages/core/test/a.test.ts']);
    expect(match('fixtures')).toEqual(['packages/web/fixtures/c.ts', 'tools/fixtures/d.js']);
    expect(match('fixtures/')).toEqual(['packages/web/fixtures/c.ts', 'tools/fixtures/d.js']);
    expect(match('README.md/')).toEqual([]);
    expect(match('packages/core')).toEqual(['packages/core/src/a.ts', 'packages/core/test/a.test.ts']);
    expect(match('/src')).toEqual(['src/index.ts', 'src/util/strings.ts', 'src/util/strings.test.ts']);
    expect(match('packages/*/src/**')).toEqual(['packages/core/src/a.ts', 'packages/web/src/b.tsx']);
    expect(match('**/src/*.ts')).toEqual(['src/index.ts', 'packages/core/src/a.ts']);
    expect(match('src/u?il/*.ts')).toEqual(['src/util/strings.ts', 'src/util/strings.test.ts']);
  });

  it('combines patterns: any include, minus every exclude', () => {
    expect(match('packages/**, !*.test.ts, !fixtures')).toEqual(['packages/core/src/a.ts', 'packages/web/src/b.tsx']);
    expect(match('!packages')).toEqual(['README.md', 'src/index.ts', 'src/util/strings.ts', 'src/util/strings.test.ts', 'tools/fixtures/d.js']);
    expect(compilePathPattern('  ,  \n ')).toBeNull();
  });

  it('refuses oversized input and stays fast on hostile patterns', () => {
    expect(() => compilePathPattern(Array.from({ length: 33 }, (_, i) => `p${i}`).join(','))).toThrow('At most 32');
    expect(() => compilePathPattern('a'.repeat(257))).toThrow('longer than 256');
    const started = performance.now();
    const hostile = compilePathPattern(`${'*a'.repeat(100)}*b, ${'**/'.repeat(80)}x`)!;
    for (let i = 0; i < 50; i++) hostile.test(`${'a'.repeat(2000)}/${'s/'.repeat(100)}y`);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
