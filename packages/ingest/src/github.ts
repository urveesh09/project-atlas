import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { IngestError } from './errors.js';
import { SafeGit, type NetworkPolicy } from './safe-git.js';

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

/**
 * Metadata request headers. An optional service token (minimum public-read scope) raises
 * API quotas only: it is sent to api.github.com alone and never reaches Git, a
 * subprocess environment, an artifact or a log (plan §8.3).
 */
function apiHeaders(token?: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'atlas-acquisition/0.1',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
  options: { fetch?: FetchLike; signal?: AbortSignal; token?: string } = {},
): Promise<GithubRepositoryInfo & { headOid: string }> {
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const get = async (url: string) => {
    const response = await doFetch(url, { method: 'GET', headers: apiHeaders(options.token), redirect: 'manual', ...(options.signal ? { signal: options.signal } : {}) }).catch((error: unknown) => {
      throw error instanceof IngestError ? error : new IngestError('UPSTREAM_UNAVAILABLE', 'Could not reach GitHub');
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

/**
 * An explicitly requested commit must be reachable from the default branch: GitHub
 * serves objects across a fork network, so fetchability alone does not prove that the
 * commit belongs to this repository (plan §4.2). Comparing head...commit lists no
 * commits ahead exactly when the commit is an ancestor of (or equal to) the head.
 */
export async function verifyCommitOnDefaultBranch(
  info: GithubRepositoryInfo & { headOid: string },
  commitOid: string,
  options: { fetch?: FetchLike; signal?: AbortSignal; token?: string } = {},
): Promise<void> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commitOid)) throw new IngestError('REF_INVALID', 'Expected a full commit ID');
  if (commitOid === info.headOid) return;
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const url = `${API}/repos/${encodeURIComponent(info.owner)}/${encodeURIComponent(info.name)}/compare/${info.headOid}...${commitOid}?per_page=1`;
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await doFetch(url, { method: 'GET', headers: apiHeaders(options.token), redirect: 'manual', ...(options.signal ? { signal: options.signal } : {}) });
  } catch (error) {
    // A diverged comparison can be large; an oversized answer is never an ancestor.
    if (error instanceof IngestError && error.details['reason'] === 'RESPONSE_TOO_LARGE') throw new IngestError('COMMIT_NOT_ACCESSIBLE', 'The commit is not on the default branch');
    throw error instanceof IngestError ? error : new IngestError('UPSTREAM_UNAVAILABLE', 'Could not reach GitHub');
  }
  if (response.status === 404 || response.status === 422) throw new IngestError('COMMIT_NOT_ACCESSIBLE', 'The commit is not on the default branch');
  const failure = classifyStatus(response.status, response.headers);
  if (failure) throw failure;
  const body = (await response.json()) as Record<string, unknown>;
  if ((body['status'] !== 'behind' && body['status'] !== 'identical') || body['ahead_by'] !== 0) {
    throw new IngestError('COMMIT_NOT_ACCESSIBLE', 'The commit is not on the default branch');
  }
}

export type GithubVisibility = { state: 'public'; owner: string; name: string } | { state: 'unavailable' };

/**
 * Revalidate a published repository by its immutable numeric ID (plan §8.6). Renames and
 * transfers keep a public repository visible; private, deleted or blocked repositories are
 * `unavailable`. Outages and throttling throw, so callers fail closed without revoking.
 */
export async function githubVisibility(numericId: string, options: { fetch?: FetchLike; signal?: AbortSignal; token?: string } = {}): Promise<GithubVisibility> {
  if (!/^[1-9]\d{0,19}$/.test(numericId)) throw new IngestError('REF_INVALID', 'Expected a numeric repository ID');
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await doFetch(`${API}/repositories/${numericId}`, { method: 'GET', headers: apiHeaders(options.token), redirect: 'manual', ...(options.signal ? { signal: options.signal } : {}) });
  } catch (error) {
    throw error instanceof IngestError ? error : new IngestError('UPSTREAM_UNAVAILABLE', 'Could not reach GitHub');
  }
  if (response.status === 404 || response.status === 451) return { state: 'unavailable' };
  if (response.status >= 300 && response.status < 400) throw new IngestError('UPSTREAM_UNAVAILABLE', 'Unexpected GitHub redirect');
  const failure = classifyStatus(response.status, response.headers);
  if (failure?.code === 'REPOSITORY_NOT_FOUND') return { state: 'unavailable' };
  if (failure) throw failure;
  const repo = (await response.json()) as Record<string, unknown>;
  if (String(repo['id']) !== numericId) throw new IngestError('UPSTREAM_UNAVAILABLE', 'Unexpected GitHub repository metadata');
  if (repo['private'] !== false || (repo['visibility'] !== undefined && repo['visibility'] !== 'public')) return { state: 'unavailable' };
  const [owner, name] = String(repo['full_name'] ?? '').split('/');
  if (!owner || !name || !OWNER.test(owner) || !NAME.test(name)) throw new IngestError('UPSTREAM_UNAVAILABLE', 'Unexpected GitHub repository name');
  return { state: 'public', owner, name };
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
  /** Reuse an earlier stage's ATLAS scratch directory (deepening the same repository). */
  scratchDir?: string;
  gitExecutable?: string;
  /**
   * `blob:none` (default) fetches commits and trees only; blobs then come by explicit
   * broker request. `none` fetches the bounded window with its blobs, which hosted
   * analysis uses because sizes, renames and line counts need blob content (ADR-031).
   */
  filter?: 'blob:none' | 'none';
  /** HTTP CONNECT egress broker (`http://host:port`); never a URL from user input. */
  proxy?: string;
  /** A trusted local bare repository instead of GitHub (authored demos, tests). */
  fixtureRemote?: string;
}

