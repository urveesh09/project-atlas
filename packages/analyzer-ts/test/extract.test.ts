import { describe, expect, it } from 'vitest';
import { extractFileFacts, type RawImport } from '@atlas/analyzer-ts';

const summary = (imports: RawImport[]) => imports.map((i) => [i.kind, i.specifier, i.unsupportedReason ?? undefined].filter((v) => v !== undefined));

describe('import extraction (plan §9.2)', () => {
  it('splits mixed type/value bindings and keeps one value observation per statement', () => {
    const facts = extractFileFacts('a.ts', `import def, { a, b, type T, type U } from './m';\n`);
    expect(summary(facts.imports)).toEqual([
      ['imports-type', './m'],
      ['imports-value', './m'],
    ]);
    // Both observations carry the specifier literal range (quotes included): offsets 42..47.
    expect(facts.imports[0]!.range).toEqual({ startOffset: 42, endOffset: 47, startLine: 1, startColumn: 43, endLine: 1, endColumn: 48 });
  });

  it('classifies every static import form', () => {
    const source = [
      `import 'side-effect';`,
      `import type { A } from './types';`,
      `import { type B } from './only-type';`,
      `import * as ns from './ns';`,
      `import {} from './empty';`,
      `import data from './data.json' with { type: 'json' };`,
      `export * from './star';`,
      `export * as nsx from './star-ns';`,
      `export { c, type D } from './mixed-re';`,
      `export type { E } from './type-re';`,
      `export type * from './type-star';`,
      `import eq = require('./eq');`,
      `import type teq = require('./teq');`,
      'let t: import("./import-type").T;',
      'const lazy = import(`./tmpl`);',
    ].join('\n');
    const facts = extractFileFacts('forms.ts', source);
    expect(facts.parseStatus).toBe('parsed');
    expect(summary(facts.imports)).toEqual([
      ['imports-value', 'side-effect'],
      ['imports-type', './types'],
      ['imports-type', './only-type'],
      ['imports-value', './ns'],
      ['imports-value', './empty'],
      ['imports-value', './data.json'],
      ['reexports-value', './star'],
      ['reexports-value', './star-ns'],
      ['reexports-type', './mixed-re'],
      ['reexports-value', './mixed-re'],
      ['reexports-type', './type-re'],
      ['reexports-type', './type-star'],
      ['imports-value', './eq'],
      ['imports-type', './teq'],
      ['imports-type', './import-type'],
      ['imports-dynamic-literal', './tmpl'],
    ]);
    expect(facts.imports.find((i) => i.specifier === './data.json')!.attributeType).toBe('json');
    expect(facts.imports.find((i) => i.specifier === './eq')!.usage).toBe('require');
  });

  it('records non-literal dynamic import and require as unsupported without a specifier', () => {
    const facts = extractFileFacts('d.js', `const n = 'x';\nimport(n);\nrequire(n + '.js');\nrequire('a', 'b');\nrequire.resolve('./r');\nimport.meta.glob('./*.ts');\n`);
    expect(summary(facts.imports)).toEqual([
      ['imports-dynamic-literal', null, 'NONLITERAL_DYNAMIC_IMPORT'],
      ['requires-literal', null, 'NONLITERAL_REQUIRE'],
      ['requires-literal', null, 'NONLITERAL_REQUIRE'],
      ['requires-literal', null, 'REQUIRE_RESOLVE_UNSUPPORTED'],
      ['imports-dynamic-literal', null, 'IMPORT_META_GLOB_UNSUPPORTED'],
    ]);
  });

  it('ignores require when it is lexically shadowed', () => {
    const source = [
      `const top = require('./top');`,
      `function param(require) { return require('./param'); }`,
      `function local() { var require = () => 0; { return require('./var-hoisted'); } }`,
      `function block() { { const require = () => 0; require('./block'); } return require('./after-block'); }`,
      `const arrow = (x) => require('./arrow');`,
      `try {} catch (require) { require('./catch'); }`,
      `const fe = function require() { return require('./fn-name'); };`,
      `const { require: alias } = obj; alias('./alias');`,
      `function destructured() { const { a: require } = obj; return require('./destructured'); }`,
    ].join('\n');
    const facts = extractFileFacts('cjs.cjs', source);
    expect(facts.imports.map((i) => i.specifier)).toEqual(['./top', './after-block', './arrow']);
  });

  it('treats an imported binding named require as shadowing the module scope', () => {
    const facts = extractFileFacts('m.mjs', `import { require } from './custom';\nrequire('./not-a-module');\n`);
    expect(facts.imports.map((i) => i.specifier)).toEqual(['./custom']);
  });

  it('makes no dependency claims for files with syntax errors', () => {
    const facts = extractFileFacts('broken.ts', `import { a } from './a';\nexport const = ;\n`);
    expect(facts.parseStatus).toBe('failed');
    expect(facts.imports).toEqual([]);
    expect(facts.parseErrors.length).toBeGreaterThan(0);
    expect(facts.parseErrors[0]!.range.startLine).toBe(2);
  });

  it('parses TSX, JSX and declaration files with the right script kind', () => {
    expect(extractFileFacts('c.tsx', `import x from './x';\nexport const C = () => <div a={x as number}>{1}</div>;\n`).parseStatus).toBe('parsed');
    expect(extractFileFacts('c.jsx', `export const C = () => <div/>;\n`).parseStatus).toBe('parsed');
    expect(extractFileFacts('c.js', `export const C = () => <div/>;\n`).parseStatus).toBe('parsed');
    expect(extractFileFacts('c.d.ts', `export declare function f(): void;\n`).declarations).toEqual([
      expect.objectContaining({ name: 'f', kind: 'function', exported: true }),
    ]);
    // Generic arrow syntax that is only valid outside TSX.
    expect(extractFileFacts('g.ts', `const id = <T,>(x: T) => x;\nconst cast = <number>value;\n`).parseStatus).toBe('parsed');
    expect(extractFileFacts('g.tsx', `const cast = <number>value;\n`).parseStatus).toBe('failed');
  });
});

describe('declaration summaries', () => {
  it('lists top-level named declarations with export state', () => {
    const facts = extractFileFacts(
      'decl.ts',
      [
        `export function f() {}`,
        `class K {}`,
        `export interface I {}`,
        `type T = 1;`,
        `export enum E { A }`,
        `export const { a, b: [c] } = obj, d = 1;`,
        `let e;`,
        `export { K, e as renamed };`,
        `export default function () {}`,
      ].join('\n'),
    );
    expect(facts.declarations.map((d) => [d.name, d.kind, d.exported])).toEqual([
      ['f', 'function', true],
      ['K', 'class', true],
      ['I', 'interface', true],
      ['T', 'type', false],
      ['E', 'enum', true],
      ['a', 'variable', true],
      ['c', 'variable', true],
      ['d', 'variable', true],
      ['e', 'variable', true],
      ['default', 'function', true],
    ]);
  });

  it('bounds the declaration list and counts omissions', () => {
    const source = Array.from({ length: 130 }, (_, i) => `export const v${i} = ${i};`).join('\n');
    const facts = extractFileFacts('many.ts', source);
    expect(facts.declarations).toHaveLength(100);
    expect(facts.declarationsOmitted).toBe(30);
  });
});
