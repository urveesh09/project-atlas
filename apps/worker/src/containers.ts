import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { killProcessTree, runBounded } from '@atlas/ingest';
import { LIMITS } from '@atlas/schema';

/**
 * Container execution for the three sandbox roles (plan §8.6, ADR-030, ADR-031):
 *
 * - `analysis`: no network at all, read-only object store, kernel-enforced memory, PID,
 *   CPU and scratch caps.
 * - `acquisition`: attached only to a per-job internal network whose single other member
 *   is the egress broker; writes the bare repository into its job directory.
 * - `broker`: the only container with an egress-capable network; holds no repository data.
 *
 * Every container runs non-root on a read-only root filesystem with all capabilities
 * dropped, from an immutable operator-owned image (`--pull=never`), named and labelled by
 * the coordinator. Abort and deadline remove the container itself, not just the CLI.
 */
export interface SandboxLimits {
  memoryBytes: number;
  scratchBytes: number;
  cpus: number;
  pids: number;
}
export const ANALYSIS_SANDBOX_LIMITS: SandboxLimits = Object.freeze({ memoryBytes: LIMITS.workerMemoryBytes, scratchBytes: LIMITS.jobScratchBytes, cpus: 4, pids: 64 });
export const ACQUISITION_SANDBOX_LIMITS: SandboxLimits = Object.freeze({ memoryBytes: 512 * 1024 * 1024, scratchBytes: 64 * 1024 * 1024, cpus: 2, pids: 32 });
export const BROKER_SANDBOX_LIMITS: SandboxLimits = Object.freeze({ memoryBytes: 128 * 1024 * 1024, scratchBytes: 8 * 1024 * 1024, cpus: 1, pids: 16 });

/** Operator-owned Docker CLI and image; never values read from a repository or submission. */
export interface SandboxRuntime {
  docker: string;
  image: string;
  cwd: string;
  env: Readonly<Record<string, string>>;
}

export type SandboxRole = 'analysis' | 'acquisition' | 'broker';
export type SandboxNetwork = { kind: 'none' } | { kind: 'internal'; name: string } | { kind: 'egress' };
export interface SandboxMount {
  source: string;
  target: '/input' | '/acquired' | '/fixture';
  readOnly: boolean;
}
export interface ContainerSpec {
  role: SandboxRole;
  limits: SandboxLimits;
  network: SandboxNetwork;
  mounts: readonly SandboxMount[];
  /** Arguments after the image: a trusted entrypoint and its JSON spec. */
  command: readonly string[];
  jobId?: string;
}

const CEILINGS: Record<SandboxRole, SandboxLimits> = { analysis: ANALYSIS_SANDBOX_LIMITS, acquisition: ACQUISITION_SANDBOX_LIMITS, broker: BROKER_SANDBOX_LIMITS };
export const NETWORK_NAME = /^atlas-acq-[0-9a-f]{32}$/;
const NAME = /^atlas-(?:analysis|acquisition|broker)-[0-9a-f]{32}$/;

export function sandboxName(role: SandboxRole): string {
  return `atlas-${role}-${randomBytes(16).toString('hex')}`;
}

function checkedLimits(role: SandboxRole, limits: SandboxLimits): void {
  const ceiling = CEILINGS[role];
  if (
    !Number.isInteger(limits.memoryBytes) || limits.memoryBytes < 32 * 1024 * 1024 || limits.memoryBytes > ceiling.memoryBytes ||
    !Number.isInteger(limits.scratchBytes) || limits.scratchBytes < 1024 * 1024 || limits.scratchBytes > ceiling.scratchBytes ||
    !Number.isFinite(limits.cpus) || limits.cpus <= 0 || limits.cpus > ceiling.cpus ||
    !Number.isInteger(limits.pids) || limits.pids < 8 || limits.pids > ceiling.pids
  ) {
    throw new Error('Sandbox limits may only be lowered within the profile');
  }
}

