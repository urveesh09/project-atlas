import type { Pool } from 'pg';
import {
  ByteMeter,
  IngestError,
  githubVisibility,
  pinnedFetch,
  resolveGithubRepository,
  verifyCommitOnDefaultBranch,
  type FetchLike,
  type GithubRepositoryRef,
  type GithubVisibility,
  type Lookup,
} from '@atlas/ingest';
import { ServiceError } from './errors.js';

/** The immutable identity a job analyzes (plan §8.2): numeric ID, canonical name and a full SHA. */
export interface RepositoryResolution {
  numericId: string;
  owner: string;
  name: string;
  defaultBranch: string;
  commitOid: string;
  objectFormat: 'sha1' | 'sha256';
}

export interface RepositoryResolver {
  /** Resolve visibility, identity and the commit (the default branch head unless `commitSha`). */
  resolve(ref: GithubRepositoryRef, commitSha: string | null, signal?: AbortSignal): Promise<RepositoryResolution>;
  /** Current visibility by numeric ID. Throws on outage or throttling so callers fail closed. */
  visibility(numericId: string, signal?: AbortSignal): Promise<GithubVisibility>;
}

/**
 * GitHub request budget shared by every API process and worker slot through PostgreSQL
 * (plan §13.4). Upstream quota headers and Retry-After block all callers until the reset,
 * so one throttled answer stops a retry storm instead of multiplying it.
 */
export class UpstreamGate {
  constructor(
    readonly pool: Pool,
    readonly name = 'github-api',
    /** Stop voluntarily with this many requests left in the window. */
    readonly reserve = 2,
  ) {}

  async before(): Promise<void> {
    const row = (await this.pool.query<{ wait: string | null }>(
      'SELECT ceil(extract(epoch FROM blocked_until-clock_timestamp()))::text AS wait FROM upstream_budgets WHERE name=$1 AND blocked_until>clock_timestamp()',
      [this.name],
    )).rows[0];
    if (row) throw new ServiceError('UPSTREAM_RATE_LIMITED', 503, 'GitHub is rate limiting requests; try again later.', Math.min(Math.max(Number(row.wait ?? 60), 1), 3600));
  }

  async observe(status: number, headers: { get(name: string): string | null }): Promise<void> {
    const remaining = Number(headers.get('x-ratelimit-remaining'));
    const reset = Number(headers.get('x-ratelimit-reset'));
    const retryAfter = Number(headers.get('retry-after'));
    const hasRemaining = headers.get('x-ratelimit-remaining') !== null && Number.isInteger(remaining);
    const hasReset = headers.get('x-ratelimit-reset') !== null && Number.isInteger(reset) && reset > 0;
    let blockSeconds: number | null = null;
    if (headers.get('retry-after') !== null && Number.isFinite(retryAfter) && retryAfter >= 0) blockSeconds = Math.min(Math.ceil(retryAfter), 3600);
    else if ((status === 403 || status === 429) && hasRemaining && remaining === 0) blockSeconds = hasReset ? null : 60;
    else if (status === 429) blockSeconds = 60;
    const throttled = blockSeconds !== null || (hasRemaining && remaining <= this.reserve);
    if (!hasRemaining && !throttled) return;
    await this.pool.query(
      `INSERT INTO upstream_budgets(name,blocked_until,remaining,reset_at,updated_at)
       VALUES($1,
         CASE WHEN $2::int IS NOT NULL THEN clock_timestamp()+make_interval(secs=>$2::int)
              WHEN $5 AND $4::bigint IS NOT NULL THEN least(to_timestamp($4::bigint),clock_timestamp()+interval '1 hour') END,
         $3,CASE WHEN $4::bigint IS NOT NULL THEN to_timestamp($4::bigint) END,clock_timestamp())
       ON CONFLICT(name) DO UPDATE SET blocked_until=greatest(upstream_budgets.blocked_until,EXCLUDED.blocked_until),
         remaining=EXCLUDED.remaining,reset_at=EXCLUDED.reset_at,updated_at=EXCLUDED.updated_at`,
      [this.name, blockSeconds, hasRemaining ? remaining : null, hasReset ? reset : null, throttled],
    );
  }

  /** Wrap a fetch so every request checks and updates the shared budget. */
  wrap(inner: FetchLike): FetchLike {
    return async (url, init) => {
      await this.before();
      const response = await inner(url, init);
      await this.observe(response.status, response.headers);
      return response;
    };
  }
}

