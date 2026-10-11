#!/usr/bin/env node
/**
 * Historical analysis benchmark (plan §15.2: "12-frame historical analysis after
 * acquisition — medium <= 90 s p95"; "medium artifact compressed <= 5 MiB"). Builds the
 * deterministic medium repository of bench-analysis.mjs (3,000 files, ~30,000 imports),
 * then a 40-commit mainline evolution inside 60 days: edits, additions, pure renames,
 * rename+edit, deletions and one merge-free refactor wave. Each run analyzes the full
 * history (window walk, rename-aware diffs, 12 frames, churn, hotspots, union layout,
 * frame-delta packing) with a cold fact cache. Writes docs/benchmarks/phase4-history.{json,md}.
 *
 *   node scripts/bench-history.mjs [--files 3000] [--runs 20] [--commits 40] [--keep <artifact-dir>]
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : fallback;
};
const FILES = arg('files', 3000);
const RUNS = arg('runs', 20);
const COMMITS = arg('commits', 40);
const PACKAGES = 10;
const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'phase4-history';
if (!/^[a-z0-9-]+$/.test(out ?? '')) throw new Error('Report name must be lowercase letters, digits and hyphens');
if (!Number.isInteger(RUNS) || RUNS < 1 || RUNS > 100) throw new Error('Runs must be 1..100');
const tier = FILES > 3000 ? 'large' : 'medium';
const diagnosticOnly = process.argv.includes('--diagnostic-once');

const pathArg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  if (!process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw new Error(`Missing --${name} path`);
  return path.resolve(process.argv[i + 1]);
};
const fixturePath = pathArg('fixture');
const runtimeRoot = pathArg('runtime-root');
const runtimeRequire = runtimeRoot ? createRequire(path.join(runtimeRoot, 'package.json')) : null;
const imp = (p) => import(pathToFileURL(runtimeRequire
  ? runtimeRequire.resolve(`@atlas/${p.split('/')[1]}${p.endsWith('node-entry.js') ? '/node' : ''}`)
  : path.join(root, p)).href);
const resourceLimits = process.argv.includes('--require-container-limits') ? {
  memoryBytes: Number(readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim()),
  cpuMax: readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim(),
} : null;
if (resourceLimits) {
  const [quota, period] = resourceLimits.cpuMax.split(/\s+/).map(Number);
  if (resourceLimits.memoryBytes !== 2 * 1024 ** 3 || quota / period !== 4) throw new Error('Capacity container must enforce exactly 4 CPUs and 2 GiB total memory');
}
const resourceUsage = () => resourceLimits ? {
  peakBytes: Number(readFileSync('/sys/fs/cgroup/memory.peak', 'utf8').trim()),
  events: Object.fromEntries(readFileSync('/sys/fs/cgroup/memory.events', 'utf8').trim().split('\n').map((line) => {
    const [key, value] = line.trim().split(/\s+/);
    return [key, Number(value)];
  })),
} : null;
const { openLocalRepository, resolveLocalCommit, gitVersion } = await imp('packages/ingest/dist/index.js');
const { analyzeCommit, ParserPool, MemoryFactCache } = await imp('packages/analyzer-core/dist/index.js');
const { gzipDeterministic, writeArtifactDirectory } = await imp('packages/artifact/dist/node-entry.js');
const { localRepositoryId } = await imp('packages/schema/dist/index.js');

let fixture;
if (fixturePath) {
  console.error(`Reading prepared fixture at ${fixturePath}…`);
  fixture = { dir: fixturePath, dispose() {} }; // Caller owns it; never delete it.
} else {
  const { buildMediumHistoryCommits } = await import(pathToFileURL(path.join(root, 'scripts/lib/medium-history.mjs')).href);
  const { commits, baseFiles } = buildMediumHistoryCommits({ files: FILES, commits: COMMITS, packages: PACKAGES });
  console.error(`Building ${baseFiles} files and ${COMMITS} commits…`);
  const { createGitFixture } = await imp('packages/test-fixtures/dist/index.js');
  fixture = createGitFixture(commits);
}
const { repo, git } = await openLocalRepository(fixture.dir);
const head = await resolveLocalCommit(repo, git);
const version = await gitVersion();
const pool = new ParserPool({ workers: 2 });
const timings = [];
const completeness = [];
let last;
let warmupMs;
try {
  for (let runIndex = 0; runIndex < (diagnosticOnly ? 1 : RUNS + 1); runIndex++) {
    // A production sandbox owns one dataset. Do not retain the preceding result
    // throughout the next cold analysis just to publish the final sample later.
    last = undefined;
    const started = performance.now();
    const result = await analyzeCommit({
      git,
      commitOid: head,
      gitVersion: version,
      repository: { repoId: localRepositoryId('3f2a9c4e-8b1d-4f6a-9c2e-7d5b1a0e4c3f'), displayName: 'bench', sourceKind: 'local-git', remote: null, objectFormat: repo.objectFormat },
      pool,
      factCache: new MemoryFactCache(),
      transport: gzipDeterministic,
      onProgress: (event) => {
        if (event.stage === 'layout' || event.stage === 'assemble')
          console.error(`  run ${runIndex}: ${event.stage}`);
        if (event.stage === 'frames' && event.done !== undefined)
          console.error(`  run ${runIndex}: historical frames ${event.done}/${event.total}`);
      },
    });
    const elapsed = performance.now() - started;
    if (runIndex === 0) warmupMs = elapsed;
    const coverage = result.packed.manifest.coverage;
    const complete = result.status === 'complete' && coverage.history.status === 'complete' && coverage.history.framesCompleted === 12;
    if (runIndex > 0) {
      timings.push(elapsed);
      completeness.push({ complete, status: result.status, frames: coverage.history.framesCompleted, historyStatus: coverage.history.status });
    }
    last = result;
    console.error(`  run ${runIndex}${runIndex === 0 ? ' (warm-up)' : ''}: ${(elapsed / 1000).toFixed(2)} s`);
  }
  // --keep <dir>: also publish the last artifact (input for apps/web/scripts/bench-history-viewer.mjs).
  const keep = process.argv.indexOf('--keep');
  if (keep > -1) await writeArtifactDirectory(last.packed, path.resolve(process.argv[keep + 1]), { replace: true });
} finally {
  await pool.close();
  await git.dispose();
  fixture.dispose();
}

if (diagnosticOnly) {
  console.log(JSON.stringify({ diagnosticOnly: true, warmupMs, status: last.status, frames: last.packed.manifest.frames.length, nodeFlags: process.execArgv, resourceLimits, resourceUsage: resourceUsage(), memoryAfter: process.memoryUsage() }));
  process.exit(0);
}

const sorted = [...timings].sort((a, b) => a - b);
const pct = (p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
const m = last.packed.manifest;
const h = m.coverage.history;
const chunk = (prefix) => m.chunks.filter((c) => c.path.startsWith(prefix)).reduce((a, c) => a + c.compressedBytes, 0);
const report = {
  task: `Historical analysis capacity — ${tier}, 12 frames`,
  recordedAt: new Date().toISOString(),
  environment: { os: `${os.type()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model, cpuCount: os.cpus().length, memoryGiB: +(os.totalmem() / 2 ** 30).toFixed(1), node: process.version, nodeFlags: process.execArgv.join(' '), git: version, parserWorkers: 2, containerLimits: resourceLimits, runtimeImage: process.env.ATLAS_CAPACITY_IMAGE ?? null, sourceCommit: process.env.ATLAS_CAPACITY_SOURCE_COMMIT ?? null, benchmarkSourceCommit: process.env.ATLAS_CAPACITY_BENCHMARK_COMMIT ?? null, benchmarkWorkingTreeDirty: process.env.ATLAS_CAPACITY_BENCHMARK_DIRTY ?? null },
  fixture: {
    headFiles: m.coverage.head.includedFiles,
    importStatements: m.coverage.head.observedImports,
    commits: h.commitsTraversed,
    frames: h.framesCompleted,
    boundary: h.boundary,
    renames: last.summary.history.renames,
    lineages: last.summary.history.lineages,
    historyStatus: h.status,
  },
  runs: timings.length,
  rawSampleMs: timings,
  sampleCompleteness: completeness,
  analyzer: m.analyzer,
  selectedCommit: m.selectedCommit.oid,
  layoutId: last.draft.layout.layoutId,
  resourceUsage: resourceUsage(),
  secondsP50: +(pct(0.5) / 1000).toFixed(2),
  secondsP95: +(pct(0.95) / 1000).toFixed(2),
  secondsMax: +(sorted.at(-1) / 1000).toFixed(2),
  budgetSecondsP95: tier === 'large' ? 240 : 90,
  artifact: {
    version: m.artifactVersion,
    compressedBytes: m.chunks.reduce((a, c) => a + c.compressedBytes, 0),
    headGraphBytes: m.frames.at(-1).graphChunk.compressedBytes,
    historicalGraphBytes: chunk('graphs/') - m.frames.at(-1).graphChunk.compressedBytes,
    historyBytes: chunk('history/'),
    layoutBytes: chunk('layout/'),
    budgetBytes: (tier === 'large' ? 20 : 5) * 1024 * 1024,
  },
};
report.timePass = report.secondsP95 <= report.budgetSecondsP95;
report.sizePass = report.artifact.compressedBytes <= report.artifact.budgetBytes;
report.completenessPass = completeness.every((sample) => sample.complete);
report.sampleCountPass = timings.length >= 20;
report.resourcePass = report.resourceUsage ? (report.resourceUsage.peakBytes <= resourceLimits.memoryBytes && report.resourceUsage.events.oom === 0 && report.resourceUsage.events.oom_kill === 0) : null;
report.pass = report.timePass && report.sizePass && report.completenessPass && (report.resourcePass ?? true) && report.sampleCountPass;
const outDir = pathArg('report-dir') ?? path.join(root, 'docs/benchmarks');
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, `${out}.json`), `${JSON.stringify(report, null, 2)}\n`);
const mib = (b) => `${(b / 1024 / 1024).toFixed(2)} MiB`;
writeFileSync(
  path.join(outDir, `${out}.md`),
  [
    `# ${report.task} (plan §15.2)`,
    '',
    `Recorded ${report.recordedAt} by \`node scripts/bench-history.mjs\`. ${report.runs} measured runs after one warm-up; every run uses a cold fact cache and performs the whole pipeline: first-parent walk, rename-aware diffs, 12 frame graphs, churn, hotspots, union layout and frame-delta packing within the export limits.`,
    '',
    '## Environment',
    '',
    ...Object.entries(report.environment).map(([k, v]) => `- **${k}:** ${typeof v === 'object' ? JSON.stringify(v) : v}`),
    '',
    `## Fixture (synthetic "${tier}" with history, deterministic)`,
    '',
    `- HEAD: ${report.fixture.headFiles.toLocaleString('en-US')} files, ${report.fixture.importStatements.toLocaleString('en-US')} import statements`,
    `- History: ${report.fixture.commits} mainline commits over 58.5 days (${report.fixture.boundary} boundary), ${report.fixture.frames} analyzed frames, ${report.fixture.renames} renames, ${report.fixture.lineages.toLocaleString('en-US')} lineages; status ${report.fixture.historyStatus}`,
    '',
    '## Result',
    '',
    '| Measure | Value | Budget |',
    '|---|---:|---:|',
    `| p50 | ${report.secondsP50} s | |`,
    `| p95 | ${report.secondsP95} s | ≤ ${report.budgetSecondsP95} s |`,
    `| max | ${report.secondsMax} s | |`,
    `| artifact (all chunks) | ${mib(report.artifact.compressedBytes)} | ≤ ${mib(report.artifact.budgetBytes)} |`,
    ...(report.resourceUsage ? [`| whole-job cgroup peak | ${mib(report.resourceUsage.peakBytes)} | ≤ ${mib(resourceLimits.memoryBytes)} |`] : []),
    `| — selected graph | ${mib(report.artifact.headGraphBytes)} | |`,
    `| — 11 historical frames (deltas) | ${mib(report.artifact.historicalGraphBytes)} | |`,
    `| — history / layout | ${mib(report.artifact.historyBytes)} / ${mib(report.artifact.layoutBytes)} | |`,
    '',
    `**${report.pass ? 'Pass' : 'Fail'}.** Time: ${report.timePass ? 'pass' : 'fail'}; size: ${report.sizePass ? 'pass' : 'fail'}; all measured runs complete with 12 frames: ${report.completenessPass ? 'pass' : 'fail'}; twenty-sample minimum: ${report.sampleCountPass ? 'pass' : 'fail'}; resource gate: ${report.resourceUsage ? `${report.resourcePass ? 'pass' : 'fail'} (events ${JSON.stringify(report.resourceUsage.events)})` : 'unmeasured; no whole-job/reference-resource pass is claimed'}. Format ${report.artifact.version}; frame-delta transport per ADR-026.`,
    '',
  ].join('\n'),
);
console.log(JSON.stringify(report, null, 2));
if (!report.pass) process.exitCode = 1;
