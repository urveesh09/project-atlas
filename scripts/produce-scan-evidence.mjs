#!/usr/bin/env node
/** Owner-reviewed external CI producer example (ADR-086), NOT an analyzer feature.
 * Runs only the explicitly supplied trusted Ruff against this repository's committed
 * Python files. No repository configuration, plugin or Python source is executed.
 */
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { run } from '../packages/cli/dist/index.js';
import { openArtifactDirectory } from '../packages/artifact/dist/node.js';
import { runBounded } from '../packages/ingest/dist/index.js';

let stage = 'prepare';
async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { values } = parseArgs({ options: { ruff: { type: 'string' }, out: { type: 'string' } }, strict: true });
  assert(values.ruff && path.isAbsolute(values.ruff), 'Provide the trusted absolute Ruff executable path.');
  assert(values.out, 'Provide a fresh output directory inside .atlas-tmp.');
  const out = path.resolve(root, values.out),
    scratch = await realpath(path.join(root, '.atlas-tmp'));
  assert(path.dirname(out) === scratch, 'Example output must be a direct child of this repository’s .atlas-tmp.');
  await mkdir(out, { mode: 0o700 }); // Never overwrite/reuse previous evidence.
  const control = new AbortController();
  process.once('SIGINT', () => control.abort());
  const io = {
    cwd: root,
    env: { NO_COLOR: '1' },
    signal: control.signal,
    stdout: { write() {} },
    stderr: { write() {} },
  };
  const artifact = path.join(out, 'artifact');
  const ref = process.env.GITHUB_SHA;
  if (ref) assert(/^[0-9a-f]{40}$/.test(ref), 'CI source must be a full commit ID.');
  stage = 'analyze';
  const code = await run(['analyze', root, '--out', artifact, '--no-history', ...(ref ? ['--ref', ref] : [])], io);
  assert.equal(code, 0, 'Example requires a complete analysis. Keep failed outputs for investigation.');
  const opened = await openArtifactDirectory(artifact);
  assert(opened.ok, 'Artifact must validate.');
  const frame = await opened.artifact.frame(0);
  assert(frame.ok, 'Frame must validate.');
  if (ref) assert.equal(frame.graph.commitOid, ref);
  const files = frame.graph.nodes.filter((n) => n.kind === 'file' && /\.pyi?$/.test(n.path));
  assert(files.length > 0 && files.length <= 100, 'The reviewed example supports 1..100 Python files.');
  const absoluteFiles = [];
  for (const file of files) {
    const absolute = path.join(root, file.path);
    const actual = await realpath(absolute);
    assert(actual.startsWith(root + path.sep), 'Scan path cannot leave the source checkout.');
    assert((await lstat(absolute)).isFile(), 'Scan paths must be regular files, not links.');
    absoluteFiles.push(absolute);
  }
  async function checkCommittedBytes() {
    for (let i = 0; i < files.length; i++) {
      const bytes = await readFile(absoluteFiles[i]);
      const oid = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      assert.equal(oid, files[i].blobOid, 'Working file differs from the committed analyzed blob.');
    }
  }
  stage = 'committed-bytes';
  await checkCommittedBytes();
  const profile = {
    format: 'atlas.ruff-profile/1',
    isolated: true,
    ignoreNoqa: true,
    respectGitignore: false,
    forceExclude: false,
    targetVersion: 'py314',
    rules: ['F401', 'F821'],
  };
  const env = { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), NO_COLOR: '1' };
  const options = {
    cwd: root,
    env,
    signal: control.signal,
    timeoutMs: 20_000,
    maxStdoutBytes: 8 * 1024 * 1024,
    maxStderrBytes: 4096,
    okExitCodes: [0, 1],
  };
  stage = 'ruff-version';
  const version = await runBounded(values.ruff, ['--version'], options);
  assert.equal(version.stdout.toString('utf8').trim(), 'ruff 0.17.3', 'Example pins Ruff 0.17.3.');
  stage = 'ruff-scan';
  const scanned = await runBounded(
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
      ...absoluteFiles,
    ],
    options,
  );
  stage = 'committed-bytes-after';
  await checkCommittedBytes();
  const sarif = path.join(out, 'ruff.sarif'),
    quality = path.join(out, 'quality.json');
  await writeFile(sarif, scanned.stdout, { mode: 0o600, flag: 'wx' });
  stage = 'import';
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
        root,
        '--out',
        quality,
      ],
      io,
    ),
    0,
    'No result may be dropped by this complete-scope example.',
  );
  const profileFile = path.join(out, 'profile.json'),
    scopeFile = path.join(out, 'scope.json');
  await writeFile(profileFile, JSON.stringify(profile) + '\n', { mode: 0o600, flag: 'wx' });
  await writeFile(
    scopeFile,
    JSON.stringify({ format: 'atlas.scan-scope/1', files: files.map(({ path, blobOid }) => ({ path, blobOid })) }) +
      '\n',
    { mode: 0o600, flag: 'wx' },
  );
  stage = 'manifest';
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
        scopeFile,
        '--exit-code',
        String(scanned.exitCode),
        '--out',
        path.join(out, 'scan.json'),
      ],
      io,
    ),
    0,
  );
  console.log(
    JSON.stringify({
      ok: true,
      sourceCommit: frame.graph.commitOid,
      scannedPythonFiles: files.length,
      ruffExitCode: scanned.exitCode,
      provenance: 'awaiting-external-attestation',
    }),
  );
}
try {
  await main();
} catch {
  // Raw scanner/process exceptions can contain source snippets, paths and SARIF.
  // Preserve local evidence, but do not leak those exceptions into CI logs.
  console.error(JSON.stringify({ ok: false, code: 'SCAN_PRODUCER_FAILED', stage }));
  process.exitCode = 1;
}
