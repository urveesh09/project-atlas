import { IngestError } from './errors.js';
import type { SafeGit } from './safe-git.js';

/**
 * Plain, bounded readers over a SafeGit instance. Every parser consumes NUL-framed or
 * length-prefixed Git output and preserves raw path bytes so ordering and identity are
 * never affected by lossy decoding (plan §8.5).
 */

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface ObjectInfo {
  oid: string;
  type: ObjectType | 'missing';
  size: number | null;
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

export function decodeStrictUtf8(bytes: Uint8Array): string | null {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return null;
  }
}

/** `git cat-file --batch-check` for a list of validated OIDs. */
export async function batchCheck(git: SafeGit, oids: readonly string[], signal?: AbortSignal): Promise<ObjectInfo[]> {
  if (oids.length === 0) return [];
  for (const oid of oids) git.assertOid(oid);
  const result = await git.run(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], {
    stdin: `${oids.join('\n')}\n`,
    maxStdoutBytes: oids.length * 160 + 1024,
    ...(signal ? { signal } : {}),
  });
  const lines = result.stdout.toString('utf8').split('\n').filter((l) => l.length > 0);
  if (lines.length !== oids.length) throw new IngestError('GIT_FAILED', 'Unexpected cat-file output');
  return lines.map((line, i) => {
    const parts = line.split(' ');
    if (parts[1] === 'missing') return { oid: oids[i]!, type: 'missing', size: null };
    const [oid, type, size] = parts;
    if (oid !== oids[i] || !['blob', 'tree', 'commit', 'tag'].includes(type!)) {
      throw new IngestError('GIT_FAILED', 'Unexpected cat-file output');
    }
    return { oid: oid!, type: type as ObjectType, size: Number(size) };
  });
}

/**
 * Read whole objects with `git cat-file --batch`. Callers must have size-checked the
 * OIDs; the stdout cap is the sum of declared sizes plus framing.
 */
export async function readObjects(
  git: SafeGit,
  objects: readonly { oid: string; size: number }[],
  signal?: AbortSignal,
): Promise<Map<string, { type: ObjectType; bytes: Buffer }>> {
  const out = new Map<string, { type: ObjectType; bytes: Buffer }>();
  if (objects.length === 0) return out;
  let budget = 0;
  for (const o of objects) {
    git.assertOid(o.oid);
    budget += o.size + 100;
  }
  const result = await git.run(['cat-file', '--batch'], {
    stdin: `${objects.map((o) => o.oid).join('\n')}\n`,
    maxStdoutBytes: budget + 1024,
    ...(signal ? { signal } : {}),
  });
  const buffer = result.stdout;
  let offset = 0;
  for (const expected of objects) {
    const newline = buffer.indexOf(0x0a, offset);
    if (newline === -1) throw new IngestError('GIT_FAILED', 'Truncated cat-file output');
    const header = buffer.subarray(offset, newline).toString('utf8').split(' ');
    if (header[1] === 'missing') throw new IngestError('LOCAL_OBJECT_MISSING', 'A required Git object is missing', { oid: expected.oid });
    const [oid, type, sizeText] = header;
    const size = Number(sizeText);
    if (oid !== expected.oid || !Number.isSafeInteger(size)) throw new IngestError('GIT_FAILED', 'Unexpected cat-file output');
    const start = newline + 1;
    out.set(oid, { type: type as ObjectType, bytes: Buffer.from(buffer.subarray(start, start + size)) });
    offset = start + size + 1; // trailing LF
  }
  return out;
}

export interface CommitObject {
  oid: string;
  tree: string;
  parents: string[];
  /** Committer timestamp in seconds since epoch and its timezone offset (e.g. +0530). */
  committerEpochSeconds: number;
  committerTimezone: string;
}

/**
 * Parse a raw commit. Only structural headers are retained; author/committer identities
 * and the message are deliberately discarded (plan §6.4: no emails or messages).
 */
