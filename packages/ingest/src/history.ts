import { IngestError } from './errors.js';
import { decodeStrictUtf8, parseCommit, type CommitObject, type ObjectType, type RawChange } from './objects.js';
import { killProcessTree } from './process.js';
import type { SafeGit } from './safe-git.js';

/**
 * Bounded first-parent history readers (plan §7.2, §7.3). Everything here reads committed
 * objects through SafeGit: no revision expressions, no repository configuration, no
 * external diff or textconv, and a missing object is reported rather than fetched.
 */

// ---------------------------------------------------------------------------------------
// Interactive object session
// ---------------------------------------------------------------------------------------

/**
 * One `git cat-file --batch` child answering requests in order. A first-parent walk needs
 * each commit before it knows the next OID, so a request/response session replaces one
 * process per commit. The deadline and byte cap cover the whole session.
 */
export class ObjectSession {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly pending: { oid: string; resolve: (value: { type: ObjectType; bytes: Buffer } | null) => void; reject: (error: IngestError) => void }[] = [];
  private failure: IngestError | null = null;
  private bytesRead = 0;
  private closed = false;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly onAbort: () => void;

  private constructor(
    private readonly git: SafeGit,
    private readonly child: ReturnType<SafeGit['spawnInteractive']>,
    private readonly options: { maxBytes: number; maxObjectBytes: number; signal?: AbortSignal },
    timeoutMs: number,
  ) {
    this.timer = setTimeout(() => this.fail(new IngestError('TIMEOUT', 'Git object reads exceeded their deadline', { timeoutMs })), timeoutMs);
    this.onAbort = () => this.fail(new IngestError('CANCELLED', 'Operation cancelled'));
    options.signal?.addEventListener('abort', this.onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    child.stderr.on('data', () => {
      // Classification only happens through the protocol; stderr is never surfaced.
    });
    child.stdin.on('error', () => this.fail(new IngestError('GIT_FAILED', 'Git object session closed unexpectedly')));
    child.on('error', (error: NodeJS.ErrnoException) =>
      this.fail(error.code === 'ENOENT' ? new IngestError('GIT_UNAVAILABLE', 'The Git executable was not found') : new IngestError('GIT_FAILED', 'Failed to start Git')),
    );
    child.on('close', () => {
      if (!this.closed) this.fail(new IngestError('GIT_FAILED', 'Git object session ended unexpectedly'));
    });
  }

  static open(git: SafeGit, options: { timeoutMs?: number; maxBytes?: number; maxObjectBytes?: number; signal?: AbortSignal } = {}): ObjectSession {
    if (options.signal?.aborted) throw new IngestError('CANCELLED', 'Operation cancelled before start');
    const child = git.spawnInteractive(['cat-file', '--batch']);
    return new ObjectSession(
      git,
      child,
      {
        maxBytes: options.maxBytes ?? 64 * 1024 * 1024,
        maxObjectBytes: options.maxObjectBytes ?? 1024 * 1024,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      options.timeoutMs ?? 60_000,
    );
  }

  /** Read one object; null when it is missing from the object store. */
  read(oid: string): Promise<{ type: ObjectType; bytes: Buffer } | null> {
    this.git.assertOid(oid);
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new IngestError('GIT_FAILED', 'Object session is closed'));
    return new Promise((resolve, reject) => {
      this.pending.push({ oid, resolve, reject });
      this.child.stdin.write(`${oid}\n`);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.options.signal?.removeEventListener('abort', this.onAbort);
    this.child.stdin.end();
    if (this.child.exitCode === null && this.child.pid !== undefined) killProcessTree(this.child.pid);
    for (const request of this.pending.splice(0)) request.reject(new IngestError('GIT_FAILED', 'Object session is closed'));
  }

  private fail(error: IngestError): void {
    if (this.failure || this.closed) return;
    this.failure = error;
    this.closed = true;
    clearTimeout(this.timer);
    this.options.signal?.removeEventListener('abort', this.onAbort);
    if (this.child.pid !== undefined) killProcessTree(this.child.pid);
    for (const request of this.pending.splice(0)) request.reject(error);
  }

  private receive(chunk: Buffer): void {
    if (this.failure) return;
    this.bytesRead += chunk.length;
    if (this.bytesRead > this.options.maxBytes) {
      this.fail(new IngestError('RESOURCE_LIMIT', 'Git object reads exceeded their byte limit', { limitBytes: this.options.maxBytes }));
      return;
    }
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (this.pending.length > 0) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline === -1) return;
      const header = this.buffer.subarray(0, newline).toString('latin1').split(' ');
      const request = this.pending[0]!;
      if (header[0] !== request.oid) {
        this.fail(new IngestError('GIT_FAILED', 'Unexpected cat-file response'));
        return;
      }
      if (header[1] === 'missing' && header.length === 2) {
        this.buffer = this.buffer.subarray(newline + 1);
        this.pending.shift();
        request.resolve(null);
        continue;
      }
      const type = header[1] as ObjectType;
      const size = Number(header[2]);
      if (!['blob', 'tree', 'commit', 'tag'].includes(type) || !Number.isSafeInteger(size) || size < 0) {
        this.fail(new IngestError('GIT_FAILED', 'Unexpected cat-file response'));
        return;
      }
      if (size > this.options.maxObjectBytes) {
        this.fail(new IngestError('RESOURCE_LIMIT', 'A Git object exceeded its size limit', { limitBytes: this.options.maxObjectBytes }));
        return;
      }
      const end = newline + 1 + size;
      if (this.buffer.length < end + 1) return; // body plus trailing LF not complete yet
      const bytes = Buffer.from(this.buffer.subarray(newline + 1, end));
      this.buffer = this.buffer.subarray(end + 1);
      this.pending.shift();
      request.resolve({ type, bytes });
    }
  }
}

// ---------------------------------------------------------------------------------------
// First-parent window
// ---------------------------------------------------------------------------------------

export type WalkBoundary = 'root' | 'days' | 'commit-cap' | 'shallow';

export interface FirstParentWindow {
  /** Included commits, newest (the selected commit) to oldest, in parent-chain order. */
  commits: CommitObject[];
  /** Why the walk stopped below the oldest included commit. */
  boundary: WalkBoundary;
  /**
   * The first excluded first parent, read so the oldest included commit's change can be
   * computed (plan §7.2). Null at a root or when the parent object is missing.
   */
  boundaryParent: CommitObject | null;
}

/**
 * Walk first-parent links from `start`, newest to oldest. The selected commit is always
 * included. A parent is included while fewer than `maxCommits` are included and its
 * committer timestamp is not older than `minCommitterEpochSeconds`; the walk stops at the
 * first parent failing either test (the window is contiguous, never reordered by date).
 */
export async function walkFirstParent(
  git: SafeGit,
  start: string,
  options: { maxCommits: number; minCommitterEpochSeconds: number; signal?: AbortSignal; timeoutMs?: number },
): Promise<FirstParentWindow> {
  if (!Number.isInteger(options.maxCommits) || options.maxCommits < 1) throw new RangeError('maxCommits must be a positive integer');
  const session = ObjectSession.open(git, {
    timeoutMs: options.timeoutMs ?? 60_000,
    maxObjectBytes: 1024 * 1024,
    maxBytes: (options.maxCommits + 2) * 1024 * 1024,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const readCommitObject = async (oid: string): Promise<CommitObject | null> => {
    const object = await session.read(oid);
    if (object === null) return null;
    if (object.type !== 'commit') throw new IngestError('GIT_FAILED', 'A first-parent link does not name a commit', { oid });
    return parseCommit(oid, object.bytes);
  };
  try {
    const head = await readCommitObject(start);
    if (head === null) throw new IngestError('LOCAL_OBJECT_MISSING', 'Commit object is missing', { oid: start });
    const commits = [head];
    for (;;) {
      const parentOid = commits.at(-1)!.parents[0];
      if (parentOid === undefined) return { commits, boundary: 'root', boundaryParent: null };
      const parent = await readCommitObject(parentOid);
      if (parent === null) return { commits, boundary: 'shallow', boundaryParent: null };
      if (parent.committerEpochSeconds < options.minCommitterEpochSeconds) return { commits, boundary: 'days', boundaryParent: parent };
      if (commits.length >= options.maxCommits) return { commits, boundary: 'commit-cap', boundaryParent: parent };
      commits.push(parent);
    }
  } finally {
    session.close();
  }
}

// ---------------------------------------------------------------------------------------
// First-parent diffs with line statistics
// ---------------------------------------------------------------------------------------

export interface DiffEntry extends RawChange {
  /** Text line counts from numstat; null for binary content or when unavailable. */
  added: number | null;
  deleted: number | null;
  /** True when a path's raw bytes are not valid UTF-8 (its decoded path is null). */
  undecodablePath: boolean;
}

export interface CommitDiffRequest {
  commitOid: string;
  /** First parent to compare against, or null to compare a root commit to the empty tree. */
  parentOid: string | null;
}

export type CommitDiffResult =
  | {
      status: 'complete' | 'partial';
      /** `full`: rename detection and numstat; `paths-only`: tree comparison only. */
      mode: 'full' | 'paths-only';
      /** Git skipped inexact rename detection because the candidate limit was exceeded. */
      renameLimited: boolean;
      entries: DiffEntry[];
    }
  | { status: 'unavailable'; reason: string };

/** The fixed rename/diff policy (plan §7.3), recorded alongside the Git version. */
export const DIFF_POLICY = Object.freeze({
  renameSimilarityPercent: 80,
  renameCandidateLimit: 1_000,
  copies: false,
  externalDiff: false,
  textconv: false,
  firstParentOnly: true,
});

const FULL_DIFF_ARGS = [
  '-r',
  '-z',
  '--raw',
  '--numstat',
  '--no-abbrev',
  '--no-ext-diff',
  '--no-textconv',
  `--find-renames=${DIFF_POLICY.renameSimilarityPercent}%`,
  `-l${DIFF_POLICY.renameCandidateLimit}`,
  '--ignore-submodules=none',
  '--root',
  '--always',
];

const RENAME_SKIPPED = /rename detection was skipped|diff\.renameLimit/i;
const HEX_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Compute first-parent diffs for many commits. Batches of commits share one
 * `diff-tree --stdin` process. A batch that fails, or whose rename detection was limited,
 * is retried commit by commit so the limitation is attributed exactly; a commit whose
 * full diff still fails falls back to a tree-only comparison (paths, no renames or line
 * counts), and only then becomes unavailable.
 */
export async function diffCommits(
  git: SafeGit,
  requests: readonly CommitDiffRequest[],
  options: { signal?: AbortSignal; timeoutMs?: number; batchSize?: number; maxOutputBytes?: number } = {},
): Promise<Map<string, CommitDiffResult>> {
  for (const request of requests) {
    git.assertOid(request.commitOid);
    if (request.parentOid !== null) git.assertOid(request.parentOid);
  }
  const results = new Map<string, CommitDiffResult>();
  const batchSize = options.batchSize ?? 25;
  for (let start = 0; start < requests.length; start += batchSize) {
    const batch = requests.slice(start, start + batchSize);
    let parsed: Map<string, DiffEntry[]> | null = null;
    let limited = false;
    try {
      const run = await runFullDiff(git, batch, options);
      parsed = run.entries;
      limited = run.renameLimited;
    } catch (error) {
      if (error instanceof IngestError && error.code === 'CANCELLED') throw error;
      parsed = null;
    }
    if (parsed !== null && !limited) {
      for (const request of batch) results.set(request.commitOid, { status: 'complete', mode: 'full', renameLimited: false, entries: parsed.get(request.commitOid)! });
      continue;
    }
    for (const request of batch) results.set(request.commitOid, await diffOne(git, request, options));
  }
  return results;
}

async function diffOne(git: SafeGit, request: CommitDiffRequest, options: { signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number }): Promise<CommitDiffResult> {
  try {
    const run = await runFullDiff(git, [request], options);
    return { status: run.renameLimited ? 'partial' : 'complete', mode: 'full', renameLimited: run.renameLimited, entries: run.entries.get(request.commitOid)! };
  } catch (error) {
    if (error instanceof IngestError && error.code === 'CANCELLED') throw error;
  }
  try {
    const entries = await pathsOnlyDiff(git, request, options);
    return { status: 'partial', mode: 'paths-only', renameLimited: false, entries };
  } catch (error) {
    if (error instanceof IngestError && error.code === 'CANCELLED') throw error;
    return { status: 'unavailable', reason: error instanceof IngestError ? error.code : 'GIT_FAILED' };
  }
}

async function runFullDiff(
  git: SafeGit,
  batch: readonly CommitDiffRequest[],
  options: { signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number },
): Promise<{ entries: Map<string, DiffEntry[]>; renameLimited: boolean }> {
  const stdin = batch.map((r) => (r.parentOid === null ? `${r.commitOid}\n` : `${r.commitOid} ${r.parentOid}\n`)).join('');
  const result = await git.run(['diff-tree', '--stdin', ...FULL_DIFF_ARGS], {
    stdin,
    timeoutMs: options.timeoutMs ?? 60_000,
    maxStdoutBytes: options.maxOutputBytes ?? 64 * 1024 * 1024,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return { entries: parseDiffStream(result.stdout, batch.map((r) => r.commitOid)), renameLimited: RENAME_SKIPPED.test(result.stderr) };
}

async function pathsOnlyDiff(git: SafeGit, request: CommitDiffRequest, options: { signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number }): Promise<DiffEntry[]> {
  const args = ['diff-tree', '-r', '-z', '--raw', '--no-abbrev', '--no-commit-id', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=none'];
  const result = await git.run([...args, ...(request.parentOid === null ? ['--root', request.commitOid] : [request.parentOid, request.commitOid])], {
    timeoutMs: options.timeoutMs ?? 60_000,
    maxStdoutBytes: options.maxOutputBytes ?? 64 * 1024 * 1024,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const tokens = result.stdout.toString('latin1').split('\0');
  const entries: DiffEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i] === '') {
      i++;
      continue;
    }
    const parsed = parseRawRecord(tokens, i);
    entries.push({ ...parsed.entry, added: null, deleted: null });
    i = parsed.next;
  }
  return entries;
}

function decodePath(latin1: string): { path: string | null; undecodable: boolean } {
  const path = decodeStrictUtf8(Buffer.from(latin1, 'latin1'));
  return { path, undecodable: path === null };
}

function parseRawRecord(tokens: readonly string[], start: number): { entry: Omit<DiffEntry, 'added' | 'deleted'>; next: number } {
  const meta = tokens[start]!;
  if (!meta.startsWith(':')) throw new IngestError('GIT_FAILED', 'Malformed diff-tree output');
  const fields = meta.slice(1).split(' ');
  if (fields.length !== 5) throw new IngestError('GIT_FAILED', 'Malformed diff-tree output');
  const [oldMode, newMode, oldOid, newOid, statusField] = fields as [string, string, string, string, string];
  const status = statusField[0] as RawChange['status'];
  if (!'AMDRCTUX'.includes(status) || !HEX_OID.test(oldOid) || !HEX_OID.test(newOid)) throw new IngestError('GIT_FAILED', 'Malformed diff-tree output');
  const two = status === 'R' || status === 'C';
  const first = tokens[start + 1];
  const second = two ? tokens[start + 2] : undefined;
  if (first === undefined || (two && second === undefined)) throw new IngestError('GIT_FAILED', 'Truncated diff-tree output');
  const a = decodePath(first);
  const b = two ? decodePath(second!) : a;
  const zero = /^0+$/;
  return {
    entry: {
      status,
      similarity: two ? Number(statusField.slice(1)) : null,
      oldMode,
      newMode,
      oldOid: zero.test(oldOid) ? null : oldOid,
      newOid: zero.test(newOid) ? null : newOid,
      oldPath: status === 'A' ? null : a.path,
      newPath: status === 'D' ? null : b.path,
      undecodablePath: a.undecodable || b.undecodable,
    },
    next: start + (two ? 3 : 2),
  };
}

interface NumstatRecord {
  added: number | null;
  deleted: number | null;
  oldPath: string | null;
  newPath: string | null;
}

/**
 * Parse `diff-tree --stdin --always --raw --numstat -z` output. Each requested commit
 * yields its OID header, its raw records, then its numstat records; headers must appear
 * in request order. Numstat rows are matched to raw rows by path in order; a raw row
 * without a matching numstat row keeps null line counts rather than zero.
 */
export function parseDiffStream(stdout: Buffer, expected: readonly string[]): Map<string, DiffEntry[]> {
  const tokens = stdout.toString('latin1').split('\0');
  const out = new Map<string, DiffEntry[]>();
  let i = 0;
  let sequence = 0;
  const skipEmpty = () => {
    while (i < tokens.length && tokens[i] === '') i++;
  };
  skipEmpty();
  while (i < tokens.length) {
    const header = tokens[i]!;
    if (!HEX_OID.test(header) || header !== expected[sequence]) throw new IngestError('GIT_FAILED', 'Unexpected diff-tree commit header');
    i++;
    sequence++;
    const raw: Omit<DiffEntry, 'added' | 'deleted'>[] = [];
    while (i < tokens.length && tokens[i]!.startsWith(':')) {
      const parsed = parseRawRecord(tokens, i);
      raw.push(parsed.entry);
      i = parsed.next;
    }
    const numstat: NumstatRecord[] = [];
    while (i < tokens.length && tokens[i] !== '' && tokens[i]!.includes('\t')) {
      const token = tokens[i]!;
      const firstTab = token.indexOf('\t');
      const secondTab = token.indexOf('\t', firstTab + 1);
      if (secondTab === -1) throw new IngestError('GIT_FAILED', 'Malformed numstat output');
      const count = (text: string) => (text === '-' ? null : /^\d+$/.test(text) ? Number(text) : Number.NaN);
      const added = count(token.slice(0, firstTab));
      const deleted = count(token.slice(firstTab + 1, secondTab));
      if (Number.isNaN(added) || Number.isNaN(deleted)) throw new IngestError('GIT_FAILED', 'Malformed numstat output');
      const rest = token.slice(secondTab + 1);
      if (rest === '') {
        // Rename/copy: old and new paths follow as separate tokens.
        const oldPath = tokens[i + 1];
        const newPath = tokens[i + 2];
        if (oldPath === undefined || newPath === undefined) throw new IngestError('GIT_FAILED', 'Truncated numstat output');
        numstat.push({ added, deleted, oldPath: decodePath(oldPath).path, newPath: decodePath(newPath).path });
        i += 3;
      } else {
        const path = decodePath(rest).path;
        numstat.push({ added, deleted, oldPath: path, newPath: path });
        i += 1;
      }
    }
    let n = 0;
    const entries: DiffEntry[] = raw.map((entry) => {
      const candidate = numstat[n];
      const pathA = entry.oldPath ?? entry.newPath;
      const pathB = entry.newPath ?? entry.oldPath;
      if (!entry.undecodablePath && candidate && candidate.oldPath === pathA && candidate.newPath === pathB) {
        n++;
        return { ...entry, added: candidate.added, deleted: candidate.deleted };
      }
      return { ...entry, added: null, deleted: null };
    });
    out.set(header, entries);
    skipEmpty();
  }
  if (sequence !== expected.length) throw new IngestError('GIT_FAILED', 'diff-tree omitted a requested commit');
  return out;
}
