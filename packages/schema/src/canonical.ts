import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const encoder = new TextEncoder();

export function utf8Bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

export function utf8ByteLength(value: string): number {
  // Fast path for ASCII; exact count otherwise without allocating.
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

export function sha256Hex(data: Uint8Array | string): string {
  return bytesToHex(sha256(typeof data === 'string' ? utf8Bytes(data) : data));
}

/**
 * Compare two strings by their UTF-8 byte sequences (equivalently, by Unicode code
 * points). This is the canonical repository path order (plan §7.1); JavaScript's default
 * string comparison uses UTF-16 code units, which differs for astral characters.
 */
export function compareUtf8(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    if (ca === cb) continue;
    const pa = a.codePointAt(i)!;
    const pb = b.codePointAt(i)!;
    return pa < pb ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** ASCII/ID comparison used for sorting hash-derived identifiers. */
export function compareAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class CanonicalJsonError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} at ${path}`);
    this.name = 'CanonicalJsonError';
  }
}

/**
 * Canonical JSON in the spirit of RFC 8785 (JCS): no insignificant whitespace, object
 * keys sorted by UTF-16 code units, ECMAScript number formatting. Rejects values that
 * have no canonical form: undefined, functions, non-finite numbers, non-plain objects
 * and ill-formed Unicode strings.
 */
export function canonicalJson(value: unknown): string {
  const parts: string[] = [];
  write(value, '$', parts, new Set());
  return parts.join('');
}

function write(value: unknown, path: string, out: string[], stack: Set<object>): void {
  if (value === null) {
    out.push('null');
    return;
  }
  switch (typeof value) {
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError('Non-finite number', path);
      out.push(Object.is(value, -0) ? '0' : JSON.stringify(value));
      return;
    case 'string':
      if (!value.isWellFormed()) throw new CanonicalJsonError('Ill-formed Unicode string', path);
      out.push(JSON.stringify(value));
      return;
    case 'object':
      break;
    default:
      throw new CanonicalJsonError(`Unsupported ${typeof value} value`, path);
  }
  const object = value as object;
  if (stack.has(object)) throw new CanonicalJsonError('Cyclic structure', path);
  stack.add(object);
  if (Array.isArray(object)) {
    out.push('[');
    for (let i = 0; i < object.length; i++) {
      if (i > 0) out.push(',');
      write(object[i], `${path}[${i}]`, out, stack);
    }
    out.push(']');
  } else {
    const proto = Object.getPrototypeOf(object);
    if (proto !== Object.prototype && proto !== null) {
      throw new CanonicalJsonError('Non-plain object', path);
    }
    const keys = Object.keys(object).sort();
    out.push('{');
    let first = true;
    for (const key of keys) {
      const child = (object as Record<string, unknown>)[key];
      if (child === undefined) throw new CanonicalJsonError(`Undefined value for "${key}"`, path);
      if (!key.isWellFormed()) throw new CanonicalJsonError('Ill-formed Unicode key', path);
      if (!first) out.push(',');
      first = false;
      out.push(JSON.stringify(key), ':');
      write(child, `${path}.${key}`, out, stack);
    }
    out.push('}');
  }
  stack.delete(object);
}

export function canonicalJsonSha256(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