export function parseCommit(oid: string, raw: Buffer): CommitObject {
  const headerEnd = raw.indexOf('\n\n');
  const header = raw.subarray(0, headerEnd === -1 ? raw.length : headerEnd).toString('utf8');
  let tree: string | null = null;
  const parents: string[] = [];
  let committerEpochSeconds: number | null = null;
  let committerTimezone = '+0000';
  for (const line of header.split('\n')) {
    if (line.startsWith(' ')) continue; // continuation (e.g. gpgsig)
    const space = line.indexOf(' ');
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'tree' && tree === null) tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'committer') {
      const match = / (-?\d+) ([+-]\d{4})$/.exec(value);
      if (match) {
        committerEpochSeconds = Number(match[1]);
        committerTimezone = match[2]!;
      }
    }
  }
  const oidPattern = oid.length === 64 ? /^[0-9a-f]{64}$/ : /^[0-9a-f]{40}$/;
  if (!tree || !oidPattern.test(tree) || parents.some((p) => !oidPattern.test(p)) || committerEpochSeconds === null) {
    throw new IngestError('GIT_FAILED', 'Malformed commit object', { oid });
  }
  return { oid, tree, parents, committerEpochSeconds, committerTimezone };
}

export async function readCommit(git: SafeGit, oid: string, signal?: AbortSignal): Promise<CommitObject> {
  const [info] = await batchCheck(git, [oid], signal);
  if (!info || info.type === 'missing') throw new IngestError('LOCAL_OBJECT_MISSING', 'Commit object is missing', { oid });
  if (info.type !== 'commit') throw new IngestError('REF_NOT_COMMIT', 'Object is not a commit', { oid });
  if (info.size! > 1024 * 1024) throw new IngestError('RESOURCE_LIMIT', 'Commit object too large', { oid });
  const objects = await readObjects(git, [{ oid, size: info.size! }], signal);
  return parseCommit(oid, objects.get(oid)!.bytes);
}

/** Peel annotated tags (bounded) until a commit is reached. */
export async function peelToCommit(git: SafeGit, oid: string, signal?: AbortSignal): Promise<string> {
  let current = oid;
  for (let depth = 0; depth < 10; depth++) {
    const [info] = await batchCheck(git, [current], signal);
    if (!info || info.type === 'missing') throw new IngestError('LOCAL_OBJECT_MISSING', 'Referenced object is missing', { oid: current });
    if (info.type === 'commit') return current;
    if (info.type !== 'tag') throw new IngestError('REF_NOT_COMMIT', 'Reference does not point to a commit');
    const objects = await readObjects(git, [{ oid: current, size: info.size! }], signal);
    const match = /^object ([0-9a-f]+)\n/.exec(objects.get(current)!.bytes.subarray(0, 200).toString('utf8'));
    if (!match) throw new IngestError('GIT_FAILED', 'Malformed tag object');
    current = match[1]!;
  }
  throw new IngestError('REF_NOT_COMMIT', 'Tag chain too deep');
}

export type TreeEntryKind = 'blob' | 'symlink' | 'submodule' | 'unknown';

export interface TreeEntry {
  /** Decoded path, or null when the raw bytes are not valid UTF-8. */
  path: string | null;
  /** Raw path bytes for canonical byte ordering and safe counting. */
  rawPath: Buffer;
  mode: string;
  kind: TreeEntryKind;
  executable: boolean;
  oid: string;
  size: number | null;
}

export interface TreeListing {
  entries: TreeEntry[];
  /** True when the entry cap stopped enumeration (the snapshot must then abort). */
  truncated: boolean;
}

