import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from '@atlas/cli';
import { openArtifactDirectory } from '@atlas/artifact/node';
import { createGitFixture, type GitFixture } from '@atlas/test-fixtures';

let work: string, repo: GitFixture;
const raw = () =>
  JSON.parse(readFileSync(new URL('../../graph/test/fixtures/ruff-0.17.3.sarif.json', import.meta.url), 'utf8'));
async function command(args: string[], signal = new AbortController().signal) {
  let stdout = '',
    stderr = '';
  const code = await run(args, {
    cwd: work,
    signal,
    env: { NO_COLOR: '1' },
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
function artifactHash() {
  const digest = createHash('sha256');
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) walk(file);
      else digest.update(file).update(readFileSync(file));
    }
  };
  walk(path.join(work, 'artifact'));
  return digest.digest('hex');
}
beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'atlas-quality-'));
  repo = createGitFixture(
    [
      {
        date: '2026-10-01T00:00:00Z',
        message: 'two authored lint findings',
        files: { 'sample.py': 'import os\nprint(missing)\n' },
      },
      {
        date: '2026-10-02T00:00:00Z',
        message: 'remove undefined name',
        files: { 'sample.py': 'import os\nprint(0)\n' },
      },
    ],
    { parent: work },
  );
  expect((await command(['analyze', repo.dir, '--out', 'artifact'])).code).toBe(0);
  writeFileSync(path.join(work, 'old.sarif'), JSON.stringify(raw()));
  const newer = raw();
  newer.runs[0].results = newer.runs[0].results.filter((r: { ruleId: string }) => r.ruleId === 'F401');
  writeFileSync(path.join(work, 'new.sarif'), JSON.stringify(newer));
}, 60_000);
afterAll(() => {
  repo?.dispose();
  if (work) rmSync(work, { recursive: true, force: true });
});

describe('findings CLI on real committed snapshots', () => {
  it.skipIf(process.platform === 'win32')('rejects a POSIX FIFO without waiting for a writer', async () => {
    const opened = await openArtifactDirectory(path.join(work, 'artifact'));
    if (!opened.ok) throw new Error('artifact');
    execFileSync('mkfifo', [path.join(work, 'pipe.sarif')]);
    const imported = await command([
      'findings',
      'pipe.sarif',
      '--artifact',
      'artifact',
      '--commit',
      opened.artifact.manifest.selectedCommit.oid,
      '--out',
      'pipe.json',
      '--json',
    ]);
    expect(imported.code).toBe(1);
    expect(imported.stdout).toContain('regular file');
    expect(existsSync(path.join(work, 'pipe.json'))).toBe(false);
  });
  it('reports partial imports and rejects artifact output through a directory alias', async () => {
    const opened = await openArtifactDirectory(path.join(work, 'artifact'));
    if (!opened.ok) throw new Error('artifact');
    const commit = opened.artifact.manifest.selectedCommit.oid;
    const partial = raw();
    partial.runs[0].results[1].locations[0].physicalLocation.artifactLocation.uri = 'untracked.py';
    writeFileSync(path.join(work, 'partial.sarif'), JSON.stringify(partial));
    const imported = await command([
      'findings',
      'partial.sarif',
      '--artifact',
      'artifact',
      '--commit',
      commit,
      '--out',
      'partial.json',
      '--json',
    ]);
    expect(imported.code).toBe(2);
    expect(JSON.parse(imported.stdout)).toMatchObject({ ok: true, findings: 1, dropped: { unmapped: 1 } });
    expect(existsSync(path.join(work, 'partial.json'))).toBe(true);
    symlinkSync(
      path.join(work, 'artifact'),
      path.join(work, 'artifact-alias'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const before = artifactHash();
    expect(
      (
        await command([
          'findings',
          'new.sarif',
          '--artifact',
          'artifact',
          '--commit',
          commit,
          '--out',
          'artifact-alias/quality.json',
        ])
      ).code,
    ).toBe(64);
    expect(artifactHash()).toBe(before);
    expect(existsSync(path.join(work, 'artifact', 'quality.json'))).toBe(false);
  });
  it('imports real producer records into separate private sidecars and compares without changing the artifact', async () => {
    const before = artifactHash();
    const opened = await openArtifactDirectory(path.join(work, 'artifact'));
    if (!opened.ok) throw new Error('artifact');
    const frames = opened.artifact.manifest.frames;
    const old = await command([
      'findings',
      'old.sarif',
      '--artifact',
      'artifact',
      '--commit',
      frames[0]!.commit.oid,
      '--out',
      'old.json',
      '--json',
    ]);
    expect(old.code).toBe(0);
    expect(JSON.parse(old.stdout).findings).toBe(2);
    const current = await command([
      'findings',
      'new.sarif',
      '--artifact',
      'artifact',
      '--commit',
      frames.at(-1)!.commit.oid,
      '--out',
      'new.json',
      '--baseline',
      'old.json',
      '--json',
    ]);
    expect(current.code).toBe(0);
    expect(JSON.parse(current.stdout).comparison).toEqual({ newlyReported: 0, noLongerReported: 1, sameLocation: 1 });
    const stored = readFileSync(path.join(work, 'old.json'), 'utf8');
    expect(stored).not.toMatch(/missing|imported but|fixes|file:\/|Users|message/);
    expect(artifactHash()).toBe(before);
    const oldBytes = readFileSync(path.join(work, 'old.json'));
    expect(
      (
        await command([
          'findings',
          'new.sarif',
          '--artifact',
          'artifact',
          '--commit',
          frames.at(-1)!.commit.oid,
          '--out',
          'old.json',
        ])
      ).code,
    ).toBe(1);
    expect(readFileSync(path.join(work, 'old.json'))).toEqual(oldBytes);
  });
  it('rejects invalid bindings, artifact-contained output and invalid UTF-8 without leaking content', async () => {
    const opened = await openArtifactDirectory(path.join(work, 'artifact'));
    if (!opened.ok) throw new Error('artifact');
    const commit = opened.artifact.manifest.selectedCommit.oid;
    expect(
      (
        await command([
          'findings',
          'new.sarif',
          '--artifact',
          'artifact',
          '--commit',
          '0'.repeat(40),
          '--out',
          'wrong.json',
        ])
      ).code,
    ).toBe(64);
    expect(
      (
        await command([
          'findings',
          'new.sarif',
          '--artifact',
          'artifact',
          '--commit',
          commit,
          '--out',
          'artifact/quality.json',
        ])
      ).code,
    ).toBe(64);
    writeFileSync(path.join(work, 'invalid.sarif'), Buffer.from([0xff, 0xfe]));
    const bad = await command([
      'findings',
      'invalid.sarif',
      '--artifact',
      'artifact',
      '--commit',
      commit,
      '--out',
      'bad.json',
      '--json',
    ]);
    expect(bad.code).toBe(1);
    expect(bad.stdout).toContain('not valid UTF-8');
    expect(bad.stderr).not.toContain(work);
    const cancelled = new AbortController();
    cancelled.abort();
    expect(
      (
        await command(
          ['findings', 'new.sarif', '--artifact', 'artifact', '--commit', commit, '--out', 'cancelled.json'],
          cancelled.signal,
        )
      ).code,
    ).toBe(130);
  });
});
