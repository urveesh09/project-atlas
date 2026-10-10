import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { IngestError } from './errors.js';
import { peelToCommit } from './objects.js';
import { SafeGit, type ObjectFormat } from './safe-git.js';

/**
 * Local repository discovery through bounded metadata reads (plan §8.4). The user's Git
 * configuration is parsed as inert data only to learn the object format and detect
 * unsupported layouts; it is never handed to Git.
 */
export interface LocalRepository {
  /** Per-worktree git directory (HEAD lives here). */
  gitDir: string;
  /** Common directory shared by linked worktrees (refs, packed-refs, objects). */
  commonDir: string;
  objectsDir: string;
  objectFormat: ObjectFormat;
  /** The repository uses reftable; symbolic refs require a full commit ID instead. */
  reftable: boolean;
  /** Partial clone: objects may be missing locally and are never fetched. */
  promisor: boolean;
  linkedWorktree: boolean;
  bare: boolean;
  /** Directory holding the `.git` entry (null for bare repositories). */
  worktreeRoot: string | null;
}

const MAX_METADATA_BYTES = 1024 * 1024;

async function readSmall(file: string, limit = MAX_METADATA_BYTES): Promise<string | null> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return null;
    if (info.size > limit) throw new IngestError('LOCAL_OBJECT_STORE_UNSUPPORTED', 'Repository metadata file is too large');
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof IngestError) throw error;
    return null;
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function looksLikeGitDir(dir: string): Promise<boolean> {
  return (await readSmall(path.join(dir, 'HEAD'), 4096)) !== null && ((await isDirectory(path.join(dir, 'objects'))) || (await readSmall(path.join(dir, 'commondir'), 4096)) !== null);
}

