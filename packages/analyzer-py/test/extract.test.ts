import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { LANGUAGE_VERSION, MIN_COMPATIBLE_VERSION } from 'web-tree-sitter';
import { PYTHON_GRAMMAR, PYTHON_PARSER_VERSION, extractPythonFacts, initPythonParser, pythonGrammarPath, pythonParser, type PythonFacts } from '@atlas/analyzer-py';

beforeAll(async () => {
  await initPythonParser();
});
const facts = (text: string, path = 'pkg/mod.py'): PythonFacts => extractPythonFacts(path, text);
const imports = (f: PythonFacts) => f.imports.map((i) => [i.kind, i.specifier, i.unsupportedReason, i.guarded] as const);

describe('Python grammar and parse status (ADR-056)', () => {
  it('loads only the vendored grammar with the recorded hash', () => {
    expect(createHash('sha256').update(readFileSync(pythonGrammarPath())).digest('hex')).toBe(PYTHON_GRAMMAR.sha256);
    const abi = pythonParser().language!.abiVersion;
    expect(abi).toBe(15);
    expect(abi).toBeGreaterThanOrEqual(MIN_COMPATIBLE_VERSION);
    expect(abi).toBeLessThanOrEqual(LANGUAGE_VERSION);
  });

  it('records the installed runtime accurately in artifact and cache provenance', () => {
    const installed = JSON.parse(readFileSync(new URL('./package.json', import.meta.resolve('web-tree-sitter')), 'utf8')) as { version: string };
    expect(PYTHON_GRAMMAR.runtime).toBe(`web-tree-sitter@${installed.version}`);
    expect(PYTHON_PARSER_VERSION).toBe(`tree-sitter-python@0.25.0+atlas.1+wts@${installed.version}`);
  });

  it.each([0, 1023, 4095, 8191])('preserves UTF-16 ranges around astral text after %i padding characters', (padding) => {
    // Runtime 0.27 includes UTF-16 decoding fixes. Exercise pairs near input-buffer
    // boundaries and at EOF, then verify the actual specifier slice and location.
    const prefix = `s = "${'x'.repeat(padding)}😀"\n`;
    const text = `${prefix}import os\ntail = "😀"`;
    const f = facts(text);
    expect(f.parseStatus).toBe('parsed');
    expect(f.parseErrors).toEqual([]);
    expect(f.imports).toHaveLength(1);
    expect(f.imports[0]!.range).toEqual({
      startOffset: prefix.length + 7, endOffset: prefix.length + 9,
      startLine: 2, startColumn: 8, endLine: 2, endColumn: 10,
    });
    expect(text.slice(f.imports[0]!.range.startOffset, f.imports[0]!.range.endOffset)).toBe('os');
    expect(f.codeLines).toBe(3);
  });

  it('parses modern syntax: match, PEP 695, PEP 701 f-strings, except*, async and walrus', () => {
    const f = facts(
      [
        'type Pair[T] = tuple[T, T]',
        'def first[T](p: Pair[T]) -> T:',
        '    match p:',
        '        case (a, _): return a',
        'async def run(xs):',
        '    async for x in xs:',
        '        if (n := len(x)) > 3: print(f"{x!r:>{n}} {"nested"}")',
        '    try:',
        '        pass',
        '    except* ValueError:',
        '        pass',
        '',
      ].join('\n'),
    );
    expect(f.parseStatus).toBe('parsed');
    expect(f.parseErrors).toEqual([]);
  });

  it('parses Python 3.15 syntax: lazy imports, unpacking in comprehensions, unary plus patterns (ADR-080)', () => {
    const f = facts(
      [
        'lazy import json',
        'lazy from pathlib import Path',
        'lazy = True',
        'lazy(lazy.attr)',
        'def g(lists, dicts, agen):',
        '    a = [*L for L in lists if L]',
        '    b = {*s for s in lists}',
        '    c = {**d for d in dicts}',
        '    e = sum(*L for L in lists)',
        '    f = (*x async for x in agen())',
        '    match a:',
        '        case +1 | -2: return {+1: b}',
        '        case +1 - 2j: return c',
        '',
      ].join('\n'),
    );
    expect(f.parseStatus).toBe('parsed');
    expect(f.parseErrors).toEqual([]);
    expect(imports(f)).toEqual([
      ['imports-value', 'json', null, false],
      ['imports-value', 'pathlib', null, false],
    ]);
    // Five comprehension loops, one comprehension `if`, two cases: as for the same comprehensions without unpacking.
    expect(f.callables.map((c) => [c.name, c.complexity, c.contributions.loop, c.contributions.if, c.contributions.case])).toEqual([['g', 9, 5, 1, 2]]);
    expect(f.declarations.map((d) => d.name)).toEqual(['lazy', 'g']);
  });

  it('rejects a lazy __future__ import, as CPython 3.15 does, and nothing else about lazy imports', () => {
    const f = facts('import os\nlazy from __future__ import annotations\n');
    expect(f.parseStatus).toBe('failed');
    expect(f.failureReason).toBe('SYNTAX_ERROR');
    expect(f.parseErrors).toEqual([{ code: 1, range: { startOffset: 10, endOffset: 49, startLine: 2, startColumn: 1, endLine: 2, endColumn: 40 } }]);
    expect(f.imports).toEqual([]);
    // Scope and wildcard rules are compile-time checks in CPython; the parser accepts them,
    // and every one is still a dependency.
    const scoped = facts(['lazy from os import *', 'def f():', '    lazy import a', 'class C:', '    lazy import b', 'try:', '    lazy import c', 'except ImportError:', '    pass', ''].join('\n'));
    expect(scoped.parseStatus).toBe('parsed');
    expect(imports(scoped)).toEqual([
      ['imports-value', 'os', null, false],
      ['imports-value', 'a', null, false],
      ['imports-value', 'b', null, false],
      ['imports-value', 'c', null, true],
    ]);
    expect(scoped.imports[0]!.wildcard).toBe(true);
  });

  it('reports a syntax error as a failed parse with ranges, and claims nothing else', () => {
    const f = facts('import os\ndef broken(:\n    pass\n');
    expect(f.parseStatus).toBe('failed');
    expect(f.failureReason).toBe('SYNTAX_ERROR');
    expect(f.parseErrors.length).toBeGreaterThan(0);
    expect(f.parseErrors[0]!.range.startLine).toBe(2);
    expect(f.imports).toEqual([]);
    expect(f.codeLines).toBeNull();
    expect(f.complexity).toBeNull();
    expect(f.physicalLines).toBe(3);
  });

  it('uses UTF-16 offsets and columns, like the TypeScript compiler', () => {
    const text = 's = "é😀"\nimport os\n';
    const [imp] = facts(text).imports;
    expect(imp!.range).toEqual({ startOffset: 17, endOffset: 19, startLine: 2, startColumn: 8, endLine: 2, endColumn: 10 });
    expect(text.slice(imp!.range.startOffset, imp!.range.endOffset)).toBe('os');
  });
});

