#!/usr/bin/env node
/** Byte-preserving changes must match the last committed real-repository report. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const file = 'docs/release/real-repositories.json';
const baseline = JSON.parse(execFileSync('git', ['show', `HEAD:${file}`], { encoding: 'utf8', windowsHide: true }));
const current = JSON.parse(await readFile(file, 'utf8'));
assert.equal(current.analyzerVersion, baseline.analyzerVersion, 'Update the corpus baseline deliberately when semantics/version change');
assert.equal(current.repositories.length, baseline.repositories.length);
for (const repo of baseline.repositories) {
  const measured = current.repositories.find((other) => other.numericId === repo.numericId && other.commit === repo.commit);
  assert(measured?.exportVerified && measured.deterministic && current.runs >= 5);
  assert.equal(measured.digest, repo.digest, `Canonical/wire payload changed: ${repo.owner}/${repo.name}`);
  assert.deepEqual(measured.checks, repo.checks);
  console.log(`${repo.owner}/${repo.name}: exact committed baseline payload and independent source checks preserved`);
}
