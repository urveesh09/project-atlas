import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IngestError, killProcessTree } from '@atlas/ingest';
import { LIMITS } from '@atlas/schema';
import type { z } from 'zod';
import {
  ACQUISITION_SANDBOX_LIMITS,
  ANALYSIS_SANDBOX_LIMITS,
  BROKER_SANDBOX_LIMITS,
  SandboxError,
  createInternalNetwork,
  dockerControl,
  removeNetwork,
  runContainer,
  type SandboxMount,
  type SandboxRuntime,
} from './containers.js';
import { FRAME, FrameDecoder, ProtocolError, type Frame } from './protocol.js';
import {
  ACQUIRED_OBJECTS,
  AcquireResultSchema,
  BrokerResultSchema,
  ProgressSchema,
  AnalyzeResultSchema,
  type AcquireSpec,
  type AnalyzeSpec,
  type SandboxProgress,
} from './sandbox/spec.js';

export interface AcquireRequest {
  jobId: string;
  /** Host directory owned by this attempt; the bare repository lives inside it. */
  acquiredDir: string;
  owner: string;
  name: string;
  numericId: string;
  commitOid: string;
  depth: number;
  maxNetworkBytes: number;
  deadlineMs: number;
  signal: AbortSignal;
}
export interface AcquireOutcome {
  bytesOnDisk: number;
  /** Bytes counted by the egress broker; null for a local fixture source. */
  networkBytes: number | null;
}

export interface AnalyzeRequest {
  jobId: string;
  acquiredDir: string;
  /** Host directory receiving the sandbox's (untrusted) artifact files. */
  outDir: string;
  spec: Omit<AnalyzeSpec, 'v' | 'objects' | 'scratch'>;
  deadlineMs: number;
  signal: AbortSignal;
  onProgress: (progress: SandboxProgress) => void;
}
export type AnalyzeOutcome = { ok: true; status: 'complete' | 'partial' } | { ok: false; code: string; limit: string | null };

/** The isolated stages a coordinator drives. */
export interface StageRunners {
  readonly isolation: 'container' | 'process';
  acquire(request: AcquireRequest): Promise<AcquireOutcome>;
  analyze(request: AnalyzeRequest): Promise<AnalyzeOutcome>;
}

/** Where acquisition fetches from: GitHub through the broker, or a trusted local fixture. */
export type AcquisitionSource = { kind: 'github' } | { kind: 'fixture'; remoteFor(numericId: string): string };

/**
 * Collects analysis frames: files land in `outDir` under validated artifact names, progress
 * is forwarded, and exactly one result must arrive. A sandbox can say anything; the
 * coordinator verifies the written artifact independently afterwards.
 */
class AnalysisCollector {
  readonly decoder = new FrameDecoder();
  result: AnalyzeOutcome | null = null;
  private writes: Promise<void> = Promise.resolve();
  constructor(
    private readonly outDir: string,
    private readonly onProgress: (progress: SandboxProgress) => void,
  ) {}
  push(chunk: Buffer): void {
    for (const frame of this.decoder.push(chunk)) this.handle(frame);
  }
  private handle(frame: Frame): void {
    if (this.result) throw new ProtocolError('Output after the sandbox result');
    if (frame.type === FRAME.PROGRESS) {
      const parsed = ProgressSchema.safeParse(frame.value);
      if (parsed.success) this.onProgress(parsed.data);
    } else if (frame.type === FRAME.FILE) {
      const target = path.join(this.outDir, ...frame.name.split('/'));
      this.writes = this.writes.then(async () => {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, frame.bytes, { flag: 'wx' });
      });
    } else {
      const parsed = AnalyzeResultSchema.safeParse(frame.value);
      if (!parsed.success) throw new ProtocolError('Malformed sandbox result');
      this.result = parsed.data;
    }
  }
  async finish(): Promise<AnalyzeOutcome> {
    this.decoder.end();
    await this.writes;
    if (!this.result) throw new ProtocolError('The sandbox ended without a result');
    return this.result;
  }
}

