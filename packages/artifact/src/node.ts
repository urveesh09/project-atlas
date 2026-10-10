import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { constants, gunzipSync, gzipSync } from 'node:zlib';
import { DecompressionLimitError, MANIFEST_PATH, loadArtifact, openArtifact, type ArtifactSource, type Decompressor, type LoadResult, type OpenResult } from './load.js';
import type { PackedArtifact } from './pack.js';

/**
 * Node-side artifact I/O (plan §6.5, §14.2): deterministic gzip, bounded reads that
 * refuse symlinks and traversal, and atomic directory publication with crash recovery.
 */

/** Gzip with fixed metadata: mtime 0 and OS "unknown" (255), so output does not encode where or when it was written. */
export function gzipDeterministic(bytes: Uint8Array): Uint8Array {
  const out = gzipSync(bytes, { level: 9, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY });
  out.writeUInt32LE(0, 4);
  out[9] = 0xff;
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

export const gunzipNode: Decompressor = async (compressed, maxBytes) => {
  try {
    return new Uint8Array(gunzipSync(compressed, { maxOutputLength: Math.max(1, maxBytes) }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|larger than/i.test(String(error))) {
      throw new DecompressionLimitError(maxBytes);
    }
    throw error;
  }
};

/** Read only regular files strictly inside `root`; symlinks and escapes read as absent. */
export function directorySource(root: string): ArtifactSource {
  const base = path.resolve(root);
  return {
    async read(relative, maxBytes) {
      if (relative.includes('\\') || relative.split('/').some((s) => s === '' || s === '.' || s === '..')) return null;
      const full = path.resolve(base, ...relative.split('/'));
      if (!full.startsWith(base + path.sep)) return null;
      // Every segment must be a real directory/file, never a link.
      let current = base;
      for (const segment of relative.split('/')) {
        current = path.join(current, segment);
        const info = await lstat(current).catch(() => null);
        if (!info || info.isSymbolicLink()) return null;
      }
      const handle = await open(full, 'r').catch(() => null);
      if (!handle) return null;
      try {
        const info = await handle.stat();
        if (!info.isFile()) return null;
        const length = Math.min(info.size, maxBytes + 1);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, 0);
        return new Uint8Array(buffer.buffer, buffer.byteOffset, length);
      } finally {
        await handle.close();
      }
    },
  };
}

export function readArtifactDirectory(dir: string): Promise<LoadResult> {
  return loadArtifact(directorySource(dir), gunzipNode);
}

export type ArtifactWriteErrorCode = 'OUTPUT_EXISTS' | 'OUTPUT_NOT_DIRECTORY' | 'OUTPUT_NOT_ARTIFACT' | 'OUTPUT_UNSAFE' | 'WRITE_FAILED' | 'VERIFY_FAILED';

export class ArtifactWriteError extends Error {
  constructor(
    readonly code: ArtifactWriteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ArtifactWriteError';
  }
}

export interface WriteOptions {
  replace?: boolean;
  /** Extra small JSON files written beside the chunks (summary.json, repository-id.json). */
  extras?: Record<string, unknown>;
  /** Directories the output must never equal or contain (e.g. the analyzed repository). */
  protectedPaths?: readonly string[];
  /** Test-only: simulate a crash at a named point (no cleanup runs). */
  crashAt?: 'after-staging' | 'after-backup';
}

const STAGING = 'atlas-staging';
const BACKUP = 'atlas-backup';

async function retry<T>(work: () => Promise<T>): Promise<T> {
  // Windows can briefly hold directory handles (indexers, antivirus) after writes.
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 8 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error;
      await new Promise((r) => setTimeout(r, 25 * 2 ** attempt));
    }
  }
}

async function isArtifactDirectory(dir: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(path.join(dir, MANIFEST_PATH), 'utf8')) as { artifactVersion?: unknown };
    return typeof manifest.artifactVersion === 'string' && manifest.artifactVersion.startsWith('atlas.artifact/');
  } catch {
    return false;
  }
}

/**
 * Finish or undo a previously interrupted publication of `target`:
 * - a backup with no target means the crash happened mid-swap: restore the backup;
 * - leftover staging directories are always discarded (they were never published).
 * Only directories carrying this target's ATLAS staging/backup names are touched.
 */
