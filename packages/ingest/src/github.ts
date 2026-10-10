import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { IngestError } from './errors.js';
import { SafeGit } from './safe-git.js';

/**
 * Hosted repository admission (plan §8.2). Only `https://github.com/<owner>/<repo>` with
 * an optional trailing slash or `.git` suffix is accepted. All outbound URLs are rebuilt
 * from the validated owner/name; user input is never used as a network destination.
 */
export interface GithubRepositoryRef {
  owner: string;
  name: string;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

export function parseGithubRepositoryUrl(raw: string): GithubRepositoryRef {
  const reject = (why: string): never => {
    throw new IngestError('INVALID_REPOSITORY_URL', 'Enter a public repository URL like https://github.com/owner/repo', { reason: why });
  };
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) reject('LENGTH');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f-\u009f]/.test(raw)) reject('CONTROL_OR_SPACE');
  if (raw.includes('\\')) reject('BACKSLASH');
  if (/%/.test(raw)) reject('PERCENT_ENCODING');
  if (!/^https:\/\/github\.com\//.test(raw)) reject('NOT_GITHUB_HTTPS');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return reject('UNPARSEABLE');
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port !== '') reject('HOST');
  if (url.username !== '' || url.password !== '') reject('USERINFO');
  if (url.search !== '' || url.hash !== '' || raw.includes('?') || raw.includes('#')) reject('QUERY_OR_FRAGMENT');
  // Revalidate the normalized fields against the raw input: the parser must not have
  // rewritten anything (e.g. dot segments or case-folded hosts).
  const rawPath = raw.slice('https://github.com'.length);
  if (url.pathname !== rawPath) reject('NORMALIZED');
  const match = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(rawPath);
  if (!match) reject('PATH_SHAPE');
  const owner = match![1]!;
  const name = match![2]!;
  if (!OWNER.test(owner)) reject('OWNER');
  if (!NAME.test(name) || name === '.' || name === '..' || name.endsWith('.git')) reject('NAME');
  return { owner, name };
}

export interface GithubRepositoryInfo {
  numericId: string;
  owner: string;
  name: string;
  defaultBranch: string;
  visibility: 'public';
  sizeKiB: number;
}

export type FetchLike = (url: string, init: { method: 'GET'; headers: Record<string, string>; redirect: 'manual'; signal?: AbortSignal }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

const API = 'https://api.github.com';

function apiHeaders(): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'atlas-acquisition/0.1',
  };
}

function classifyStatus(status: number, headers: { get(name: string): string | null }): IngestError | null {
  if (status === 200) return null;
  if (status === 301 || status === 302 || status === 307 || status === 308) {
    return new IngestError('REPOSITORY_MOVED', 'The repository was renamed or transferred; submit its current URL');
  }
  if (status === 404) return new IngestError('REPOSITORY_NOT_FOUND', 'Repository not found or not public');
  if (status === 403 || status === 429) {
    if (headers.get('x-ratelimit-remaining') === '0' || headers.get('retry-after') !== null || status === 429) {
      const retryAfter = Number(headers.get('retry-after') ?? '60');
      return new IngestError('UPSTREAM_RATE_LIMITED', 'GitHub rate limit reached; try again later', { retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : 60 });
    }
    return new IngestError('REPOSITORY_NOT_FOUND', 'Repository not found or not public');
  }
  if (status === 409) return new IngestError('EMPTY_REPOSITORY', 'The repository is empty');
  if (status >= 500) return new IngestError('UPSTREAM_UNAVAILABLE', 'GitHub is unavailable; try again later');
  return new IngestError('UPSTREAM_UNAVAILABLE', 'Unexpected GitHub response', { status });
}

/** Resolve repository identity, visibility and the default branch's immutable commit. */
export async function resolveGithubRepository(
  ref: GithubRepositoryRef,
  options: { fetch?: FetchLike; signal?: AbortSignal } = {},
): Promise<GithubRepositoryInfo & { headOid: string }> {
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const get = async (url: string) => {
    const response = await doFetch(url, { method: 'GET', headers: apiHeaders(), redirect: 'manual', ...(options.signal ? { signal: options.signal } : {}) }).catch(() => {
      throw new IngestError('UPSTREAM_UNAVAILABLE', 'Could not reach GitHub');
    });
    const failure = classifyStatus(response.status, response.headers);
    if (failure) throw failure;
    return (await response.json()) as Record<string, unknown>;
  };
  const repo = await get(`${API}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}`);
  if (repo['private'] !== false || (repo['visibility'] !== undefined && repo['visibility'] !== 'public')) {
    // Same response as not-found: never reveal the existence of private repositories.
    throw new IngestError('REPOSITORY_NOT_FOUND', 'Repository not found or not public');
  }
  const id = repo['id'];
  const fullName = repo['full_name'];
  const defaultBranch = repo['default_branch'];
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || typeof fullName !== 'string' || typeof defaultBranch !== 'string') {
    throw new IngestError('UPSTREAM_UNAVAILABLE', 'Unexpected GitHub repository metadata');
  }
  const [owner, name] = fullName.split('/');
  if (!owner || !name || !OWNER.test(owner) || !NAME.test(name)) throw new IngestError('UPSTREAM_UNAVAILABLE', 'Unexpected GitHub repository name');
  if (owner.toLowerCase() !== ref.owner.toLowerCase() || name.toLowerCase() !== ref.name.toLowerCase()) {
    throw new IngestError('REPOSITORY_MOVED', 'The repository was renamed or transferred; submit its current URL');
  }
  if (defaultBranch.length === 0 || defaultBranch.length > 255) throw new IngestError('EMPTY_REPOSITORY', 'The repository has no default branch');
  const branchPath = defaultBranch.split('/').map(encodeURIComponent).join('/');
  const refInfo = await get(`${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/ref/heads/${branchPath}`);
  const object = refInfo['object'] as Record<string, unknown> | undefined;
  const sha = object?.['sha'];
  if (object?.['type'] !== 'commit' || typeof sha !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) {
    throw new IngestError('EMPTY_REPOSITORY', 'The default branch does not point to a commit');
  }
  const size = repo['size'];
  return {
    numericId: String(id),
    owner,
    name,
    defaultBranch,
    visibility: 'public',
    sizeKiB: typeof size === 'number' ? size : 0,
    headOid: sha,
  };
}

