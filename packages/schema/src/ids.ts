import { sha256Hex, utf8Bytes } from './canonical.js';

/**
 * Readable type prefixes for hash-derived identifiers (plan §6.1, §7.1). Every ID is
 * `<prefix>_<64 lowercase hex>`; Git object IDs keep their native format instead.
 */
export const ID_PREFIXES = {
  repository: 'repo',
  snapshot: 'snap',
  node: 'node',
  lineage: 'lin',
  observation: 'obs',
  edge: 'edge',
  diagnostic: 'diag',
  scc: 'scc',
  district: 'dist',
  layout: 'layout',
  history: 'hist',
  analysisKey: 'akey',
  analysis: 'analysis',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdKind];

export type HashField = string | number | null;

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Hash an ordered list of fields without ambiguity. Each field is framed as
 * `<type-tag><decimal byte length>:<bytes>` so no concatenation of distinct field lists
 * can collide (plan §7.1: "never ambiguous string concatenation").
 */
export function hashFields(domain: string, fields: readonly HashField[]): string {
  const chunks: Uint8Array[] = [];
  const push = (tag: string, payload: Uint8Array) => {
    chunks.push(utf8Bytes(`${tag}${payload.length}:`), payload);
  };
  push('d', utf8Bytes(domain));
  for (const field of fields) {
    if (field === null) push('z', new Uint8Array(0));
    else if (typeof field === 'number') {
      if (!Number.isSafeInteger(field)) throw new TypeError(`Hash field must be a safe integer, got ${field}`);
      push('n', utf8Bytes(String(field)));
    } else {
      if (!field.isWellFormed()) throw new TypeError('Hash field must be well-formed Unicode');
      push('s', utf8Bytes(field));
    }
  }
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  return sha256Hex(buffer);
}

export function makeId(kind: IdKind, fields: readonly HashField[]): string {
  const prefix = ID_PREFIXES[kind];
  return `${prefix}_${hashFields(`atlas.id/1:${prefix}`, fields)}`;
}

export function idPattern(kind: IdKind): RegExp {
  return new RegExp(`^${ID_PREFIXES[kind]}_[0-9a-f]{64}$`);
}

export function isId(kind: IdKind, value: string): boolean {
  return idPattern(kind).test(value);
}

export function isHex64(value: string): boolean {
  return HEX64.test(value);
}

/** Git object IDs: 40 hex (SHA-1) or 64 hex (SHA-256), lowercase. */
export function isGitOid(value: string, format?: 'sha1' | 'sha256'): boolean {
  if (format === 'sha1') return /^[0-9a-f]{40}$/.test(value);
  if (format === 'sha256') return HEX64.test(value);
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

/** Random opaque IDs (analysis IDs) use 32 bytes of CSPRNG output. */
export function randomId(kind: 'analysis'): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return `${ID_PREFIXES[kind]}_${hex}`;
}

// ---------------------------------------------------------------------------------------
// Identity derivations (plan §7.1). Each function documents exactly what it hashes.
// ---------------------------------------------------------------------------------------

/** Hosted repository: `github.com` plus numeric repository ID (stable across renames). */
export function hostedRepositoryId(numericGithubId: string): string {
  if (!/^[1-9]\d{0,19}$/.test(numericGithubId)) throw new TypeError('Invalid GitHub numeric repository ID');
  return makeId('repository', ['github.com', numericGithubId]);
}

/** Local repository: a generated UUID persisted beside the output. */
export function localRepositoryId(uuid: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid)) {
    throw new TypeError('Invalid local repository UUID');
  }
  return makeId('repository', ['local', uuid]);
}

export function snapshotId(repoId: string, commitOid: string, analyzerVersion: string, optionsDigest: string): string {
  return makeId('snapshot', [repoId, commitOid, analyzerVersion, optionsDigest]);
}

export type OccurrenceKind = 'repository' | 'package' | 'directory' | 'file' | 'external-package' | 'builtin';

/** Node occurrence: snapshot + kind + canonical path (or canonical perimeter name). */
export function nodeId(snapshot: string, kind: OccurrenceKind, canonicalKey: string): string {
  return makeId('node', [snapshot, kind, canonicalKey]);
}

export function lineageId(repoId: string, boundaryCommitOid: string, anchorCommitOid: string, originalPath: string): string {
  return makeId('lineage', [repoId, boundaryCommitOid, anchorCommitOid, originalPath]);
}

export interface RangeKey {
  startOffset: number;
  endOffset: number;
}

export function observationId(
  snapshot: string,
  sourceNodeId: string,
  kind: string,
  range: RangeKey,
  specifier: string | null,
): string {
  return makeId('observation', [snapshot, sourceNodeId, kind, range.startOffset, range.endOffset, specifier]);
}

export function edgeId(snapshot: string, sourceIdValue: string, targetIdValue: string, kind: string, confidence: string): string {
  return makeId('edge', [snapshot, sourceIdValue, targetIdValue, kind, confidence]);
}

export function districtId(repoId: string, anchorKind: 'repository' | 'package' | 'directory' | 'direct', anchorPath: string): string {
  return makeId('district', [repoId, anchorKind, anchorPath]);
}
