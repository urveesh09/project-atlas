import { describe, expect, it } from 'vitest';
import { extractFileFacts, physicalLineCount } from '@atlas/analyzer-ts';

/**
 * P2.1/P2.4 evidence: every expected number below is counted by hand from plan §10.1,
 * with the counting shown in comments. None is produced by running the analyzer.
 */
describe('physical lines', () => {
  it.each([
    ['', 0],
    ['a', 1],
    ['a\n', 1],
    ['a\nb', 2],
    ['a\nb\n', 2],
    ['\n', 1],
    ['\n\n', 2],
    ['a\r\nb\r\n', 2], // LF-delimited: CR is part of the line
  ])('%j has %i', (text, lines) => {
    expect(physicalLineCount(text)).toBe(lines);
  });
});

describe('code lines', () => {
  it('excludes blank and comment-only lines and counts multi-line tokens on every line', () => {
    const source = [
      '// leading comment', //  1 comment only
      '', //                     2 blank
      'const a = 1; // trailing', // 3 code
      '/* block', //             4 comment only
      '   comment */', //        5 comment only
      'const t = `x', //         6 template spans 6-8
      '', //                     7 inside the template token: counts
      'y`;', //                  8
      '   ', //                  9 whitespace only
      'export {}', //           10 code
    ].join('\n');
    const facts = extractFileFacts('lines.ts', source);
    expect(facts.physicalLines).toBe(10);
    expect(facts.codeLines).toBe(5); // lines 3, 6, 7, 8 and 10
  });

  it('counts JSX text lines only where they have visible characters', () => {
    const source = ['export const A = () => (', '  <div>', '    hello', '', '  </div>', ');'].join('\n');
    // Lines 1, 2, 3, 5, 6 carry tokens or visible text; line 4 is whitespace inside JSX text.
    expect(extractFileFacts('a.tsx', source).codeLines).toBe(5);
  });

  it('is null for failed parses while physical lines remain available', () => {
    const facts = extractFileFacts('bad.ts', 'const = ;\n');
    expect(facts.parseStatus).toBe('failed');
    expect(facts.codeLines).toBeNull();
    expect(facts.complexity).toBeNull();
    expect(facts.physicalLines).toBe(1);
  });
});

describe('cyclomatic complexity per callable', () => {
  it('counts every decision kind exactly once', () => {
    const source = `
export function decide(a: number, b?: { c?: number }) {
  if (a > 0) {}                 // if +1
  else if (a < 0) {}            // if +1
  for (let i = 0; i < a; i++) {} // loop +1
  for (const k in b) {}         // loop +1
  for (const v of [1]) {}       // loop +1
  while (a--) {}                // loop +1
  do {} while (false);          // loop +1
  try {} catch {}               // catch +1
  const x = a ? 1 : 2;          // conditional +1
  switch (a) {
    case 1: break;              // case +1
    case 2: break;              // case +1
    default: break;             // default: 0
  }
  const y = a && b || null;     // logical +2
  const z = b ?? 0;             // logical +1
  const w = b?.c;               // optional chaining: 0
  let q = 0; q ||= 1;           // logical assignment: 0
  return x + (y ? 1 : 0);       // conditional +1
}`;
    const [callable] = extractFileFacts('d.ts', source).callables;
    expect(callable).toMatchObject({
      name: 'decide',
      kind: 'function',
      complexity: 1 + 2 + 5 + 1 + 2 + 2 + 3,
      contributions: { if: 2, loop: 5, catch: 1, conditional: 2, case: 2, logical: 3 },
    });
  });

  it('computes nested callables separately and excludes them from the parent', () => {
    const source = `
function outer(x: number) {          // 1 + if = 2
  if (x) {}
  const inner = (y: number) => {     // 1 + if + && = 3
    if (y && x) {}
  };
  return [1].map(function mapper(v) { return v ? 1 : 0; }); // 1 + ?: = 2
}
class Box {
  constructor(private v: number) { if (v) {} }   // 2
  get value() { return this.v || 0; }            // 2
  set value(n: number) { this.v = n; }           // 1
  method() { return () => 1; }                   // method 1, arrow 1
  static { if (true) {} }                        // static block: not a callable
}
if (Math.random()) {}                            // top level: not counted anywhere
`;
    const facts = extractFileFacts('n.ts', source);
    expect(facts.callables.map((c) => [c.name, c.kind, c.complexity])).toEqual([
      ['outer', 'function', 2],
      ['inner', 'arrow', 3],
      ['mapper', 'function', 2],
      ['constructor', 'constructor', 2],
      ['get value', 'getter', 2],
      ['set value', 'setter', 1],
      ['method', 'method', 1],
      ['anonymous arrow (line 13)', 'arrow', 1],
    ]);
    expect(facts.complexity).toEqual({ callableCount: 8, maxCyclomatic: 3, sumCyclomatic: 14 });
  });

  it('reports 0/0 for a parsed file with no callables', () => {
    expect(extractFileFacts('consts.ts', 'export const a = 1 && 2;\n').complexity).toEqual({ callableCount: 0, maxCyclomatic: 0, sumCyclomatic: 0 });
  });

  it('ignores bodiless overloads and abstract members', () => {
    const facts = extractFileFacts('o.ts', 'export function f(a: string): void;\nexport function f(a: unknown) { if (a) {} }\nabstract class A { abstract m(): void; }\n');
    expect(facts.callables.map((c) => [c.name, c.complexity])).toEqual([['f', 2]]);
  });
});

describe('containment', () => {
  it('turns parser stack exhaustion into a failed parse instead of a crash', () => {
    const deep = `${'('.repeat(60_000)}1${')'.repeat(60_000)};`;
    const facts = extractFileFacts('deep.ts', deep);
    expect(facts.parseStatus).toBe('failed');
    expect(['PARSER_STACK_LIMIT', 'SYNTAX_ERROR']).toContain(facts.failureReason);
  });

  it('handles a very long single token', () => {
    const facts = extractFileFacts('long.ts', `export const s = "${'x'.repeat(500_000)}";\n`);
    expect(facts.parseStatus).toBe('parsed');
    expect(facts.codeLines).toBe(1);
  });
});
