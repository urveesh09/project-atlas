#!/usr/bin/env node
/** P6.1/§16.2: compare two independently acquired/analyzed five-repeat reports. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
assert.equal(process.argv.length, 4, 'Provide exactly two corpus JSON reports');
assert.notEqual(path.resolve(process.argv[2]), path.resolve(process.argv[3]), 'A report cannot be its own independent comparison');
const [left, right] = await Promise.all(process.argv.slice(2).map(async (file) => JSON.parse(await readFile(file, 'utf8'))));
const platforms = [left, right].map((report) => report.environment?.os?.split(' ')[0]).sort();
assert.deepEqual(platforms, ['Linux', 'Windows_NT'], 'Require independent Windows and Linux reports');
assert.equal(left.analyzerVersion, right.analyzerVersion);
assert(left.runs >= 5 && right.runs >= 5);
// Both reports cover exactly the committed pinned corpus, each repository once (ADR-060
// added pallets/flask, so the size is read from the corpus rather than written here).
const corpus = JSON.parse(await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '../docs/release/repository-corpus.json'), 'utf8'));
const pinned = corpus.repositories.map((repo) => `${repo.numericId}:${repo.commit}`).sort();
assert(pinned.length >= 3 && new Set(pinned).size === pinned.length, 'The pinned corpus must hold at least three unique repositories');
for (const report of [left, right]) {
  assert.deepEqual(report.repositories.map((repo) => `${repo.numericId}:${repo.commit}`).sort(), pinned, 'A report must cover exactly the pinned corpus');
  for (const repo of report.repositories) assert.match(repo.digest, /^[0-9a-f]{64}$/);
}
for (const repo of left.repositories) {
  const other = right.repositories.find((r) => r.numericId === repo.numericId && r.commit === repo.commit);
  assert(other, `Different corpus pin: ${repo.owner}/${repo.name}`);
  assert(repo.exportVerified && other.exportVerified && repo.deterministic && other.deterministic);
  assert.equal(repo.digest, other.digest, `Cross-platform graph/history/layout mismatch: ${repo.owner}/${repo.name}`);
  assert.deepEqual(repo.checks, other.checks, `Independent source checks differ: ${repo.owner}/${repo.name}`);
  console.log(`${repo.owner}/${repo.name}@${repo.commit}: five repeats on each platform, exact canonical/wire digest ${repo.digest}`);
}