function singleResult<S extends z.ZodType>(schema: S) {
  type T = z.infer<S>;
  const decoder = new FrameDecoder();
  let result: T | null = null;
  return {
    push(chunk: Buffer) {
      for (const frame of decoder.push(chunk)) {
        if (frame.type !== FRAME.RESULT || result !== null) throw new ProtocolError('Unexpected sandbox output');
        const parsed = schema.safeParse(frame.value);
        if (!parsed.success) throw new ProtocolError('Malformed sandbox result');
        result = parsed.data;
      }
    },
    finish(): T {
      decoder.end();
      if (result === null) throw new ProtocolError('The sandbox ended without a result');
      return result;
    },
  };
}

function acquisitionFailure(code: string): Error {
  if (code === 'REPOSITORY_TOO_LARGE') return new IngestError('REPOSITORY_TOO_LARGE', 'Repository acquisition exceeded the transfer limit');
  if (code === 'COMMIT_NOT_ACCESSIBLE' || code === 'GIT_FAILED') return new IngestError('COMMIT_NOT_ACCESSIBLE', 'The commit could not be fetched from the repository');
  if (code === 'TIMEOUT') return new IngestError('TIMEOUT', 'Acquisition exceeded its deadline');
  return new IngestError('UPSTREAM_UNAVAILABLE', 'Acquisition failed');
}

/**
 * Production runners: every stage in its own container (plan §8.6). Acquisition reaches
 * GitHub only through a per-job broker container on a private internal network; analysis
 * has no network at all and reads the acquired objects read-only.
 */
export class DockerStageRunners implements StageRunners {
  readonly isolation = 'container' as const;
  constructor(
    readonly runtime: SandboxRuntime,
    private readonly source: AcquisitionSource,
    private readonly entry = '/atlas/dist/sandbox',
  ) {}

  /**
   * Run `work` inside a fresh per-job internal network. With `broker`, an egress broker
   * container joins that network as `atlas-broker` and is the network's only route out;
   * its byte counters are returned after it is stopped. The network and broker are always
   * removed, whatever `work` does.
   */
  async withEgress<T>(
    input: { jobId: string; maxBytes: number; signal: AbortSignal; deadlineMs: number; broker: boolean },
    work: (network: string) => Promise<T>,
  ): Promise<{ result: T; networkBytes: number | null; exceeded: boolean }> {
    const network = await createInternalNetwork(this.runtime, input.jobId);
    let brokerName: string | null = null;
    let brokerRun: Promise<{ bytes: number; exceeded: boolean } | null> = Promise.resolve(null);
    try {
      if (input.broker) {
        const broker = singleResult(BrokerResultSchema);
        let started: () => void = () => {};
        const ready = new Promise<void>((resolve) => (started = resolve));
        brokerRun = runContainer(
          this.runtime,
          {
            role: 'broker',
            limits: BROKER_SANDBOX_LIMITS,
            network: { kind: 'egress' },
            mounts: [],
            command: ['node', `${this.entry}/broker-main.js`, JSON.stringify({ v: 1, port: 3128, maxBytes: input.maxBytes })],
            jobId: input.jobId,
          },
          {
            signal: input.signal,
            deadlineMs: Math.min(LIMITS.workerDeadlineMs, input.deadlineMs + 15_000),
            onStdout: (chunk) => broker.push(chunk),
            beforeStart: async (name) => {
              brokerName = name;
              await dockerControl(this.runtime, ['network', 'connect', '--alias', 'atlas-broker', network, name]);
              started();
            },
          },
        ).then(() => broker.finish());
        brokerRun.catch(() => started());
        await ready;
      }
      const result = await work(network);
      let stats: { bytes: number; exceeded: boolean } | null = null;
      if (brokerName) {
        await dockerControl(this.runtime, ['kill', '--signal', 'SIGTERM', brokerName], { okExitCodes: [0, 1] }).catch(() => undefined);
        stats = await brokerRun;
      }
      return { result, networkBytes: stats?.bytes ?? null, exceeded: stats?.exceeded === true };
    } catch (error) {
      // A tripped budget closes the broker and with it Git's tunnel: report the cause.
      if (brokerName) {
        await dockerControl(this.runtime, ['kill', '--signal', 'SIGTERM', brokerName], { okExitCodes: [0, 1] }).catch(() => undefined);
        const stats = await brokerRun.catch(() => null);
        if (stats?.exceeded) throw new IngestError('REPOSITORY_TOO_LARGE', 'Repository acquisition exceeded the transfer limit');
      }
      throw error;
    } finally {
      if (brokerName) await dockerControl(this.runtime, ['kill', brokerName], { okExitCodes: [0, 1] }).catch(() => undefined);
      await brokerRun.catch(() => undefined);
      await removeNetwork(this.runtime, network);
    }
  }

