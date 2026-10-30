import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { createGitFixture, type GitFixture } from '@atlas/test-fixtures';
import { run } from '@atlas/cli';
import { openArtifactDirectory } from '@atlas/artifact/node';
import { validateArchitectureReview } from '@atlas/graph';
import type { ArchitectureReview } from '@atlas/schema';
let work: string, repo: GitFixture;
async function command(args: string[], signal = new AbortController().signal) {
  let stdout = '', stderr = '';
  const code = await run(args, { cwd: work, env: { NO_COLOR: '1' }, signal, stdout: { write(s) { stdout += s; } }, stderr: { write(s) { stderr += s; } } });
  return { code, stdout, stderr };
}
const policy = {
  format: 'atlas.architecture-policy/1', rules: [
    { id: 'production-tests', kind: 'forbidden-dependency', from: { roles: ['source'] }, to: { roles: ['test'] }, edgeKinds: ['imports-value'] },
    { id: 'web-api', kind: 'forbidden-dependency', from: { packages: ['packages/web'] }, to: { packages: ['packages/api'] }, edgeKinds: ['imports-value'] },
    { id: 'cycles', kind: 'cycle' },
  ]
};
beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'atlas-architecture-'));
  repo = createGitFixture([
    {
      date: '2026-10-01T00:00:00Z', message: 'authored baseline', files: {
        'package.json': '{"private":true,"workspaces":["packages/*"]}',
        'packages/web/package.json': '{"name":"web"}',
        'packages/api/package.json': '{"name":"api"}',
        'packages/web/src/main.ts': 'import { value } from "../../api/index";\nexport const main = value;\n',
        'packages/api/index.ts': 'export const value = 1;\n',
        'tests/helper.ts': 'export const helper = 2;\n',
        'service.py': 'value = 1\n',
        'tests/__init__.py': '',
        'tests/support.py': 'helper = 2\n',
      }
    },
    {
      date: '2026-10-02T00:00:00Z', message: 'authored new violations', files: {
        'packages/web/src/main.ts': 'import { value } from "../../api/index";\nimport { helper } from "../../../tests/helper";\nexport const main = value + helper;\n',
        'packages/api/index.ts': 'import { main } from "../web/src/main";\nexport const value = main;\n',
        'service.py': 'from tests.support import helper\nvalue = helper\n',
      }
    },
  ], { parent: work });
  expect((await command(['analyze', repo.dir, '--out', 'artifact', '--snapshots', '2', '--json'])).code).toBe(0);
  writeFileSync(path.join(work, 'policy.json'), JSON.stringify(policy));
});
afterAll(() => {
  repo?.dispose(); if (work)
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const args = (out: string) => ['review-architecture', 'artifact', '--policy', 'policy.json', '--commit', repo.commits[1]!, '--baseline', repo.commits[0]!, '--out', out, '--json'];
it('reviews real TS and Python dependencies, old package boundaries and a new cycle with authored counts', async () => {
  const result = await command([...args('review.json'), '--fail-on', 'new']);
  expect(result.code, result.stdout + result.stderr).toBe(3);
  const report: ArchitectureReview = JSON.parse(readFileSync(path.join(work, 'review.json'), 'utf8'));
  expect(report.rules.find(r => r.ruleId === 'production-tests')).toMatchObject({ current: 2, baseline: 0, newlyObserved: 2 });
  expect(report.rules.find(r => r.ruleId === 'web-api')).toMatchObject({ current: 1, baseline: 1, continuing: 1, newlyObserved: 0 });
  expect(report.rules.find(r => r.ruleId === 'cycles')).toMatchObject({ current: 1, baseline: 0, newlyObserved: 1 });
  expect(report.rows.filter(r => r.kind === 'forbidden-dependency').map(r => r.edge.from.path).sort()).toEqual(['packages/web/src/main.ts', 'packages/web/src/main.ts', 'service.py']);
  expect(report.rows.some(r => r.kind === 'forbidden-dependency' && r.edge.locations.some(l => l.range.startLine === 2))).toBe(true);
  const artifact = await openArtifactDirectory(path.join(work, 'artifact'));
  if (!artifact.ok)
    throw new Error('fixture artifact');
  const old = await artifact.artifact.frame(0), now = await artifact.artifact.frame(1);
  if (!old.ok || !now.ok)
    throw new Error('fixture frames');
  expect(validateArchitectureReview(JSON.stringify(report), artifact.artifact.manifest.analysisId, now.graph, old.graph)).toEqual(report);
  const text = JSON.stringify(report);
  expect(text).not.toContain('export const');
  expect(text).not.toContain(repo.dir);
  expect(text).not.toContain('authored new violations');
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, policyBlocked: true, securityVerdict: 'not-established' });
});
it('writes useful Markdown without source or active links and never overwrites a prior report', async () => {
  const r = await command([...args('report.md'), '--markdown']);
  expect([0, 2]).toContain(r.code);
  const text = readFileSync(path.join(work, 'report.md'), 'utf8');
  expect(text).toContain('packages/web/src/main&#46;ts');
  expect(text).toContain('Static synchronous value cycle component');
  expect(text).not.toContain('export const');
  expect((await command([...args('report.md'), '--markdown'])).code).toBe(1);
  expect(readFileSync(path.join(work, 'report.md'), 'utf8')).toBe(text);
});
it('keeps immutable artifact bytes and refuses outputs inside it or through an artifact directory alias', async () => {
  const manifest = readFileSync(path.join(work, 'artifact', 'manifest.json'));
  expect((await command(args('artifact/extra.json'))).code).toBe(64);
  symlinkSync(path.join(work, 'artifact'), path.join(work, 'artifact-alias'), process.platform === 'win32' ? 'junction' : 'dir');
  expect((await command(args('artifact-alias/extra.json'))).code).toBe(64);
  expect(existsSync(path.join(work, 'artifact', 'extra.json'))).toBe(false);
  expect(readFileSync(path.join(work, 'artifact', 'manifest.json'))).toEqual(manifest);
});
it('rejects wrong/reversed/abbreviated commits, bad flags, malformed policy and cancellation without output', async () => {
  const cases = [
    ['review-architecture', 'artifact', '--policy', 'policy.json', '--commit', 'a'.repeat(40), '--out', 'bad.json'],
    ['review-architecture', 'artifact', '--policy', 'policy.json', '--commit', repo.commits[0]!, '--baseline', repo.commits[1]!, '--out', 'bad.json'],
    ['review-architecture', 'artifact', '--policy', 'policy.json', '--commit', repo.commits[1]!.slice(0, 7), '--out', 'bad.json'],
    ['review-architecture', 'artifact', '--policy', 'policy.json', '--commit', repo.commits[1]!, '--fail-on', 'new', '--out', 'bad.json'],
    [...args('bad.json'), '--fail-on', 'unknown'],
    [...args('bad.json'), '--execute'],
  ];
  for (const a of cases)
    expect((await command(a)).code).toBe(64);
  writeFileSync(path.join(work, 'invalid.json'), '{"format":"bad","source":"PRIVATE"}');
  const a = args('bad.json');
  a[a.indexOf('policy.json')] = 'invalid.json';
  const result = await command(a);
  expect(result.code).toBe(1);
  expect(result.stdout).not.toContain('PRIVATE');
  expect(result.stdout).not.toContain(work);
  const abort = new AbortController();
  abort.abort();
  expect((await command(args('bad.json'), abort.signal)).code).toBe(130);
  expect(existsSync(path.join(work, 'bad.json'))).toBe(false);
});
it('supports HEAD-only explicit all checks and refuses an artifact directory output', async () => {
  const a = ['review-architecture', 'artifact', '--policy', 'policy.json', '--commit', repo.commits[1]!, '--out', 'head.json', '--fail-on', 'all', '--json'];
  expect((await command(a)).code).toBe(3);
  expect(JSON.parse(readFileSync(path.join(work, 'head.json'), 'utf8')).rows.every((r: {
    state: string;
  }) => r.state === 'uncompared')).toBe(true);
  // A directory output also exercises exclusive creation without Windows file-symlink privileges.
  const b = args('artifact');
  expect((await command(b)).code).toBe(64);
});
