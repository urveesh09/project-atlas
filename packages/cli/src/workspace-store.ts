import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { canonicalJson, WORKSPACE_LIMITS, type ReviewWorkspace } from '@atlas/schema';
import { parseReviewWorkspace, QualityImportError } from '@atlas/graph';

const STATE = 'workspace.json';
const LOCK = '.atlas-review.lock';
function fail(message: string): never { throw new QualityImportError(message); }
function sameIdentity(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function rejectAlternateStream(file: string): void {
  if (process.platform === 'win32' && file.slice(path.parse(file).root.length).includes(':'))
    fail('Workspace paths must not name an alternate data stream.');
}

/** Identity checks also catch case aliases on case-insensitive POSIX filesystems. */
export async function assertWorkspaceOutside(directory: string, target: string): Promise<void> {
  const identity = await lstat(directory);
  if (!identity.isDirectory() || identity.isSymbolicLink()) fail('Protected directory must be a real directory.');
  let current = path.resolve(target);
  rejectAlternateStream(current);
  await checkWorkspaceDirectory(path.dirname(current), false);
  for (;;) {
    const stat = await lstat(current).catch((error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat?.isSymbolicLink()) fail('Workspace paths must never use symlinks or junctions.');
    if (stat && sameIdentity(identity, stat)) fail('Workspace and export paths must be outside protected artifact/workspace directories.');
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

/** Reject aliases rather than resolving a path that may leave the operator's chosen directory. */
export async function checkWorkspaceDirectory(directory: string, privateLeaf = true): Promise<Stats> {
  const absolute = path.resolve(directory), root = path.parse(absolute).root;
  let current = root;
  let result = await lstat(root);
  for (const segment of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    result = await lstat(current);
    if (!result.isDirectory() || result.isSymbolicLink()) fail('Workspace paths must use real directories, never symlinks or junctions.');
  }
  if (privateLeaf && process.platform !== 'win32' && (result.mode & 0o077) !== 0) fail('Workspace directory permissions must exclude other users.');
  return result;
}

export async function readWorkspaceFile(file: string, privateFile = false): Promise<{ text: string; identity: Stats; digest: string }> {
  rejectAlternateStream(file);
  await checkWorkspaceDirectory(path.dirname(file), false);
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > WORKSPACE_LIMITS.bytes)
    fail('Workspace input must be one regular, unlinked file within its byte limit.');
  if (privateFile && process.platform !== 'win32' && (before.mode & 0o077) !== 0) fail('Workspace file permissions must exclude other users.');
  const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK | constants.O_NOFOLLOW);
  const handle = await open(file, flags);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameIdentity(before, opened)) fail('Workspace input changed while opening.');
    if (opened.size > WORKSPACE_LIMITS.bytes) fail('Workspace input exceeds its byte limit.');
    const stillAtPath = await lstat(file);
    if (!stillAtPath.isFile() || stillAtPath.isSymbolicLink() || !sameIdentity(stillAtPath, opened)) fail('Workspace input pathname changed while opening.');
    if (privateFile && process.platform !== 'win32' && (opened.mode & 0o077) !== 0) fail('Workspace file permissions must exclude other users.');
    const bytes = Buffer.alloc(opened.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const next = await handle.read(bytes, used, bytes.length - used, used);
      if (!next.bytesRead) break;
      used += next.bytesRead;
    }
    const after = await handle.stat();
    if (used > WORKSPACE_LIMITS.bytes || opened.size !== used || after.size !== used
      || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) fail('Workspace input changed or exceeded its byte limit.');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, used)); }
    catch { return fail('Workspace input is not valid UTF-8.'); }
    return { text, identity: opened, digest: createHash('sha256').update(bytes.subarray(0, used)).digest('hex') };
  } finally { await handle.close(); }
}

