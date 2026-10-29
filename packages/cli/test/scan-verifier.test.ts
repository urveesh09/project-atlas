import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyScanProvenance, scanSha256, type VerifierRunner } from '../src/scan-verifier.js';
import { type ScanTrustPolicy, SCAN_LIMITS } from '@atlas/schema';

const evidence = '{"sourceFree":"test fixture"}\n',
  root = '{"trusted":"operator-selected"}\n';
const policy: ScanTrustPolicy = {
  format: 'atlas.scan-trust/1',
  repository: 'owner/repo',
  workflow: '.github/workflows/scan.yml',
  workflowCommit: 'a'.repeat(40),
  sourceCommit: 'b'.repeat(40),
  sourceRef: 'refs/heads/main',
  trustedRootSha256: scanSha256(root),
};
const response = () =>
  Buffer.from(
    JSON.stringify([
      {
        verificationResult: {
          statement: {
            predicateType: 'https://slsa.dev/provenance/v1',
            subject: [{ name: 'scan.json', digest: { sha256: scanSha256(evidence) } }],
          },
        },
      },
    ]),
  );
function input() {
  return {
    evidence,
    bundle: '{"opaque":"signed bundle"}',
    trustedRoot: root,
    policy,
    executable: path.resolve('trusted-gh'),
    signal: new AbortController().signal,
    env: {
      SystemRoot: 'C:/Windows',
      GH_TOKEN: 'SECRET',
      HTTPS_PROXY: 'SECRET',
      PATH: 'untrusted-repository',
      GH_HOST: 'evil.invalid',
    },
  };
}

describe('trusted verifier orchestration (not a cryptographic mock proof)', () => {
  it('pins every identity, isolates inputs/environment and cleans snapshots after success', async () => {
    let directory = '',
      calls = 0;
    const runner: VerifierRunner = async (_executable, args, options) => {
      calls++;
      directory = options.cwd;
      expect(options.env.GH_TOKEN).toBeUndefined();
      expect(options.env.HTTPS_PROXY).toBeUndefined();
      expect(options.env.PATH).toBeUndefined();
      expect(options.env.GH_HOST).toBe('github.com');
      expect(options.env.GH_CONFIG_DIR).toBe(path.join(directory, 'config'));
      expect(options.timeoutMs).toBe(SCAN_LIMITS.timeoutMs);
      if (args[0] === '--version')
        return { exitCode: 0, stdout: Buffer.from('gh version 2.102.0 (2026-09-30)\n'), stderr: '' };
      expect(readFileSync(args[2]!, 'utf8')).toBe(evidence);
      expect(args).toEqual([
        'attestation',
        'verify',
        path.join(directory, 'scan.json'),
        '--bundle',
        path.join(directory, 'bundle.json'),
        '--custom-trusted-root',
        path.join(directory, 'root.json'),
        '--repo',
        'owner/repo',
        '--signer-workflow',
        'owner/repo/.github/workflows/scan.yml',
        '--signer-digest',
        policy.workflowCommit,
        '--source-digest',
        policy.sourceCommit,
        '--source-ref',
        'refs/heads/main',
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
      return { exitCode: 0, stdout: response(), stderr: 'SECRET verifier diagnostics' };
    };
    await verifyScanProvenance(input(), runner);
    expect(calls).toBe(2);
    expect(existsSync(directory)).toBe(false);
  });
  it('rejects a root not pinned by independent policy before launching a process', async () => {
    let called = false;
    await expect(
      verifyScanProvenance({ ...input(), trustedRoot: root + ' ' }, async () => {
        called = true;
        throw new Error();
      }),
    ).rejects.toThrow('Trust-root bytes');
    expect(called).toBe(false);
  });
  it.each([
    { exitCode: 1, stdout: response(), contains: 'did not verify' },
    { exitCode: 0, stdout: Buffer.from('{"SECRET":"broken'), contains: 'invalid response' },
    { exitCode: 0, stdout: Buffer.from('[]'), contains: 'no bounded' },
    { exitCode: 0, stdout: Buffer.from('[{}]'), contains: 'incompatible' },
    {
      exitCode: 0,
      stdout: Buffer.from(response().toString().replace(scanSha256(evidence), 'f'.repeat(64))),
      contains: 'does not bind',
    },
    {
      exitCode: 0,
      stdout: Buffer.from(response().toString().replace('https://slsa.dev/provenance/v1', 'https://evil.invalid')),
      contains: 'does not bind',
    },
  ])('fails closed for a verifier failure/invalid response: $contains', async ({ exitCode, stdout, contains }) => {
    let directory = '';
    await expect(
      verifyScanProvenance(input(), async (_, args, options) => {
        directory = options.cwd;
        return {
          exitCode: args[0] === '--version' ? 0 : exitCode,
          stdout: args[0] === '--version' ? Buffer.from('gh version 2.102.0 (date)') : stdout,
          stderr: 'SECRET',
        };
      }),
    ).rejects.toThrow(contains);
    expect(existsSync(directory)).toBe(false);
  });
  it('rejects an unreviewed CLI version and cleans up after process errors', async () => {
    let directory = '';
    await expect(
      verifyScanProvenance(input(), async (_, _args, options) => {
        directory = options.cwd;
        return { exitCode: 0, stdout: Buffer.from('gh version 2.103.0 (date)'), stderr: '' };
      }),
    ).rejects.toThrow('reviewed');
    expect(existsSync(directory)).toBe(false);
    await expect(
      verifyScanProvenance(input(), async (_, _args, options) => {
        directory = options.cwd;
        throw new Error('SECRET');
      }),
    ).rejects.toThrow();
    expect(existsSync(directory)).toBe(false);
  });
});
