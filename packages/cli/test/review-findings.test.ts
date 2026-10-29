import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { createGitFixture, type GitFixture } from '@atlas/test-fixtures';
import { run } from '@atlas/cli';
import { openArtifactDirectory } from '@atlas/artifact/node';
import { canonicalJson, type FindingReview } from '@atlas/schema';
import { createScanEvidence, importRuffSarif, parseFindingReview, qualityTarget } from '@atlas/graph';
import * as verifier from '../src/scan-verifier.js';

let work: string, repo: GitFixture;
const source =
  Array.from({ length: 17 }, (_, i) => `# header ${i}\n`).join('') +
  'def inspect():\n    before = 1\n    print(missing)\n    after = 2\n    return before + after\n' +
  Array.from({ length: 17 }, (_, i) => `# tail ${i}\n`).join('');
const profile = {
  format: 'atlas.ruff-profile/1',
  isolated: true,
  ignoreNoqa: true,
  respectGitignore: false,
  forceExclude: false,
  targetVersion: 'py314',
  rules: ['F821'],
};
async function command(args: string[], signal = new AbortController().signal) {
  let stdout = '',
    stderr = '';
  const code = await run(args, {
    cwd: work,
    env: { NO_COLOR: '1' },
    signal,
    stdout: {
      write(s) {
        stdout += s;
      },
    },
    stderr: {
      write(s) {
        stderr += s;
      },
    },
  });
  return { code, stdout, stderr };
}
beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'atlas-finding-review-'));
  repo = createGitFixture(
    [
      {
        date: '2026-10-01T00:00:00Z',
        message: 'initial authored lint context',
        files: { 'src/check.py': source, 'other.py': 'pass\n' },
      },
      { date: '2026-10-02T00:00:00Z', message: 'rename only', renames: [['src/check.py', 'src/renamed.py']] },
      {
        date: '2026-10-03T00:00:00Z',
        message: 'insert unrelated prefix',
        files: { 'src/renamed.py': '# added one\n# added two\n# added three\n' + source },
      },
    ],
    { parent: work },
  );
  expect((await command(['analyze', repo.dir, '--out', 'artifact', '--snapshots', '3'])).code).toBe(0);
  const artifact = await openArtifactDirectory(path.join(work, 'artifact'));
  if (!artifact.ok) throw new Error('fixture artifact');
  expect(artifact.artifact.manifest.frames).toHaveLength(3);
  for (let i = 0; i < 3; i++) {
    const frame = await artifact.artifact.frame(i);
    if (!frame.ok) throw new Error('fixture frame');
    const target = qualityTarget(frame.graph, artifact.artifact.manifest.analysisId);
    const report = importRuffSarif(
      JSON.stringify({
        version: '2.1.0',
        runs: [
          {
            tool: { driver: { name: 'ruff', version: '0.17.3' } },
            results: [
              {
                ruleId: 'F821',
                level: 'error',
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: i === 0 ? 'src/check.py' : 'src/renamed.py' },
                      region: { startLine: i === 2 ? 23 : 20, startColumn: 11 },
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
      target,
      target.commitOid,
    );
    const scan = createScanEvidence(
      report,
      profile,
      { format: 'atlas.scan-scope/1', files: target.files.map(({ path, blobOid }) => ({ path, blobOid })) },
      1,
      target,
    );
    writeFileSync(path.join(work, `scan-${i}.json`), canonicalJson(scan) + '\n');
    const proof = path.join(work, `proof-${i}`);
    mkdirSync(proof);
    writeFileSync(path.join(proof, 'bundle.jsonl'), '{}');
    writeFileSync(path.join(proof, 'trusted-root.jsonl'), '{}');
    writeFileSync(
      path.join(proof, 'trust.json'),
      JSON.stringify({
        format: 'atlas.scan-trust/1',
        repository: 'owner/repo',
        workflow: '.github/workflows/scan.yml',
        workflowCommit: target.commitOid,
        sourceCommit: target.commitOid,
        sourceRef: 'refs/heads/main',
        trustedRootSha256: verifier.scanSha256('{}'),
      }),
    );
  }
  // Neither uncommitted content nor untrusted repository config may supply context.
  writeFileSync(path.join(repo.dir, 'src/renamed.py'), 'raise RuntimeError("DO_NOT_EXECUTE_WORKTREE")\n');
  repo.git(['config', 'core.fsmonitor', 'DO_NOT_EXECUTE_REPOSITORY_CONFIG']);
}, 60_000);
afterAll(() => {
  repo?.dispose();
  if (work) rmSync(work, { recursive: true, force: true });
});
const args = (out: string, current = 2, baseline = 0) => [
  'review-findings',
  `scan-${current}.json`,
  '--baseline',
  `scan-${baseline}.json`,
  '--artifact',
  'artifact',
  '--repo',
  repo.dir,
  '--out',
  out,
  '--json',
];
const read = (name: string): FindingReview => parseFindingReview(readFileSync(path.join(work, name), 'utf8'));

describe('finding-review CLI: real committed Git data, no scanner', () => {
  it('pins historical scan targets separately from a shared producer checkout (mock orchestration only)', async () => {
    const proof = vi.spyOn(verifier, 'verifyScanProvenance').mockResolvedValue(undefined);
    const oldPath = path.join(work, 'proof-0/trust.json'),
      nowPath = path.join(work, 'proof-2/trust.json');
    const oldText = readFileSync(oldPath, 'utf8'),
      nowText = readFileSync(nowPath, 'utf8');
    const oldPolicy = JSON.parse(oldText),
      nowPolicy = JSON.parse(nowText);
    const argsWithProof = (out: string) => [
      ...args(out),
      '--current-proof',
      'proof-2',
      '--baseline-proof',
      'proof-0',
      '--gh',
      process.execPath,
    ];
    try {
      writeFileSync(
        oldPath,
        JSON.stringify({
          format: 'atlas.review-scan-trust/1',
          scanCommit: oldPolicy.sourceCommit,
          producer: nowPolicy,
        }),
      );
      writeFileSync(
        nowPath,
        JSON.stringify({
          format: 'atlas.review-scan-trust/1',
          scanCommit: nowPolicy.sourceCommit,
          producer: nowPolicy,
        }),
      );
      expect((await command(argsWithProof('historical-review.json'))).code).toBe(0);
      expect(proof).toHaveBeenCalledTimes(2);
      expect(proof.mock.calls[0]![0].policy.sourceCommit).toBe(nowPolicy.sourceCommit);
      expect(proof.mock.calls[1]![0].policy.sourceCommit).toBe(nowPolicy.sourceCommit);
      const result = read('historical-review.json');
      expect(result.baseline.report.commitOid).toBe(oldPolicy.sourceCommit);
      expect(result.baseline.declaredTrust!.producer.sourceCommit).toBe(nowPolicy.sourceCommit);
      proof.mockClear();
      writeFileSync(
        oldPath,
        JSON.stringify({
          format: 'atlas.review-scan-trust/1',
          scanCommit: nowPolicy.sourceCommit,
          producer: nowPolicy,
        }),
      );
      expect((await command(argsWithProof('wrong-target.json'))).code).toBe(1);
      expect(proof).not.toHaveBeenCalled();
      expect(existsSync(path.join(work, 'wrong-target.json'))).toBe(false);
      writeFileSync(oldPath, nowText); // Direct policy must STILL bind the old scan, not just its producer.
      expect((await command(argsWithProof('wrong-direct-target.json'))).code).toBe(1);
      expect(proof).not.toHaveBeenCalled();
    } finally {
      writeFileSync(oldPath, oldText);
      writeFileSync(nowPath, nowText);
      proof.mockRestore();
    }
  });
  it('reads more than one native blob batch without dropping or conflating findings', async () => {
    const base = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`file_${i}.py`, `# file ${i}\n${source}`]));
    const changed = Object.fromEntries(Object.entries(base).map(([name, text]) => [name, '# prefix\n' + text]));
    const multi = createGitFixture(
      [
        { date: '2026-10-01T00:00:00Z', message: 'seventy contexts', files: base },
        { date: '2026-10-02T00:00:00Z', message: 'seventy shifted contexts', files: changed },
      ],
      { parent: work },
    );
    try {
      expect((await command(['analyze', multi.dir, '--out', 'batch-artifact', '--snapshots', '2'])).code).toBe(0);
      const opened = await openArtifactDirectory(path.join(work, 'batch-artifact'));
      if (!opened.ok) throw new Error('batch fixture');
      for (let i = 0; i < 2; i++) {
        const frame = await opened.artifact.frame(i);
        if (!frame.ok) throw new Error('batch frame');
        const target = qualityTarget(frame.graph, opened.artifact.manifest.analysisId);
        const report = importRuffSarif(
          JSON.stringify({
            version: '2.1.0',
            runs: [
              {
                tool: { driver: { name: 'ruff', version: '0.17.3' } },
                results: Object.keys(base).map((uri) => ({
                  ruleId: 'F821',
                  locations: [
                    {
                      physicalLocation: {
                        artifactLocation: { uri },
                        region: { startLine: i === 0 ? 21 : 22, startColumn: 11 },
                      },
                    },
                  ],
                })),
              },
            ],
          }),
          target,
          target.commitOid,
        );
        const scan = createScanEvidence(
          report,
          profile,
          { format: 'atlas.scan-scope/1', files: target.files.map(({ path, blobOid }) => ({ path, blobOid })) },
          1,
          target,
        );
        writeFileSync(path.join(work, `batch-${i}.json`), canonicalJson(scan));
      }
      const result = await command([
        'review-findings',
        'batch-1.json',
        '--baseline',
        'batch-0.json',
        '--artifact',
        'batch-artifact',
        '--repo',
        multi.dir,
        '--out',
        'batch-review.json',
        '--json',
      ]);
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stdout).counts).toEqual({
        continuing: 70,
        'newly-reported': 0,
        'no-longer-reported': 0,
        'unmatched-current': 0,
        'unmatched-baseline': 0,
      });
      expect(new Set(read('batch-review.json').issues.map((r) => r.id)).size).toBe(70);
    } finally {
      multi.dispose();
    }
  });
  it('keeps the tracking identity through three frames, ignoring worktree edits and preserving Git metadata', async () => {
    const config = readFileSync(path.join(repo.dir, '.git/config'));
    expect((await command(args('review-01.json', 1, 0))).code).toBe(2);
    expect((await command(args('review-12.json', 2, 1))).code).toBe(2);
    expect(read('review-01.json').issues[0]).toMatchObject({ state: 'continuing', basis: 'unique-context' });
    expect(read('review-12.json').issues[0]!.id).toBe(read('review-01.json').issues[0]!.id);
    const text = readFileSync(path.join(work, 'review-12.json'), 'utf8');
    expect(text).not.toContain('print(missing)');
    expect(text).not.toContain('DO_NOT_EXECUTE');
    expect(text).not.toContain(work);
    expect(readFileSync(path.join(repo.dir, '.git/config'))).toEqual(config);
  });
  it('rejects reversed/same snapshots, wrong repositories, overwritten output and artifact aliases', async () => {
    const before = readFileSync(path.join(work, 'review-12.json'));
    expect((await command(args('review-12.json'))).code).toBe(1);
    expect(readFileSync(path.join(work, 'review-12.json'))).toEqual(before);
    expect((await command(args('reverse.json', 0, 2))).code).toBe(1);
    expect((await command(args('same.json', 1, 1))).code).toBe(1);
    const wrong = args('wrong.json');
    wrong[wrong.indexOf('--repo') + 1] = work;
    const failed = await command(wrong);
    expect(failed.code).toBe(1);
    expect(failed.stdout).not.toContain(work);
    expect(existsSync(path.join(work, 'wrong.json'))).toBe(false);
    symlinkSync(
      path.join(work, 'artifact'),
      path.join(work, 'artifact-alias'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect((await command(args('artifact-alias/review.json'))).code).toBe(64);
  });
  it('requires paired proof arguments and handles cancellation before output', async () => {
    expect((await command([...args('one-proof.json'), '--current-proof', 'proof-2'])).code).toBe(64);
    expect((await command([...args('empty-proof.json'), '--current-proof', '', '--baseline-proof', ''])).code).toBe(64);
    expect((await command([...args('gh-only.json'), '--gh', process.execPath])).code).toBe(64);
    expect((await command(['review-findings'])).code).toBe(64);
    const control = new AbortController();
    control.abort();
    expect((await command(args('cancelled.json'), control.signal)).code).toBe(130);
    expect(existsSync(path.join(work, 'cancelled.json'))).toBe(false);
  });
  it('composes two independent policy checks without treating output as a browser receipt (mock orchestration only)', async () => {
    const proof = vi.spyOn(verifier, 'verifyScanProvenance').mockResolvedValue(undefined);
    const verified = (out: string) => [
      ...args(out),
      '--current-proof',
      'proof-2',
      '--baseline-proof',
      'proof-0',
      '--gh',
      process.execPath,
    ];
    try {
      const result = await command(verified('declared-verified.json'));
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        provenanceVerifiedInThisProcess: true,
        cleanVerdict: 'not-established',
        counts: { continuing: 1 },
      });
      expect(proof).toHaveBeenCalledTimes(2);
      expect(proof.mock.calls[0]![0].evidence).toBe(readFileSync(path.join(work, 'scan-0.json'), 'utf8'));
      expect(proof.mock.calls[1]![0].evidence).toBe(readFileSync(path.join(work, 'scan-2.json'), 'utf8'));
      expect(proof.mock.calls[0]![0].policy.workflowCommit).not.toBe(proof.mock.calls[1]![0].policy.workflowCommit);
      const policyPath = path.join(work, 'proof-2/trust.json'),
        original = readFileSync(policyPath, 'utf8');
      writeFileSync(policyPath, JSON.stringify({ ...JSON.parse(original), repository: 'different/producer' }));
      expect((await command(verified('different-policy.json'))).code).toBe(2);
      expect(read('different-policy.json').reasons).toContain('producer-policy-differs');
      writeFileSync(policyPath, original);
      proof.mockRejectedValue(new Error('PRIVATE_VERIFIER_OUTPUT'));
      const failed = await command(verified('bad-proof.json'));
      expect(failed.code).toBe(1);
      expect(failed.stdout).not.toContain('PRIVATE_VERIFIER_OUTPUT');
      expect(existsSync(path.join(work, 'bad-proof.json'))).toBe(false);
    } finally {
      proof.mockRestore();
    }
  });
});
