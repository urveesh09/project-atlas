#!/usr/bin/env node
/** Real Ruff/CLI check on authored data. CI runs this in a no-network namespace.
 * No signature is created; the crypto adapter has a separate authentic fixture gate.
 */
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createGitFixture } from '../packages/test-fixtures/dist/index.js';
import { parseFindingReview, parseScanEvidence } from '../packages/graph/dist/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fixture;
try {
  const { values } = parseArgs({ options: { ruff: { type: 'string' }, out: { type: 'string' } }, strict: true });
  assert(values.ruff && path.isAbsolute(values.ruff) && values.out);
  const source = '# top one\n# top two\n# top three\n# top four\nx = 1\ny = 2\nprint(missing)\nz = 3\nw = 4\n# last\n';
  fixture = createGitFixture([
    { date: '2026-10-01T00:00:00Z', message: 'authored undefined name', files: { 'sample.py': source } },
    { date: '2026-10-02T00:00:00Z', message: 'accepted rename', renames: [['sample.py', 'renamed.py']] },
    {
      date: '2026-10-03T00:00:00Z',
      message: 'move unchanged context',
      files: { 'renamed.py': '# extra a\n# extra b\n# extra c\n' + source },
    },
  ]);
  fixture.git(['config', 'core.fsmonitor', 'DO_NOT_EXECUTE_REPOSITORY_CONFIG']);
  await writeFile(path.join(fixture.dir, 'renamed.py'), 'raise RuntimeError("DO_NOT_READ_WORKTREE")\n');
  async function metadata(dir) {
    const files = [];
    async function walk(current) {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const file = path.join(current, entry.name);
        if (entry.isDirectory()) await walk(file);
        else
          files.push([
            path.relative(dir, file),
            createHash('sha256')
              .update(await readFile(file))
              .digest('hex'),
          ]);
      }
    }
    await walk(dir);
    return files.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }
  const before = await metadata(path.join(fixture.dir, '.git'));
  const stdout = execFileSync(
    process.execPath,
    [
      path.join(root, 'scripts/produce-finding-review.mjs'),
      '--ruff',
      values.ruff,
      '--repo',
      fixture.dir,
      '--baseline',
      fixture.commits[0],
      '--out',
      values.out,
    ],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '',
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        NO_COLOR: '1',
      },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 64 * 1024,
    },
  );
  assert.equal(JSON.parse(stdout).ok, true);
  assert.deepEqual(await metadata(path.join(fixture.dir, '.git')), before);
  const out = path.resolve(root, values.out);
  const baseline = parseScanEvidence(await readFile(path.join(out, 'baseline.scan.json'), 'utf8'));
  const current = parseScanEvidence(await readFile(path.join(out, 'current.scan.json'), 'utf8'));
  assert.deepEqual(
    baseline.report.findings.map(({ ruleId, path, line, column }) => ({ ruleId, path, line, column })),
    [{ ruleId: 'F821', path: 'sample.py', line: 7, column: 7 }],
  );
  assert.deepEqual(
    current.report.findings.map(({ ruleId, path, line, column }) => ({ ruleId, path, line, column })),
    [{ ruleId: 'F821', path: 'renamed.py', line: 10, column: 7 }],
  );
  assert.equal(baseline.report.tool.version, '0.17.3');
  assert.equal(current.report.tool.version, '0.17.3');
  const text = await readFile(path.join(out, 'finding-review.json'), 'utf8'),
    review = parseFindingReview(text);
  assert.equal(review.issues.length, 1);
  assert.equal(review.issues[0].state, 'continuing');
  assert.equal(review.issues[0].basis, 'unique-context');
  assert.equal(review.declaredVerification, 'unverified');
  assert(!text.includes('print(missing)') && !text.includes('DO_NOT_READ_WORKTREE') && !text.includes(fixture.dir));
  const result = {
    format: 'atlas.finding-review.producer-check/1',
    ok: true,
    ruff: '0.17.3',
    baseline: fixture.commits[0],
    current: fixture.commits[2],
    expectedPositions: [
      [7, 7],
      [10, 7],
    ],
    retainedFindings: [1, 1],
    continuing: 1,
    acceptedRename: true,
    sourceExcluded: true,
    gitMetadataUnchanged: true,
    signature: 'not-created',
  };
  await writeFile(path.join(out, 'producer-check.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} catch {
  console.error(JSON.stringify({ ok: false, code: 'FINDING_REVIEW_PRODUCER_CHECK_FAILED' }));
  process.exitCode = 1;
} finally {
  fixture?.dispose();
}
