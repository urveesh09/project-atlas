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
import { mkdirSync, writeFileSync } from 'node:fs';
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

const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const { createGitFixture } = await imp('packages/test-fixtures/dist/index.js');
const { openLocalRepository, resolveLocalCommit, gitVersion } = await imp('packages/ingest/dist/index.js');
const { analyzeCommit, ParserPool, MemoryFactCache } = await imp('packages/analyzer-core/dist/index.js');
const { gzipDeterministic, writeArtifactDirectory } = await imp('packages/artifact/dist/node-entry.js');
const { localRepositoryId } = await imp('packages/schema/dist/index.js');

let state = 0x2545f491;
const next = () => {
  state ^= state << 13;
  state >>>= 0;
  state ^= state >>> 17;
  state ^= state << 5;
  state >>>= 0;
  return state;
};

const perPackage = Math.ceil(FILES / PACKAGES);
function sourceFile(p, i, variant) {
  const lines = [];
  for (let k = 0; k < 10; k++) {
    const r = next() % 100;
    if (r < 70) {
      const j = next() % perPackage;
      lines.push(`import { f${j} } from '../m${j % 12}/f${j}';`);
    } else if (r < 85) lines.push(`import { f${next() % perPackage} as g${k} } from '@bench/p${next() % PACKAGES}/m0/f0';`);
    else if (r < 93) lines.push(`import type { T${k} } from '../m${(i + k) % 12}/types';`);
    else lines.push(`import * as ext${k} from '${['react', 'zod', 'node:fs', 'lodash'][next() % 4]}';`);
  }
  const branches = 1 + ((next() + variant) % 14);
  const body = Array.from({ length: branches }, (_, b) => `  if (x > ${b} && x < ${b * 3 + 5 + variant}) return ${b};`).join('\n');
  lines.push(`export function f${i}(x: number): number {\n${body}\n  return x ? ${variant} : 0;\n}`);
  return `${lines.join('\n')}\n`;
}

const base = {
  'package.json': JSON.stringify({ name: 'bench', private: true, workspaces: ['packages/*'] }),
  'tsconfig.json': JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler', strict: true }, include: ['packages'] }),
};
const live = [];
for (let p = 0; p < PACKAGES; p++) {
  base[`packages/p${p}/package.json`] = JSON.stringify({ name: `@bench/p${p}`, exports: { '.': './src/index.ts', './*': './src/*.ts' } });
  base[`packages/p${p}/src/index.ts`] = 'export const version = 1;\n';
  for (let d = 0; d < 12; d++) base[`packages/p${p}/src/m${d}/types.ts`] = 'export interface T0 { a: number }\n';
  for (let i = 0; i < perPackage; i++) {
    const file = `packages/p${p}/src/m${i % 12}/f${i}.ts`;
    base[file] = sourceFile(p, i, 0);
    live.push({ file, p, i });
  }
}
const day = (n) => new Date(Date.UTC(2026, 7, 1) + n * 36 * 3_600_000).toISOString();
const commits = [{ date: day(0), message: 'base', files: base }];
for (let c = 1; c < COMMITS; c++) {
  const files = {};
  const renames = [];
  // ~40 edits, hot files edited often (skewed), a few additions, deletions and renames.
  for (let k = 0; k < 40; k++) {
    const pick = live[(next() % 10 === 0 ? next() % 60 : next() % live.length)];
    if (pick) files[pick.file] = sourceFile(pick.p, pick.i, c);
  }
  for (let k = 0; k < 3; k++) {
    const p = next() % PACKAGES;
    const i = perPackage + c * 10 + k;
    const file = `packages/p${p}/src/m${i % 12}/f${i}.ts`;
    files[file] = sourceFile(p, i, c);
    live.push({ file, p, i });
  }
  if (c % 5 === 0) {
    const victim = live.splice(100 + (next() % 500), 1)[0];
    if (victim) files[victim.file] = null;
    const moved = live[200 + (next() % 500)];
    if (moved && !files[moved.file]) {
      const to = moved.file.replace('/src/', '/src/moved/');
      renames.push([moved.file, to]);
      moved.file = to;
    }
  }
  commits.push({ date: day(c), message: `change ${c}`, files, renames });
}

