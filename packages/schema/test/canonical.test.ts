import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  canonicalJsonChunks,
  canonicalJsonDigest,
  canonicalJsonEqual,
  checkRepoPath,
  compareUtf8,
  hashFields,
  isCompatibleContractVersion,
  makeId,
  nodeId,
  repoExtension,
  sha256Hex,
  utf8ByteLength,
} from '@atlas/schema';

describe('sha256Hex', () => {
  it('matches independent SHA-256 for empty, Unicode, binary and varied identity inputs', async () => {
    const { createHash } = await import('node:crypto');
    const inputs: (string | Uint8Array)[] = ['', 'abc', 'é😀\u0000', Uint8Array.from({ length: 256 }, (_, i) => i)];
    for (let i = 0; i < 256; i++) inputs.push(`atlas.id/1:obs:${i}:src/module-${i}.ts`);
    for (const input of inputs) expect(sha256Hex(input)).toBe(createHash('sha256').update(input).digest('hex'));
  });
});

describe('canonicalJson', () => {
  it('reads object properties once, matching the existing canonical writer', () => {
    let reads = 0;
    const value = { get a() { return ++reads; } };
    expect(canonicalJson(value)).toBe('{"a":1}');
    expect(reads).toBe(1);
    reads = 0;
    expect([...canonicalJsonChunks(value)].join('')).toBe('{"a":1}');
    expect(reads).toBe(1);
  });

  it('streams exactly the same canonical UTF-8 across Unicode boundaries and large row arrays', async () => {
    const { createHash } = await import('node:crypto');
    const inputs: unknown[] = [null, -0, { '2': 2, '10': 10 }, ...[65533, 65534, 65535].map((n) => 'a'.repeat(n) + '😀é')];
    inputs.push({ rows: Array.from({ length: 3000 }, (_, i) => ({ b: ['é😀', i], a: { '10': 0, '2': true } })), coverage: { z: null } });
    for (const input of inputs) {
      const text = canonicalJson(input);
      const chunks = [...canonicalJsonChunks(input)];
      expect(chunks.join('')).toBe(text);
      expect(Buffer.concat(chunks.map((s) => Buffer.from(s)))).toEqual(Buffer.from(text));
      expect(chunks.every((s) => s.length <= 65536 && s.isWellFormed())).toBe(true);
      expect(canonicalJsonDigest(input)).toEqual({ sha256: createHash('sha256').update(text).digest('hex'), byteLength: Buffer.byteLength(text) });
    }
    const rows = Array.from({ length: 3000 }, (_, i) => ({ b: '😀', a: i }));
    expect(canonicalJsonEqual({ rows, x: null }, { x: null, rows: rows.map(({ a, b }) => ({ a, b })) })).toBe(true);
    const changed = structuredClone(rows);
    changed.at(-1)!.a++;
    expect(canonicalJsonEqual({ rows }, { rows: changed })).toBe(false);
  });

  it('preserves canonical rejection of invalid values and ancestor cycles when streaming', () => {
    const cycle: unknown[] = [];
    cycle.push({ back: cycle });
    for (const input of [cycle, { a: undefined }, { a: NaN }, { a: new Date() }, { '\ud800': 1 }, ['\ud800'], [() => 1]]) {
      expect(() => canonicalJson(input)).toThrow();
      expect(() => [...canonicalJsonChunks(input)]).toThrow();
      expect(() => canonicalJsonDigest(input)).toThrow();
    }
  });

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

  it('keeps lexicographic numeric keys and Unicode exact across serialization block boundaries', () => {
    const row = { '2': 'é😀', '10': -0, '\u0001': [null, true, 1.25] };
    const expected = '{"\\u0001":[null,true,1.25],"10":0,"2":"é😀"}';
    expect(canonicalJson(Array.from({ length: 3000 }, () => row))).toBe(`[${Array(3000).fill(expected).join(',')}]`);
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

  it('matches independent binary field framing for multibyte strings and safe integers', async () => {
    const { createHash } = await import('node:crypto');
    const fields = ['é😀', 9007199254740991, null, 'a:10\u0000b'] as const;
    const frame = (tag: string, value: string) => Buffer.concat([Buffer.from(`${tag}${Buffer.byteLength(value)}:`), Buffer.from(value)]);
    const bytes = Buffer.concat([frame('d', 'atlas.test'), ...fields.map((f) => f === null ? frame('z', '') : frame(typeof f === 'number' ? 'n' : 's', String(f)))]);
    expect(hashFields('atlas.test', fields)).toBe(createHash('sha256').update(bytes).digest('hex'));
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