export async function recoverInterruptedWrite(target: string): Promise<{ restored: boolean; removed: number }> {
  const parent = path.dirname(target);
  const name = path.basename(target);
  const entries = await readdir(parent).catch(() => [] as string[]);
  let restored = false;
  let removed = 0;
  const targetExists = await stat(target).then(() => true, () => false);
  for (const entry of entries.sort()) {
    const full = path.join(parent, entry);
    if (entry.startsWith(`.${name}.${BACKUP}-`)) {
      if (!targetExists && !restored && (await isArtifactDirectory(full))) {
        await retry(() => rename(full, target));
        restored = true;
      } else {
        await rm(full, { recursive: true, force: true });
        removed++;
      }
    } else if (entry.startsWith(`.${name}.${STAGING}-`)) {
      await rm(full, { recursive: true, force: true });
      removed++;
    }
  }
  return { restored, removed };
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function writeArtifactDirectory(packed: PackedArtifact, outDir: string, options: WriteOptions = {}): Promise<{ path: string; replaced: boolean }> {
  const target = path.resolve(outDir);
  for (const protectedPath of options.protectedPaths ?? []) {
    const p = path.resolve(protectedPath);
    if (isInside(p, target)) {
      throw new ArtifactWriteError('OUTPUT_UNSAFE', 'The output directory must not be the analyzed repository or one of its parents');
    }
  }
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  await recoverInterruptedWrite(target);

  const existing = await stat(target).catch(() => null);
  let replacing = false;
  if (existing) {
    if (!existing.isDirectory()) throw new ArtifactWriteError('OUTPUT_NOT_DIRECTORY', 'The output path exists and is not a directory');
    const entries = await readdir(target);
    if (entries.length > 0) {
      if (!options.replace) throw new ArtifactWriteError('OUTPUT_EXISTS', 'The output directory is not empty; pass --replace to overwrite a previous ATLAS artifact');
      if (!(await isArtifactDirectory(target))) throw new ArtifactWriteError('OUTPUT_NOT_ARTIFACT', 'Refusing to replace a directory that is not an ATLAS artifact');
      replacing = true;
    }
  }

  const token = randomBytes(6).toString('hex');
  const staging = path.join(parent, `.${path.basename(target)}.${STAGING}-${token}`);
  const backup = path.join(parent, `.${path.basename(target)}.${BACKUP}-${token}`);
  try {
    await mkdir(staging);
    for (const [relative, bytes] of packed.chunks) {
      const full = path.join(staging, ...relative.split('/'));
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, bytes, { flag: 'wx' });
    }
    for (const [name, value] of Object.entries(options.extras ?? {})) {
      if (!/^[a-z][a-z0-9-]*\.json$/.test(name) || name === MANIFEST_PATH) throw new ArtifactWriteError('WRITE_FAILED', `Invalid extra file name ${name}`);
      await writeFile(path.join(staging, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    }
    // The manifest is written last: a staging directory without one is never valid.
    await writeFile(path.join(staging, MANIFEST_PATH), `${JSON.stringify(packed.manifest, null, 2)}\n`, { flag: 'wx' });
    const verified = await verifyArtifactDirectory(staging);
    if (!verified.ok) throw new ArtifactWriteError('VERIFY_FAILED', `Written artifact failed verification: ${verified.issues[0]?.code ?? 'unknown'}`);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error instanceof ArtifactWriteError ? error : new ArtifactWriteError('WRITE_FAILED', `Could not write the artifact: ${(error as Error).message}`);
  }
  if (options.crashAt === 'after-staging') return { path: target, replaced: false };

  if (replacing) {
    await retry(() => rename(target, backup));
    if (options.crashAt === 'after-backup') return { path: target, replaced: false };
    try {
      await retry(() => rename(staging, target));
    } catch (error) {
      await retry(() => rename(backup, target)).catch(() => undefined);
      await rm(staging, { recursive: true, force: true });
      throw new ArtifactWriteError('WRITE_FAILED', `Could not publish the artifact: ${(error as Error).message}`);
    }
    await rm(backup, { recursive: true, force: true, maxRetries: 5 });
  } else {
    if (existing) await rmdir(target);
    try {
      await retry(() => rename(staging, target));
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw new ArtifactWriteError('WRITE_FAILED', `Could not publish the artifact: ${(error as Error).message}`);
    }
  }
  return { path: target, replaced: replacing };
}

/** Open an artifact directory lazily: core and selected frame validated, other frames on demand. */
export function openArtifactDirectory(dir: string): Promise<OpenResult> {
  return openArtifact(directorySource(dir), gunzipNode);
}

export interface VerifySummary {
  frames: number;
  nodes: number;
  edges: number;
  stats: { compressedBytes: number; uncompressedBytes: number; chunks: number };
}

/**
 * Validate every chunk and frame exactly as an eager load does, decoding one frame at a
 * time so memory stays bounded by the largest frame rather than the whole history.
 */
export async function verifyArtifactDirectory(dir: string): Promise<{ ok: true; summary: VerifySummary; opened: Extract<OpenResult, { ok: true }>['artifact'] } | Extract<LoadResult, { ok: false }>> {
  const opened = await openArtifactDirectory(dir);
  if (!opened.ok) return opened;
  const { artifact } = opened;
  let nodes = 0;
  let edges = 0;
  for (let i = 0; i < artifact.manifest.frames.length; i++) {
    const frame = await artifact.frame(i);
    if (!frame.ok) return frame;
    nodes += frame.graph.nodes.length;
    edges += frame.graph.edges.length;
  }
  return { ok: true, opened: artifact, summary: { frames: artifact.manifest.frames.length, nodes, edges, stats: artifact.stats } };
}
