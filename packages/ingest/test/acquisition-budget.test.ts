import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { acquireGithubCommit, SafeGit } from '@atlas/ingest';

it('refuses a completed acquisition above the disk budget even before the watchdog polls', async () => {
  const original = SafeGit.prototype.run;
  const spy = vi.spyOn(SafeGit.prototype, 'run').mockImplementation(async function (this: SafeGit, args, options) {
    if (args[0] !== 'fetch') return original.call(this, args, options);
    // Model an immediate successful transport. No upstream or repository script runs;
    // the actual owned directory grows, and public acquisition must validate it.
    await writeFile(path.join(this.gitDir, 'objects', 'oversize-pack'), Buffer.alloc(64 * 1024));
    return { exitCode: 0, stdout: Buffer.alloc(0), stderr: '' };
  });
  try {
    await expect(acquireGithubCommit({ owner: 'atlas-demo', name: 'budget' }, 'a'.repeat(40), {
      maxBytes: 32 * 1024, timeoutMs: 10_000, depth: 1, filter: 'none',
    })).rejects.toMatchObject({ code: 'REPOSITORY_TOO_LARGE', details: { limitBytes: 32 * 1024 } });
  } finally { spy.mockRestore(); }
});