console.error(`Building ${Object.keys(base).length} files and ${COMMITS} commits…`);
const fixture = createGitFixture(commits);
const { repo, git } = await openLocalRepository(fixture.dir);
const head = await resolveLocalCommit(repo, git);
const version = await gitVersion();
const pool = new ParserPool({ workers: 2 });
const timings = [];
let last;
try {
  for (let runIndex = 0; runIndex < RUNS + 1; runIndex++) {
    const started = performance.now();
    const result = await analyzeCommit({
      git,
      commitOid: head,
      gitVersion: version,
      repository: { repoId: localRepositoryId('3f2a9c4e-8b1d-4f6a-9c2e-7d5b1a0e4c3f'), displayName: 'bench', sourceKind: 'local-git', remote: null, objectFormat: repo.objectFormat },
      pool,
      factCache: new MemoryFactCache(),
      transport: gzipDeterministic,
    });
    const elapsed = performance.now() - started;
    if (runIndex > 0) timings.push(elapsed);
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

const sorted = [...timings].sort((a, b) => a - b);
const pct = (p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
const m = last.packed.manifest;
const h = m.coverage.history;
const chunk = (prefix) => m.chunks.filter((c) => c.path.startsWith(prefix)).reduce((a, c) => a + c.compressedBytes, 0);
const report = {
  task: 'Gate G4 — medium 12-frame historical analysis and artifact size',
  recordedAt: new Date().toISOString(),
  environment: { os: `${os.type()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model, cpuCount: os.cpus().length, memoryGiB: +(os.totalmem() / 2 ** 30).toFixed(1), node: process.version, git: version, parserWorkers: 2 },
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
  analyzer: m.analyzer,
  selectedCommit: m.selectedCommit.oid,
  layoutId: last.draft.layout.layoutId,
  secondsP50: +(pct(0.5) / 1000).toFixed(2),
  secondsP95: +(pct(0.95) / 1000).toFixed(2),
  secondsMax: +(sorted.at(-1) / 1000).toFixed(2),
  budgetSecondsP95: 90,
  artifact: {
    version: m.artifactVersion,
    compressedBytes: m.chunks.reduce((a, c) => a + c.compressedBytes, 0),
    headGraphBytes: m.frames.at(-1).graphChunk.compressedBytes,
    historicalGraphBytes: chunk('graphs/') - m.frames.at(-1).graphChunk.compressedBytes,
    historyBytes: chunk('history/'),
    layoutBytes: chunk('layout/'),
    budgetBytes: 5 * 1024 * 1024,
  },
};
report.timePass = report.secondsP95 <= report.budgetSecondsP95;
report.sizePass = report.artifact.compressedBytes <= report.artifact.budgetBytes;
report.pass = report.timePass && report.sizePass && report.fixture.frames === 12;
const outDir = path.join(root, 'docs/benchmarks');
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, `${out}.json`), `${JSON.stringify(report, null, 2)}\n`);
const mib = (b) => `${(b / 1024 / 1024).toFixed(2)} MiB`;
writeFileSync(
  path.join(outDir, `${out}.md`),
  [
    '# Phase 4 historical analysis benchmark (Gate G4)',
    '',
    `Recorded ${report.recordedAt} by \`node scripts/bench-history.mjs\`. ${report.runs} measured runs after one warm-up; every run uses a cold fact cache and performs the whole pipeline: first-parent walk, rename-aware diffs, 12 frame graphs, churn, hotspots, union layout and frame-delta packing within the export limits.`,
    '',
    '## Environment',
    '',
    ...Object.entries(report.environment).map(([k, v]) => `- **${k}:** ${v}`),
    '',
    '## Fixture (synthetic "medium" with history, deterministic)',
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
    `| artifact (all chunks) | ${mib(report.artifact.compressedBytes)} | ≤ 5 MiB |`,
    `| — selected graph | ${mib(report.artifact.headGraphBytes)} | |`,
    `| — 11 historical frames (deltas) | ${mib(report.artifact.historicalGraphBytes)} | |`,
    `| — history / layout | ${mib(report.artifact.historyBytes)} / ${mib(report.artifact.layoutBytes)} | |`,
    '',
    `**${report.pass ? 'Pass' : 'Fail'}.** Time: ${report.timePass ? 'pass' : 'fail'}; size: ${report.sizePass ? 'pass' : 'fail'}. Format ${report.artifact.version}; frame-delta transport per ADR-026.`,
    '',
  ].join('\n'),
);
console.log(JSON.stringify(report, null, 2));
if (!report.pass) process.exitCode = 1;