describe('Python imports', () => {
  it('records every import form with its kind, specifier, guard and binding', () => {
    const f = facts(
      [
        'import os',
        'import os.path as osp, sys',
        'from . import sibling',
        'from ..pkg.mod import a, b as c',
        'from x import *',
        'from __future__ import annotations',
        'import importlib, importlib.util',
        'from importlib import import_module as im',
        'mod = importlib.import_module("plugins.alpha")',
        'rel = importlib.import_module(".beta", package=__package__)',
        'bad = importlib.import_module(".gamma")',
        'dyn = im(name)',
        'old = __import__("json")',
        'fmt = importlib.import_module(f"plugins.{name}")',
        'from typing import TYPE_CHECKING',
        'if TYPE_CHECKING:',
        '    from heavy import Thing',
        'else:',
        '    from light import Thing',
        'try:',
        '    import ujson as json',
        'except ImportError:',
        '    import json',
        'def f():',
        '    import inner',
        '',
      ].join('\n'),
    );
    expect(imports(f)).toEqual([
      ['imports-value', 'os', null, false],
      ['imports-value', 'os.path', null, false],
      ['imports-value', 'sys', null, false],
      ['imports-value', '.', null, false],
      ['imports-value', '..pkg.mod', null, false],
      ['imports-value', 'x', null, false],
      ['imports-value', 'importlib', null, false],
      ['imports-value', 'importlib.util', null, false],
      ['imports-value', 'importlib', null, false],
      ['imports-dynamic-literal', 'plugins.alpha', null, false],
      ['imports-dynamic-literal', '.beta', null, false],
      ['imports-dynamic-literal', '.gamma', 'RELATIVE_DYNAMIC_IMPORT_WITHOUT_PACKAGE', false],
      ['imports-dynamic-literal', null, 'NONLITERAL_DYNAMIC_IMPORT', false],
      ['imports-dynamic-literal', 'json', null, false],
      ['imports-dynamic-literal', null, 'NONLITERAL_DYNAMIC_IMPORT', false],
      ['imports-value', 'typing', null, false],
      ['imports-type', 'heavy', null, false],
      ['imports-value', 'light', null, false],
      ['imports-value', 'ujson', null, true],
      ['imports-value', 'json', null, false],
      ['imports-value', 'inner', null, false],
    ]);
    const from = f.imports[4]!;
    expect(from.names!.map((n) => [n.name, n.alias])).toEqual([
      ['a', null],
      ['b', 'c'],
    ]);
    expect(f.imports[5]!.wildcard).toBe(true);
    expect(f.imports[3]!.names!.map((n) => n.name)).toEqual(['sibling']);
    expect(f.imports.every((i) => i.specifier === null || i.specifier !== '__future__')).toBe(true);
  });

  it('records lazy imports like the imports they wrap: kinds, names, re-exports, guards (ADR-080)', () => {
    const f = facts(
      [
        'from typing import TYPE_CHECKING',
        'lazy import os.path as osp, sys',
        'lazy from ..pkg.mod import (a, b as c)',
        'lazy from . import sibling',
        'if TYPE_CHECKING:',
        '    lazy from heavy import Thing',
        'lazy import importlib',
        'm = importlib.import_module("plugins.alpha")',
        '',
      ].join('\n'),
    );
    expect(imports(f)).toEqual([
      ['imports-value', 'typing', null, false],
      ['imports-value', 'os.path', null, false],
      ['imports-value', 'sys', null, false],
      ['imports-value', '..pkg.mod', null, false],
      ['imports-value', '.', null, false],
      ['imports-type', 'heavy', null, false],
      ['imports-value', 'importlib', null, false],
      ['imports-dynamic-literal', 'plugins.alpha', null, false],
    ]);
    expect(f.imports[3]!.names!.map((n) => [n.name, n.alias])).toEqual([['a', null], ['b', 'c']]);
    const init = facts('lazy from .a import x as x\nlazy import b as b\n', 'pkg/__init__.py');
    expect(init.imports.map((i) => [i.specifier, i.kind])).toEqual([['.a', 'reexports-value'], ['b', 'reexports-value']]);
  });

  it('finds a dynamic import that is the only element of an unpacked list (ADR-080 grammar)', () => {
    // tree-sitter-python 0.25.0 parsed `[*a.b(...)]` as `(*a).b(...)`; the 3.15 patch parses
    // it as `*(a.b(...))`, as it already did with more than one element.
    const f = facts('import importlib\nmods = [*importlib.import_module("plugins").ALL]\nmore = [*__import__("json").x, 1]\n');
    expect(imports(f)).toEqual([
      ['imports-value', 'importlib', null, false],
      ['imports-dynamic-literal', 'plugins', null, false],
      ['imports-dynamic-literal', 'json', null, false],
    ]);
  });

  it('ignores calls that only look like dynamic imports when nothing binds them', () => {
    const f = facts('def import_module(x): pass\nimport_module("a")\nlib.import_module("b")\n');
    expect(f.imports).toEqual([]);
  });

  it('marks re-exports in a package __init__ by the PEP 484 rule, and stubs as type-only', () => {
    const init = facts(['from .a import x as x', 'from .b import y', 'from .c import z', 'from .d import *', '__all__ = ["y"]', ''].join('\n'), 'pkg/__init__.py');
    expect(init.imports.map((i) => [i.specifier, i.kind])).toEqual([
      ['.a', 'reexports-value'],
      ['.b', 'reexports-value'],
      ['.c', 'imports-value'],
      ['.d', 'reexports-value'],
    ]);
    // The same statements outside an __init__ are plain imports.
    expect(facts('from .a import x as x\n', 'pkg/mod.py').imports[0]!.kind).toBe('imports-value');
    const stub = facts('from .a import x as x\nimport os\n', 'pkg/__init__.pyi');
    expect(stub.imports.map((i) => i.kind)).toEqual(['reexports-type', 'imports-type']);
  });

  it('treats typing.TYPE_CHECKING like TYPE_CHECKING, and guards only the try body', () => {
    const f = facts(['import typing', 'if typing.TYPE_CHECKING:', '    import a', 'try:', '    import b', 'except Exception:', '    import c', 'try:', '    import d', 'except KeyError:', '    pass', ''].join('\n'));
    expect(imports(f)).toEqual([
      ['imports-value', 'typing', null, false],
      ['imports-type', 'a', null, false],
      ['imports-value', 'b', null, true],
      ['imports-value', 'c', null, false],
      ['imports-value', 'd', null, false],
    ]);
  });
});

