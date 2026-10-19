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
 *   node scripts/bench-history.mjs --fixture <prepared> --isolate-runs ...   (one process per run)
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PYTHON_CAPACITY_POLICY, capacityLanguage } from './lib/capacity-language.mjs';
import { observeParserMemory } from './lib/parser-memory.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : fallback;
};
const FILES = arg('files', 3000);
const RUNS = arg('runs', 20);
const COMMITS = arg('commits', 40);
const PACKAGES = 10;
const headOnly = process.argv.includes('--head');
const languageAt = process.argv.indexOf('--language');
const language = capacityLanguage(languageAt < 0 ? 'typescript' : process.argv[languageAt + 1] ?? '');
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
const version = await gitVersion();

// --isolate-runs: like a production analysis sandbox, every run (warm-up included) is a
// fresh Node process whose analysis owns, and closes, its parser pool. The orchestrator
// only aggregates; it stays inside the same cgroup, so whole-job limits, peak memory and
// OOM counters still cover every process. --child-run is that internal per-run mode.
const isolateRuns = process.argv.includes('--isolate-runs');
const childRun = process.argv.includes('--child-run');

/** What the report needs from one result, so a child process can return it as JSON. */
const factsOf = (result) => {
  const m = result.packed.manifest;
  const h = m.coverage.history;
  const chunk = (prefix) => m.chunks.filter((c) => c.path.startsWith(prefix)).reduce((a, c) => a + c.compressedBytes, 0);
  return {
    status: result.status,
    complete: result.status === 'complete' && (headOnly ? m.frames.length === 1 : h.status === 'complete' && h.framesCompleted === 12),
    fixture: { headFiles: m.coverage.head.includedFiles, importStatements: m.coverage.head.observedImports, headEdges: result.draft.graphs.at(-1).edges.length, headLimitsHit: result.draft.graphs.at(-1).coverage.limitsHit, commits: h.commitsTraversed, frames: h.framesCompleted, boundary: h.boundary, renames: result.summary.history.renames, lineages: result.summary.history.lineages, historyStatus: h.status },
    analyzer: m.analyzer,
    selectedCommit: m.selectedCommit.oid,
    layoutId: result.draft.layout.layoutId,
    parsedLanguages: Object.fromEntries(['typescript', 'javascript', 'python'].map((lang) => [lang, result.draft.graphs.at(-1).nodes.filter((node) => node.kind === 'file' && node.language === lang && node.parseStatus === 'parsed').length])),
    artifact: {
      version: m.artifactVersion,
      compressedBytes: m.chunks.reduce((a, c) => a + c.compressedBytes, 0),
      headGraphBytes: m.frames.at(-1).graphChunk.compressedBytes,
      historicalGraphBytes: chunk('graphs/') - m.frames.at(-1).graphChunk.compressedBytes,
      historyBytes: chunk('history/'),
      layoutBytes: chunk('layout/'),
    },
  };
};

const timings = [];
const completeness = [];
let lastFacts;
let warmupMs;
const record = (runIndex, elapsed, facts) => {
  if (runIndex === 0) warmupMs = elapsed;
  else {
    timings.push(elapsed);
    completeness.push({ complete: facts.complete, status: facts.status, frames: facts.fixture.frames, historyStatus: facts.fixture.historyStatus, parserMemory: facts.parserMemory });
  }
  lastFacts = facts;
  console.error(`  run ${runIndex}${runIndex === 0 ? ' (warm-up)' : ''}: ${(elapsed / 1000).toFixed(2)} s`);
};

