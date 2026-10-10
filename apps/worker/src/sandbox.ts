import { randomBytes } from 'node:crypto';
import { runBounded } from '@atlas/ingest';
import { LIMITS } from '@atlas/schema';

export interface SandboxLimits { memoryBytes: number; scratchBytes: number; cpus: number; pids: number }
export const ANALYSIS_SANDBOX_LIMITS: SandboxLimits = Object.freeze({ memoryBytes: LIMITS.workerMemoryBytes, scratchBytes: LIMITS.jobScratchBytes, cpus: 4, pids: 64 });
/** Operator-owned image/executable; never values read from a repository/submission. */
export interface SandboxRuntime { docker: string; image: string; cwd: string; env: Readonly<Record<string, string>> }
function checkedLimits(limits: SandboxLimits) {
  if (!Number.isInteger(limits.memoryBytes) || limits.memoryBytes < 32 * 1024 * 1024 || limits.memoryBytes > LIMITS.workerMemoryBytes ||
      !Number.isInteger(limits.scratchBytes) || limits.scratchBytes < 1024 * 1024 || limits.scratchBytes > LIMITS.jobScratchBytes ||
      !Number.isFinite(limits.cpus) || limits.cpus <= 0 || limits.cpus > 4 || !Number.isInteger(limits.pids) || limits.pids < 8 || limits.pids > 64) throw new Error('Sandbox limits may only be lowered within the profile');
}
/** Pure policy is independently tested and inspected on a real Linux Docker engine. */
export function analysisContainerArgs(name: string, image: string, limits = ANALYSIS_SANDBOX_LIMITS): string[] {
  if (!/^atlas-analysis-[0-9a-f]{32}$/.test(name) || !/^sha256:[0-9a-f]{64}$/.test(image)) throw new Error('Trusted immutable image and generated sandbox name are required');
  checkedLimits(limits);
  const tmp = Math.min(64 * 1024 * 1024, Math.floor(limits.scratchBytes / 8));
  return ['create', '--name', name, '--label', 'atlas.sandbox=analysis', '--pull=never',
    '--network=none', '--read-only', '--user=10001:10001', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--pids-limit', String(limits.pids), '--cpus', String(limits.cpus), '--memory', String(limits.memoryBytes), '--memory-swap', String(limits.memoryBytes),
    '--ulimit', 'nofile=256:256', '--log-driver=none', '--init',
    '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${tmp},uid=10001,gid=10001,mode=0700`,
    '--tmpfs', `/scratch:rw,noexec,nosuid,nodev,size=${limits.scratchBytes - tmp},uid=10001,gid=10001,mode=0700`,
    '--workdir=/scratch', '--env=HOME=/tmp', '--env=TMPDIR=/tmp', '--env=GIT_NO_LAZY_FETCH=1', image];
}
/**
 * Offline isolation spike. Only a trusted Node entrypoint is accepted here; source data
 * mounts and broker/coordinator integration are the next P5.3 deliverables.
 * Killing the Docker CLI is insufficient: always force-remove the named container.
 */
export async function runOfflineProbe(runtime: SandboxRuntime, trustedProgram: string, options: { limits?: SandboxLimits; signal?: AbortSignal; deadlineMs?: number } = {}) {
  const name = `atlas-analysis-${randomBytes(16).toString('hex')}`;
  const deadline = options.deadlineMs ?? LIMITS.workerDeadlineMs;
  if (!Number.isInteger(deadline) || deadline < 1 || deadline > LIMITS.workerDeadlineMs) throw new Error('Invalid sandbox deadline');
  const control = (args: string[], signal?: AbortSignal, timeoutMs = 15_000, okExitCodes = [0]) => runBounded(runtime.docker, args, {
    cwd: runtime.cwd, env: runtime.env, timeoutMs, maxStdoutBytes: 64 * 1024, maxStderrBytes: 4096, ...(signal ? { signal } : {}),
    okExitCodes,
  });
  const createArgs = analysisContainerArgs(name, runtime.image, options.limits);
  if (options.signal?.aborted) throw new Error('Sandbox cancelled before creation');
  try {
    const result = await control([...createArgs, 'node', '-e', trustedProgram], options.signal);
    const id = result.stdout.toString('utf8').trim();
    if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('Unexpected container identity');
    const config = JSON.parse((await control(['inspect', '--format', '{{json .HostConfig}}', name])).stdout.toString('utf8')) as unknown;
    const output = await control(['start', '--attach', name], options.signal, deadline, [0, 1, 126, 127, 134, 137]);
    const state = JSON.parse((await control(['inspect', '--format', '{{json .State}}', name])).stdout.toString('utf8')) as { ExitCode: number; OOMKilled: boolean };
    return { name, exitCode: state.ExitCode, oomKilled: state.OOMKilled, stdout: output.stdout.toString('utf8'), config };
  } finally {
    // An interrupted create may have reached the daemon before the CLI stopped.
    // Cleanup is independent of the request's aborted signal/deadline.
    const cleanup = await runBounded(runtime.docker, ['rm', '--force', name], { cwd: runtime.cwd, env: runtime.env,
      timeoutMs: 15_000, maxStdoutBytes: 4096, maxStderrBytes: 4096, okExitCodes: [0, 1] }).catch(() => null);
    if (!cleanup || (cleanup.exitCode !== 0 && !cleanup.stderr.includes(`No such container: ${name}`)))
      throw new Error('Sandbox cleanup failed; operator reconciliation is required');
  }
}
