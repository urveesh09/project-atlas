import { sha256 } from '@noble/hashes/sha2.js';

const encoder = new TextEncoder();
const hexPairs = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, '0'));

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
  // Joining bounded pairs produces a flat digest. Repeated concatenation can retain
  // a rope of intermediate strings for each of millions of graph IDs (ADR-036).
  const digest = sha256(typeof data === 'string' ? utf8Bytes(data) : data);
  return digestHex(digest);
}

function digestHex(digest: Uint8Array): string {
  return Array.from(digest, (byte) => hexPairs[byte]!).join('');
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

/**
 * The same canonical text in UTF-8-safe chunks, without joining all root collection
 * rows into one document string. A nested row/scalar is serialized by the shared
 * writer; temporary memory is bounded by that row, rather than the whole graph.
 */
export function* canonicalJsonChunks(value: unknown): Generator<string> {
  const path: (string | number)[] = [];
  const stack = new Set<object>();
  const keys = new Map<string, string>();
  function* fragments(child: unknown): Generator<string> {
    if (child === null || typeof child !== 'object') {
      yield write(child, path, stack, keys);
      return;
    }
    if (stack.has(child)) throw new CanonicalJsonError('Cyclic structure', '$' + path.map((p) => typeof p === 'number' ? `[${p}]` : `.${p}`).join(''));
    if (Array.isArray(child)) {
      stack.add(child);
      yield '[';
      for (let i = 0; i < child.length; i++) {
        if (i > 0) yield ',';
        path.push(i);
        // Graph/history rows are small subtrees. Arrays nested directly in arrays
        // still stream, and the shared stack detects references to any ancestor.
        if (Array.isArray(child[i])) yield* fragments(child[i]);
        else yield write(child[i], path, stack, keys);
        path.pop();
      }
      yield ']';
      stack.delete(child);
      return;
    }
    const proto = Object.getPrototypeOf(child);
    if (proto !== Object.prototype && proto !== null) {
      yield write(child, path, stack, keys); // Reuse the canonical error contract.
      return;
    }
    stack.add(child);
    yield '{';
    const sorted = Object.keys(child).sort();
    for (let i = 0; i < sorted.length; i++) {
      if (i > 0) yield ',';
      const key = sorted[i]!;
      const at = () => '$' + path.map((p) => typeof p === 'number' ? `[${p}]` : `.${p}`).join('');
      if (!key.isWellFormed()) throw new CanonicalJsonError('Ill-formed Unicode key', at());
      if ((child as Record<string, unknown>)[key] === undefined) throw new CanonicalJsonError(`Undefined value for "${key}"`, at());
      yield write(key, path, stack, keys);
      yield ':';
      path.push(key);
      yield* fragments((child as Record<string, unknown>)[key]);
      path.pop();
    }
    yield '}';
    stack.delete(child);
  }
  const size = 64 * 1024;
  let pending = '';
  for (const fragment of fragments(value)) {
    pending += fragment;
    while (pending.length >= size) {
      // TextEncoder operates on each chunk independently: never split a surrogate.
      const code = pending.charCodeAt(size - 1);
      const end = code >= 0xd800 && code <= 0xdbff ? size - 1 : size;
      yield pending.slice(0, end);
      pending = pending.slice(end);
    }
  }
  if (pending.length > 0) yield pending;
}

/** Exact canonical text equality; unlike digest comparison, this has no collision assumption. */
export function canonicalJsonEqual(a: unknown, b: unknown): boolean {
  const left = canonicalJsonChunks(a);
  const right = canonicalJsonChunks(b);
  for (;;) {
    const x = left.next();
    const y = right.next();
    if (x.done || y.done) return x.done === y.done;
    if (x.value !== y.value) return false;
  }
}

export function canonicalJsonDigest(value: unknown): { sha256: string; byteLength: number } {
  const hash = sha256.create();
  let byteLength = 0;
  for (const chunk of canonicalJsonChunks(value)) {
    const bytes = utf8Bytes(chunk);
    hash.update(bytes);
    byteLength += bytes.length;
  }
  return { sha256: digestHex(hash.digest()), byteLength };
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