/** Minimal INI reader for `[section]` / `[section "sub"]` and `key = value` lines. */
export function parseGitConfigData(text: string): Map<string, string> {
  const values = new Map<string, string>();
  let section = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\]/.exec(line);
    if (header) {
      section = header[2] === undefined ? header[1]!.toLowerCase() : `${header[1]!.toLowerCase()}.${header[2]}`;
      continue;
    }
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (kv && section) values.set(`${section}.${kv[1]!.toLowerCase()}`, (kv[2] ?? 'true').replace(/\s*[#;].*$/, '').replace(/^"(.*)"$/, '$1'));
  }
  return values;
}

export async function discoverLocalRepository(start: string): Promise<LocalRepository> {
  let dir = await realpath(start).catch(() => {
    throw new IngestError('NOT_A_GIT_REPOSITORY', 'The repository path does not exist');
  });
  let gitDir: string | null = null;
  let bare = false;
  let worktreeRoot: string | null = null;
  for (let depth = 0; depth < 128 && gitDir === null; depth++) {
    const dotGit = path.join(dir, '.git');
    const info = await lstat(dotGit).catch(() => null);
    if (info?.isDirectory()) {
      gitDir = dotGit;
      worktreeRoot = dir;
    } else if (info?.isFile()) {
      const content = await readSmall(dotGit, 4096);
      const match = content ? /^gitdir:\s*(.+?)\s*$/m.exec(content) : null;
      if (!match) throw new IngestError('NOT_A_GIT_REPOSITORY', 'Malformed .git file');
      gitDir = path.resolve(dir, match[1]!);
      worktreeRoot = dir;
    } else if (await looksLikeGitDir(dir)) {
      gitDir = dir;
      bare = true;
    } else {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  if (gitDir === null) throw new IngestError('NOT_A_GIT_REPOSITORY', 'No Git repository found at or above the path');

  const commondirFile = await readSmall(path.join(gitDir, 'commondir'), 4096);
  const commonDir = commondirFile ? path.resolve(gitDir, commondirFile.trim()) : gitDir;
  const objectsDir = path.join(commonDir, 'objects');
  if (!(await isDirectory(objectsDir))) throw new IngestError('LOCAL_OBJECT_STORE_UNSUPPORTED', 'Repository has no local object directory');

  const alternates = await readSmall(path.join(objectsDir, 'info', 'alternates'));
  if (alternates && alternates.split(/\r?\n/).some((l) => l.trim() !== '' && !l.trim().startsWith('#'))) {
    throw new IngestError('LOCAL_OBJECT_STORE_UNSUPPORTED', 'Repositories that borrow objects through alternates are not supported; create a normal local clone', {
      reason: 'ALTERNATES',
    });
  }

  const config = parseGitConfigData((await readSmall(path.join(commonDir, 'config'))) ?? '');
  const formatValue = (config.get('extensions.objectformat') ?? 'sha1').toLowerCase();
  if (formatValue !== 'sha1' && formatValue !== 'sha256') {
    throw new IngestError('LOCAL_OBJECT_STORE_UNSUPPORTED', 'Unsupported object format', { reason: 'OBJECT_FORMAT' });
  }
  const promisor =
    config.has('extensions.partialclone') || [...config.entries()].some(([k, v]) => k.startsWith('remote.') && k.endsWith('.promisor') && v === 'true');
  return {
    gitDir,
    commonDir,
    objectsDir,
    objectFormat: formatValue,
    reftable: (config.get('extensions.refstorage') ?? '').toLowerCase() === 'reftable',
    promisor,
    linkedWorktree: commondirFile !== null,
    bare: bare || config.get('core.bare') === 'true',
    worktreeRoot,
  };
}

const SIMPLE_REF = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\.lock(?:\/|$))(?!.*\/$)(?!.*\.$)[A-Za-z0-9._/-]{1,255}$/;

export function isSimpleRefName(name: string): boolean {
  return SIMPLE_REF.test(name) && !name.split('/').some((s) => s.startsWith('.'));
}

async function readLooseRef(baseDir: string, ref: string): Promise<string | null> {
  const file = path.join(baseDir, ...ref.split('/'));
  const content = await readSmall(file, 4096);
  return content === null ? null : content.trim();
}

async function readPackedRefs(commonDir: string): Promise<Map<string, string>> {
  const refs = new Map<string, string>();
  const content = await readSmall(path.join(commonDir, 'packed-refs'), 64 * 1024 * 1024);
  if (content) {
    for (const line of content.split(/\r?\n/)) {
      const match = /^([0-9a-f]{40}|[0-9a-f]{64}) (refs\/\S+)$/.exec(line);
      if (match) refs.set(match[2]!, match[1]!);
    }
  }
  return refs;
}

async function lookupRef(repo: LocalRepository, ref: string, depth = 0): Promise<string | null> {
  if (depth > 5) throw new IngestError('REF_INVALID', 'Symbolic reference chain too deep');
  // HEAD and other per-worktree pseudo refs live in gitDir; shared refs in commonDir.
  const perWorktree = ref === 'HEAD' || ref.startsWith('refs/worktree/') || ref.startsWith('refs/bisect/');
  const loose = await readLooseRef(perWorktree ? repo.gitDir : repo.commonDir, ref);
  if (loose !== null) {
    const symbolic = /^ref:\s*(refs\/\S+)$/.exec(loose);
    if (symbolic) {
      if (!isSimpleRefName(symbolic[1]!)) throw new IngestError('REF_INVALID', 'Invalid symbolic reference');
      return lookupRef(repo, symbolic[1]!, depth + 1);
    }
    if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(loose)) return loose;
    throw new IngestError('REF_INVALID', 'Malformed reference file');
  }
  if (ref === 'HEAD') return null;
  return (await readPackedRefs(repo.commonDir)).get(ref) ?? null;
}

/**
 * Resolve HEAD, a simple ref name, or a full object ID to a full commit OID using only
 * bounded metadata reads plus SafeGit object inspection (never revision expressions).
 */
export async function resolveLocalCommit(repo: LocalRepository, git: SafeGit, ref?: string, signal?: AbortSignal): Promise<string> {
  const oidLength = repo.objectFormat === 'sha256' ? 64 : 40;
  let oid: string | null = null;
  if (ref !== undefined && new RegExp(`^[0-9a-f]{${oidLength}}$`).test(ref)) oid = ref;
  else {
    if (repo.reftable) {
      throw new IngestError('LOCAL_OBJECT_STORE_UNSUPPORTED', 'Reftable repositories need an explicit full commit ID (--ref <sha>)', { reason: 'REFTABLE' });
    }
    const name = ref ?? 'HEAD';
    if (name !== 'HEAD' && !isSimpleRefName(name)) throw new IngestError('REF_INVALID', 'References must be simple names such as main or v1.2.0');
    const candidates = name === 'HEAD' ? ['HEAD'] : name.startsWith('refs/') ? [name] : [`refs/${name}`, `refs/tags/${name}`, `refs/heads/${name}`, `refs/remotes/${name}`, `refs/remotes/${name}/HEAD`];
    for (const candidate of candidates) {
      oid = await lookupRef(repo, candidate);
      if (oid) break;
    }
    if (!oid) {
      if (name === 'HEAD') throw new IngestError('EMPTY_REPOSITORY', 'The repository has no commits');
      throw new IngestError('REF_NOT_FOUND', 'Reference not found');
    }
  }
  if (oid.length !== oidLength) throw new IngestError('REF_INVALID', 'Object ID does not match the repository object format');
  return peelToCommit(git, oid, signal);
}

/** Open a sanitized offline reader over a discovered local repository. */
export async function openLocalRepository(start: string, options: { gitExecutable?: string; scratchRoot?: string } = {}): Promise<{ repo: LocalRepository; git: SafeGit }> {
  const repo = await discoverLocalRepository(start);
  const git = await SafeGit.create({
    objectDirectory: repo.objectsDir,
    objectFormat: repo.objectFormat,
    network: { kind: 'offline' },
    ...(options.gitExecutable ? { gitExecutable: options.gitExecutable } : {}),
    ...(options.scratchRoot ? { scratchRoot: options.scratchRoot } : {}),
  });
  return { repo, git };
}
