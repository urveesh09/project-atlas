import { mkdtemp, mkdir, writeFile, rm, access, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runBounded, type BoundedRunOptions, type BoundedRunResult } from '@atlas/ingest';
import { SCAN_LIMITS, type ScanTrustPolicy } from '@atlas/schema';
import { QualityImportError } from '@atlas/graph';

export const GH_SCAN_VERSION = '2.102.0';
export type VerifierRunner = (
  executable: string,
  args: readonly string[],
  options: BoundedRunOptions,
) => Promise<BoundedRunResult>;
export const scanSha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Data never chooses an executable. Defaults are installed host locations, not CWD/PATH. */
export async function installedScanVerifier(explicit?: string): Promise<string> {
  const candidates = explicit
    ? [explicit]
    : process.platform === 'win32'
      ? ['C:/Program Files/GitHub CLI/gh.exe']
      : ['/usr/bin/gh', '/usr/local/bin/gh', '/opt/homebrew/bin/gh'];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate))
      throw new QualityImportError('Choose an absolute path to the trusted GitHub CLI executable.');
    try {
      await access(candidate);
      return await realpath(candidate);
    } catch {
      /* Try the next installed location. */
    }
  }
  throw new QualityImportError('Install GitHub CLI 2.102.0 or provide its trusted absolute executable path.');
}

/** All verification inputs are private snapshots: parsing and crypto see the SAME bytes. */
export async function verifyScanProvenance(
  input: {
    evidence: string | Uint8Array;
    bundle: string;
    trustedRoot: string;
    policy: ScanTrustPolicy;
    executable: string;
    signal: AbortSignal;
    env: Readonly<Record<string, string | undefined>>;
  },
  runner: VerifierRunner = runBounded,
): Promise<void> {
  if (scanSha256(input.trustedRoot) !== input.policy.trustedRootSha256)
    throw new QualityImportError('Trust-root bytes do not match the independently selected policy.');
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'atlas-scan-verify-'));
  try {
    const config = path.join(scratch, 'config');
    await mkdir(config, { mode: 0o700 });
    const files = {
      evidence: path.join(scratch, 'scan.json'),
      bundle: path.join(scratch, 'bundle.json'),
      root: path.join(scratch, 'root.json'),
    };
    await writeFile(files.evidence, input.evidence, { flag: 'wx', mode: 0o600 });
    await writeFile(files.bundle, input.bundle, { flag: 'wx', mode: 0o600 });
    await writeFile(files.root, input.trustedRoot, { flag: 'wx', mode: 0o600 });
    const env: Record<string, string> = {
      GH_CONFIG_DIR: config,
      GH_HOST: 'github.com',
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
      NO_COLOR: '1',
      HOME: scratch,
      XDG_CONFIG_HOME: config,
      TMPDIR: scratch,
      TEMP: scratch,
      TMP: scratch,
    };
    // Windows needs its OS directory to start native programs; no credentials, proxies,
    // aliases, user config or repository-controlled PATH enter the verifier.
    if (input.env.SystemRoot) env.SystemRoot = input.env.SystemRoot;
    const options: BoundedRunOptions = {
      cwd: scratch,
      env,
      signal: input.signal,
      timeoutMs: SCAN_LIMITS.timeoutMs,
      maxStdoutBytes: SCAN_LIMITS.verifierBytes,
      maxStderrBytes: 4096,
      okExitCodes: [0, 1, 2, 4],
    };
    const invoke = async (args: readonly string[], overrides: Partial<BoundedRunOptions> = {}) => {
      try {
        return await runner(input.executable, args, { ...options, ...overrides });
      } catch {
        throw new QualityImportError(
          input.signal.aborted
            ? 'Scan verification cancelled.'
            : 'Trusted verifier failed or exceeded its resource/deadline limits.',
        );
      }
    };
    const version = await invoke(['--version'], { maxStdoutBytes: 2048 });
    if (version.exitCode !== 0 || !version.stdout.toString('utf8').startsWith(`gh version ${GH_SCAN_VERSION} `))
      throw new QualityImportError('Scan verification requires the reviewed GitHub CLI version 2.102.0.');
    const policy = input.policy;
    const result = await invoke([
      'attestation',
      'verify',
      files.evidence,
      '--bundle',
      files.bundle,
      '--custom-trusted-root',
      files.root,
      '--repo',
      policy.repository,
      '--signer-workflow',
      `${policy.repository}/${policy.workflow}`,
      '--signer-digest',
      policy.workflowCommit,
      '--source-digest',
      policy.sourceCommit,
      '--source-ref',
      policy.sourceRef,
      '--cert-oidc-issuer',
      'https://token.actions.githubusercontent.com',
      '--deny-self-hosted-runners',
      '--predicate-type',
      'https://slsa.dev/provenance/v1',
      '--digest-alg',
      'sha256',
      '--hostname',
      'github.com',
      '--format',
      'json',
    ]);
    if (result.exitCode !== 0)
      throw new QualityImportError('Attestation did not verify against the selected workflow/source policy.');
    let verified: unknown;
    try {
      verified = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result.stdout));
    } catch {
      throw new QualityImportError('Trusted verifier returned an invalid response.');
    }
    if (!Array.isArray(verified) || verified.length < 1 || verified.length > 30)
      throw new QualityImportError('Trusted verifier returned no bounded verified attestations.');
    const digest = scanSha256(input.evidence);
    for (const item of verified) {
      const row: unknown = item;
      // These are verifier results, not a bundle decoded by ATLAS. Still reject an
      // incompatible output shape or a subject not bound to the immutable input.
      if (!row || typeof row !== 'object' || !('verificationResult' in row))
        throw new QualityImportError('Trusted verifier returned an incompatible response.');
      const result = row.verificationResult;
      if (!result || typeof result !== 'object' || !('statement' in result))
        throw new QualityImportError('Trusted verifier returned an incompatible response.');
      const statement = result.statement;
      if (
        !statement ||
        typeof statement !== 'object' ||
        !('subject' in statement) ||
        !Array.isArray(statement.subject) ||
        !('predicateType' in statement) ||
        statement.predicateType !== 'https://slsa.dev/provenance/v1' ||
        !statement.subject.some((subject: unknown) => {
          if (!subject || typeof subject !== 'object' || !('digest' in subject)) return false;
          const value = subject.digest;
          return value !== null && typeof value === 'object' && 'sha256' in value && value.sha256 === digest;
        })
      )
        throw new QualityImportError('Verified attestation does not bind these scan-evidence bytes.');
    }
  } finally {
    // The target comes only from this call's mkdtemp, never from policy or report data.
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