  async acquire(request: AcquireRequest): Promise<AcquireOutcome> {
    const spec: AcquireSpec = {
      v: 1,
      target: '/acquired',
      owner: request.owner,
      name: request.name,
      commitOid: request.commitOid,
      depth: request.depth,
      maxBytes: request.maxNetworkBytes,
      timeoutMs: Math.max(1000, request.deadlineMs - 2000),
      source: this.source.kind === 'github' ? { kind: 'github', proxy: 'http://atlas-broker:3128' } : { kind: 'fixture', remote: '/fixture' },
    };
    const mounts: SandboxMount[] = [{ source: request.acquiredDir, target: '/acquired', readOnly: false }];
    if (this.source.kind === 'fixture') mounts.push({ source: this.source.remoteFor(request.numericId), target: '/fixture', readOnly: true });
    try {
      const { result: outcome, networkBytes, exceeded } = await this.withEgress(
        { jobId: request.jobId, maxBytes: request.maxNetworkBytes, signal: request.signal, deadlineMs: request.deadlineMs, broker: this.source.kind === 'github' },
        async (network) => {
          const acquisition = singleResult(AcquireResultSchema);
          const run = await runContainer(
            this.runtime,
            { role: 'acquisition', limits: ACQUISITION_SANDBOX_LIMITS, network: { kind: 'internal', name: network }, mounts, command: ['node', `${this.entry}/acquire-main.js`, JSON.stringify(spec)], jobId: request.jobId },
            { signal: request.signal, deadlineMs: request.deadlineMs, onStdout: (chunk) => acquisition.push(chunk) },
          );
          return run.exitCode === 0 || run.exitCode === 2 ? acquisition.finish() : null;
        },
      );
      if (exceeded) throw new IngestError('REPOSITORY_TOO_LARGE', 'Repository acquisition exceeded the transfer limit');
      if (!outcome) throw new IngestError('UPSTREAM_UNAVAILABLE', 'Acquisition ended unexpectedly');
      if (!outcome.ok) throw acquisitionFailure(outcome.code);
      return { bytesOnDisk: outcome.bytesOnDisk, networkBytes };
    } catch (error) {
      if (error instanceof SandboxError && error.code === 'TIMEOUT') throw new IngestError('TIMEOUT', 'Acquisition exceeded its deadline');
      throw error;
    }
  }

  async analyze(request: AnalyzeRequest): Promise<AnalyzeOutcome> {
    const collector = new AnalysisCollector(request.outDir, request.onProgress);
    const spec: AnalyzeSpec = { v: 1, objects: '/input', scratch: '/scratch', ...request.spec };
    const run = await runContainer(
      this.runtime,
      {
        role: 'analysis',
        limits: ANALYSIS_SANDBOX_LIMITS,
        network: { kind: 'none' },
        mounts: [{ source: path.join(request.acquiredDir, ...ACQUIRED_OBJECTS.split('/')), target: '/input', readOnly: true }],
        command: ['node', `--max-old-space-size=${Math.floor((ANALYSIS_SANDBOX_LIMITS.memoryBytes * 0.75) / 1024 / 1024)}`, `${this.entry}/analyze-main.js`, JSON.stringify(spec)],
        jobId: request.jobId,
      },
      { signal: request.signal, deadlineMs: request.deadlineMs, onStdout: (chunk) => collector.push(chunk) },
    );
    if (run.exitCode !== 0 && run.exitCode !== 2) return { ok: false, code: run.exitCode === 137 ? 'SANDBOX_KILLED' : 'SANDBOX_FAILED', limit: null };
    return collector.finish();
  }
}