describe('Python declarations', () => {
  it('lists module-level definitions with Python kinds and export rules', () => {
    const f = facts(
      [
        'from typing import Protocol, TypeAlias, TypedDict',
        'from enum import Enum',
        'import enum',
        '@decorator',
        'def run(): pass',
        'async def fetch(): pass',
        'class Shape(Protocol): pass',
        'class Color(enum.IntEnum): pass',
        'class Opts(TypedDict): pass',
        'class Plain: pass',
        'type Vec = list[float]',
        'Path: TypeAlias = str',
        'a, (b, *rest) = 1, (2, 3)',
        'x = y = 0',
        '_private = 1',
        'obj.attr = 2',
        'if True:',
        '    def inside_if(): pass',
        'try:',
        '    import fast',
        'except ImportError:',
        '    fast = None',
        'def outer():',
        '    nested = 1',
        '',
      ].join('\n'),
    );
    expect(f.declarations.map((d) => [d.name, d.kind, d.exported])).toEqual([
      ['run', 'function', true],
      ['fetch', 'function', true],
      ['Shape', 'interface', true],
      ['Color', 'enum', true],
      ['Opts', 'interface', true],
      ['Plain', 'class', true],
      ['Vec', 'type', true],
      ['Path', 'type', true],
      ['a', 'variable', true],
      ['b', 'variable', true],
      ['rest', 'variable', true],
      ['x', 'variable', true],
      ['y', 'variable', true],
      ['_private', 'variable', false],
      ['inside_if', 'function', true],
      ['fast', 'variable', true],
      ['outer', 'function', true],
    ]);
    // A decorated definition's range starts at its decorator.
    expect(f.declarations[0]!.range.startLine).toBe(4);
  });

  it('follows a literal __all__, including += and extend, and falls back for a dynamic one', () => {
    const f = facts(['__all__ = ["a"]', '__all__ += ["b"]', '__all__.extend(["c"])', 'a = b = c = d = 1', ''].join('\n'));
    expect(f.declarations.filter((d) => d.name !== '__all__').map((d) => [d.name, d.exported])).toEqual([
      ['a', true],
      ['b', true],
      ['c', true],
      ['d', false],
    ]);
    const dynamic = facts(['__all__ = names()', 'e = 1', '_f = 2', ''].join('\n'));
    expect(dynamic.declarations.filter((d) => d.name !== '__all__').map((d) => [d.name, d.exported])).toEqual([
      ['e', true],
      ['_f', false],
    ]);
  });
});