async function writeExclusive(file: string, text: string, created?: () => void): Promise<void> {
  if (Buffer.byteLength(text) > WORKSPACE_LIMITS.bytes) fail('Workspace output exceeds its byte limit.');
  const handle = await open(file, 'wx', 0o600);
  created?.();
  try { await handle.writeFile(text, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
}

export async function initializeWorkspace(directory: string, artifact: string, workspace: ReviewWorkspace): Promise<void> {
  const target = path.resolve(directory);
  await assertWorkspaceOutside(artifact, target);
  await checkWorkspaceDirectory(path.dirname(target), false);
  await mkdir(target, { mode: 0o700 }); // Exclusive directory admission; never reuse or replace a path.
  // Preserve partial initialization evidence on failure; never recursively clean user-chosen paths.
  await checkWorkspaceDirectory(target);
  await writeExclusive(path.join(target, STATE), canonicalJson(parseReviewWorkspace(canonicalJson(workspace))) + '\n');
}

export async function loadWorkspace(directory: string): Promise<ReviewWorkspace> {
  await checkWorkspaceDirectory(directory);
  return parseReviewWorkspace((await readWorkspaceFile(path.join(directory, STATE), true)).text);
}

/** The lock serializes cooperating writers. Identity and digest checks detect earlier external edits. */
export async function updateWorkspace(
  directory: string,
  expectedRevision: number,
  update: (current: ReviewWorkspace) => Promise<ReviewWorkspace>,
  signal?: AbortSignal,
): Promise<ReviewWorkspace> {
  if (signal?.aborted) fail('Workspace update cancelled.');
  const target = path.resolve(directory), identity = await checkWorkspaceDirectory(target);
  const lockPath = path.join(target, LOCK), statePath = path.join(target, STATE);
  const lock = await open(lockPath, 'wx', 0o600).catch(() => fail('Workspace lock could not be acquired. Check access or an existing lock; no automatic lock removal is performed.'));
  let lockIdentity: Stats | undefined;
  const temp = path.join(target, `.atlas-review-${randomUUID()}.tmp`);
  let tempCreated = false;
  try {
    lockIdentity = await lock.stat();
    const before = await readWorkspaceFile(statePath, true);
    const current = parseReviewWorkspace(before.text);
    if (current.revision !== expectedRevision) fail('Workspace revision changed. Inspect it before making another decision.');
    const next = await update(current);
    if (signal?.aborted) fail('Workspace update cancelled.');
    if (next.revision !== current.revision + 1 || next.id !== current.id || next.reportSha256 !== current.reportSha256)
      fail('Workspace update must retain its exact review and advance one revision.');
    const text = canonicalJson(parseReviewWorkspace(canonicalJson(next))) + '\n';
    await writeExclusive(temp, text, () => { tempCreated = true; });
    const after = await readWorkspaceFile(statePath, true);
    const currentDirectory = await checkWorkspaceDirectory(target);
    if (!sameIdentity(identity, currentDirectory) || !sameIdentity(before.identity, after.identity) || before.digest !== after.digest)
      fail('Workspace changed outside this transaction. No replacement was applied.');
    if (signal?.aborted) fail('Workspace update cancelled.');
    await rename(temp, statePath);
    tempCreated = false;
    return next;
  } finally {
    if (tempCreated) await unlink(temp).catch(() => undefined);
    await lock.close();
    // Do not remove another process's replacement lock.
    const existing = await lstat(lockPath).catch(() => null);
    if (existing && lockIdentity && sameIdentity(existing, lockIdentity) && !existing.isSymbolicLink()) await unlink(lockPath);
  }
}

export async function exportWorkspace(directory: string, artifact: string, output: string, workspace: ReviewWorkspace): Promise<void> {
  const target = path.resolve(output);
  await assertWorkspaceOutside(artifact, target);
  await assertWorkspaceOutside(path.resolve(directory), target);
  await checkWorkspaceDirectory(path.dirname(target), false);
  await writeExclusive(target, canonicalJson(parseReviewWorkspace(canonicalJson(workspace))) + '\n');
}
