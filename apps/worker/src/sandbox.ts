import { randomBytes } from 'node:crypto';
import { runBounded } from '@atlas/ingest';
import { LIMITS } from '@atlas/schema';
import { analysisContainerArgs, type SandboxLimits, type SandboxRuntime } from './containers.js';

export { ANALYSIS_SANDBOX_LIMITS, analysisContainerArgs, type SandboxLimits, type SandboxRuntime } from './containers.js';

/**
 * Offline isolation spike. Only a trusted Node entrypoint is accepted here; source data
 * mounts and broker/coordinator integration are the next P5.3 deliverables.
 * Killing the Docker CLI is insufficient: always force-remove the named container.
 */
export async function runOfflineProbe(runtime: SandboxRuntime, trustedProgram: string, options: { limits?: SandboxLimits; signal?: AbortSignal; deadlineMs?: number; jobId?: string } = {}) {
  const name = `atlas-analysis-${randomBytes(16).toString('hex')}`;
  const deadline = options.deadlineMs ?? LIMITS.workerDeadlineMs;
  if (!Number.isInteger(deadline) || deadline < 1 || deadline > LIMITS.workerDeadlineMs) throw new Error('Invalid sandbox deadline');
  const control = (args: string[], signal?: AbortSignal, timeoutMs = 15_000, okExitCodes = [0]) => runBounded(runtime.docker, args, {
    cwd: runtime.cwd, env: runtime.env, timeoutMs, maxStdoutBytes: 64 * 1024, maxStderrBytes: 4096, ...(signal ? { signal } : {}),
    okExitCodes,
  });
  const createArgs = analysisContainerArgs(name, runtime.image, options.limits, options.jobId);
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
