#!/usr/bin/env node
/**
 * P6.1/§16.2: compare independently acquired/analyzed five-repeat reports, one per
 * operating system. Windows and Linux are required; macOS joins them in CI (ADR-068).
 *
 *   node scripts/compare-repository-reports.mjs <report.json> <report.json> [<report.json>...]
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const files = process.argv.slice(2);
assert(files.length >= 2, 'Provide at least two corpus JSON reports');
assert.equal(new Set(files.map((file) => path.resolve(file))).size, files.length, 'A report cannot be its own independent comparison');
const reports = await Promise.all(files.map(async (file) => JSON.parse(await readFile(file, 'utf8'))));
// `os.type()` names: Linux, Windows_NT, Darwin.
const platforms = reports.map((report) => report.environment?.os?.split(' ')[0]);
for (const platform of platforms) assert(['Linux', 'Windows_NT', 'Darwin'].includes(platform), `Unknown report platform: ${platform}`);
assert.equal(new Set(platforms).size, platforms.length, 'Each report must come from a different operating system');
assert(platforms.includes('Linux') && platforms.includes('Windows_NT'), 'Require independent Windows and Linux reports');
for (const report of reports) {
  assert.equal(report.analyzerVersion, reports[0].analyzerVersion);
  assert(report.runs >= 5);
}
// Every report covers exactly the committed pinned corpus, each repository once (ADR-060
// added pallets/flask, so the size is read from the corpus rather than written here).
const corpus = JSON.parse(await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '../docs/release/repository-corpus.json'), 'utf8'));
const pinned = corpus.repositories.map((repo) => `${repo.numericId}:${repo.commit}`).sort();
assert(pinned.length >= 3 && new Set(pinned).size === pinned.length, 'The pinned corpus must hold at least three unique repositories');
for (const report of reports) {
  assert.deepEqual(report.repositories.map((repo) => `${repo.numericId}:${repo.commit}`).sort(), pinned, 'A report must cover exactly the pinned corpus');
  for (const repo of report.repositories) assert.match(repo.digest, /^[0-9a-f]{64}$/);
}
const [reference, ...others] = reports;
for (const repo of reference.repositories) {
  assert(repo.exportVerified && repo.deterministic, `Not verified or not deterministic on ${platforms[0]}: ${repo.owner}/${repo.name}`);
  others.forEach((report, index) => {
    const platform = platforms[index + 1];
    const other = report.repositories.find((r) => r.numericId === repo.numericId && r.commit === repo.commit);
    assert(other, `Different corpus pin: ${repo.owner}/${repo.name}`);
    assert(other.exportVerified && other.deterministic, `Not verified or not deterministic on ${platform}: ${repo.owner}/${repo.name}`);
    assert.equal(other.digest, repo.digest, `Cross-platform graph/history/layout mismatch (${platforms[0]} vs ${platform}): ${repo.owner}/${repo.name}`);
    assert.deepEqual(other.checks, repo.checks, `Independent source checks differ (${platforms[0]} vs ${platform}): ${repo.owner}/${repo.name}`);
  });
  console.log(`${repo.owner}/${repo.name}@${repo.commit}: five repeats on each of ${platforms.join(', ')}, exact canonical/wire digest ${repo.digest}`);
}
