import { utf8ByteLength } from './canonical.js';
import { LIMITS } from './limits.js';

/**
 * Repository path rules (plan §8.5). A RepoPath is a relative, '/'-separated, case- and
 * Unicode-preserving path inside the analyzed tree. Paths are never normalized (no case
 * folding, no NFC/NFD), so distinct Git paths can never collide on one identity.
 */
export type RepoPathRejection =
  | 'EMPTY'
  | 'ABSOLUTE'
  | 'BACKSLASH'
  | 'NUL'
  | 'CONTROL_CHARACTER'
  | 'DOT_SEGMENT'
  | 'EMPTY_SEGMENT'
  | 'GIT_METADATA'
  | 'ILL_FORMED_UNICODE'
  | 'TOO_LONG'
  | 'TOO_DEEP';

export type RepoPathCheck = { ok: true } | { ok: false; reason: RepoPathRejection };

// C0 controls, DEL and C1 controls. Displayable metadata must not carry them.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export function checkRepoPath(path: string): RepoPathCheck {
  if (path.length === 0) return { ok: false, reason: 'EMPTY' };
  if (!path.isWellFormed()) return { ok: false, reason: 'ILL_FORMED_UNICODE' };
  if (path.includes('\u0000')) return { ok: false, reason: 'NUL' };
  if (path.includes('\\')) return { ok: false, reason: 'BACKSLASH' };
  if (CONTROL.test(path)) return { ok: false, reason: 'CONTROL_CHARACTER' };
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return { ok: false, reason: 'ABSOLUTE' };
  if (utf8ByteLength(path) > LIMITS.pathBytes) return { ok: false, reason: 'TOO_LONG' };
  const segments = path.split('/');
  for (const segment of segments) {
    if (segment.length === 0) return { ok: false, reason: 'EMPTY_SEGMENT' };
    if (segment === '.' || segment === '..') return { ok: false, reason: 'DOT_SEGMENT' };
    if (segment.toLowerCase() === '.git') return { ok: false, reason: 'GIT_METADATA' };
  }
  // A file at depth N has N-1 directory ancestors; nesting beyond the limit is flattened
  // for display, but the canonical path itself must stay within a sane bound.
  if (segments.length > LIMITS.pathBytes / 2) return { ok: false, reason: 'TOO_DEEP' };
  return { ok: true };
}

export function isRepoPath(path: string): boolean {
  return checkRepoPath(path).ok;
}

/** Parent directory of a RepoPath; the repository root is represented by ''. */
export function repoDirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

export function repoBasename(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

/**
 * Lowercased extension including compound declaration suffixes: `a.d.ts` -> `.d.ts`,
 * `b.test.ts` -> `.ts`, `Makefile` -> ''.
 */
export function repoExtension(path: string): string {
  const base = repoBasename(path).toLowerCase();
  for (const compound of ['.d.ts', '.d.mts', '.d.cts']) {
    if (base.endsWith(compound) && base.length > compound.length) return compound;
  }
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot);
}

/** True when `path` equals `ancestor` or lies beneath it. '' is the repository root. */
export function isWithinRepoPath(path: string, ancestor: string): boolean {
  if (ancestor === '') return true;
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

/** Ancestor directories from shallowest to deepest, excluding the root and the path. */
export function repoAncestors(path: string): string[] {
  const segments = path.split('/');
  const out: string[] = [];
  for (let i = 1; i < segments.length; i++) out.push(segments.slice(0, i).join('/'));
  return out;
}

/** Escape control characters for display (plan §8.5). Never used for identity. */
export function escapeForDisplay(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
