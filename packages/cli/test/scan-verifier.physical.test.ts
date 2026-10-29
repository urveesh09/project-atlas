import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { verifyScanProvenance, scanSha256 } from '../src/scan-verifier.js';
import type { ScanTrustPolicy } from '@atlas/schema';

const executable = process.env['ATLAS_TEST_SCAN_GH'];
if (process.env['ATLAS_REQUIRE_SCAN_VERIFIER_TESTS'] === '1' && !executable)
  throw new Error('Required real attestation tests need the pinned GitHub CLI path.');
const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/scan-proof/${name}`, import.meta.url)), 'utf8');
const artifact = () => Buffer.from(fixture('artifact.b64').trim(), 'base64');
const policy = (): ScanTrustPolicy => ({
  format: 'atlas.scan-trust/1',
  repository: 'actions/attest-demo',
  workflow: '.github/workflows/build-python.yml',
  workflowCommit: 'a6c23b9806c593664f68637c8f9d45dfcf98b2db',
  sourceCommit: 'a6c23b9806c593664f68637c8f9d45dfcf98b2db',
  sourceRef: 'refs/heads/main',
  trustedRootSha256: scanSha256(fixture('trusted-root.jsonl')),
});
const input = () => ({
  evidence: artifact(),
  bundle: fixture('bundle.jsonl'),
  trustedRoot: fixture('trusted-root.jsonl'),
  policy: policy(),
  executable: executable!,
  signal: new AbortController().signal,
  env: process.env,
});

describe.runIf(Boolean(executable))('official GitHub CLI: real signature verification, no mocks', () => {
  it('verifies the authentic public fixture with immutable workflow/source policy', async () => {
    expect(scanSha256(artifact())).toBe('ae57936def59bc4c75edd3a837d89bcefc6d3a5e31d55a6fa7a71624f92c3c3b');
    await expect(verifyScanProvenance(input())).resolves.toBeUndefined();
  });
  it('rejects changed artifact bytes and valid signatures from the wrong policy', async () => {
    await expect(
      verifyScanProvenance({ ...input(), evidence: Buffer.concat([artifact(), Buffer.from('tampered')]) }),
    ).rejects.toThrow('did not verify');
    await expect(
      verifyScanProvenance({ ...input(), policy: { ...policy(), workflowCommit: 'a'.repeat(40) } }),
    ).rejects.toThrow('did not verify');
    await expect(
      verifyScanProvenance({ ...input(), policy: { ...policy(), sourceRef: 'refs/heads/untrusted' } }),
    ).rejects.toThrow('did not verify');
  });
});
