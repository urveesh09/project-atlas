import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { createGitFixture, type GitFixture } from '@atlas/test-fixtures';
import { run } from '@atlas/cli';
import { canonicalJson, canonicalJsonSha256, hashFields, makeId } from '@atlas/schema';
import { createReviewWorkspace } from '@atlas/graph';

let root: string, repo: GitFixture, issue: string, tempBase: string;
async function command(args: string[], signal = new AbortController().signal) {
  let stdout = '', stderr = '';
  const code = await run(args, { cwd: root, env: { NO_COLOR: '1' }, signal, stdout: { write(text) { stdout += text; } }, stderr: { write(text) { stderr += text; } } });
  return { code, stdout, stderr };
}
beforeAll(async () => {
  tempBase = realpathSync(os.tmpdir());
  root = mkdtempSync(path.join(tempBase, 'atlas-workspace-cli-'));
  repo = createGitFixture([{ date: '2026-10-01T00:00:00Z', message: 'authored private review fixture', files: {
    'src/main.ts': 'import { helper } from "../tests/helper";\nexport const value = helper;\n',
    'tests/helper.ts': 'export const helper = 2;\n',
  } }], { parent: root });
  expect((await command(['analyze', repo.dir, '--out', 'artifact', '--no-history', '--json'])).code).toBe(0);
  const policy = { format: 'atlas.architecture-policy/1', rules: [{ id: 'production-tests', kind: 'forbidden-dependency', from: { roles: ['source'] }, to: { roles: ['test'] }, edgeKinds: ['imports-value'] }] };
  writeFileSync(path.join(root, 'policy.json'), JSON.stringify(policy));
  const reviewed = await command(['review-architecture', 'artifact', '--policy', 'policy.json', '--commit', repo.commits[0]!, '--out', 'review.json', '--json']);
  expect(reviewed.code, reviewed.stdout + reviewed.stderr).toBe(0);
  issue = JSON.parse(readFileSync(path.join(root, 'review.json'), 'utf8')).rows[0].id;
});
afterAll(() => {
  repo?.dispose();
  if (root) {
    if (path.dirname(root) !== tempBase || !path.basename(root).startsWith('atlas-workspace-cli-')) throw new Error('Unexpected cleanup target');
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

it('admits a real review, records a local decision, exports/imports, and keeps policy outcome unchanged', async () => {
  const initialized = await command(['workspace', 'init', 'review.json', '--artifact', 'artifact', '--out', 'workspace', '--json']);
  expect(initialized.code, initialized.stdout + initialized.stderr).toBe(0);
  expect(JSON.parse(initialized.stdout)).toMatchObject({ revision: 0, counts: { retainedIssues: 1, decisions: 0 }, policyOverride: 'none' });
  const decision = await command(['workspace', 'decide', 'workspace', '--artifact', 'artifact', '--issue', issue, '--state', 'acknowledged', '--owner', 'architecture-review', '--expected-revision', '0', '--json']);
  expect(decision.code, decision.stdout + decision.stderr).toBe(0);
  expect(JSON.parse(decision.stdout)).toMatchObject({ revision: 1, counts: { decisions: 1 }, artifactProvenance: 'not-authenticated' });
  const state = readFileSync(path.join(root, 'workspace', 'workspace.json'), 'utf8');
  expect(state).not.toContain('export const'); expect(state).not.toContain(repo.dir); expect(state).not.toContain('authored private review fixture');
  expect((await command(['workspace', 'export', 'workspace', '--artifact', 'artifact', '--out', 'export.json', '--json'])).code).toBe(0);
  expect(readFileSync(path.join(root, 'export.json'), 'utf8')).toBe(state);
  expect((await command(['workspace', 'import', 'export.json', '--artifact', 'artifact', '--out', 'restored', '--json'])).code).toBe(0);
  expect(readFileSync(path.join(root, 'restored', 'workspace.json'), 'utf8')).toBe(state);
  expect((await command(['workspace', 'inspect', 'restored', '--artifact', 'artifact', '--json'])).code).toBe(0);
  const policyResult = await command(['review-architecture', 'artifact', '--policy', 'policy.json', '--commit', repo.commits[0]!, '--out', 'still-blocked.json', '--fail-on', 'all', '--json']);
  expect(policyResult.code).toBe(3);
});

it('fails stale decisions and preserves prior bytes; rejects unknown issue IDs and existing destinations', async () => {
  expect((await command(['workspace', 'init', 'review.json', '--artifact', 'artifact', '--out', 'conflict', '--json'])).code).toBe(0);
  const args = ['workspace', 'decide', 'conflict', '--artifact', 'artifact', '--issue', issue, '--state', 'deferred', '--expected-revision', '0', '--json'];
  expect((await command(args)).code).toBe(0);
  const prior = readFileSync(path.join(root, 'conflict', 'workspace.json'), 'utf8');
  const stale = await command(args); expect(stale.code).toBe(1); expect(stale.stdout).toContain('revision changed');
  expect(readFileSync(path.join(root, 'conflict', 'workspace.json'), 'utf8')).toBe(prior);
  const unknown = [...args]; unknown[unknown.indexOf(issue)] = `ar_${'f'.repeat(64)}`; unknown[unknown.indexOf('0')] = '1';
  expect((await command(unknown)).code).toBe(1);
  expect((await command(['workspace', 'init', 'review.json', '--artifact', 'artifact', '--out', 'conflict', '--json'])).code).toBe(1);
  expect(readFileSync(path.join(root, 'conflict', 'workspace.json'), 'utf8')).toBe(prior);
});

it('recomputes stored reports rather than trusting a forged digest, and refuses artifact-relative output', async () => {
  const state = createReviewWorkspace(JSON.parse(readFileSync(path.join(root, 'review.json'), 'utf8')));
  state.report.rules[0]!.current = 0;
  state.reportSha256 = canonicalJsonSha256(state.report);
  state.id = `ws_${hashFields('atlas.local-workspace/1', [state.reportSha256])}`;
  state.decisions = []; state.revision = 0;
  writeFileSync(path.join(root, 'forged.json'), canonicalJson(state));
  const forged = await command(['workspace', 'import', 'forged.json', '--artifact', 'artifact', '--out', 'forged-workspace', '--json']);
  expect(forged.code).toBe(1); expect(forged.stdout).toContain('differs');
  expect(existsSync(path.join(root, 'forged-workspace'))).toBe(false);
  const otherAnalysis = createReviewWorkspace({ ...state.report, analysisId: makeId('analysis', ['unrelated']) });
  writeFileSync(path.join(root, 'other-analysis.json'), canonicalJson(otherAnalysis));
  const foreign = await command(['workspace', 'import', 'other-analysis.json', '--artifact', 'artifact', '--out', 'foreign-workspace', '--json']);
  expect(foreign.code).toBe(1); expect(foreign.stdout).toContain('different artifact');
  expect(existsSync(path.join(root, 'foreign-workspace'))).toBe(false);
  expect((await command(['workspace', 'init', 'review.json', '--artifact', 'artifact', '--out', 'artifact/workspace', '--json'])).code).toBe(1);
  expect(existsSync(path.join(root, 'artifact', 'workspace'))).toBe(false);
});

it('rejects unsupported commands/fields and honors cancellation without creating a workspace', async () => {
  for (const args of [
    ['workspace', 'unknown', 'review.json', '--artifact', 'artifact'],
    ['workspace', 'init', 'review.json', '--out', 'bad'],
    ['workspace', 'inspect', 'workspace', '--artifact', 'artifact', '--out', 'bad'],
    ['workspace', 'decide', 'workspace', '--artifact', 'artifact', '--issue', issue, '--state', 'resolved', '--expected-revision', '0'],
    ['workspace', 'decide', 'workspace', '--artifact', 'artifact', '--issue', issue, '--state', 'deferred', '--expected-revision', '0', '--owner', 'someone@example.com'],
    ['workspace', 'decide', 'workspace', '--artifact', 'artifact', '--issue', issue, '--state', 'deferred', '--expected-revision', '-1'],
    ['workspace', 'init', 'review.json', '--artifact', 'artifact', '--out', 'bad', '--execute'],
  ]) expect((await command(args)).code).toBe(64);
  const abort = new AbortController(); abort.abort();
  expect((await command(['workspace', 'init', 'review.json', '--artifact', 'artifact', '--out', 'cancelled'], abort.signal)).code).toBe(130);
  expect(existsSync(path.join(root, 'cancelled'))).toBe(false);
});

it('shows coverage warnings in human output even when there are no retained issues', async () => {
  const policy = JSON.parse(readFileSync(path.join(root, 'policy.json'), 'utf8'));
  policy.rules[0].from = { paths: ['missing'] };
  writeFileSync(path.join(root, 'unmatched-policy.json'), JSON.stringify(policy));
  const reviewed = await command(['review-architecture', 'artifact', '--policy', 'unmatched-policy.json', '--commit', repo.commits[0]!, '--out', 'unmatched.json']);
  expect(reviewed.code).toBe(2);
  expect((await command(['workspace', 'init', 'unmatched.json', '--artifact', 'artifact', '--out', 'unmatched'])).code).toBe(0);
  const inspected = await command(['workspace', 'inspect', 'unmatched', '--artifact', 'artifact']);
  expect(inspected.code).toBe(0);
  expect(inspected.stdout).toContain('0 retained issues');
  expect(inspected.stdout).toContain('Coverage: At least one rule selector matches no files in a selected snapshot.');
});
