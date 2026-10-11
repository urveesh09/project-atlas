#!/usr/bin/env node
/** P6.1: pinned acquisition, offline analysis, independent source checks, exact repeat hashes.
 * Acquire once with --acquire; reruns without it have no network path.
 * Artifacts/sources live under the ignored .atlas-tmp/release-corpus; only reports are tracked.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpus = JSON.parse(await readFile(path.join(root, 'docs/release/repository-corpus.json'), 'utf8'));
const state = path.join(root, '.atlas-tmp/release-corpus');
await mkdir(state, { recursive: true });
const load = (name, entry = 'index.js') => import(pathToFileURL(path.join(root, 'packages', name, 'dist', entry)).href);
const { acquireGithubCommit, SafeGit, gitVersion, listTree, readObjects } = await load('ingest');
const { analyzeCommit, ANALYZER_VERSION } = await load('analyzer-core');
const { gzipDeterministic, writeArtifactDirectory, verifyArtifactDirectory } = await load('artifact', 'node-entry.js');
const { hostedRepositoryId, canonicalJsonSha256, LIMITS } = await load('schema');
const version = await gitVersion();
const acquire = process.argv.includes('--acquire');
const inspect = process.argv.indexOf('--source');
const countIndex = process.argv.indexOf('--runs');
const runs = countIndex < 0 ? 5 : Number(process.argv[countIndex + 1]);
assert(Number.isInteger(runs) && runs >= 5 && runs <= 20, 'Use 5..20 measured repeats');
const report = {
  task: 'P6.1 pinned public repository validation', recordedAt: new Date().toISOString(),
  analyzerVersion: ANALYZER_VERSION, runs,
  environment: { os: `${os.type()} ${os.release()} ${os.arch()}`, node: process.version, git: version, cpu: os.cpus()[0]?.model, memoryGiB: os.totalmem() / 2 ** 30 },
  method: 'Unfiltered depth-201 acquisition capped at 256 MiB; offline SafeGit reads; cold parser facts per repeat; canonical and compressed chunk hashes include every frame. Envelope IDs/time excluded. Authored examples check facts, repeat hashes check determinism only. Timings are corpus observations, not the synthetic capacity gate.',
  repositories: [],
};
for (const repo of corpus.repositories) {
  const key = `${repo.owner}-${repo.name}`;
  const dir = path.join(state, key);
  const objectDirectory = path.join(dir, 'git/meta.git/objects');
  if (acquire) {
    console.log(`Acquire ${repo.owner}/${repo.name}@${repo.commit}`);
    const acquired = await acquireGithubCommit(repo, repo.commit, { scratchDir: path.join(dir, 'git'), depth: 201, filter: 'none', maxBytes: LIMITS.acquisitionNetworkBytes, timeoutMs: 120_000 });
    // The owned acquisition directory is intentionally retained for subsequent offline validation.
    console.log(`Stored ${(acquired.bytesOnDisk / 2 ** 20).toFixed(2)} MiB`);
    continue;
  }
  await access(objectDirectory).catch(() => { throw new Error(`${key}: run with --acquire before offline validation`); });
  const git = await SafeGit.create({ objectDirectory, objectFormat: 'sha1', network: { kind: 'offline' } });
  try {
    if (inspect >= 0) {
      if (process.argv[inspect + 1] !== key) continue;
      const listing = await listTree(git, repo.commit, { maxEntries: LIMITS.treeEntriesPerSnapshot });
      for (const name of process.argv.slice(inspect + 2)) {
        if (name.endsWith('/')) {
          console.log(JSON.stringify(listing.entries.filter((e) => e.path?.startsWith(name)).map((e) => e.path)));
          continue;
        }
        const entry = listing.entries.find((e) => e.path === name);
        assert(entry && entry.kind === 'blob' && entry.size < 100_000, `No bounded blob: ${name}`);
        const objects = await readObjects(git, [{ oid: entry.oid, size: entry.size }]);
        console.log(JSON.stringify({ repository: key, path: name, oid: entry.oid, text: objects.get(entry.oid).bytes.toString('utf8').split('\n').slice(0, 80).join('\n') }));
      }
      continue;
    }
    assert(repo.checks.files.length > 0 && repo.checks.imports.length > 0, `${key}: independent checks must be authored before analysis`);
    const samples = [];
    let baseline, final;
    for (let i = 0; i < runs; i++) {
      const start = performance.now();
      const result = await analyzeCommit({
        git, commitOid: repo.commit, gitVersion: version,
        repository: { repoId: hostedRepositoryId(repo.numericId), displayName: `${repo.owner}/${repo.name}`, sourceKind: 'public-github', remote: { host: 'github.com', owner: repo.owner, name: repo.name, numericId: repo.numericId }, objectFormat: 'sha1' },
        transport: gzipDeterministic,
      });
      const packed = result.packed;
      assert(packed, 'Missing packed result');
      const fingerprint = packed.manifest.chunks.map((c) => ({ path: c.path, sha256: c.sha256, encodedSha256: c.encodedSha256 ?? null, compressedBytes: c.compressedBytes }));
      const digest = canonicalJsonSha256(fingerprint);
      baseline ??= digest;
      assert.equal(digest, baseline, `${key}: chunk payloads changed across cold runs`);
      const head = result.draft.graphs.at(-1);
      const nodes = new Map(head.nodes.map((n) => [n.id, n]));
      const files = new Map(head.nodes.filter((n) => n.kind === 'file').map((n) => [n.path, n]));
      const checks = [];
      for (const check of repo.checks.files) {
        const file = files.get(check.path);
        assert(file, `Missing expected file ${check.path}`);
        for (const field of ['role', 'language', 'parseStatus']) if (field in check) assert.equal(file[field], check[field], `${key}/${check.path}: ${field}`);
        checks.push({ type: 'file', ...check, passed: true });
      }
      for (const check of repo.checks.imports) {
        const matches = head.importObservations.filter((o) => nodes.get(o.sourceId)?.path === check.source && o.specifier === check.specifier && o.kind === check.kind);
        assert(matches.length > 0, `Missing observation ${check.source}: ${check.specifier}`);
        for (const match of matches) {
          const target = nodes.get(match.targetId);
          const key = target?.kind === 'file' ? target.path : target?.kind === 'external-package' ? target.packageName : target?.kind === 'builtin' ? target.moduleName : null;
          assert.equal(match.status, check.status, `${check.source}: ${check.specifier}: status`);
          assert.equal(key, check.target, `${check.source}: ${check.specifier}: target`);
        }
        checks.push({ type: 'import', ...check, passed: true });
      }
      samples.push(performance.now() - start);
      final = { result, packed, checks };
      console.log(`${key}: repeat ${i + 1}/${runs}, ${(samples.at(-1) / 1000).toFixed(2)} s, ${result.status}`);
    }
    const artifact = path.join(dir, 'artifact');
    await writeArtifactDirectory(final.packed, artifact, { replace: true });
    const verified = await verifyArtifactDirectory(artifact);
    assert(verified.ok, `${key}: exported artifact failed independent load/validation`);
    const head = final.result.draft.graphs.at(-1);
    const byId = new Map(head.nodes.map((n) => [n.id, n]));
    const reasons = {};
    const examples = {};
    for (const observation of head.importObservations) {
      if (['resolved-internal', 'resolved-external', 'builtin'].includes(observation.status)) continue;
      const reason = `${observation.status}:${observation.reasonCode ?? 'NONE'}`;
      reasons[reason] = (reasons[reason] ?? 0) + 1;
      (examples[reason] ??= []).length < 3 && examples[reason].push({ source: byId.get(observation.sourceId)?.path, specifier: observation.specifier, kind: observation.kind });
    }
    report.repositories.push({
      ...repo, checks: final.checks, artifactPath: path.relative(root, artifact).replaceAll('\\', '/'),
      analysisStatus: final.result.status, coverage: final.result.summary, reasons, examples,
      parseFailures: head.nodes.filter((node) => node.kind === 'file' && node.parseStatus === 'failed').map((node) => node.path),
      digest: baseline, chunks: final.packed.manifest.chunks, milliseconds: samples,
      compressedBytes: verified.summary.stats.compressedBytes, exportVerified: true, deterministic: true,
    });
  } finally { await git.dispose(); }
}
if (acquire || inspect >= 0) process.exit(0);
const out = path.join(root, 'docs/release');
await writeFile(path.join(out, 'real-repositories.json'), `${JSON.stringify(report, null, 2)}\n`);
const lines = ['# P6.1: pinned real-repository validation', '', `Recorded ${report.recordedAt}; analyzer ${ANALYZER_VERSION}, ${runs} cold repeats per repository.`, '', report.method, '', 'Artifacts are retained locally under the ignored `.atlas-tmp/release-corpus/`. Recreate them with the commands below; source is never tracked or exported. A source-free artifact still exposes paths, declarations and relationships, so any onward sharing is explicit.', '', '| Repository / category | Pinned commit | Files supported/included | Imports internal/external/builtin/unresolved/unsupported/excluded | Status | Size MiB | Checks |', '|---|---|---|---|---|---|---|'];
lines.splice(7, 0, 'Resolution follows TypeScript compiler lookup, including declaration-file substitution: `test.js` → `./index.js` in is-plain-obj resolves to committed `index.d.ts` ahead of `index.js`. This is a compiler dependency graph. The initial source-based expectation of `index.js` failed; rereading plan §9.2 and the [TypeScript extension-substitution contract](https://www.typescriptlang.org/docs/handbook/modules/reference.html#file-extension-substitution) explained the discrepancy. The expectation was corrected to that independently documented contract before acceptance repeats. Root `test.js` does not match conventional test-role patterns, so it retains the source role; role heuristics do not infer repository test-script meaning.', '');
for (const item of report.repositories) {
  const s = item.coverage;
  lines.push(`| [${item.owner}/${item.name}](https://github.com/${item.owner}/${item.name}/tree/${item.commit}) (${item.category}) | \`${item.commit}\` | ${s.files.supported}/${s.files.included} | ${['internal', 'external', 'builtin', 'unresolved', 'unsupported', 'excludedTargets'].map((k) => s.imports[k]).join('/')} | ${item.analysisStatus} | ${(item.compressedBytes / 2 ** 20).toFixed(2)} | ${item.checks.length} |`);
}
lines.push('', '## Independent source examples and limitations', '');
for (const item of report.repositories) {
  lines.push(`### ${item.owner}/${item.name}`, '', `Canonical/wire chunk digest: \`${item.digest}\`. All ${runs} repeats and exported streaming validation passed.`, '');
  for (const check of item.checks) lines.push(check.type === 'file' ? `- \`${check.path}\`: ${check.role}, ${check.language}, ${check.parseStatus}.` : `- \`${check.source}\` → \`${check.specifier}\` (${check.kind}): ${check.status} → \`${check.target}\`.`);
  lines.push('', `HEAD parsing: ${item.coverage.parse.parsed} parsed, ${item.coverage.parse.failed} failed. ${item.parseFailures.length ? `Failed paths: ${item.parseFailures.map((name) => `\`${name}\``).join(', ')}.` : 'No parse failures.'}`);
  lines.push('', 'Unresolved/unsupported/excluded categories (all counts and representative observations are in the JSON):', '');
  for (const [reason, count] of Object.entries(item.reasons)) lines.push(`- ${reason}: ${count}; e.g. ${item.examples[reason].map((e) => `\`${e.source}\` → \`${e.specifier ?? '(nonliteral)'}\``).join(', ')}.`);
  if (Object.keys(item.reasons).length === 0) lines.push('- None observed in this bounded corpus.');
  lines.push('', `History: ${item.coverage.history.status}, ${item.coverage.history.commits} commits, ${item.coverage.history.frames.completed} frames; boundary ${item.coverage.history.boundary}.`, '');
}
lines.push('## Reproduce', '', '```sh', 'pnpm install --frozen-lockfile && pnpm build', 'node scripts/validate-real-repositories.mjs --acquire # explicit network acquisition only', 'node scripts/validate-real-repositories.mjs           # five fully offline cold repeats', '```', '', 'Expected examples in `repository-corpus.json` were authored by reading pinned committed blobs before running the analyzer. They are not analyzer-generated correctness goldens. Counts describe this empirical corpus; external package resolution does not prove installed dependency contents exist, and framework transforms/nonliteral imports remain limitations. This report does not complete human usability, assistive-technology, integrated-GPU or public-infrastructure release gates.', '');
await writeFile(path.join(out, 'real-repositories.md'), lines.join('\n'));