function checkedMount(mount: SandboxMount, role: SandboxRole): string {
  // Docker's --mount syntax is comma separated; refuse anything that could add options.
  if (!path.isAbsolute(mount.source) || /[,\n\r\0"=]/.test(mount.source)) throw new Error('Invalid sandbox mount source');
  const allowed = role === 'analysis' ? mount.target === '/input' && mount.readOnly : role === 'acquisition' ? (mount.target === '/acquired' && !mount.readOnly) || (mount.target === '/fixture' && mount.readOnly) : false;
  if (!allowed) throw new Error('Mount is not permitted for this sandbox role');
  return `type=bind,source=${mount.source},target=${mount.target}${mount.readOnly ? ',readonly' : ''}`;
}

/** Pure policy, independently tested and inspected on a real Linux Docker engine. */
export function containerArgs(name: string, image: string, spec: ContainerSpec): string[] {
  if (!NAME.test(name) || !name.startsWith(`atlas-${spec.role}-`) || !/^sha256:[0-9a-f]{64}$/.test(image)) throw new Error('Trusted immutable image and generated sandbox name are required');
  checkedLimits(spec.role, spec.limits);
  if (spec.role === 'analysis' && spec.network.kind !== 'none') throw new Error('Analysis sandboxes never have a network');
  if (spec.role === 'acquisition' && spec.network.kind !== 'internal') throw new Error('Acquisition reaches only the broker network');
  if (spec.role === 'broker' && spec.network.kind !== 'egress') throw new Error('Only the broker has egress');
  if (spec.network.kind === 'internal' && !NETWORK_NAME.test(spec.network.name)) throw new Error('Invalid sandbox network');
  if (spec.jobId !== undefined && !/^job_[0-9a-f]{32}$/.test(spec.jobId)) throw new Error('Invalid job label');
  const limits = spec.limits;
  const tmp = Math.min(64 * 1024 * 1024, Math.floor(limits.scratchBytes / 8));
  const network = spec.network.kind === 'none' ? 'none' : spec.network.kind === 'internal' ? spec.network.name : 'bridge';
  return [
    'create', '--name', name, '--label', `atlas.sandbox=${spec.role}`, ...(spec.jobId ? ['--label', `atlas.job=${spec.jobId}`] : []), '--pull=never',
    `--network=${network}`, '--read-only', '--user=10001:10001', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--pids-limit', String(limits.pids), '--cpus', String(limits.cpus), '--memory', String(limits.memoryBytes), '--memory-swap', String(limits.memoryBytes),
    '--ulimit', 'nofile=256:256', '--log-driver=none', '--init',
    '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${tmp},uid=10001,gid=10001,mode=0700`,
    '--tmpfs', `/scratch:rw,noexec,nosuid,nodev,size=${limits.scratchBytes - tmp},uid=10001,gid=10001,mode=0700`,
    ...spec.mounts.flatMap((m) => ['--mount', checkedMount(m, spec.role)]),
    '--workdir=/scratch', '--env=HOME=/tmp', '--env=TMPDIR=/tmp', '--env=GIT_NO_LAZY_FETCH=1', '--env=NODE_ENV=production',
    image, ...spec.command,
  ];
}

/** Back-compatible policy for the offline probe image used by the isolation spike. */
export function analysisContainerArgs(name: string, image: string, limits = ANALYSIS_SANDBOX_LIMITS, jobId?: string): string[] {
  return containerArgs(name, image, { role: 'analysis', limits, network: { kind: 'none' }, mounts: [], command: [], ...(jobId ? { jobId } : {}) });
}

export class SandboxError extends Error {
  constructor(
    readonly code: 'TIMEOUT' | 'CANCELLED' | 'OUTPUT_LIMIT' | 'START_FAILED' | 'CLEANUP_FAILED' | 'PROTOCOL',
    message: string,
  ) {
    super(message);
    this.name = 'SandboxError';
  }
}

export interface RunOptions {
  signal?: AbortSignal;
  deadlineMs: number;
  onStdout: (chunk: Buffer) => void;
  /** After creation, before start (e.g. connect the broker to the acquisition network). */
  beforeStart?: (name: string) => Promise<void>;
}

export interface RunResult {
  name: string;
  exitCode: number;
  /** Raw Docker metadata; never the sole witness of a resource diagnosis (ADR-030). */
  oomKilled: boolean;
}

export function dockerControl(runtime: SandboxRuntime, args: string[], options: { signal?: AbortSignal; timeoutMs?: number; okExitCodes?: number[] } = {}) {
  return runBounded(runtime.docker, args, {
    cwd: runtime.cwd,
    env: runtime.env,
    timeoutMs: options.timeoutMs ?? 15_000,
    maxStdoutBytes: 64 * 1024,
    maxStderrBytes: 4096,
    ...(options.signal ? { signal: options.signal } : {}),
    okExitCodes: options.okExitCodes ?? [0],
  });
}

/** Force-remove; tolerate only a confirmed absent container. Independent of the job's signal. */
export async function removeContainer(runtime: SandboxRuntime, name: string): Promise<void> {
  const cleanup = await runBounded(runtime.docker, ['rm', '--force', '--volumes', name], {
    cwd: runtime.cwd, env: runtime.env, timeoutMs: 15_000, maxStdoutBytes: 4096, maxStderrBytes: 4096, okExitCodes: [0, 1],
  }).catch(() => null);
  if (!cleanup || (cleanup.exitCode !== 0 && !cleanup.stderr.includes(`No such container: ${name}`))) {
    throw new SandboxError('CLEANUP_FAILED', 'Sandbox cleanup failed; operator reconciliation is required');
  }
}

/**
 * Create, start and stream one sandbox, then always remove it. Output is passed to
 * `onStdout` as it arrives (the caller enforces protocol caps and may throw to stop).
 */
export async function runContainer(runtime: SandboxRuntime, spec: ContainerSpec, options: RunOptions): Promise<RunResult> {
  if (!Number.isInteger(options.deadlineMs) || options.deadlineMs < 1 || options.deadlineMs > LIMITS.workerDeadlineMs) throw new Error('Invalid sandbox deadline');
  const name = sandboxName(spec.role);
  const args = containerArgs(name, runtime.image, spec);
  if (options.signal?.aborted) throw new SandboxError('CANCELLED', 'Sandbox cancelled before creation');
  try {
    await dockerControl(runtime, args, options.signal ? { signal: options.signal } : {}).catch((error: unknown) => {
      throw options.signal?.aborted ? new SandboxError('CANCELLED', 'Sandbox cancelled') : new SandboxError('START_FAILED', `Sandbox could not be created (${(error as Error).message})`);
    });
    if (options.beforeStart) await options.beforeStart(name);
    const exitCode = await streamAttached(runtime, name, options);
    const state = JSON.parse((await dockerControl(runtime, ['inspect', '--format', '{{json .State}}', name])).stdout.toString('utf8')) as { ExitCode: number; OOMKilled: boolean };
    return { name, exitCode: state.ExitCode ?? exitCode, oomKilled: state.OOMKilled === true };
  } finally {
    await removeContainer(runtime, name);
  }
}

function streamAttached(runtime: SandboxRuntime, name: string, options: RunOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(runtime.docker, ['start', '--attach', name], {
      cwd: runtime.cwd, env: { ...runtime.env }, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    let failure: SandboxError | null = null;
    const stop = (error: SandboxError) => {
      if (failure) return;
      failure = error;
      // Killing the CLI does not stop the container; the caller's finally removes it.
      void removeContainer(runtime, name).catch(() => undefined);
      if (child.pid !== undefined) killProcessTree(child.pid);
    };
    const timer = setTimeout(() => stop(new SandboxError('TIMEOUT', 'Sandbox exceeded its deadline')), options.deadlineMs);
    const onAbort = () => stop(new SandboxError('CANCELLED', 'Sandbox cancelled'));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure) return;
      try {
        options.onStdout(chunk);
      } catch (error) {
        stop(error instanceof SandboxError ? error : new SandboxError('PROTOCOL', (error as Error).message));
      }
    });
    // Sandbox stderr is untrusted and may echo repository data: drained, never logged.
    child.stderr.resume();
    child.on('error', () => stop(new SandboxError('START_FAILED', 'The Docker CLI could not be started')));
    child.on('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (failure) reject(failure);
      else resolve(code ?? 1);
    });
  });
}

