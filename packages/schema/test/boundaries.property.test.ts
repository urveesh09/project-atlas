import fc from 'fast-check';
import { expect, it } from 'vitest';
import { CanonicalJsonError, LIMITS, canonicalJson, canonicalJsonChunks, canonicalJsonDigest, canonicalValueEqual, checkRepoPath, repoAncestors, repoBasename, repoDirname, sha256Hex } from '@atlas/schema';
import { boundedJson } from '../../../scripts/lib/property-arbitraries.js';

const parameters = { seed: 0x41544c41, numRuns: 250 };
const json = boundedJson(4);
// Include lone surrogates and controls, which default printable-string generators miss.
const text = fc.array(fc.integer({ min: 0, max: 0xffff }), { maxLength: 256 }).map((units) => String.fromCharCode(...units));

it('canonical JSON round-trips exactly and all writers/hashers agree', () => {
  fc.assert(fc.property(json, (value) => {
    const encoded = canonicalJson(value);
    const decoded: unknown = JSON.parse(encoded);
    expect(canonicalJson(decoded)).toBe(encoded);
    expect(canonicalValueEqual(value, decoded)).toBe(true);
    expect([...canonicalJsonChunks(value)].join('')).toBe(encoded);
    expect(canonicalJsonDigest(value)).toEqual({ sha256: sha256Hex(encoded), byteLength: Buffer.byteLength(encoded) });
  }), parameters);
});

it('arbitrary UTF-16 is either preserved exactly or rejected with CanonicalJsonError', () => {
  fc.assert(fc.property(text, (value) => {
    if (value.isWellFormed()) expect(JSON.parse(canonicalJson({ [value]: value }))).toEqual({ [value]: value });
    else expect(() => canonicalJson({ [value]: value })).toThrow(CanonicalJsonError);
  }), parameters);
});

it('accepted repository paths preserve case/Unicode and cannot escape or name Git metadata', () => {
  const segment = fc.stringMatching(/^[A-Za-z0-9_é]{1,12}$/);
  const valid = fc.array(segment, { minLength: 1, maxLength: 12 }).map((parts) => parts.join('/'));
  fc.assert(fc.property(fc.oneof(text, valid), (value) => {
    const result = checkRepoPath(value);
    if (!result.ok) {
      expect(['EMPTY', 'ABSOLUTE', 'BACKSLASH', 'NUL', 'CONTROL_CHARACTER', 'DOT_SEGMENT', 'EMPTY_SEGMENT', 'GIT_METADATA', 'ILL_FORMED_UNICODE', 'TOO_LONG', 'TOO_DEEP']).toContain(result.reason);
      return;
    }
    expect(value.isWellFormed()).toBe(true);
    expect(Buffer.byteLength(value)).toBeLessThanOrEqual(LIMITS.pathBytes);
    expect(value).not.toMatch(/^(?:\/|[A-Za-z]:)|[\\\u0000-\u001f\u007f-\u009f]/);
    for (const part of value.split('/')) expect(['', '.', '..', '.git']).not.toContain(part.toLowerCase());
    const parent = repoDirname(value);
    expect(parent ? `${parent}/${repoBasename(value)}` : repoBasename(value)).toBe(value);
    for (const ancestor of repoAncestors(value)) expect(value.startsWith(`${ancestor}/`)).toBe(true);
  }), parameters);
});

it('unsafe path segments are rejected rather than normalized into another identity', () => {
  fc.assert(fc.property(fc.stringMatching(/^[a-z]{1,20}$/), fc.constantFrom('.', '..', '.git', '.GiT', ''), (safe, unsafe) => {
    expect(checkRepoPath(`${safe}/${unsafe}/file.py`).ok).toBe(false);
    expect(checkRepoPath(`${safe}\\file.py`).ok).toBe(false);
  }), parameters);
});

it('path admission applies the byte cap to multibyte Unicode at the boundary', () => {
  fc.assert(fc.property(fc.integer({ min: 2040, max: 2052 }), (length) => {
    const path = 'é'.repeat(length);
    expect(checkRepoPath(path)).toEqual(length * 2 <= LIMITS.pathBytes ? { ok: true } : { ok: false, reason: 'TOO_LONG' });
  }), parameters);
});
