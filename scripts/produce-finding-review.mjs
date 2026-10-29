#!/usr/bin/env node
/** Owner-reviewed CI producer. An explicitly selected local repository is data only.
 * Copies committed Python
 * blobs into private scratch for isolated Ruff; never checks out or executes them.
 * Output scans share one history artifact. Signing remains an external owner action.
 */
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { run } from '../packages/cli/dist/index.js';
import { openArtifactDirectory } from '../packages/artifact/dist/node.js';
import { openLocalRepository, resolveLocalCommit, readObjects, runBounded } from '../packages/ingest/dist/index.js';
import { LIMITS } from '../packages/schema/dist/index.js';
import { parseFindingReview } from '../packages/graph/dist/index.js';

let stage = 'prepare';
async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { values } = parseArgs({
    options: {
      ruff: { type: 'string' },
      baseline: { type: 'string' },
      out: { type: 'string' },
      repo: { type: 'string' },
    },
    strict: true,
  });
  assert(values.ruff && path.isAbsolute(values.ruff), 'Provide a trusted absolute Ruff path.');
  assert(values.baseline && /^[0-9a-f]{40}$/.test(values.baseline), 'Baseline must be a full committed SHA-1.');
  assert(values.out, 'Provide a fresh direct child of .atlas-tmp.');
  const out = path.resolve(root, values.out),
    scratch = await realpath(path.join(root, '.atlas-tmp'));
  assert(path.dirname(out) === scratch, 'Output must stay directly below this checkout’s .atlas-tmp.');
  await mkdir(out, { mode: 0o700 }); // Exclusive; preserve failed evidence for diagnosis.
  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort());
  const io = {
    cwd: root,
    env: { NO_COLOR: '1' },
    signal: abort.signal,
    stdout: { write() {} },
    stderr: { write() {} },
  };
  const sourceRoot = values.repo ? path.resolve(process.cwd(), values.repo) : root;
  const { repo, git } = await openLocalRepository(sourceRoot);
  try {
    const expected = values.repo ? undefined : process.env.GITHUB_SHA;
    if (expected) assert(/^[0-9a-f]{40}$/.test(expected), 'Producer source must be a full commit ID.');
    stage = 'history-window';
    const current = await resolveLocalCommit(repo, git, expected, abort.signal);
    const chain = (
      await git.run(['rev-list', '--first-parent', `--max-count=${LIMITS.firstParentCommits}`, current], {
        signal: abort.signal,
        maxStdoutBytes: 200 * 66,
      })
    ).stdout
      .toString('utf8')
      .trim()
      .split('\n');
    const before = chain.indexOf(values.baseline);
    assert(before > 0, 'Baseline must precede current in the bounded first-parent chain.');
    const artifact = path.join(out, 'artifact');
    stage = 'analyze';
    assert.equal(
      await run(
        [
          'analyze',
          sourceRoot,
          '--ref',
          current,
          '--history-commits',
          String(before + 1),
          '--snapshots',
          '2',
          '--out',
          artifact,
        ],
        io,
      ),
      0,
      'A complete two-frame analysis is required.',
    );
    const opened = await openArtifactDirectory(artifact);
    assert(opened.ok);
    assert.equal(opened.artifact.manifest.frames.length, 2);
    assert.equal(
      opened.artifact.manifest.frames[0].commit.oid,
      values.baseline,
      'Date/shallow limits cannot silently substitute another baseline.',
    );
    assert.equal(opened.artifact.manifest.frames[1].commit.oid, current);
    const env = { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), NO_COLOR: '1' };
    const options = {
      cwd: root,
      env,
      signal: abort.signal,
      timeoutMs: 20_000,
      maxStdoutBytes: 8 * 1024 * 1024,
      maxStderrBytes: 4096,
      okExitCodes: [0, 1],
    };
    stage = 'ruff-version';
    assert.equal((await runBounded(values.ruff, ['--version'], options)).stdout.toString('utf8').trim(), 'ruff 0.17.3');
    const profile = {
      format: 'atlas.ruff-profile/1',
      isolated: true,
      ignoreNoqa: true,
      respectGitignore: false,
      forceExclude: false,
      targetVersion: 'py314',
      rules: ['F401', 'F821'],
    };
    const profileFile = path.join(out, 'profile.json');
    await writeFile(profileFile, JSON.stringify(profile) + '\n', { flag: 'wx', mode: 0o600 });
    let sourceBytes = 0;
    const scannedFiles = [];
    for (let i = 0; i < 2; i++) {
      const name = i === 0 ? 'baseline' : 'current';
      const frame = await opened.artifact.frame(i);
      assert(frame.ok);
      const files = frame.graph.nodes.filter(
        (n) => n.kind === 'file' && n.language === 'python' && /\.pyi?$/.test(n.path),
      );
      assert(files.length > 0 && files.length <= 100, 'Example requires 1..100 included Python files per frame.');
      scannedFiles.push(files.length);
      const staging = path.join(out, 'private', name, 'source');
      await mkdir(staging, { recursive: true, mode: 0o700 });
      const absolute = [];
      stage = `${name}-committed-source`;
      for (const file of files) {
        assert(file.byteSize <= LIMITS.sourceBlobBytes);
        sourceBytes += file.byteSize;
        assert(sourceBytes <= LIMITS.headDecodedSourceBytes);
        const object = (await readObjects(git, [{ oid: file.blobOid, size: file.byteSize }], abort.signal)).get(
          file.blobOid,
        );
        assert(object?.type === 'blob' && object.bytes.length === file.byteSize);
        assert.equal(
          createHash(repo.objectFormat).update(`blob ${object.bytes.length}\0`).update(object.bytes).digest('hex'),
          file.blobOid,
        );
        const destination = path.resolve(staging, file.path);
        assert(destination.startsWith(staging + path.sep));
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, object.bytes, { flag: 'wx', mode: 0o600 });
        absolute.push(destination);
      }
      stage = `${name}-ruff`;
      const result = await runBounded(
        values.ruff,
        [
          'check',
          '--isolated',
          '--ignore-noqa',
          '--no-respect-gitignore',
          '--no-cache',
          '--target-version',
          'py314',
          '--select',
          'F401,F821',
          '--output-format',
          'sarif',
          ...absolute,
        ],
        options,
      );
      const sarif = path.join(out, 'private', name, 'ruff.sarif'),
        quality = path.join(out, `${name}.quality.json`),
        scope = path.join(out, `${name}.scope.json`);
      await writeFile(sarif, result.stdout, { flag: 'wx', mode: 0o600 });
      await writeFile(
        scope,
        JSON.stringify({ format: 'atlas.scan-scope/1', files: files.map(({ path, blobOid }) => ({ path, blobOid })) }) +
          '\n',
        { flag: 'wx', mode: 0o600 },
      );
      stage = `${name}-import`;
      assert.equal(
        await run(
          [
            'findings',
            sarif,
            '--artifact',
            artifact,
            '--commit',
            frame.graph.commitOid,
            '--source-root',
            staging,
            '--out',
            quality,
          ],
          io,
        ),
        0,
        'No dropped scan records accepted.',
      );
      assert.equal(
        await run(
          [
            'scan-evidence',
            quality,
            '--artifact',
            artifact,
            '--profile',
            profileFile,
            '--scope',
            scope,
            '--exit-code',
            String(result.exitCode),
            '--out',
            path.join(out, `${name}.scan.json`),
          ],
          io,
        ),
        0,
      );
    }
    stage = 'review';
    const reviewFile = path.join(out, 'finding-review.json');
    assert.equal(
      await run(
        [
          'review-findings',
          path.join(out, 'current.scan.json'),
          '--baseline',
          path.join(out, 'baseline.scan.json'),
          '--artifact',
          artifact,
          '--repo',
          sourceRoot,
          '--out',
          reviewFile,
        ],
        io,
      ),
      2,
      'Unsigned declarations stay partial.',
    );
    const review = parseFindingReview(await readFile(reviewFile, 'utf8'));
    assert.equal(review.declaredVerification, 'unverified');
    console.log(
      JSON.stringify({
        ok: true,
        baseline: values.baseline,
        current,
        scannedFiles,
        rows: review.issues.length,
        provenance: 'awaiting-external-attestation',
      }),
    );
  } finally {
    await git.dispose();
  }
}
try {
  await main();
} catch {
  // Raw scanner/process errors can contain SARIF, source or machine paths.
  console.error(JSON.stringify({ ok: false, code: 'FINDING_REVIEW_PRODUCER_FAILED', stage }));
  process.exitCode = 1;
}