/** A per-job internal network: members reach each other and nothing else. */
export async function createInternalNetwork(runtime: SandboxRuntime, jobId: string): Promise<string> {
  const name = `atlas-acq-${randomBytes(16).toString('hex')}`;
  await dockerControl(runtime, ['network', 'create', '--internal', '--driver', 'bridge', '--label', 'atlas.sandbox=network', '--label', `atlas.job=${jobId}`, name]);
  return name;
}

export async function removeNetwork(runtime: SandboxRuntime, name: string): Promise<void> {
  if (!NETWORK_NAME.test(name)) throw new Error('Invalid sandbox network');
  const result = await dockerControl(runtime, ['network', 'rm', name], { okExitCodes: [0, 1] }).catch(() => null);
  if (!result || (result.exitCode !== 0 && !/not found|No such network/i.test(result.stderr))) throw new SandboxError('CLEANUP_FAILED', 'Sandbox network cleanup failed; operator reconciliation is required');
}

/**
 * Startup reconciliation (runbook "worker crash"): remove every ATLAS sandbox container
 * and network left by a crashed coordinator on this engine. One coordinator service owns
 * an engine; containers are never reused across processes.
 */
export async function reconcileSandboxes(runtime: SandboxRuntime): Promise<{ containers: number; networks: number }> {
  const containers = (await dockerControl(runtime, ['ps', '--all', '--filter', 'label=atlas.sandbox', '--format', '{{.Names}}'])).stdout.toString('utf8').split('\n').filter((n) => NAME.test(n));
  for (const name of containers) await removeContainer(runtime, name);
  const networks = (await dockerControl(runtime, ['network', 'ls', '--filter', 'label=atlas.sandbox=network', '--format', '{{.Name}}'])).stdout.toString('utf8').split('\n').filter((n) => NETWORK_NAME.test(n));
  for (const name of networks) await removeNetwork(runtime, name);
  return { containers: containers.length, networks: networks.length };
}
