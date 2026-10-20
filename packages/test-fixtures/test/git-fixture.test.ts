import { describe, expect, it } from 'vitest';
import { createGitFixture, importGitFixture, type FixtureCommit, type GitFixture } from '@atlas/test-fixtures';

// importGitFixture must build exactly the repository createGitFixture builds: same commit
// IDs, hence the same trees, blobs, dates, identities and messages.
const commits: FixtureCommit[] = [
  { date: '2026-09-01T00:00:00Z', message: 'base', files: { 'src/a.ts': 'export const a = 1;\n', 'src/dir with space/b.ts': 'export const b = 2;\r\n', 'docs/naïve notes.md': '# title\n', 'bin.dat': new Uint8Array([0, 1, 2, 255, 10, 13]) } },
  { date: '2026-09-02T10:30:00+05:30', message: 'rename and edit\n\nwith a body line', renames: [['src/a.ts', 'src/moved/a.ts'], ['src/dir with space/b.ts', 'src/dir with space/b renamed.ts']], files: { 'src/moved/a.ts': 'export const a = 3;\n', 'docs/naïve notes.md': null } },
  { date: '2026-09-03T00:00:00-07:00', message: 'empty' },
  { date: '2026-09-04T00:00:00Z', message: 'restore', files: { 'docs/naïve notes.md': '# back\n', 'src/dir with space/b renamed.ts': null } },
];

const both = (objectFormat: 'sha1' | 'sha256'): [GitFixture, GitFixture] => [createGitFixture(commits, { objectFormat }), importGitFixture(commits, { objectFormat })];

describe('importGitFixture', () => {
  for (const objectFormat of ['sha1', 'sha256'] as const) {
    it(`builds the same ${objectFormat} commits as createGitFixture`, () => {
      const [created, imported] = both(objectFormat);
      try {
        expect(imported.commits).toHaveLength(commits.length);
        expect(imported.commits).toEqual(created.commits);
        expect(imported.git(['rev-parse', 'HEAD']).trim()).toBe(created.commits.at(-1));
      } finally {
        created.dispose();
        imported.dispose();
      }
    }, 60_000);
  }

  it('refuses inputs it cannot reproduce exactly', () => {
    expect(() => importGitFixture([{ date: '2026-09-01T00:00:00', message: 'local time' }])).toThrow(/explicit offset/);
    expect(() => importGitFixture([{ date: '2026-09-01T00:00:00Z', message: 'trailing space ' }])).toThrow(/committed form/);
    expect(() => importGitFixture([{ date: '2026-09-01T00:00:00Z', message: 'tagged', tag: { name: 'v1', annotated: false } }])).toThrow(/branches or tags/);
  });
});
