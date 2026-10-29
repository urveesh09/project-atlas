import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { run } from '@atlas/cli';
import { createGitFixture, type GitFixture } from '@atlas/test-fixtures';
import { openArtifactDirectory } from '@atlas/artifact/node';
import * as verifier from '../src/scan-verifier.js';

let work: string, repo: GitFixture, commit: string;
let files: { path: string; blobOid: string }[];
const profile = {
  format: 'atlas.ruff-profile/1',
  isolated: true,
  ignoreNoqa: true,
  respectGitignore: false,
  forceExclude: false,
  targetVersion: 'py314',
  rules: ['F401', 'F821'],
};
async function command(args: string[], signal = new AbortController().signal) {
  let stdout = '',
    stderr = '';
  const code = await run(args, {
    cwd: work,
    env: { NO_COLOR: '1' },
    signal,
    stdout: {
      write: (s) => {
        stdout += s;
      },
    },
    stderr: {
      write: (s) => {
        stderr += s;
      },
    },
  });
  return { code, stdout, stderr };
}
beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'atlas-scan-cli-'));
  repo = createGitFixture(
    [
      {
        date: '2026-10-01T00:00:00Z',
        message: 'authored scan scope',
        files: { 'sample.py': 'import os\nprint(missing)\n', 'other.py': 'pass\n', 'ui.ts': 'export const x = 1;\n' },
      },
    ],
    { parent: work },
  );
  expect((await command(['analyze', repo.dir, '--out', 'artifact', '--no-history'])).code).toBe(0);
  const artifact = await openArtifactDirectory(path.join(work, 'artifact'));
  if (!artifact.ok) throw new Error('fixture artifact');
  commit = artifact.artifact.manifest.selectedCommit.oid;
  const frame = await artifact.artifact.frame(0);
  if (!frame.ok) throw new Error('fixture frame');
  files = frame.graph.nodes.flatMap((n) =>
    n.kind === 'file' && n.path.endsWith('.py') ? [{ path: n.path, blobOid: n.blobOid }] : [],
  );
  writeFileSync(
    path.join(work, 'ruff.sarif'),
    readFileSync(new URL('../../graph/test/fixtures/ruff-0.17.3.sarif.json', import.meta.url)),
  );
  expect(
    (await command(['findings', 'ruff.sarif', '--artifact', 'artifact', '--commit', commit, '--out', 'quality.json']))
      .code,
  ).toBe(0);
  writeFileSync(path.join(work, 'profile.json'), JSON.stringify(profile));
  writeFileSync(path.join(work, 'scope.json'), JSON.stringify({ format: 'atlas.scan-scope/1', files }));
  writeFileSync(
    path.join(work, 'subset.json'),
    JSON.stringify({ format: 'atlas.scan-scope/1', files: files.filter((f) => f.path === 'sample.py') }),
  );
}, 60_000);
afterAll(() => {
  repo?.dispose();
  if (work) rmSync(work, { recursive: true, force: true });
});
const create = (scope: string, out: string) => [
  'scan-evidence',
  'quality.json',
  '--artifact',
  'artifact',
  '--profile',
  'profile.json',
  '--scope',
  scope,
  '--exit-code',
  '1',
  '--out',
  out,
  '--json',
];

describe('scan CLI: source-free declarations and verified adapter composition', () => {
  it('keeps missing files partial and creates complete declarations without claiming proof', async () => {
    const partial = await command(create('subset.json', 'partial.json'));
    expect(partial.code).toBe(2);
    expect(JSON.parse(partial.stdout)).toMatchObject({
      provenance: 'unverified',
      execution: 'producer-asserted',
      missingFiles: 1,
      scopeMatchesAnalysis: false,
    });
    const complete = await command(create('scope.json', 'scan.json'));
    expect(complete.code).toBe(0);
    expect(JSON.parse(complete.stdout)).toMatchObject({
      provenance: 'unverified',
      analyzedPythonFiles: 2,
      declaredScannedFiles: 2,
      scopeMatchesAnalysis: true,
    });
    const text = readFileSync(path.join(work, 'scan.json'), 'utf8');
    expect(text).not.toMatch(/imported but|missing\)|file:\/|Users|"message"/);
    expect((await command(create('scope.json', 'scan.json'))).code).toBe(1);
    expect(readFileSync(path.join(work, 'scan.json'), 'utf8')).toBe(text);
  });
  it('rejects wrong blobs and output through an artifact directory alias', async () => {
    writeFileSync(
      path.join(work, 'bad-scope.json'),
      JSON.stringify({ format: 'atlas.scan-scope/1', files: [{ ...files[0], blobOid: 'a'.repeat(40) }] }),
    );
    expect((await command(create('bad-scope.json', 'bad.json'))).code).toBe(1);
    expect(existsSync(path.join(work, 'bad.json'))).toBe(false);
    symlinkSync(
      path.join(work, 'artifact'),
      path.join(work, 'alias'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect((await command(create('scope.json', 'alias/scan.json'))).code).toBe(64);
    expect(existsSync(path.join(work, 'artifact', 'scan.json'))).toBe(false);
    expect((await command(['scan-evidence'])).code).toBe(64);
  });
  it('validates references/policy before verification and emits no browser trust receipt', async () => {
    // This is orchestration only. Real signature and failure policies have their own
    // native-verifier test, including a network-disabled CI namespace.
    const proof = vi.spyOn(verifier, 'verifyScanProvenance').mockResolvedValue(undefined);
    try {
      const policy = {
        format: 'atlas.scan-trust/1',
        repository: 'owner/repo',
        workflow: '.github/workflows/scan.yml',
        workflowCommit: 'a'.repeat(40),
        sourceCommit: commit,
        sourceRef: 'refs/heads/main',
        trustedRootSha256: verifier.scanSha256('{}'),
      };
      writeFileSync(path.join(work, 'policy.json'), JSON.stringify(policy));
      writeFileSync(path.join(work, 'bundle.json'), '{}');
      writeFileSync(path.join(work, 'root.json'), '{}');
      const args = [
        'verify-scan',
        'scan.json',
        '--artifact',
        'artifact',
        '--bundle',
        'bundle.json',
        '--policy',
        'policy.json',
        '--trusted-root',
        'root.json',
        '--gh',
        process.execPath,
        '--json',
      ];
      const result = await command(args);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        provenance: 'github-actions-verified',
        execution: 'producer-asserted',
        findings: 2,
        cleanVerdict: 'not-established',
      });
      expect(proof).toHaveBeenCalledOnce();
      expect(proof.mock.calls[0]![0].evidence).toBe(readFileSync(path.join(work, 'scan.json'), 'utf8'));
      proof.mockClear();
      writeFileSync(path.join(work, 'policy.json'), JSON.stringify({ ...policy, sourceCommit: 'b'.repeat(40) }));
      expect((await command(args)).code).toBe(1);
      expect(proof).not.toHaveBeenCalled();
      const cancelled = new AbortController();
      cancelled.abort();
      expect((await command(args, cancelled.signal)).code).toBe(130);
      expect((await command(['verify-scan'])).code).toBe(64);
    } finally {
      proof.mockRestore();
    }
  });
});
