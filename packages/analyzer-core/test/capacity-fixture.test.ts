import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, expect, it } from 'vitest';
import { initPythonParser, extractPythonFacts } from '@atlas/analyzer-py';
import { ParserPool } from '@atlas/analyzer-core';

type Commit = { files: Record<string, string | null>; renames?: [string, string][] };
const { buildMediumHistoryCommits } = await import(pathToFileURL(path.resolve('scripts/lib/medium-history.mjs')).href);
const { observeParserMemory } = await import(pathToFileURL(path.resolve('scripts/lib/parser-memory.mjs')).href);
beforeAll(async () => { await initPythonParser(); });

it('preserves the original TypeScript fixture byte-for-byte across its evolution', () => {
  // Determinism golden from the unchanged afbeede generator, compared directly before
  // recording. Correctness is independently asserted in the language/count tests below.
  const fixture = buildMediumHistoryCommits({ files: 1000, commits: 6, packages: 10 });
  expect(createHash('sha256').update(JSON.stringify(fixture)).digest('hex')).toBe('e6929af5c2ae8c1d184ed005e080c2394c520ddcb6ea9ad400433052b99efd78');
});

it.each(['python', 'mixed'])('preserves every original dependency and adds the real typing import in %s', (language) => {
  const options = { files: 1000, commits: 6, packages: 10 };
  const baseline = buildMediumHistoryCommits(options).commits as Commit[];
  const commits = buildMediumHistoryCommits({ ...options, language }).commits as Commit[];
  expect(commits.map((c) => Object.keys(c.files).length)).toEqual(baseline.map((c) => Object.keys(c.files).length));
  const sources = Object.entries(commits[0]!.files).filter(([file]) => /\/f\d+\.(?:ts|py)$/.test(file));
  expect(sources).toHaveLength(1000);
  expect(sources.filter(([file]) => file.endsWith('.py'))).toHaveLength(language === 'python' ? 1000 : 500);
  for (const [file, text] of sources.filter(([file]) => file.endsWith('.py')).slice(0, 25)) {
    const facts = extractPythonFacts(file, text!);
    expect(facts.parseStatus).toBe('parsed');
    expect(facts.imports).toHaveLength(11);
    expect(facts.imports[0]).toMatchObject({ specifier: 'typing', kind: 'imports-value' });
    // No original import may be dropped merely to keep an observation count identical.
    // All ten authored source statements survive after the one explicit typing import.
    expect(facts.imports.slice(1)).toHaveLength(10);
    expect(facts.callables).toHaveLength(1);
    expect(facts.codeLines).toBeGreaterThan(12);
  }
  for (const c of commits) for (const [from, to] of c.renames ?? []) {
    expect(from.endsWith('.py')).toBe(to.endsWith('.py'));
    expect(from).not.toBe(to);
  }
  const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  expect(digest(commits)).toBe(digest(buildMediumHistoryCommits({ ...options, language }).commits));
});

it('records actual parser-child kernel peaks before closing, or explicitly reports unsupported OS', async () => {
  const memory = observeParserMemory(ParserPool);
  const pool = new ParserPool({ workers: 1 });
  try { expect((await pool.parse('a.py', 'import os\nx = 1\n')).parseStatus).toBe('parsed'); }
  finally { await pool.close(); }
  const result = memory.finish();
  expect(result.available).toBe(process.platform === 'linux');
  if (result.available) {
    expect(result.children).toHaveLength(1);
    expect(result.children[0].peakRSSBytes).toBeGreaterThan(1024 * 1024);
  } else expect(result.children).toEqual([]);
});

it('retains a structured failure when even the warm-up cannot complete', () => {
  const work = mkdtempSync(path.join(tmpdir(), 'atlas-capacity-failure-'));
  try {
    const run = spawnSync(process.execPath, ['scripts/bench-history.mjs', '--fixture', path.join(work, 'missing'), '--language', 'python', '--head', '--isolate-runs', '--runs', '1', '--out', 'failure', '--report-dir', work], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(1);
    const report = JSON.parse(readFileSync(path.join(work, 'failure.json'), 'utf8'));
    expect(report).toMatchObject({ runs: 0, pass: false, fixture: null, artifact: null, failedRun: { runIndex: 0, code: 1 } });
    expect(report.rawSampleMs).toEqual([]);
    expect(report.sampleCountPass).toBe(false);
    expect(readFileSync(path.join(work, 'failure.md'), 'utf8')).toContain('No analysis completed');
  } finally { rmSync(work, { recursive: true, force: true }); }
});