/** Recursively enumerate a tree with NUL framing (`ls-tree -r -l -z`). */
export async function listTree(
  git: SafeGit,
  treeOid: string,
  /**
   * `sizes: false` lists names and IDs only (no blob reads): used to choose blobs for an
   * explicit acquisition request. Analysis always lists with sizes.
   */
  options: { maxEntries: number; recursive?: boolean; signal?: AbortSignal; sizes?: boolean },
): Promise<TreeListing> {
  git.assertOid(treeOid);
  const sizes = options.sizes !== false;
  let result;
  try {
    result = await git.run(['ls-tree', ...(options.recursive === false ? [] : ['-r']), ...(sizes ? ['-l'] : []), '-z', '--full-tree', treeOid], {
      maxStdoutBytes: options.maxEntries * 4_400 + 4096,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (error instanceof IngestError && error.code === 'GIT_FAILED') {
      throw new IngestError('LOCAL_OBJECT_MISSING', 'Tree objects are missing or unreadable', { oid: treeOid });
    }
    throw error;
  }
  const buffer = result.stdout;
  const entries: TreeEntry[] = [];
  let offset = 0;
  let truncated = false;
  while (offset < buffer.length) {
    const end = buffer.indexOf(0, offset);
    const record = buffer.subarray(offset, end === -1 ? buffer.length : end);
    offset = end === -1 ? buffer.length : end + 1;
    if (record.length === 0) continue;
    if (entries.length >= options.maxEntries) {
      truncated = true;
      break;
    }
    const tab = record.indexOf(0x09);
    if (tab === -1) throw new IngestError('GIT_FAILED', 'Malformed ls-tree output');
    const meta = record.subarray(0, tab).toString('utf8').trim().split(/ +/);
    const [mode, type, oid, sizeText] = meta;
    const rawPath = Buffer.from(record.subarray(tab + 1));
    let kind: TreeEntryKind = 'unknown';
    if (type === 'commit' && mode === '160000') kind = 'submodule';
    else if (type === 'blob' && mode === '120000') kind = 'symlink';
    else if (type === 'blob' && (mode === '100644' || mode === '100755')) kind = 'blob';
    // Git prints "BAD" (or "-") as the size of a blob absent from the object store. A
    // missing object is an explicit failure, never a file of unknown or zero size.
    if (sizes && type === 'blob' && (sizeText === undefined || !/^\d{1,15}$/.test(sizeText))) {
      throw new IngestError('LOCAL_OBJECT_MISSING', 'A required Git object is missing', { oid: oid ?? '' });
    }
    entries.push({
      path: decodeStrictUtf8(rawPath),
      rawPath,
      mode: mode!,
      kind,
      executable: mode === '100755',
      oid: oid!,
      size: sizeText === undefined || sizeText === '-' ? null : Number(sizeText),
    });
  }
  return { entries, truncated };
}

export interface RawChange {
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | 'X';
  similarity: number | null;
  oldMode: string;
  newMode: string;
  oldOid: string | null;
  newOid: string | null;
  oldPath: string | null;
  newPath: string | null;
}

/**
 * First-parent tree diff with the fixed rename policy (plan §7.3): 80% similarity,
 * copies disabled, candidate limit 1,000, external diff and textconv disabled.
 * `parentOid === null` compares a root commit against the empty tree.
 */
export async function diffTrees(
  git: SafeGit,
  parentOid: string | null,
  commitOid: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<RawChange[]> {
  git.assertOid(commitOid);
  if (parentOid !== null) git.assertOid(parentOid);
  const args = [
    'diff-tree',
    '-r',
    '-z',
    '--raw',
    '--no-abbrev',
    '--no-commit-id',
    '--no-ext-diff',
    '--no-textconv',
    '--find-renames=80%',
    '-l1000',
    '--ignore-submodules=none',
    ...(parentOid === null ? ['--root', commitOid] : [parentOid, commitOid]),
  ];
  const result = await git.run(args, {
    maxStdoutBytes: 64 * 1024 * 1024,
    timeoutMs: options.timeoutMs ?? 30_000,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const parts = result.stdout.toString('binary').split('\0');
  const zero = /^0+$/;
  const changes: RawChange[] = [];
  for (let i = 0; i < parts.length; ) {
    const meta = parts[i++]!;
    if (meta.length === 0) continue;
    if (!meta.startsWith(':')) throw new IngestError('GIT_FAILED', 'Malformed diff-tree output');
    const [oldMode, newMode, oldOid, newOid, statusField] = meta.slice(1).split(' ');
    const status = statusField![0] as RawChange['status'];
    const score = statusField!.length > 1 ? Number(statusField!.slice(1)) : null;
    const decode = (s: string) => decodeStrictUtf8(Buffer.from(s, 'binary'));
    const first = decode(parts[i++] ?? '');
    let oldPath: string | null = first;
    let newPath: string | null = first;
    if (status === 'R' || status === 'C') newPath = decode(parts[i++] ?? '');
    if (status === 'A') oldPath = null;
    if (status === 'D') newPath = null;
    changes.push({
      status,
      similarity: status === 'R' || status === 'C' ? score : null,
      oldMode: oldMode!,
      newMode: newMode!,
      oldOid: zero.test(oldOid!) ? null : oldOid!,
      newOid: zero.test(newOid!) ? null : newOid!,
      oldPath,
      newPath,
    });
  }
  return changes;
}
