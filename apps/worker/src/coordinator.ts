import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { ANALYZER_VERSION } from '@atlas/analyzer-core';
import { directorySource, verifyArtifactDirectory } from '@atlas/artifact/node';
import {
  PublicationStore,
  ServiceError,
  cacheKey,
  contentKey,
  publishCachedInTransaction,
  publishInTransaction,
  toServiceError,
  uploadSource,
  uploadVerifiedArtifact,
  type ObjectStore,
  type RepositoryResolution,
  type RepositoryResolver,
} from '@atlas/control';
import { openArtifact } from '@atlas/artifact';
import { gunzipNode } from '@atlas/artifact/node';
import { parseGithubRepositoryUrl } from '@atlas/ingest';
import { LIMITS, hostedRepositoryId, type ArtifactManifest, type JobStatus } from '@atlas/schema';
import type { Pool } from 'pg';
import { JobQueue, LeaseLostError, type Lease } from './queue.js';
import type { StageRunners } from './runners.js';
import type { SandboxProgress } from './sandbox/spec.js';

export type LogFields = Record<string, string | number | boolean | null>;
export type Logger = (event: string, fields: LogFields) => void;

export interface CoordinatorOptions {
  pool: Pool;
  queue: JobQueue;
  store: ObjectStore;
  publications: PublicationStore;
  resolver: RepositoryResolver;
  runners: StageRunners;
  /** Host directory for per-attempt scratch (acquired objects, sandbox output). */
  workRoot: string;
  log?: Logger;
  /** Time kept back from analysis for verification, upload and publication. */
  publishReserveMs?: number;
}

type StopReason = 'cancelled' | 'lease-lost' | 'deadline';

/**
 * Why history is missing from a published HEAD checkpoint (job warning codes). The
 * artifact itself records history as unavailable at a resource boundary.
 */
type FallbackReason = 'ACQUISITION_NETWORK_LIMIT' | 'HISTORY_ACQUISITION_FAILED' | 'HISTORY_ANALYSIS_FAILED' | 'HISTORY_DEADLINE' | 'HISTORY_ARTIFACT_INVALID';

class StageFailure extends Error {
  constructor(readonly fallback: FallbackReason, override readonly cause: unknown) {
    super(fallback);
  }
}

/**
 * Heartbeats every 10 s, polls for cancellation every second and stops work before the
 * hard deadline, all on database authority (ADR-029). Any stop aborts the shared signal,
 * which removes running containers before the coordinator acknowledges anything.
 */
class LeaseMonitor {
  reason: StopReason | null = null;
  private readonly controller = new AbortController();
  private readonly timers: ReturnType<typeof setTimeout>[] = [];
  private beats = 0;
  readonly signal = this.controller.signal;
  readonly deadlineAt: number;
  constructor(
    private readonly queue: JobQueue,
    private readonly lease: Lease,
    stopBeforeDeadlineMs: number,
  ) {
    this.deadlineAt = performance.now() + lease.remainingMs;
    const poll = setInterval(() => void this.check(), 1000);
    this.timers.push(poll, setTimeout(() => this.stop('deadline'), Math.max(0, lease.remainingMs - stopBeforeDeadlineMs)));
  }
  remainingMs(): number {
    return this.deadlineAt - performance.now();
  }
  private async check() {
    if (this.reason) return;
    try {
      const state = await this.queue.leaseState(this.lease);
      if (state.state === 'CANCEL_REQUESTED') return this.stop('cancelled');
      if (!state.live) return this.stop('lease-lost');
      if (++this.beats % 10 === 0 && !(await this.queue.heartbeat(this.lease))) {
        const again = await this.queue.leaseState(this.lease);
        this.stop(again.state === 'CANCEL_REQUESTED' ? 'cancelled' : 'lease-lost');
      }
    } catch {
      // A database blip is tolerated until the lease itself lapses (30 s).
    }
  }
  stop(reason: StopReason) {
    if (this.reason) return;
    this.reason = reason;
    this.controller.abort();
  }
  dispose() {
    for (const timer of this.timers) clearTimeout(timer);
  }
}

const repositoryTag = (numericId: string) => createHash('sha256').update(`repo\0${numericId}`).digest('hex').slice(0, 16);

/**
 * Crash-recovery sweep of temporary source data (plan §8.6: within one hour). Removes
 * attempt directories older than `maxAgeMs` that no running attempt owns. A killed
 * process leaves its scratch behind; normal attempts remove their own at once.
 */