let failedRun = null;
if (isolateRuns) {
  if (!fixturePath) throw new Error('--isolate-runs requires a prepared --fixture');
  const { spawn } = await import('node:child_process');
  const childArgs = process.argv.slice(2).filter((a) => a !== '--isolate-runs' && a !== '--diagnostic-once');
  for (let runIndex = 0; runIndex < (diagnosticOnly ? 1 : RUNS + 1); runIndex++) {
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), ...childArgs, '--child-run', '--run-index', String(runIndex)], { stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (text) => (stdout += text));
    const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
    const line = stdout.split('\n').find((l) => l.startsWith('ATLAS_SAMPLE '));
    if (exit.code !== 0 || !line) {
      // A killed or failed run is evidence, not a skipped sample: stop and report it.
      failedRun = { runIndex, code: exit.code, signal: exit.signal };
      console.error(`  run ${runIndex}: process failed (${JSON.stringify(failedRun)})`);
      break;
    }
    const sample = JSON.parse(line.slice('ATLAS_SAMPLE '.length));
    record(runIndex, sample.elapsedMs, sample.facts);
  }
} else {
  const { analyzeCommit, ParserPool, MemoryFactCache } = await imp('packages/analyzer-core/dist/index.js');
  const memory = observeParserMemory(ParserPool);
  const { gzipDeterministic, writeArtifactDirectory } = await imp('packages/artifact/dist/node-entry.js');
  const { localRepositoryId } = await imp('packages/schema/dist/index.js');
  let fixture;
  if (fixturePath) {
    console.error(`Reading prepared fixture at ${fixturePath}…`);
    fixture = { dir: fixturePath, dispose() {} }; // Caller owns it; never delete it.
  } else {
    const { buildMediumHistoryCommits } = await import(pathToFileURL(path.join(root, 'scripts/lib/medium-history.mjs')).href);
    const { commits, baseFiles } = buildMediumHistoryCommits({ files: FILES, commits: headOnly ? 1 : COMMITS, packages: PACKAGES, language });
    console.error(`Building ${baseFiles} files and ${COMMITS} commits…`);
    const { createGitFixture } = await imp('packages/test-fixtures/dist/index.js');
    fixture = createGitFixture(commits);
  }
  const { repo, git } = await openLocalRepository(fixture.dir);
  const head = await resolveLocalCommit(repo, git);
  // A child run is one production-shaped analysis: analyzeCommit owns its parser pool.
  const pool = childRun ? undefined : new ParserPool({ workers: 2 });
  const indexArg = process.argv.indexOf('--run-index');
  const firstIndex = childRun && indexArg > -1 ? Number(process.argv[indexArg + 1]) : 0;
  let last;
  try {
    for (let runIndex = firstIndex; runIndex < (childRun ? firstIndex + 1 : diagnosticOnly ? 1 : RUNS + 1); runIndex++) {
      // A production sandbox owns one dataset. Do not retain the preceding result
      // throughout the next cold analysis just to publish the final sample later.
      last = undefined;
      const started = performance.now();
      const result = await analyzeCommit({
        git,
        commitOid: head,
        gitVersion: version,
        ...(headOnly ? { options: { history: { enabled: false } } } : {}),
        repository: { repoId: localRepositoryId('3f2a9c4e-8b1d-4f6a-9c2e-7d5b1a0e4c3f'), displayName: 'bench', sourceKind: 'local-git', remote: null, objectFormat: repo.objectFormat },
        ...(pool ? { pool } : {}),
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
      if (childRun) {
        console.log(`ATLAS_SAMPLE ${JSON.stringify({ elapsedMs: elapsed, facts: { ...factsOf(result), parserMemory: memory.finish() } })}`);
        break;
      }
      record(runIndex, elapsed, factsOf(result));
      last = result;
    }
    // --keep <dir>: also publish the last artifact (input for apps/web/scripts/bench-history-viewer.mjs).
    const keep = process.argv.indexOf('--keep');
    if (keep > -1 && last) await writeArtifactDirectory(last.packed, path.resolve(process.argv[keep + 1]), { replace: true });
  } finally {
    await pool?.close();
    if (!childRun) memory.finish();
    await git.dispose();
    fixture.dispose();
  }
  if (childRun) process.exit(0);
}

if (diagnosticOnly) {
  console.log(JSON.stringify({ diagnosticOnly: true, isolateRuns, warmupMs, failedRun, status: lastFacts?.status, frames: lastFacts?.fixture.frames, parsedLanguages: lastFacts?.parsedLanguages, parserMemory: lastFacts?.parserMemory, nodeFlags: process.execArgv, resourceLimits, resourceUsage: resourceUsage(), memoryAfter: process.memoryUsage() }));
  process.exit(failedRun ? 1 : 0);
}
if (!lastFacts) {
  // A failed warm-up is evidence too. Unknown analysis facts stay null, never zero
  // or copied from an earlier successful report. The wrapper already uses a fresh dir.
  const failure = {
    task: 'Capacity failure before any completed analysis', language, mode: headOnly ? 'head' : 'history', recordedAt: new Date().toISOString(),
    environment: { os: `${os.type()} ${os.release()} ${os.arch()}`, node: process.version, git: version, containerLimits: resourceLimits, runtimeImage: process.env.ATLAS_CAPACITY_IMAGE ?? null, sourceCommit: process.env.ATLAS_CAPACITY_SOURCE_COMMIT ?? null, benchmarkSourceCommit: process.env.ATLAS_CAPACITY_BENCHMARK_COMMIT ?? null, benchmarkWorkingTreeDirty: process.env.ATLAS_CAPACITY_BENCHMARK_DIRTY ?? null },
    requestedRuns: RUNS, runs: 0, warmupMs: null, rawSampleMs: [], failedRun, fixture: null, artifact: null, analyzer: null, parsedLanguages: null, parserMemory: null,
    resourceUsage: resourceUsage(), timePass: false, sizePass: false, completenessPass: false, sampleCountPass: false, parserMemoryPass: false, languagePass: false, resourcePass: false, pass: false,
  };
  const dir = pathArg('report-dir') ?? path.join(root, 'docs', 'benchmarks');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${out}.json`), JSON.stringify(failure, null, 2) + '\n');
  writeFileSync(path.join(dir, `${out}.md`), `# Capacity failure\n\nRecorded ${failure.recordedAt}. No analysis completed, including warm-up.\n\nFailed process: ${JSON.stringify(failedRun)}. Completed measurements: zero.\n\nAnalysis facts, artifact sizes and parser-child memory are unknown. No time, size, completeness or resource gate passes. Exact environment and available cgroup observations are retained in the JSON.\n`);
  console.log(JSON.stringify(failure, null, 2));
  process.exit(1);
}

const sorted = [...timings].sort((a, b) => a - b);
const pct = (p) => (sorted.length === 0 ? NaN : sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]);
const report = {
  task: `${headOnly ? 'HEAD' : 'Historical'} analysis capacity — ${tier}, ${headOnly ? 1 : 12} frames`,
  language,
  mode: headOnly ? 'head' : 'history',
  fixturePolicy: language === 'typescript' ? null : PYTHON_CAPACITY_POLICY,
  recordedAt: new Date().toISOString(),
  environment: { os: `${os.type()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model, cpuCount: os.cpus().length, memoryGiB: +(os.totalmem() / 2 ** 30).toFixed(1), node: process.version, nodeFlags: process.execArgv.join(' '), git: version, parserWorkers: 2, processPerRun: isolateRuns, containerLimits: resourceLimits, runtimeImage: process.env.ATLAS_CAPACITY_IMAGE ?? null, sourceCommit: process.env.ATLAS_CAPACITY_SOURCE_COMMIT ?? null, benchmarkSourceCommit: process.env.ATLAS_CAPACITY_BENCHMARK_COMMIT ?? null, benchmarkWorkingTreeDirty: process.env.ATLAS_CAPACITY_BENCHMARK_DIRTY ?? null },
  fixture: lastFacts.fixture,
  runs: timings.length,
  warmupMs,
  rawSampleMs: timings,
  sampleCompleteness: completeness,
  failedRun,
  analyzer: lastFacts.analyzer,
  parsedLanguages: lastFacts.parsedLanguages,
  selectedCommit: lastFacts.selectedCommit,
  layoutId: lastFacts.layoutId,
  resourceUsage: resourceUsage(),
  secondsP50: +(pct(0.5) / 1000).toFixed(2),
  secondsP95: +(pct(0.95) / 1000).toFixed(2),
  secondsMax: +(sorted.at(-1) / 1000).toFixed(2),
  budgetSecondsP95: headOnly ? (tier === 'large' ? 60 : 15) : (tier === 'large' ? 240 : 90),
  artifact: { ...lastFacts.artifact, budgetBytes: (tier === 'large' ? 20 : 5) * 1024 * 1024 },
};
report.timePass = report.secondsP95 <= report.budgetSecondsP95;
report.sizePass = report.artifact.compressedBytes <= report.artifact.budgetBytes;
report.completenessPass = failedRun === null && completeness.every((sample) => sample.complete);
report.sampleCountPass = timings.length >= 20;
report.parserMemoryPass = completeness.every((sample) => sample.parserMemory?.available && sample.parserMemory.children.length >= 1);
const languages = report.parsedLanguages;
report.languagePass = language === 'python' ? languages.python > 0 && languages.typescript + languages.javascript === 0
  : language === 'mixed' ? languages.python > 0 && languages.typescript + languages.javascript > 0 : languages.python === 0;
report.resourcePass = report.resourceUsage ? (report.resourceUsage.peakBytes <= resourceLimits.memoryBytes && report.resourceUsage.events.oom === 0 && report.resourceUsage.events.oom_kill === 0) : null;
report.pass = report.timePass && report.sizePass && report.completenessPass && (report.resourcePass ?? true) && report.sampleCountPass && report.languagePass && (!isolateRuns || report.parserMemoryPass);
const outDir = pathArg('report-dir') ?? path.join(root, 'docs/benchmarks');
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, `${out}.json`), `${JSON.stringify(report, null, 2)}\n`);
const mib = (b) => `${(b / 1024 / 1024).toFixed(2)} MiB`;
writeFileSync(
  path.join(outDir, `${out}.md`),
  [
    `# ${report.task} (plan §15.2)`,
    '',
    `Recorded ${report.recordedAt} by \`node scripts/bench-history.mjs\`. Language: ${language}; mode: ${report.mode}. ${report.runs} measured runs after one warm-up${report.environment.processPerRun ? ', each in a fresh process whose analysis owns and closes its parser pool, as in a production analysis sandbox' : ''}; every run uses a cold fact cache, complete analysis and artifact packing.`,
    '',
    '## Environment',
    '',
    ...Object.entries(report.environment).map(([k, v]) => `- **${k}:** ${typeof v === 'object' ? JSON.stringify(v) : v}`),
    '',
    `## Fixture (synthetic "${tier}", ${language}, ${report.mode}, deterministic)`,
    '',
    `- HEAD: ${report.fixture.headFiles.toLocaleString('en-US')} files, ${report.fixture.importStatements.toLocaleString('en-US')} import statements`,
    `- Parsed languages: ${JSON.stringify(report.parsedLanguages)}; language validation: ${report.languagePass ? 'pass' : 'fail'}`,
    `- HEAD dependency edges: ${report.fixture.headEdges.toLocaleString('en-US')} (limits hit: ${report.fixture.headLimitsHit.length === 0 ? 'none' : report.fixture.headLimitsHit.join(', ')})${report.fixturePolicy ? `; Python fixture policy ${report.fixturePolicy} (ADR-067)` : ''}`,
    headOnly ? '- History disabled; one selected frame.' : `- History: ${report.fixture.commits} mainline commits over 58.5 days (${report.fixture.boundary} boundary), ${report.fixture.frames} analyzed frames, ${report.fixture.renames} renames, ${report.fixture.lineages.toLocaleString('en-US')} lineages; status ${report.fixture.historyStatus}`,
    '',
    '## Result',
    '',
    '| Measure | Value | Budget |',
    '|---|---:|---:|',
    `| p50 | ${report.secondsP50} s | |`,
    `| p95 | ${report.secondsP95} s | ≤ ${report.budgetSecondsP95} s |`,
    `| max | ${report.secondsMax} s | |`,
    ...(report.parserMemoryPass ? [`| largest parser-child VmHWM | ${mib(Math.max(...completeness.flatMap((sample) => sample.parserMemory.children.map((child) => child.peakRSSBytes))))} | recorded per child in JSON |`] : []),
    `| artifact (all chunks) | ${mib(report.artifact.compressedBytes)} | ≤ ${mib(report.artifact.budgetBytes)} |`,
    ...(report.resourceUsage ? [`| whole-job cgroup peak | ${mib(report.resourceUsage.peakBytes)} | ≤ ${mib(resourceLimits.memoryBytes)} |`] : []),
    `| — selected graph | ${mib(report.artifact.headGraphBytes)} | |`,
    ...(headOnly ? [] : [`| — 11 historical frames (deltas) | ${mib(report.artifact.historicalGraphBytes)} | |`]),
    `| — history / layout | ${mib(report.artifact.historyBytes)} / ${mib(report.artifact.layoutBytes)} | |`,
    '',
    ...(report.failedRun ? [`Run ${report.failedRun.runIndex} did not complete (exit ${report.failedRun.code}, signal ${report.failedRun.signal}); no later runs were attempted.`, ''] : []),
    `**${report.pass ? 'Pass' : 'Fail'}.** Time: ${report.timePass ? 'pass' : 'fail'}; size: ${report.sizePass ? 'pass' : 'fail'}; all measured runs complete with ${headOnly ? 1 : 12} frames: ${report.completenessPass ? 'pass' : 'fail'}; twenty-sample minimum: ${report.sampleCountPass ? 'pass' : 'fail'}; parser-memory capture: ${report.parserMemoryPass ? 'pass' : 'unmeasured'}; resource gate: ${report.resourceUsage ? `${report.resourcePass ? 'pass' : 'fail'} (events ${JSON.stringify(report.resourceUsage.events)})` : 'unmeasured; no whole-job/reference-resource pass is claimed'}. Format ${report.artifact.version}; frame-delta transport per ADR-026.`,
    '',
  ].join('\n'),
);
console.log(JSON.stringify(report, null, 2));
if (!report.pass) process.exitCode = 1;