describe('Python lines', () => {
  it('counts code lines without comments, blank lines or docstrings', () => {
    const text = [
      '"""Module docstring.', //  1 docstring
      '', //                          2
      'More text.', //                3
      '"""', //                       4
      '# comment', //                 5
      '', //                          6
      'import os', //                 7 code
      '', //                          8
      'x = 1 + \\', //                9 code
      '    2', //                    10 code
      's = """a', //                 11 code (a string value, not a docstring)
      'b"""', //                     12 code
      'def f(a):', //                13 code
      '    """Doc."""', //           14 docstring
      '    return a  # trailing', // 15 code
      'class C:', //                 16 code
      '    f"not a doc {x}"', //     17 code: an f-string is an expression
      '    y = 2', //                18 code
      '',
    ].join('\n');
    const f = facts(text);
    expect(f.physicalLines).toBe(18);
    expect(f.codeLines).toBe(10);
  });
});

describe('Python details the CPython oracle found', () => {
  it('treats capture patterns as defaults, but a one-element sequence or a value pattern as decisions', () => {
    const f = facts(['def f(x):', '    match x:', '        case Color.RED: pass', '        case y,: pass', '        case (z): pass', '', 'def g(x):', '    match x:', '        case 1: pass', '        case other: pass', ''].join('\n'));
    expect(f.callables.map((c) => [c.name, c.complexity])).toEqual([
      ['f', 3],
      ['g', 2],
    ]);
  });

  it('counts string text on every line, blank lines inside included, but not comments inside f-string fields', () => {
    const text = ['s = """', '', 'text with \\n escape', '"""', "t = f'''{", '# comment inside a replacement field', "1}'''", ''].join('\n');
    // Lines 1-4 (the string, blank line included), 5 and 7; line 6 is a comment.
    expect(facts(text).codeLines).toBe(6);
  });
});