/**
 * Development and test runners: the same entrypoints and protocol as child processes,
 * WITHOUT container isolation. The service refuses them for a public origin; they exist so
 * the hosted flow runs on machines without a Linux container engine.
 */
export class ProcessStageRunners implements StageRunners {
  readonly isolation = 'process' as const;
  constructor(
    private readonly source: Extract<AcquisitionSource, { kind: 'fixture' }>,
    private readonly entry = fileURLToPath(new URL('./sandbox/', import.meta.url)).replace(/[\\/]src[\\/]sandbox[\\/]$/, `${path.sep}dist${path.sep}sandbox${path.sep}`),
  ) {}

  private run(script: string, spec: unknown, request: { signal: AbortSignal; deadlineMs: number }, onStdout: (chunk: Buffer) => void): Promise<number> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(this.entry, script), JSON.stringify(spec)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: { PATH: process.env['PATH'] ?? '', SystemRoot: process.env['SystemRoot'] ?? '', NODE_ENV: 'production' },
      });
      let failure: Error | null = null;
      const stop = (error: Error) => {
        if (failure) return;
        failure = error;
        if (child.pid !== undefined) killProcessTree(child.pid);
      };
      const timer = setTimeout(() => stop(new SandboxError('TIMEOUT', 'Stage exceeded its deadline')), request.deadlineMs);
      const onAbort = () => stop(new SandboxError('CANCELLED', 'Stage cancelled'));
      request.signal.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => {
        if (failure) return;
        try {
          onStdout(chunk);
        } catch (error) {
          stop(error as Error);
        }
      });
      child.stderr.resume();
      child.on('close', (code) => {
        clearTimeout(timer);
        request.signal.removeEventListener('abort', onAbort);
        if (failure) reject(failure);
        else resolve(code ?? 1);
      });
    });
  }

  async acquire(request: AcquireRequest): Promise<AcquireOutcome> {
    const result = singleResult(AcquireResultSchema);
    const spec: AcquireSpec = {
      v: 1,
      target: request.acquiredDir,
      owner: request.owner,
      name: request.name,
      commitOid: request.commitOid,
      depth: request.depth,
      maxBytes: request.maxNetworkBytes,
      timeoutMs: Math.max(1000, request.deadlineMs - 2000),
      source: { kind: 'fixture', remote: this.source.remoteFor(request.numericId) },
    };
    const code = await this.run('acquire-main.js', spec, request, (chunk) => result.push(chunk)).catch((error: unknown) => {
      throw error instanceof SandboxError && error.code === 'TIMEOUT' ? new IngestError('TIMEOUT', 'Acquisition exceeded its deadline') : error;
    });
    if (code !== 0 && code !== 2) throw new IngestError('UPSTREAM_UNAVAILABLE', 'Acquisition ended unexpectedly');
    const outcome = result.finish();
    if (!outcome.ok) throw acquisitionFailure(outcome.code);
    return { bytesOnDisk: outcome.bytesOnDisk, networkBytes: null };
  }

  async analyze(request: AnalyzeRequest): Promise<AnalyzeOutcome> {
    const collector = new AnalysisCollector(request.outDir, request.onProgress);
    const scratch = path.join(request.acquiredDir, '..', 'analysis-scratch');
    await mkdir(scratch, { recursive: true });
    const spec: AnalyzeSpec = { v: 1, objects: path.join(request.acquiredDir, ...ACQUIRED_OBJECTS.split('/')), scratch, ...request.spec };
    const code = await this.run('analyze-main.js', spec, request, (chunk) => collector.push(chunk));
    if (code !== 0 && code !== 2) return { ok: false, code: 'SANDBOX_FAILED', limit: null };
    return collector.finish();
  }
}

export const DEFAULT_NETWORK_BUDGET = LIMITS.acquisitionNetworkBytes;