export async function sweepScratch(workRoot: string, active: ReadonlySet<string>, maxAgeMs = 3_600_000): Promise<number> {
  let removed = 0;
  const running = new Set([...active].map((p) => path.resolve(p)));
  const entries = await readdir(workRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^job_[0-9a-f]{32}-/.test(entry.name)) continue;
    const full = path.join(workRoot, entry.name);
    if (running.has(path.resolve(full))) continue;
    const info = await stat(full).catch(() => null);
    if (!info || Date.now() - info.mtimeMs < maxAgeMs) continue;
    await rm(full, { recursive: true, force: true, maxRetries: 3 }).then(() => removed++, () => undefined);
  }
  return removed;
}

/** One job attempt, end to end (plan §8.3, §13.2, ADR-031). */
export class Coordinator {
  private readonly log: Logger;
  private readonly reserveMs: number;
  /** Scratch directories of attempts running in this process (never swept). */
  readonly activeScratch = new Set<string>();
  constructor(private readonly options: CoordinatorOptions) {
    this.log = options.log ?? (() => {});
    this.reserveMs = options.publishReserveMs ?? 20_000;
  }

  /** Remove scratch left by crashed processes (see `sweepScratch`). */
  sweepScratch(maxAgeMs?: number): Promise<number> {
    return sweepScratch(this.options.workRoot, this.activeScratch, maxAgeMs);
  }

  /** Claim and run one job; false when the queue is empty. */
  async runOnce(): Promise<boolean> {
    const lease = await this.options.queue.claim();
    if (!lease) return false;
    await this.run(lease);
    return true;
  }

  async run(lease: Lease): Promise<void> {
    const { queue } = this.options;
    const monitor = new LeaseMonitor(queue, lease, 8_000);
    const metrics: Record<string, unknown> = { attempt: lease.attempt, isolation: this.options.runners.isolation, stageMs: {} as Record<string, number> };
    await mkdir(this.options.workRoot, { recursive: true, mode: 0o700 });
    const jobDir = await mkdtemp(path.join(this.options.workRoot, `${lease.jobId}-`));
    this.activeScratch.add(jobDir);
    this.log('job.start', { job: lease.jobId, attempt: lease.attempt });
    try {
      const pipeline = new Pipeline(this.options, lease, monitor, jobDir, metrics, this.log, this.reserveMs);
      await pipeline.run();
    } catch (error) {
      await this.settleFailure(lease, monitor, error, metrics);
    } finally {
      monitor.dispose();
      await rm(jobDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => this.log('job.scratch-cleanup-failed', { job: lease.jobId }));
      this.activeScratch.delete(jobDir);
    }
  }

  private async settleFailure(lease: Lease, monitor: LeaseMonitor, error: unknown, metrics: Record<string, unknown>) {
    const { queue } = this.options;
    const state = await queue.leaseState(lease).catch(() => ({ state: null, live: false }));
    if (monitor.reason === 'cancelled' || state.state === 'CANCEL_REQUESTED') {
      // Containers were removed when the stage's signal aborted; only now acknowledge.
      await queue.cancelled(lease).catch(() => undefined);
      this.log('job.cancelled', { job: lease.jobId });
      return;
    }
    if (monitor.reason === 'lease-lost' || error instanceof LeaseLostError || !state.live) {
      this.log('job.lease-lost', { job: lease.jobId });
      return;
    }
    const failure = monitor.reason === 'deadline' ? new ServiceError('ANALYSIS_RESOURCE_LIMIT', 413, 'The job exceeded the V0.1 time limit.') : toServiceError(error);
    await queue
      .fail(lease, { code: failure.code, message: failure.message, retryable: failure.status >= 500 || failure.status === 429, details: { ...failure.details }, requestId: `req_${createHash('sha256').update(`${lease.jobId}\0${lease.attempt}`).digest('hex').slice(0, 32)}` }, { ...metrics, outcome: failure.code })
      .catch(() => undefined);
    this.log('job.failed', { job: lease.jobId, code: failure.code });
  }
}