describe('Python complexity', () => {
  it('counts decisions per callable with their contributions, Python defaults and kinds', () => {
    const f = facts(
      [
        'def score(items, mode=1 if X else 2):',
        '    total = 0',
        '    for item in items:',
        '        if item > 3 and item < 9:',
        '            total += 1',
        '        elif item == 0 or item == 1 or item == 2:',
        '            total -= 1',
        '    while total > 100:',
        '        total //= 2',
        '    evens = [i for i in items if i % 2 == 0]',
        '    try:',
        '        risky()',
        '    except (ValueError, KeyError):',
        '        pass',
        '    except OSError:',
        '        pass',
        '    label = "big" if total > 10 else "small"',
        '    match mode:',
        '        case 1: pass',
        '        case 2 if total: pass',
        '        case _: pass',
        '    key = lambda v: v if v else 0',
        '    return total',
        'class Box:',
        '    def __init__(self): pass',
        '    @property',
        '    def size(self): return 1',
        '    @size.setter',
        '    def size(self, v): pass',
        '    def grow(self): return [x for x in y]',
        'compose = lambda f: lambda g: f if g else g',
        '',
      ].join('\n'),
    );
    const byName = new Map(f.callables.map((c) => [c.name, c]));
    expect(byName.get('score')).toMatchObject({ kind: 'function', complexity: 15, contributions: { if: 3, loop: 3, catch: 2, conditional: 1, case: 2, logical: 3 } });
    expect(byName.get('key')).toMatchObject({ kind: 'arrow', complexity: 2, contributions: { conditional: 1 } });
    expect(byName.get('__init__')).toMatchObject({ kind: 'constructor', complexity: 1 });
    expect(byName.get('get size')).toMatchObject({ kind: 'getter', complexity: 1 });
    expect(byName.get('set size')).toMatchObject({ kind: 'setter', complexity: 1 });
    expect(byName.get('grow')).toMatchObject({ kind: 'method', complexity: 2, contributions: { loop: 1 } });
    // A lambda returning a lambda: two callables, the inner one owning the conditional.
    expect(byName.get('compose')).toMatchObject({ complexity: 1 });
    expect(f.callables.find((c) => c.name === 'lambda (line 31)')).toMatchObject({ kind: 'arrow', complexity: 2 });
    expect(f.complexity).toEqual({ callableCount: 8, maxCyclomatic: 15, sumCyclomatic: 15 + 2 + 1 + 1 + 1 + 2 + 1 + 2 });
  });
});