export interface AcquiredRepository {
  /** SafeGit with network access to this one repository (acquisition stage only). */
  git: SafeGit;
  objectsDir: string;
  bytesOnDisk: number;
}

function acquisitionNetwork(ref: GithubRepositoryRef, options: AcquisitionOptions): NetworkPolicy {
  if (options.fixtureRemote) return { kind: 'local-fixture', remotePath: options.fixtureRemote };
  return {
    kind: 'https-github',
    remoteUrl: `https://github.com/${ref.owner}/${ref.name}.git`,
    promisor: (options.filter ?? 'blob:none') === 'blob:none',
    ...(options.proxy ? { proxy: options.proxy } : {}),
  };
}

function fetchArgs(commitOid: string, options: AcquisitionOptions): string[] {
  const depth = options.depth ?? 201;
  if (!Number.isInteger(depth) || depth < 1 || depth > 201) throw new IngestError('GIT_FAILED', 'Invalid acquisition depth');
  return [
    'fetch',
    '--no-tags',
    '--no-recurse-submodules',
    '--no-write-fetch-head',
    '--no-auto-gc',
    ...((options.filter ?? 'blob:none') === 'blob:none' ? ['--filter=blob:none'] : []),
    `--depth=${depth}`,
    'origin',
    commitOid,
  ];
}

/**
 * Acquisition-stage fetch (plan §8.3): a fresh bare repository, a single validated
 * commit, shallow depth, no tags, no submodules, optionally blob-filtered. A watchdog kills
 * the Git process tree when the scratch directory exceeds the byte budget; hosted
 * acquisition also runs in a container whose only route out is the egress broker, which
 * counts actual network bytes (ADR-031).
 */
export async function acquireGithubCommit(ref: GithubRepositoryRef, commitOid: string, options: AcquisitionOptions): Promise<AcquiredRepository> {
  const git = await SafeGit.create({
    objectDirectory: null,
    objectFormat: commitOid.length === 64 ? 'sha256' : 'sha1',
    network: acquisitionNetwork(ref, options),
    ...(options.scratchRoot ? { scratchRoot: options.scratchRoot } : {}),
    ...(options.scratchDir ? { scratchDir: options.scratchDir } : {}),
    ...(options.gitExecutable ? { gitExecutable: options.gitExecutable } : {}),
    defaultTimeoutMs: options.timeoutMs,
  });
  try {
    git.assertOid(commitOid);
    await runFetch(git, commitOid, options);
  } catch (error) {
    if (!options.scratchDir) await git.dispose();
    throw error;
  }
  return { git, objectsDir: path.join(git.gitDir, 'objects'), bytesOnDisk: await directorySize(git.gitDir, Number.MAX_SAFE_INTEGER) };
}

/**
 * Deepen an acquisition to `depth` commits (the history stage, after the HEAD
 * checkpoint). The byte budget bounds what this call adds; returns the bytes added.
 */
export async function deepenAcquisition(acquired: AcquiredRepository, commitOid: string, options: AcquisitionOptions): Promise<number> {
  acquired.git.assertOid(commitOid);
  const before = await directorySize(acquired.git.gitDir, Number.MAX_SAFE_INTEGER);
  await runFetch(acquired.git, commitOid, { ...options, maxBytes: before + options.maxBytes });
  acquired.bytesOnDisk = await directorySize(acquired.git.gitDir, Number.MAX_SAFE_INTEGER);
  return acquired.bytesOnDisk - before;
}

async function runFetch(git: SafeGit, commitOid: string, options: AcquisitionOptions): Promise<void> {
  try {
    await withSizeWatchdog(git, options, (signal) => git.run(fetchArgs(commitOid, options), { timeoutMs: options.timeoutMs, maxStdoutBytes: 1024 * 1024, signal }));
  } catch (error) {
    if (error instanceof IngestError && error.code === 'GIT_FAILED') {
      throw new IngestError('COMMIT_NOT_ACCESSIBLE', 'The commit could not be fetched from the repository');
    }
    throw error;
  }
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
  if (linked?.aborted) controller.abort();
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
    const result = await work(controller.signal);
    // A fast fetch can finish before the first polling tick. Check the final stored
    // size before returning success; the polling watchdog alone leaves a gap.
    if (exceeded || (await directorySize(git.gitDir, options.maxBytes)) > options.maxBytes) {
      throw new IngestError('REPOSITORY_TOO_LARGE', 'Repository acquisition exceeded the transfer limit', { limitBytes: options.maxBytes });
    }
    return result;
  } catch (error) {
    if (exceeded) throw new IngestError('REPOSITORY_TOO_LARGE', 'Repository acquisition exceeded the transfer limit', { limitBytes: options.maxBytes });
    throw error;
  } finally {
    running = false;
    linked?.removeEventListener('abort', onAbort);
    await poll;
  }
}
