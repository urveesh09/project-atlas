import { sha256 } from '@noble/hashes/sha2.js';

const encoder = new TextEncoder();
const hexCodes = new Uint16Array(512);
for (let byte = 0; byte < 256; byte++) {
  const pair = byte.toString(16).padStart(2, '0');
  hexCodes[byte * 2] = pair.charCodeAt(0);
  hexCodes[byte * 2 + 1] = pair.charCodeAt(1);
}

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

/**
 * SHA-256 is a fixed standard, so Node's native implementation and the portable
 * `@noble/hashes` one produce identical digests. Analysis hashes millions of IDs, so
 * Node uses its native hash when available (obtained synchronously, without a static
 * `node:` import the viewer bundle could not resolve); browsers use the portable one.
 * Tests pin both paths to each other, including lone surrogates (both encoders
 * substitute U+FFFD).
 */
type NodeCrypto = typeof import('node:crypto');
const nodeCrypto = ((globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process?.getBuiltinModule?.('node:crypto') ?? null) as NodeCrypto | null;

interface IncrementalSha256 {
  update(data: Uint8Array | string): void;
  hex(): string;
}

function createSha256(native = nodeCrypto): IncrementalSha256 {
  if (native) {
    const hash = native.createHash('sha256');
    return { update: (data) => void (typeof data === 'string' ? hash.update(data, 'utf8') : hash.update(data)), hex: () => hash.digest('hex') };
  }
  const hash = sha256.create();
  return { update: (data) => void hash.update(typeof data === 'string' ? utf8Bytes(data) : data), hex: () => digestHex(hash.digest()) };
}

const nativeOneShot = typeof nodeCrypto?.hash === 'function' ? nodeCrypto.hash : null;

export function sha256Hex(data: Uint8Array | string): string {
  if (nativeOneShot) return nativeOneShot('sha256', data, 'hex');
  if (nodeCrypto) return nodeCrypto.createHash('sha256').update(data).digest('hex');
  return portableSha256Hex(data);
}

/** The browser path, exported so tests can prove it equals the native digest. */
export function portableSha256Hex(data: Uint8Array | string): string {
  return digestHex(sha256(typeof data === 'string' ? utf8Bytes(data) : data));
}

/**
 * One flat string per digest: repeated concatenation can retain a rope of intermediate
 * strings for each of millions of graph IDs (ADR-036), and mapping through an array
 * allocates per byte.
 */
function digestHex(digest: Uint8Array): string {
  const codes = new Uint16Array(digest.length * 2);
  for (let i = 0; i < digest.length; i++) {
    codes[i * 2] = hexCodes[digest[i]! * 2]!;
    codes[i * 2 + 1] = hexCodes[digest[i]! * 2 + 1]!;
  }
  return String.fromCharCode.apply(null, codes as unknown as number[]);
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
      const value = (child as Record<string, unknown>)[key];
      const at = () => '$' + path.map((p) => typeof p === 'number' ? `[${p}]` : `.${p}`).join('');
      if (!key.isWellFormed()) throw new CanonicalJsonError('Ill-formed Unicode key', at());
      if (value === undefined) throw new CanonicalJsonError(`Undefined value for "${key}"`, at());
      yield write(key, path, stack, keys);
      yield ':';
      path.push(key);
      yield* fragments(value);
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
  return digestChunks(canonicalJsonChunks(value), null)!;
}

/**
 * Whether `other` has exactly `value`'s canonical JSON text, decided without building
 * it: the same plain-JSON shape, key sets and scalars. `===` matches canonical number
 * text, which writes -0 as 0. A value without a canonical form (undefined, NaN,
 * ill-formed strings, functions, non-plain objects, holes) is equal to nothing, not
 * even itself, so the result is true exactly when both texts exist and are identical.
 * Callers compare acyclic graphs; a cycle overflows the stack rather than looping.
 */
export function canonicalValueEqual(value: unknown, other: unknown): boolean {
  if (typeof value !== 'object' || value === null) return value === other && canonicalScalar(value);
  if (typeof other !== 'object' || other === null) return false;
  if (value === other) return plainJsonTree(value);
  if (Array.isArray(value)) {
    if (!Array.isArray(other) || value.length !== other.length) return false;
    for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i) || !Object.hasOwn(other, i) || !canonicalValueEqual(value[i], other[i])) return false;
    return true;
  }
  if (Array.isArray(other) || !isPlainObject(value) || !isPlainObject(other)) return false;
  const keys = Object.keys(value);
  if (keys.length !== Object.keys(other).length) return false;
  for (const key of keys) {
    if (!key.isWellFormed() || !Object.hasOwn(other, key) || !canonicalValueEqual((value as Record<string, unknown>)[key], (other as Record<string, unknown>)[key])) return false;
  }
  return true;
}