class Pipeline {
  private readonly queue: JobQueue;
  private readonly acquiredDir: string;
  private counts: Record<string, number> = {};
  private warnings = new Map<string, number>();
  private lastProgressAt = 0;
  private state: 'ACQUIRING' | 'ANALYZING' | 'HISTORY' | 'LAYOUT' | 'VALIDATING' = 'ACQUIRING';
  private stage: NonNullable<JobStatus['stage']> = 'acquire';
  private networkBytes = 0;

  constructor(
    private readonly options: CoordinatorOptions,
    private readonly lease: Lease,
    private readonly monitor: LeaseMonitor,
    private readonly jobDir: string,
    private readonly metrics: Record<string, unknown>,
    private readonly log: Logger,
    private readonly reserveMs: number,
  ) {
    this.queue = options.queue;
    this.acquiredDir = path.join(jobDir, 'acquired');
  }

  private get signal() {
    return this.monitor.signal;
  }

  private async timed<T>(name: string, work: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await work();
    } finally {
      (this.metrics['stageMs'] as Record<string, number>)[name] = Math.round(performance.now() - started);
    }
  }

  /** Progress writes are applied strictly in order, so a stage can never be skipped or reordered. */
  private progressChain: Promise<void> = Promise.resolve();
  private progress(state: Pipeline['state'], stage: Pipeline['stage'], force = true): Promise<void> {
    const write = async () => {
      const advanced = state !== this.state || stage !== this.stage;
      if (!force && !advanced && performance.now() - this.lastProgressAt < 1000) return;
      this.state = state;
      this.stage = stage;
      this.lastProgressAt = performance.now();
      await this.queue.progress(this.lease, { state, stage, counts: { ...this.counts }, warnings: [...this.warnings].map(([code, count]) => ({ code, count })) });
    };
    const next = this.progressChain.then(write);
    // A failed live update must not block later ones; awaited callers still see it.
    this.progressChain = next.catch(() => undefined);
    return next;
  }

  private warn(code: string, count = 1) {
    this.warnings.set(code, (this.warnings.get(code) ?? 0) + count);
  }

  /** Remaining time for sandbox work, keeping the publication reserve. */
  private budget(): number {
    return Math.floor(this.monitor.remainingMs() - this.reserveMs);
  }

  async run(): Promise<void> {
    const input = this.lease.input;
    if (this.options.runners.isolation === 'process') this.warn('PROCESS_ISOLATION_ONLY');

    // 1. Validate: immutable identity from GitHub (or the fixture resolver), recorded under the lease.
    await this.progress('ACQUIRING', 'validate');
    const repo = await this.timed('validate', () => this.options.resolver.resolve(parseGithubRepositoryUrl(input.repositoryUrl), input.commitSha, this.signal));
    await this.queue.recordRepository(this.lease, repo);
    this.log('job.resolved', { job: this.lease.jobId, repo: repositoryTag(repo.numericId) });
    const key = cacheKey({ githubId: repo.numericId, commitOid: repo.commitOid, profile: input.profile, historyEnabled: input.history.enabled, analyzerVersion: ANALYZER_VERSION });

    // 2. A complete cached artifact for this exact identity becomes a new publication.
    const reused = await this.queue.complete(this.lease, { state: 'READY', counts: { cached: 1 }, warnings: [], metrics: { ...this.metrics, outcome: 'CACHED' } }, async (client) => {
      const cached = await publishCachedInTransaction(client, { jobId: this.lease.jobId, cacheKey: key });
      if (!cached) throw new CacheMiss();
      return cached.analysisId;
    }).catch((error: unknown) => {
      if (error instanceof CacheMiss) return null;
      throw error;
    });
    if (reused) {
      this.log('job.ready', { job: this.lease.jobId, cached: true });
      return;
    }

    await mkdir(this.acquiredDir, { recursive: true });
    // Acquisition sandboxes run as an unprivileged container user; the parent job directory stays private.
    await chmod(this.acquiredDir, 0o777);

    if (!input.history.enabled) {
      await this.acquire(repo, 1);
      const out = await this.analyze(repo, { history: false, checkpoint: false });
      await this.publishArtifact(repo, out, key);
      return;
    }

    // 3. History requested. HEAD first, verified and checkpointed durably (plan §8.3).
    let checkpoint = await this.queue.checkpoint(this.lease.jobId);
    if (!checkpoint) {
      await this.acquire(repo, 1);
      const head = await this.analyze(repo, { history: true, checkpoint: true });
      checkpoint = await this.storeCheckpoint(repo, head);
    } else {
      this.warn('CHECKPOINT_RECOVERED');
    }

    // 4. History: deepen acquisition, then the full analysis. Any failure here publishes the
    //    verified checkpoint as a PARTIAL result instead of failing the job.
    try {
      await this.progress('HISTORY', 'history');
      try {
        await this.acquire(repo, LIMITS.firstParentCommits + 1, 'acquireHistory');
      } catch (error) {
        const failure = toServiceError(error);
        throw new StageFailure(failure.code === 'REPOSITORY_TOO_LARGE' ? 'ACQUISITION_NETWORK_LIMIT' : this.monitor.reason === 'deadline' ? 'HISTORY_DEADLINE' : 'HISTORY_ACQUISITION_FAILED', error);
      }
      let full: string;
      try {
        full = await this.analyze(repo, { history: true, checkpoint: false });
      } catch (error) {
        if (error instanceof StageFailure) throw error;
        throw new StageFailure(this.monitor.reason === 'deadline' ? 'HISTORY_DEADLINE' : 'HISTORY_ANALYSIS_FAILED', error);
      }
      await this.publishArtifact(repo, full, key);
    } catch (error) {
      if (!(error instanceof StageFailure) || this.monitor.reason === 'cancelled' || this.monitor.reason === 'lease-lost') throw error;
      this.log('job.history-fallback', { job: this.lease.jobId, reason: error.fallback });
      await this.publishCheckpoint(repo, checkpoint, error.fallback);
    }
  }

  private async acquire(repo: RepositoryResolution, depth: number, metric = 'acquireHead'): Promise<void> {
    if (depth === 1) await this.progress('ACQUIRING', 'acquire');
    const deadlineMs = Math.min(this.budget(), 120_000);
    if (deadlineMs < 1000) throw new ServiceError('ANALYSIS_RESOURCE_LIMIT', 413, 'The job exceeded the V0.1 time limit.');
    const remainingBytes = LIMITS.acquisitionNetworkBytes - this.networkBytes;
    if (remainingBytes < 1) throw new ServiceError('REPOSITORY_TOO_LARGE', 413, 'Repository acquisition exceeded the V0.1 transfer limit.', undefined, { limitMiB: 256 });
    const outcome = await this.timed(metric, () =>
      this.options.runners.acquire({
        jobId: this.lease.jobId,
        acquiredDir: this.acquiredDir,
        owner: repo.owner,
        name: repo.name,
        numericId: repo.numericId,
        commitOid: repo.commitOid,
        depth,
        maxNetworkBytes: remainingBytes,
        deadlineMs,
        signal: this.signal,
      }),
    );
    this.networkBytes += outcome.networkBytes ?? 0;
    this.metrics['networkBytes'] = this.networkBytes;
    this.metrics['acquiredBytes'] = outcome.bytesOnDisk;
    this.counts['acquiredKiB'] = Math.ceil(outcome.bytesOnDisk / 1024);
  }

  /** Run one analysis sandbox; returns the host directory with its (unverified) artifact. */
  private async analyze(repo: RepositoryResolution, mode: { history: boolean; checkpoint: boolean }): Promise<string> {
    const full = mode.history && !mode.checkpoint;
    if (!full) await this.progress('ANALYZING', 'index');
    const outDir = path.join(this.jobDir, full ? 'artifact' : mode.history ? 'checkpoint' : 'artifact');
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    const deadlineMs = this.budget();
    if (deadlineMs < 5000) throw new ServiceError('ANALYSIS_RESOURCE_LIMIT', 413, 'The job exceeded the V0.1 time limit.');
    const onProgress = (event: SandboxProgress) => void this.onAnalysisProgress(event, full).catch(() => undefined);
    const result = await this.timed(full ? 'analyzeHistory' : 'analyzeHead', () =>
      this.options.runners.analyze({
        jobId: this.lease.jobId,
        acquiredDir: this.acquiredDir,
        outDir,
        spec: {
          commitOid: repo.commitOid,
          objectFormat: repo.objectFormat,
          repository: { numericId: repo.numericId, owner: repo.owner, name: repo.name },
          history: mode.history,
          checkpoint: mode.checkpoint,
          // The analyzer degrades history before the sandbox deadline; HEAD fails last.
          deadlineMs: Math.max(1000, Math.min(LIMITS.workerDeadlineMs, deadlineMs - 5000)),
        },
        deadlineMs,
        signal: this.signal,
        onProgress,
      }),
    );
    // Every live update lands before the stage advances; the sandbox has laid out the city.
    await this.progressChain;
    if (result.ok && full && this.state !== 'LAYOUT') await this.progress('LAYOUT', 'layout');
    if (!result.ok) {
      const code = result.code === 'ANALYSIS_RESOURCE_LIMIT' || result.code === 'SANDBOX_KILLED' ? 'ANALYSIS_RESOURCE_LIMIT' : result.code === 'EMPTY_REPOSITORY' ? 'EMPTY_REPOSITORY' : 'ANALYSIS_RESOURCE_LIMIT';
      throw new ServiceError(code, code === 'EMPTY_REPOSITORY' ? 409 : 413, code === 'EMPTY_REPOSITORY' ? 'The repository is empty or has no default branch commit.' : 'Analysis exceeded a V0.1 resource limit.', undefined, result.limit ? { limit: result.limit } : {});
    }
    return outDir;
  }

  private async onAnalysisProgress(event: SandboxProgress, full: boolean) {
    if (event.stage === 'parse' && event.total !== undefined) {
      this.counts['filesParsed'] = event.done ?? 0;
      this.counts['filesToParse'] = event.total;
    }
    if (event.stage === 'frames' && event.total !== undefined) {
      this.counts['framesDone'] = event.done ?? 0;
      this.counts['framesTotal'] = event.total;
    }
    if (full && (event.stage === 'layout' || event.stage === 'assemble')) return this.progress('LAYOUT', 'layout', false);
    if (full) return this.progress('HISTORY', 'history', false);
    return this.progress('ANALYZING', event.stage === 'parse' || event.stage === 'dependencies' || event.stage === 'findings' ? 'analyze' : 'index', false);
  }

  /**
   * Independent verification of sandbox output (plan §8.1): the full streaming validator,
   * then identity checks a sandbox could not satisfy by accident. Nothing unverified is
   * uploaded or published.
   */
  private async verify(repo: RepositoryResolution, dir: string, expectHistory: 'unavailable' | 'requested' | 'disabled'): Promise<{ manifest: ArtifactManifest; status: 'complete' | 'partial'; compressedBytes: number }> {
    const verified = await verifyArtifactDirectory(dir);
    if (!verified.ok) throw new ServiceError('ARTIFACT_INVALID', 503, 'The analysis output failed validation.', undefined, { issue: verified.issues[0]?.code ?? 'UNKNOWN' });
    const manifest = verified.opened.manifest;
    const remote = manifest.repo.remote;
    const history = manifest.coverage.history;
    const identityOk =
      manifest.repo.sourceKind === 'public-github' &&
      remote !== null &&
      remote.numericId === repo.numericId &&
      remote.owner === repo.owner &&
      remote.name === repo.name &&
      manifest.repo.repoId === hostedRepositoryId(repo.numericId) &&
      manifest.selectedCommit.oid === repo.commitOid &&
      manifest.analyzer.version === ANALYZER_VERSION &&
      (expectHistory === 'requested' ? history.requestedCommitCap > 0 : expectHistory === 'unavailable' ? history.status === 'unavailable' && history.boundary === 'resource-cap' : history.requestedCommitCap === 0);
    if (!identityOk) throw new ServiceError('ARTIFACT_INVALID', 503, 'The analysis output does not match the requested repository or commit.');
    const head = manifest.frames.at(-1)!;
    const historyIncomplete = expectHistory !== 'disabled' && history.status !== 'complete';
    const status = head.analysisStatus === 'partial' || historyIncomplete ? 'partial' : 'complete';
    const c = head.coverage;
    this.counts = {
      ...this.counts,
      filesDiscovered: c.discoveredFiles,
      filesIncluded: c.includedFiles,
      filesParsed: c.parsedFiles,
      importsObserved: c.observedImports,
      // Unavailable history has no counts: never report it as a measured zero.
      ...(history.status === 'unavailable' ? {} : { framesCompleted: history.framesCompleted, framesRequested: history.framesRequested, commitsTraversed: history.commitsTraversed }),
      artifactKiB: Math.ceil(verified.summary.stats.compressedBytes / 1024),
    };
    for (const limit of c.limitsHit) this.warn(limit);
    if (c.parseFailedFiles > 0) this.warn('PARSE_FAILED', c.parseFailedFiles);
    return { manifest, status, compressedBytes: verified.summary.stats.compressedBytes };
  }

  /** Verified and stored while the job is still ANALYZING: the state machine only moves forward. */
  private async storeCheckpoint(repo: RepositoryResolution, dir: string): Promise<{ uploadId: string; contentKey: string }> {
    const verified = await this.timed('verifyHead', () => this.verify(repo, dir, 'unavailable'));
    const { uploadId } = await this.timed('uploadHead', () =>
      uploadVerifiedArtifact(this.options.pool, this.options.store, { jobId: this.lease.jobId, generation: this.lease.generation, purpose: 'checkpoint', source: directorySource(dir), manifest: verified.manifest, signal: this.signal }),
    );
    const checkpoint = { uploadId, contentKey: contentKey(verified.manifest) };
    await this.queue.recordCheckpoint(this.lease, checkpoint);
    this.log('job.checkpoint', { job: this.lease.jobId });
    return checkpoint;
  }

  private async publishArtifact(repo: RepositoryResolution, dir: string, key: string): Promise<void> {
    const history = this.lease.input.history.enabled;
    await this.progress('VALIDATING', 'validate');
    let verified;
    try {
      verified = await this.timed('verify', () => this.verify(repo, dir, history ? 'requested' : 'disabled'));
    } catch (error) {
      if (history && error instanceof ServiceError && error.code === 'ARTIFACT_INVALID') throw new StageFailure('HISTORY_ARTIFACT_INVALID', error);
      throw error;
    }
    if (history && verified.manifest.coverage.history.status !== 'complete') this.warn('HISTORY_PARTIAL');
    await this.progress('VALIDATING', 'publish');
    const { uploadId } = await this.timed('upload', () =>
      uploadVerifiedArtifact(this.options.pool, this.options.store, { jobId: this.lease.jobId, generation: this.lease.generation, purpose: 'artifact', source: directorySource(dir), manifest: verified.manifest, signal: this.signal }),
    );
    await this.finish(repo, verified, uploadId, verified.status === 'complete' ? key : null);
  }

  /** Publish the verified HEAD checkpoint as PARTIAL (plan §4.2: complete HEAD, partial history). */
  private async publishCheckpoint(repo: RepositoryResolution, checkpoint: { uploadId: string; contentKey: string }, reason: FallbackReason): Promise<void> {
    this.warn('HISTORY_NOT_ACQUIRED');
    this.warn(reason);
    await this.progress('VALIDATING', 'publish');
    // Re-open from storage: proves the stored checkpoint still validates before reuse.
    const opened = await openArtifact(uploadSource(this.options.store, checkpoint.uploadId), gunzipNode);
    if (!opened.ok || contentKey(opened.artifact.manifest) !== checkpoint.contentKey) throw new ServiceError('ARTIFACT_INVALID', 503, 'The stored checkpoint failed validation.');
    const manifest = opened.artifact.manifest;
    await this.finish(repo, { manifest, status: 'partial', compressedBytes: opened.artifact.stats.compressedBytes }, checkpoint.uploadId, null);
  }

  private async finish(repo: RepositoryResolution, verified: { manifest: ArtifactManifest; status: 'complete' | 'partial'; compressedBytes: number }, uploadId: string, key: string | null) {
    const state = verified.status === 'complete' ? 'READY' : 'PARTIAL';
    // Live progress counters describe a running stage; the terminal state keeps facts only.
    const { filesToParse: _toParse, framesDone: _done, framesTotal: _total, ...counts } = this.counts;
    const analysisId = await this.timed('publish', () =>
      this.queue.complete(
        this.lease,
        { state, counts, warnings: [...this.warnings].map(([code, count]) => ({ code, count })).slice(0, 64), metrics: { ...this.metrics, outcome: state, artifactBytes: verified.compressedBytes } },
        (client) =>
          publishInTransaction(client, {
            jobId: this.lease.jobId,
            uploadId,
            manifest: verified.manifest,
            githubId: repo.numericId,
            commitOid: repo.commitOid,
            status: verified.status,
            cacheKey: verified.status === 'complete' ? key : null,
            compressedBytes: verified.compressedBytes,
          }),
      ),
    );
    this.log('job.published', { job: this.lease.jobId, state, analysis: analysisId.slice(0, 20) });
  }
}

class CacheMiss extends Error {}

