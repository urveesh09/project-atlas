import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  checkRepoPath,
  compareUtf8,
  hashFields,
  isCompatibleContractVersion,
  makeId,
  nodeId,
  repoExtension,
  utf8ByteLength,
} from '@atlas/schema';

describe('canonicalJson', () => {
  it('sorts keys, drops whitespace and normalizes -0', () => {
    expect(canonicalJson({ b: 1, a: [true, null, -0, 1.5], c: 'x' })).toBe('{"a":[true,null,0,1.5],"b":1,"c":"x"}');
  });

  it('is independent of key insertion order', () => {
    expect(canonicalJson({ z: { y: 1, x: 2 }, a: 0 })).toBe(canonicalJson({ a: 0, z: { x: 2, y: 1 } }));
  });

  it.each([
    ['NaN', { a: Number.NaN }],
    ['Infinity', { a: Number.POSITIVE_INFINITY }],
    ['undefined', { a: undefined }],
    ['lone surrogate', { a: '\ud800' }],
    ['Date', { a: new Date(0) }],
  ])('rejects %s', (_label, value) => {
    expect(() => canonicalJson(value)).toThrow();
  });

  it('rejects cycles', () => {
    const value: Record<string, unknown> = {};
    value['self'] = value;
    expect(() => canonicalJson(value)).toThrow(/Cyclic/);
  });
});

describe('compareUtf8', () => {
  it('orders by code point, not UTF-16 code unit', () => {
    // U+FF5E (BMP, 0xEF 0xBD 0x9E) sorts before U+1F600 (astral, 0xF0 ...) in UTF-8,
    // while UTF-16 code-unit order puts the surrogate (0xD83D) first.
    const bmp = '\uff5e';
    const astral = '\u{1f600}';
    expect(bmp < astral).toBe(false);
    expect(compareUtf8(bmp, astral)).toBe(-1);
    expect(Buffer.compare(Buffer.from(bmp), Buffer.from(astral))).toBe(-1);
  });

  it('agrees with byte comparison on a mixed corpus', () => {
    const corpus = ['a', 'B', 'a/b', 'a.b', 'ä', '\u{10000}', '\uffff', 'Z', 'a b', ''];
    const byBytes = [...corpus].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)));
    expect([...corpus].sort(compareUtf8)).toEqual(byBytes);
  });

  it('counts UTF-8 bytes exactly', () => {
    for (const s of ['', 'abc', 'ä', '€', '\u{1f600}', 'a\ud800b']) {
      expect(utf8ByteLength(s)).toBe(Buffer.byteLength(s, 'utf8'));
    }
  });
});

describe('IDs', () => {
  it('are prefixed lowercase SHA-256 digests', () => {
    expect(makeId('snapshot', ['a'])).toMatch(/^snap_[0-9a-f]{64}$/);
  });

  it('frame fields unambiguously', () => {
    expect(hashFields('d', ['ab', 'c'])).not.toBe(hashFields('d', ['a', 'bc']));
    expect(hashFields('d', ['1'])).not.toBe(hashFields('d', [1]));
    expect(hashFields('d', [null])).not.toBe(hashFields('d', ['']));
  });

  it('separate domains', () => {
    expect(makeId('node', ['x']).slice(5)).not.toBe(makeId('edge', ['x']).slice(5));
  });

  it('are stable (golden values guard accidental derivation changes)', () => {
    // Independently derived: sha256('d10:atlas.tests1:an1:1z0:') with Node crypto.
    expect(hashFields('atlas.test', ['a', 1, null])).toBe('062a4fd19db2e5e4462df41fdb0956ccc9d75a954fdf31f4c3a2fa67607cff4e');
    expect(nodeId('snap_' + '0'.repeat(64), 'file', 'src/a.ts')).toBe(
      'node_4da9a1aa8e835d7baddb35a720f4257f22085468bd69fd63430147226120ca4b',
    );
  });
});

describe('repository paths', () => {
  it.each([
    ['src/a.ts', true],
    ['Ünïcode/ファイル.ts', true],
    ['with space/x', true],
    ['', false],
    ['/abs', false],
    ['C:/abs', false],
    ['a\\b', false],
    ['a/../b', false],
    ['./a', false],
    ['a//b', false],
    ['a/', false],
    ['.git/config', false],
    ['x/.GIT/hooks', false],
    ['a\u0000b', false],
    ['line\nbreak', false],
    ['\ud800', false],
  ])('%j valid=%s', (path, valid) => {
    expect(checkRepoPath(path).ok).toBe(valid);
  });

  it('does not case-fold or normalize', () => {
    expect(checkRepoPath('Readme.md').ok && checkRepoPath('README.md').ok).toBe(true);
    const nfc: string = 'caf\u00e9.ts';
    const nfd: string = 'cafe\u0301.ts';
    expect(checkRepoPath(nfc).ok && checkRepoPath(nfd).ok).toBe(true);
    expect(compareUtf8(nfc, nfd)).not.toBe(0);
    expect(Object.keys(JSON.parse(canonicalJson({ [nfc]: 1, [nfd]: 2 })))).toHaveLength(2);
  });

  it('extracts compound declaration extensions', () => {
    expect(repoExtension('a/b.d.ts')).toBe('.d.ts');
    expect(repoExtension('x.test.TSX')).toBe('.tsx');
    expect(repoExtension('Makefile')).toBe('');
    expect(repoExtension('.eslintrc')).toBe('');
  });
});

describe('contract versions', () => {
  it('accept same-major and reject foreign majors', () => {
    expect(isCompatibleContractVersion('atlas.graph/1.4.0', 'atlas.graph/1.0.0')).toBe(true);
    expect(isCompatibleContractVersion('atlas.graph/2.0.0', 'atlas.graph/1.0.0')).toBe(false);
    expect(isCompatibleContractVersion('atlas.layout/1.0.0', 'atlas.graph/1.0.0')).toBe(false);
    expect(isCompatibleContractVersion('garbage', 'atlas.graph/1.0.0')).toBe(false);
  });
});