/** null, booleans, finite numbers and well-formed strings: the canonical scalars. */
function canonicalScalar(value: unknown): boolean {
  switch (typeof value) {
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'string':
      return value.isWellFormed();
    default:
      return value === null;
  }
}

/** The same object on both sides is equal to itself only when it is plain JSON. */
function plainJsonTree(value: object): boolean {
  const child = (v: unknown) => (typeof v === 'object' && v !== null ? plainJsonTree(v) : canonicalScalar(v));
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i) || !child(value[i])) return false;
    return true;
  }
  if (!isPlainObject(value)) return false;
  for (const key of Object.keys(value)) {
    if (!key.isWellFormed() || !child((value as Record<string, unknown>)[key])) return false;
  }
  return true;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * The digest of `value`'s canonical text, or null when `other`'s canonical text differs.
 * Serializing `value` for its digest also rejects any value without a canonical form;
 * equality is then proven structurally (exactly, with no collision assumption) instead
 * of serializing `other` too.
 */
export function canonicalJsonDigestIfEqual(value: unknown, other: unknown): { sha256: string; byteLength: number } | null {
  const digest = canonicalJsonDigest(value);
  return canonicalValueEqual(value, other) ? digest : null;
}

/** Exposed for tests: the portable incremental path must equal the native one. */
export function canonicalJsonDigestWith(value: unknown, implementation: 'native' | 'portable'): { sha256: string; byteLength: number } {
  return digestChunks(canonicalJsonChunks(value), null, implementation === 'native' ? nodeCrypto : null)!;
}

function digestChunks(chunks: Iterator<string>, other: Iterator<string> | null, native = nodeCrypto): { sha256: string; byteLength: number } | null {
  const hash = createSha256(native);
  let byteLength = 0;
  for (;;) {
    const x = chunks.next();
    if (other) {
      const y = other.next();
      if (x.done !== y.done || x.value !== y.value) return null;
    }
    if (x.done) break;
    hash.update(x.value);
    byteLength += utf8ByteLength(x.value);
  }
  return { sha256: hash.hex(), byteLength };
}

/** Join complete child values, rather than retaining millions of punctuation tokens. */
function write(value: unknown, path: (string | number)[], stack: Set<object>, keys: Map<string, string>): string {
  // Runs for every value in a graph: error paths are formatted only on failure.
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError('Non-finite number', pathText(path));
      return String(value);
    case 'string':
      if (!value.isWellFormed()) throw new CanonicalJsonError('Ill-formed Unicode string', pathText(path));
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new CanonicalJsonError(`Unsupported ${typeof value} value`, pathText(path));
  }
  const object = value as object;
  if (stack.has(object)) throw new CanonicalJsonError('Cyclic structure', pathText(path));
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
    if (proto !== Object.prototype && proto !== null) throw new CanonicalJsonError('Non-plain object', pathText(path));
    for (const key of Object.keys(object).sort()) {
      const child = (object as Record<string, unknown>)[key];
      if (child === undefined) throw new CanonicalJsonError(`Undefined value for "${key}"`, pathText(path));
      let quoted = keys.get(key);
      if (quoted === undefined) {
        if (!key.isWellFormed()) throw new CanonicalJsonError('Ill-formed Unicode key', pathText(path));
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

function pathText(path: readonly (string | number)[]): string {
  return '$' + path.map((part) => (typeof part === 'number' ? `[${part}]` : `.${part}`)).join('');
}

export function canonicalJsonSha256(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