async function directorySize(dir: string, budget: number): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0 && total <= budget) {
    const current = stack.pop()!;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) total += (await stat(full).catch(() => ({ size: 0 }))).size;
    }
  }
  return total;
}

export interface AcquisitionOptions {
  depth?: number;
  maxBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
  scratchRoot?: string;
  gitExecutable?: string;
}

export interface AcquiredRepository {
  /** SafeGit with HTTPS-only network access to this one repository (acquisition stage). */
  git: SafeGit;
  objectsDir: string;
  bytesOnDisk: number;
}

/**
 * Acquisition-stage fetch (plan §8.3): a fresh bare repository, a single validated
 * commit, shallow depth, `blob:none` filtering, no tags, no submodules. A watchdog kills
 * the Git process tree when the scratch directory exceeds the byte budget; this is the
 * in-process counterpart of the external egress/disk caps required in Phase 5.
 */
export async function acquireGithubCommit(ref: GithubRepositoryRef, commitOid: string, options: AcquisitionOptions): Promise<AcquiredRepository> {
  const remoteUrl = `https://github.com/${ref.owner}/${ref.name}.git`;
  const git = await SafeGit.create({
    objectDirectory: null,
    objectFormat: commitOid.length === 64 ? 'sha256' : 'sha1',
    network: { kind: 'https-github', remoteUrl, promisor: true },
    ...(options.scratchRoot ? { scratchRoot: options.scratchRoot } : {}),
    ...(options.gitExecutable ? { gitExecutable: options.gitExecutable } : {}),
    defaultTimeoutMs: options.timeoutMs,
  });
  git.assertOid(commitOid);
  try {
    await withSizeWatchdog(git, options, (signal) =>
      git.run(
        ['fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--filter=blob:none', `--depth=${options.depth ?? 201}`, 'origin', commitOid],
        { timeoutMs: options.timeoutMs, maxStdoutBytes: 1024 * 1024, signal },
      ),
    );
  } catch (error) {
    await git.dispose();
    if (error instanceof IngestError && error.code === 'GIT_FAILED') {
      throw new IngestError('COMMIT_NOT_ACCESSIBLE', 'The commit could not be fetched from the repository');
    }
    throw error;
  }
  return { git, objectsDir: path.join(git.gitDir, 'objects'), bytesOnDisk: await directorySize(git.gitDir, Number.MAX_SAFE_INTEGER) };
}

/** Explicit broker request for blob objects (never parser-triggered lazy fetching). */
export async function fetchBlobs(acquired: AcquiredRepository, oids: readonly string[], options: AcquisitionOptions): Promise<void> {
  if (oids.length === 0) return;
  for (const oid of oids) acquired.git.assertOid(oid);
  await withSizeWatchdog(acquired.git, options, (signal) =>
    acquired.git.run(['fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--filter=blob:none', '--stdin', 'origin'], {
      stdin: `${oids.join('\n')}\n`,
      timeoutMs: options.timeoutMs,
      maxStdoutBytes: 1024 * 1024,
      signal,
    }),
  );
}

async function withSizeWatchdog<T>(git: SafeGit, options: AcquisitionOptions, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  let exceeded = false;
  let running = true;
  const controller = new AbortController();
  const linked = options.signal;
  const onAbort = () => controller.abort();
  linked?.addEventListener('abort', onAbort, { once: true });
  const poll = (async () => {
    while (running) {
      await new Promise((r) => setTimeout(r, 200));
      if (!running) break;
      if ((await directorySize(git.gitDir, options.maxBytes)) > options.maxBytes) {
        exceeded = true;
        controller.abort();
        break;
      }
    }
  })();
  try {
    return await work(controller.signal);
  } catch (error) {
    if (exceeded) throw new IngestError('REPOSITORY_TOO_LARGE', 'Repository acquisition exceeded the transfer limit', { limitBytes: options.maxBytes });
    throw error;
  } finally {
    running = false;
    linked?.removeEventListener('abort', onAbort);
    await poll;
  }
}
