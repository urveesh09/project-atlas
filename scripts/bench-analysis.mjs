#!/usr/bin/env node
/**
 * HEAD analysis benchmark (plan §15.1/§15.2, Gate G2). Builds a deterministic synthetic
 * repository — "medium": 3,000 files and ~30,000 import statements across 10 workspace
 * packages — commits it with real Git, then times `analyzeCommit` end to end (inventory,
 * parsing in the child pool, resolution, graph, metrics, findings, layout) with a cold
 * fact cache on every run. Writes docs/benchmarks/phase2-analysis.{json,md}.
 *
 *   node scripts/bench-analysis.mjs [--files 3000] [--runs 20]
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
const nameIndex = process.argv.indexOf('--report-name');
const reportName = nameIndex < 0 ? 'phase2-analysis' : process.argv[nameIndex + 1];
if (!/^[a-z0-9-]+$/.test(reportName ?? '')) throw new Error('Report name must be lowercase letters, digits and hyphens');
if (!Number.isInteger(RUNS) || RUNS < 1 || RUNS > 100) throw new Error('Runs must be 1..100');
const IMPORTS_PER_FILE = 10;
const PACKAGES = 10;

const { createGitFixture } = await import(pathToFileURL(path.join(root, 'packages/test-fixtures/dist/index.js')).href);
const { openLocalRepository, resolveLocalCommit, gitVersion } = await import(pathToFileURL(path.join(root, 'packages/ingest/dist/index.js')).href);
const { analyzeCommit, ParserPool, MemoryFactCache } = await import(pathToFileURL(path.join(root, 'packages/analyzer-core/dist/index.js')).href);
const { packArtifact, gzipDeterministic } = await import(pathToFileURL(path.join(root, 'packages/artifact/dist/node-entry.js')).href);
const { localRepositoryId } = await import(pathToFileURL(path.join(root, 'packages/schema/dist/index.js')).href);

// Deterministic generator (xorshift32): no Math.random, same repository every time.
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
const files = {
  'package.json': JSON.stringify({ name: 'bench', private: true, workspaces: ['packages/*'] }),
  'tsconfig.json': JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler', strict: true }, include: ['packages'] }),
};
let statements = 0;
for (let p = 0; p < PACKAGES; p++) {
  files[`packages/p${p}/package.json`] = JSON.stringify({ name: `@bench/p${p}`, exports: { '.': './src/index.ts', './*': './src/*.ts' } });
  files[`packages/p${p}/src/index.ts`] = 'export const version = 1;\n';
  for (let i = 0; i < perPackage; i++) {
    const dir = `m${i % 12}`;
    const lines = [];
    for (let k = 0; k < IMPORTS_PER_FILE; k++) {
      const r = next() % 100;
      if (r < 70) {
        const j = next() % perPackage;
        lines.push(`import { f${j} } from '../m${j % 12}/f${j}';`);
      } else if (r < 85) {
        const q = next() % PACKAGES;
        const j = next() % perPackage;
        lines.push(`import { f${j} as g${k} } from '@bench/p${q}/m${j % 12}/f${j}';`);
      } else if (r < 93) lines.push(`import type { T${k} } from '../m${(i + k) % 12}/types';`);
      else lines.push(`import * as ext${k} from '${['react', 'zod', 'node:fs', 'lodash'][next() % 4]}';`);
      statements++;
    }
    const branches = 1 + (next() % 14);
    const body = Array.from({ length: branches }, (_, b) => `  if (x > ${b} && x < ${b * 3 + 5}) return ${b};`).join('\n');
    lines.push(`export function f${i}(x: number): number {\n${body}\n  return x ? 1 : 0;\n}`);
    files[`packages/p${p}/src/${dir}/f${i}.ts`] = `${lines.join('\n')}\n`;
  }
  for (let d = 0; d < 12; d++) files[`packages/p${p}/src/m${d}/types.ts`] = 'export interface T0 { a: number }\n';
}

console.error(`Generating ${Object.keys(files).length} files (${statements} import statements)…`);
const fixture = createGitFixture([{ date: '2026-10-01T00:00:00Z', message: 'bench', files }]);
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
      factCache: new MemoryFactCache(), // cold: every run parses every file
    });
    const packed = packArtifact(result.draft, gzipDeterministic);
    const elapsed = performance.now() - started;
    if (runIndex > 0) timings.push(elapsed); // the first run warms the process, not the cache
    last = { result, packed };
    console.error(`  run ${runIndex}${runIndex === 0 ? ' (warm-up)' : ''}: ${(elapsed / 1000).toFixed(2)} s`);
  }
} finally {
  await pool.close();
  await git.dispose();
  fixture.dispose();
}

const sorted = [...timings].sort((a, b) => a - b);
const pct = (p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
const c = last.result.draft.graphs[0].coverage;
const report = {
  task: `HEAD analysis capacity — ${FILES > 3000 ? 'large' : 'medium'}`,
  recordedAt: new Date().toISOString(),
  analyzerVersion: last.result.summary.analyzerVersion,
  selectedCommit: head,
  layoutId: last.result.draft.layout.layoutId,
  rawSamplesMs: timings,
  environment: { os: `${os.type()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model, cpuCount: os.cpus().length, memoryGiB: +(os.totalmem() / 2 ** 30).toFixed(1), node: process.version, git: version, parserWorkers: 2 },
  fixture: { files: c.includedFiles, parsed: c.parsedFiles, importStatements: c.observedImports, fileEdges: last.result.draft.graphs[0].edges.length, internalResolved: c.internalResolved },
  runs: timings.length,
  secondsP50: +(pct(0.5) / 1000).toFixed(2),
  secondsP95: +(pct(0.95) / 1000).toFixed(2),
  secondsMax: +(sorted.at(-1) / 1000).toFixed(2),
  budgetSecondsP95: FILES > 3000 ? 60 : 15,
  budgetArtifactBytes: (FILES > 3000 ? 20 : 5) * 1024 * 1024,
  artifactVersion: last.packed.manifest.artifactVersion,
  artifactCompressedBytes: last.packed.manifest.chunks.reduce((a, ch) => a + ch.compressedBytes, 0),
};
report.timePass = report.secondsP95 <= report.budgetSecondsP95;
report.sizePass = report.artifactCompressedBytes <= report.budgetArtifactBytes;
report.pass = report.timePass && report.sizePass;
const outDir = path.join(root, 'docs/benchmarks');
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, `${reportName}.json`), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(
  path.join(outDir, `${reportName}.md`),
  [
    `# ${report.task} (plan §15.2)`,
    '',
    `Recorded ${report.recordedAt} by \`node scripts/bench-analysis.mjs\`. ${report.runs} measured runs after one warm-up, each with a cold fact cache, so every file is parsed every time.`,
    '',
    '## Environment',
    '',
    ...Object.entries(report.environment).map(([k, v]) => `- **${k}:** ${v}`),
    '',
    `## Fixture (synthetic "${FILES <= 3000 ? 'medium' : 'large'}", deterministic)`,
    '',
    `- ${report.fixture.files.toLocaleString('en-US')} files, ${report.fixture.parsed.toLocaleString('en-US')} parsed, ${report.fixture.importStatements.toLocaleString('en-US')} import statements, ${report.fixture.fileEdges.toLocaleString('en-US')} edges`,
    `- Artifact: ${(report.artifactCompressedBytes / 1024).toFixed(0)} KiB compressed (budget ${report.budgetArtifactBytes / 2 ** 20} MiB)`,
    '',
    '## Result',
    '',
    '| Measure | Value | Budget |',
    '|---|---:|---:|',
    `| p50 | ${report.secondsP50} s | |`,
    `| p95 | ${report.secondsP95} s | ≤ ${report.budgetSecondsP95} s |`,
    `| max | ${report.secondsMax} s | |`,
    `| artifact | ${(report.artifactCompressedBytes / 1024 / 1024).toFixed(2)} MiB | ≤ ${report.budgetArtifactBytes / 2 ** 20} MiB |`,
    '',
    `**${report.pass ? 'Pass' : 'Fail'}.** Time: ${report.timePass ? 'pass' : 'fail'}; artifact size: ${report.sizePass ? 'pass' : 'fail'}. Times cover the whole HEAD pipeline after acquisition (local objects) and include artifact packing, but not writing to disk. Format: ${report.artifactVersion}; indexed graph transport per ADR-018.`,
    '',
  ].join('\n'),
);
console.log(JSON.stringify(report, null, 2));
if (!report.pass) process.exitCode = 1;