export interface GithubResolverOptions {
  gate: UpstreamGate;
  /** Optional minimum-scope token for API quotas; never given to Git or sandboxes. */
  token?: string;
  /** Tests inject transports; production uses the pinned egress fetch. */
  fetch?: FetchLike;
  lookup?: Lookup;
}

/** Production resolver: pinned, allowlisted, budgeted GitHub REST calls (plan §8.2). */
export class GithubResolver implements RepositoryResolver {
  constructor(private readonly options: GithubResolverOptions) {
    if (options.token !== undefined && !/^[A-Za-z0-9_]{20,255}$/.test(options.token)) throw new Error('Invalid GitHub token format');
  }
  private fetch(): FetchLike {
    const transport = this.options.fetch ?? pinnedFetch({ budget: new ByteMeter(8 * 1024 * 1024), ...(this.options.lookup ? { lookup: this.options.lookup } : {}) });
    return this.options.gate.wrap(transport);
  }
  async resolve(ref: GithubRepositoryRef, commitSha: string | null, signal?: AbortSignal): Promise<RepositoryResolution> {
    const fetch = this.fetch();
    const common = { fetch, ...(signal ? { signal } : {}), ...(this.options.token ? { token: this.options.token } : {}) };
    const info = await resolveGithubRepository(ref, common);
    if (commitSha !== null && info.headOid.length !== commitSha.length) throw new IngestError('COMMIT_NOT_ACCESSIBLE', 'The commit uses a different object format');
    if (commitSha !== null) await verifyCommitOnDefaultBranch(info, commitSha, common);
    const commitOid = commitSha ?? info.headOid;
    return { numericId: info.numericId, owner: info.owner, name: info.name, defaultBranch: info.defaultBranch, commitOid, objectFormat: commitOid.length === 64 ? 'sha256' : 'sha1' };
  }
  visibility(numericId: string, signal?: AbortSignal): Promise<GithubVisibility> {
    return githubVisibility(numericId, { fetch: this.fetch(), ...(signal ? { signal } : {}), ...(this.options.token ? { token: this.options.token } : {}) });
  }
}

export interface FixtureRepository {
  numericId: string;
  owner: string;
  name: string;
  defaultBranch: string;
  headOid: string;
  /** Trusted local bare repository the fixture acquirer fetches from. */
  remotePath: string;
  visibility: 'public' | 'unavailable';
}

/**
 * Authored-demo and test resolver: no network. Visibility can change at runtime so
 * revocation and purge are exercised without a real GitHub repository.
 */
export class FixtureResolver implements RepositoryResolver {
  readonly repositories = new Map<string, FixtureRepository>();
  outage = false;
  constructor(repositories: readonly FixtureRepository[]) {
    for (const repo of repositories) this.repositories.set(`${repo.owner}/${repo.name}`.toLowerCase(), repo);
  }
  byNumericId(numericId: string): FixtureRepository | undefined {
    return [...this.repositories.values()].find((r) => r.numericId === numericId);
  }
  async resolve(ref: GithubRepositoryRef, commitSha: string | null): Promise<RepositoryResolution> {
    if (this.outage) throw new IngestError('UPSTREAM_UNAVAILABLE', 'GitHub is unavailable');
    const repo = this.repositories.get(`${ref.owner}/${ref.name}`.toLowerCase());
    if (!repo || repo.visibility !== 'public') throw new IngestError('REPOSITORY_NOT_FOUND', 'Repository not found or not public');
    if (commitSha !== null && commitSha !== repo.headOid) throw new IngestError('COMMIT_NOT_ACCESSIBLE', 'The commit is not on the default branch');
    const commitOid = commitSha ?? repo.headOid;
    return { numericId: repo.numericId, owner: repo.owner, name: repo.name, defaultBranch: repo.defaultBranch, commitOid, objectFormat: commitOid.length === 64 ? 'sha256' : 'sha1' };
  }
  async visibility(numericId: string): Promise<GithubVisibility> {
    if (this.outage) throw new IngestError('UPSTREAM_UNAVAILABLE', 'GitHub is unavailable');
    const repo = this.byNumericId(numericId);
    return repo && repo.visibility === 'public' ? { state: 'public', owner: repo.owner, name: repo.name } : { state: 'unavailable' };
  }
}
