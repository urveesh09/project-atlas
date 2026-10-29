#!/usr/bin/env node
/** Extract a locally built candidate away from the checkout and prove offline usability. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, readdir, lstat, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { buildDemoRepository, createGitFixture } from '../packages/test-fixtures/dist/index.js';
import { killProcessTree } from '../packages/ingest/dist/index.js';
import { openArtifactDirectory } from '../packages/artifact/dist/node.js';
import { parseFindingReview } from '../packages/graph/dist/index.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = JSON.parse(await readFile(process.argv[2], 'utf8'));
assert.equal(createHash('sha256').update(await readFile(result.archive)).digest('hex'), result.sha256, 'Archive digest mismatch');
const work = await mkdtemp(path.join(os.tmpdir(), 'atlas-cli-install-'));
let demo, qualityRepo, reviewRepo, server, browser;
const stages = [];
const env = { PATH: process.env.PATH ?? '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), NO_COLOR: '1' };
try {
  // Only our generated, hash-matched candidate archives are inputs to this harness.
  execFileSync('tar', ['-xzf', result.archive, '-C', work], { windowsHide: true });
  const bundle = path.join(work, 'atlas-cli');
  const manifest = JSON.parse(await readFile(path.join(bundle, 'distribution.json'), 'utf8'));
  const expected = new Map(manifest.files.map((f) => [f.path, f]));
  let checked = 0;
  async function verify(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      assert(!(await lstat(full)).isSymbolicLink(), 'Extracted package contains a symlink');
      if (entry.isDirectory()) await verify(full);
      else {
        const relative = path.relative(bundle, full).replaceAll('\\', '/');
        if (relative === 'distribution.json') continue;
        const ref = expected.get(relative);
        assert(ref, `Unlisted distribution file: ${relative}`);
        const bytes = await readFile(full);
        assert.equal(bytes.length, ref.bytes);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), ref.sha256, `Changed file: ${relative}`);
        checked++;
      }
    }
  }
  await verify(bundle);
  assert.equal(checked, expected.size);
  let documentationLinks = 0;
  for (const file of ['README.md', 'docs/cli.md', 'docs/capabilities.md', 'docs/metrics.md']) {
    const full = path.join(bundle, file);
    for (const match of (await readFile(full, 'utf8')).matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1];
      if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) {
        if (target.startsWith('https://github.com/urveesh09/project-atlas/blob/')) assert(target.startsWith(`https://github.com/urveesh09/project-atlas/blob/${manifest.sourceCommit}/`));
      } else {
        const local = path.resolve(path.dirname(full), decodeURIComponent(target.split('#')[0]));
        assert(local.startsWith(bundle + path.sep), `Documentation link leaves the archive: ${file}`);
        await access(local);
      }
      documentationLinks++;
    }
  }
  stages.push({ stage: 'relocated-extraction-and-integrity', files: checked, documentationLinks, passed: true });
  // Deny every outbound client socket in the CLI entry process. Browser requests are
  // checked independently below; parser-child resolver isolation has its own gate.
  const guard = path.join(work, 'offline-guard.cjs');
  await writeFile(guard, `const net=require('node:net');const connect=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...args){const o=args[0];const host=typeof o==='object'?o.host:(typeof args[1]==='string'?args[1]:'localhost');if(host!=='127.0.0.1'&&host!=='::1'&&host!=='localhost')throw new Error('OFFLINE_SOCKET_DENIED');return connect.apply(this,args)};`);
  const bin = path.join(bundle, 'bin/atlas.js');
  const cli = (args, expectedExit = 0) => {
    const started = performance.now();
    let output;
    try {
      output = execFileSync(process.execPath, ['--require', guard, bin, ...args], { cwd: work, env, encoding: 'utf8', windowsHide: true, timeout: 300_000, maxBuffer: 2 * 1024 * 1024 });
      assert.equal(expectedExit, 0, 'Expected the documented partial exit, not success');
    } catch (error) {
      // Only the explicit unsigned-review case below accepts its documented partial
      // status. A native failure, missing output, or any other command still fails.
      if (args[0] !== 'review-findings' || expectedExit !== 2 || error.status !== 2) throw error;
      output = error.stdout;
    }
    stages.push({ stage: args[0], elapsedMs: performance.now() - started, ...(expectedExit ? { expectedExit } : {}), passed: true });
    return output;
  };
  cli(['doctor']);
  // An authored Python fixture exercises the new command from the relocated archive,
  // with no scanner executable, repository dependency install or outbound socket.
  qualityRepo = createGitFixture([{ date: '2026-10-01T00:00:00Z', message: 'authored lint fixture', files: { 'sample.py': 'import os\n' } }], { parent: work });
  const qualityArtifact = path.join(work, 'quality-artifact');
  cli(['analyze', qualityRepo.dir, '--out', qualityArtifact, '--no-history', '--json']);
  const qualityManifestBytes = await readFile(path.join(qualityArtifact, 'manifest.json'));
  const qualityManifest = JSON.parse(qualityManifestBytes.toString('utf8'));
  const sarif = path.join(work, 'ruff.sarif');
  await writeFile(sarif, JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'ruff', version: '0.17.3' } }, results: [{ ruleId: 'F401', level: 'warning', message: { text: 'SOURCE_SENTINEL' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'sample.py' }, region: { startLine: 1, startColumn: 8 } } }] }] }] }));
  const qualityOut = path.join(work, 'quality.json');
  const qualityResult = JSON.parse(cli(['findings', sarif, '--artifact', qualityArtifact, '--commit', qualityManifest.selectedCommit.oid, '--out', qualityOut, '--json']));
  assert.equal(qualityResult.findings, 1);
  assert.equal(qualityResult.binding, 'user-declared');
  assert.equal(qualityResult.scanScope, 'unverified');
  const qualityBytes = await readFile(qualityOut, 'utf8');
  assert(!qualityBytes.includes('SOURCE_SENTINEL'));
  assert.equal(JSON.parse(qualityBytes).findings[0].ruleId, 'F401');
  assert.deepEqual(await readFile(path.join(qualityArtifact, 'manifest.json')), qualityManifestBytes);
  const openedQuality = await openArtifactDirectory(qualityArtifact);
  assert(openedQuality.ok);
  const qualityFrame = await openedQuality.artifact.frame(0);
  assert(qualityFrame.ok);
  const scope = qualityFrame.graph.nodes.flatMap((n) => n.kind === 'file' && n.path === 'sample.py' ? [{ path: n.path, blobOid: n.blobOid }] : []);
  const profilePath = path.join(work, 'profile.json'), scopePath = path.join(work, 'scope.json'), scanPath = path.join(work, 'scan.json');
  await writeFile(profilePath, JSON.stringify({ format: 'atlas.ruff-profile/1', isolated: true, ignoreNoqa: true, respectGitignore: false, forceExclude: false, targetVersion: 'py314', rules: ['F401'] }));
  await writeFile(scopePath, JSON.stringify({ format: 'atlas.scan-scope/1', files: scope }));
  const scan = JSON.parse(cli(['scan-evidence', qualityOut, '--artifact', qualityArtifact, '--profile', profilePath, '--scope', scopePath, '--exit-code', '1', '--out', scanPath, '--json']));
  assert.equal(scan.provenance, 'unverified');
  assert.equal(scan.scopeMatchesAnalysis, true);
  assert(!(await readFile(scanPath, 'utf8')).includes('SOURCE_SENTINEL'));
  // Two scan declarations in ONE history artifact; the package must preserve
  // a unique code context across shifted lines without invoking any scanner.
  const reviewSource = 'a = 1\nb = 2\nprint(missing)\nc = 3\nd = 4\n';
  reviewRepo = createGitFixture([
    { date: '2026-10-01T00:00:00Z', message: 'baseline lint context', files: { 'sample.py': reviewSource } },
    { date: '2026-10-02T00:00:00Z', message: 'shift context', files: { 'sample.py': '# prefix a\n# prefix b\n# prefix c\n' + reviewSource } },
  ], { parent: work });
  const reviewArtifact = path.join(work, 'review-artifact');
  cli(['analyze', reviewRepo.dir, '--out', reviewArtifact, '--snapshots', '2', '--json']);
  const reviewed = await openArtifactDirectory(reviewArtifact);
  assert(reviewed.ok);
  for (let i = 0; i < 2; i++) {
    const frame = await reviewed.artifact.frame(i); assert(frame.ok);
    const report = path.join(work, `review-${i}.sarif`), quality = path.join(work, `review-${i}.quality.json`);
    await writeFile(report, JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'ruff', version: '0.17.3' } }, results: [{ ruleId: 'F821', locations: [{ physicalLocation: { artifactLocation: { uri: 'sample.py' }, region: { startLine: i === 0 ? 3 : 6, startColumn: 7 } } }] }] }] }));
    cli(['findings', report, '--artifact', reviewArtifact, '--commit', frame.graph.commitOid, '--out', quality, '--json']);
    const sourceFile = frame.graph.nodes.find((n) => n.kind === 'file' && n.path === 'sample.py'); assert(sourceFile?.kind === 'file');
    await writeFile(profilePath, JSON.stringify({ format: 'atlas.ruff-profile/1', isolated: true, ignoreNoqa: true, respectGitignore: false, forceExclude: false, targetVersion: 'py314', rules: ['F821'] }));
    await writeFile(scopePath, JSON.stringify({ format: 'atlas.scan-scope/1', files: [{ path: sourceFile.path, blobOid: sourceFile.blobOid }] }));
    cli(['scan-evidence', quality, '--artifact', reviewArtifact, '--profile', profilePath, '--scope', scopePath, '--exit-code', '1', '--out', path.join(work, `review-${i}.scan.json`), '--json']);
  }
  const reviewOutput = path.join(work, 'finding-review.json');
  const resultReview = JSON.parse(cli(['review-findings', path.join(work, 'review-1.scan.json'), '--baseline', path.join(work, 'review-0.scan.json'), '--artifact', reviewArtifact, '--repo', reviewRepo.dir, '--out', reviewOutput, '--json'], 2));
  assert.equal(resultReview.provenanceVerifiedInThisProcess, false);
  assert.equal(resultReview.counts.continuing, 1);
  const reviewText = await readFile(reviewOutput, 'utf8');
  assert(!reviewText.includes('print(missing)'));
  assert.equal(parseFindingReview(reviewText).issues[0].state, 'continuing');
  demo = buildDemoRepository({ parent: work });
  const artifact = path.join(work, 'artifact');
  cli(['analyze', demo.dir, '--out', artifact, '--json']);
  cli(['verify', artifact]);
  cli(['inspect', artifact, '--json']);
  const analyzed = JSON.parse(await readFile(path.join(artifact, 'manifest.json'), 'utf8'));
  assert.equal(analyzed.frames.length, 12);
  assert.equal(analyzed.coverage.head.includedFiles, 26);
  server = spawn(process.execPath, ['--require', guard, bin, 'serve', artifact, '--repo', demo.dir, '--no-open', '--json'], { cwd: work, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.resume();
  const serving = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Packaged server did not start')), 60_000);
    server.on('error', (error) => { clearTimeout(timer); reject(error); });
    server.on('exit', () => { clearTimeout(timer); reject(new Error('Packaged server exited before ready')); });
    server.stdout.on('data', (bytes) => {
      output += bytes.toString('utf8');
      const end = output.indexOf('\n');
      if (end < 0) return;
      clearTimeout(timer);
      resolve(JSON.parse(output.slice(0, end)));
    });
  });
  const require = createRequire(path.join(root, 'packages/cli/package.json'));
  const { chromium } = require('playwright');
  browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  const outbound = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    if (new URL(route.request().url()).origin === new URL(serving.url).origin) return route.continue();
    outbound.push(new URL(route.request().url()).origin);
    return route.abort();
  });
  await page.goto(serving.sessionUrl);
  await page.locator('.timeline-strip').waitFor({ timeout: 60_000 });
  assert.equal(await page.locator('.timeline-frame').count(), 12);
  await page.keyboard.press('/');
  await page.keyboard.type('pricing');
  await page.locator('[role="option"][aria-selected="true"]').waitFor();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#inspector-title')?.textContent === 'pricing.ts');
  await page.getByRole('tab', { name: 'Dependencies', exact: true }).click();
  assert((await page.locator('[role="tabpanel"]').innerText()).includes('packages/ledger/src/index.ts'));
  const screenshot = path.join(root, 'docs/images/phase6-packaged-city.png');
  await mkdir(path.dirname(screenshot), { recursive: true });
  await page.screenshot({ path: screenshot });
  assert.deepEqual(outbound, []);
  assert.deepEqual(errors, []);
  stages.push({ stage: 'packaged-browser-city-history-search-and-dependencies', passed: true, outboundRequests: 0, pageErrors: 0, browser: browser.version(), renderer: 'SwiftShader; functional only' });
  const report = { task: 'P6 distribution candidate fresh-install smoke', recordedAt: new Date().toISOString(), os: `${os.type()} ${os.release()} ${os.arch()}`, node: process.version, archiveSha256: result.sha256, archiveBytes: result.archiveBytes, sourceCommit: result.sourceCommit, workingTreeDirty: result.workingTreeDirty, stages, pass: true, limits: ['Candidate only; human and reference-hardware audits remain open.', 'The CLI entry process denies outbound sockets. Existing instrumented resolver and offline analyzer-container gates independently cover parsing/analysis.', 'Archive bytes and every extracted file are verified; this is integrity evidence, not a release signature.'] };
  await writeFile(path.join(root, 'docs/release/distribution-smoke.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(root, 'docs/release/distribution-smoke.md'), ['# CLI distribution candidate: fresh-install smoke', '', `Recorded ${report.recordedAt} on ${report.os}, Node ${report.node}.`, '', `Archive: ${report.archiveBytes} bytes; SHA-256 \`${report.archiveSha256}\`. Source commit \`${report.sourceCommit}\`; working tree dirty: ${report.workingTreeDirty}. This candidate is not a signed-off release.`, '', 'Extracted into a fresh temporary directory outside the checkout, verified every distributed file, and ran without a package manager or any dependency install. CLI entry-process outbound sockets were denied. The browser accepted only the loopback server origin.', '', ...stages.map((s) => `- ${s.stage}: passed${s.files ? ` (${s.files} files)` : ''}${s.elapsedMs ? ` (${(s.elapsedMs / 1000).toFixed(2)} s)` : ''}.`), '', 'The authored Harbor repository yielded all 12 frames and 26 HEAD files. The bundled viewer opened that artifact, searched with the keyboard and showed its independently checked ledger dependency. Zero page errors or browser outbound requests. Software rendering validates behavior; it is not a reference-GPU benchmark.', '', '![Packaged viewer, outside the checkout](../images/phase6-packaged-city.png)', '', ...report.limits, ''].join('\n'));
  console.log(JSON.stringify({ pass: true, stages: stages.length, archiveBytes: result.archiveBytes, archiveSha256: result.sha256 }));
} finally {
  await browser?.close();
  if (server?.pid && server.exitCode === null) killProcessTree(server.pid);
  demo?.dispose();
  qualityRepo?.dispose();
  reviewRepo?.dispose();
  // The only recursive removal is this harness's own fresh directory under OS temp.
  assert(path.dirname(work) === path.resolve(os.tmpdir()) && path.basename(work).startsWith('atlas-cli-install-'));
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
