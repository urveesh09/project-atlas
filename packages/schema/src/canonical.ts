import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const encoder = new TextEncoder();

export function utf8Bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

export function utf8ByteLength(value: string): number {
  // Native scanning skips long ASCII spans; visit only code units requiring extra UTF-8 bytes.
  let bytes = value.length;
  const nonAscii = /[^\x00-\x7f]/g;
  let match: RegExpExecArray | null;
  while ((match = nonAscii.exec(value)) !== null) {
    const i = match.index,
      code = value.charCodeAt(i);
    if (code < 0x800) bytes++;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < value.length &&
      value.charCodeAt(i + 1) >= 0xdc00 &&
      value.charCodeAt(i + 1) <= 0xdfff
    ) {
      bytes += 2;
      nonAscii.lastIndex++;
    } else bytes += 2;
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
  return write(value, [], new Set(), new Map());
}

/** Join complete child values, rather than retaining millions of punctuation tokens. */
function write(value: unknown, path: (string | number)[], stack: Set<object>, keys: Map<string, string>): string {
  const at = () => '$' + path.map((part) => (typeof part === 'number' ? `[${part}]` : `.${part}`)).join('');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError('Non-finite number', at());
      return String(value);
    case 'string':
      if (!value.isWellFormed()) throw new CanonicalJsonError('Ill-formed Unicode string', at());
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new CanonicalJsonError(`Unsupported ${typeof value} value`, at());
  }
  const object = value as object;
  if (stack.has(object)) throw new CanonicalJsonError('Cyclic structure', at());
  stack.add(object);
  const parts: string[] = [];
  let result: string;
  if (Array.isArray(object)) {
    for (let i = 0; i < object.length; i++) {
      path.push(i);
      parts.push(write(object[i], path, stack, keys));
      path.pop();
    }
    result = '[' + parts.join(',') + ']';
  } else {
    const proto = Object.getPrototypeOf(object);
    if (proto !== Object.prototype && proto !== null) throw new CanonicalJsonError('Non-plain object', at());
    for (const key of Object.keys(object).sort()) {
      const child = (object as Record<string, unknown>)[key];
      if (child === undefined) throw new CanonicalJsonError(`Undefined value for "${key}"`, at());
      let quoted = keys.get(key);
      if (quoted === undefined) {
        if (!key.isWellFormed()) throw new CanonicalJsonError('Ill-formed Unicode key', at());
        quoted = JSON.stringify(key);
        if (keys.size < 512) keys.set(key, quoted);
      }
      path.push(key);
      parts.push(quoted + ':' + write(child, path, stack, keys));
      path.pop();
    }
    result = '{' + parts.join(',') + '}';
  }
  stack.delete(object);
  return result;
}
export function canonicalJsonSha256(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
