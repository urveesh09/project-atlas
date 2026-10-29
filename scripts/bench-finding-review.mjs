#!/usr/bin/env node
/** Synthetic pure comparison capacity, NOT analyzer/device/release acceptance. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { canonicalJson, makeId, REVIEW_LIMITS } from '../packages/schema/dist/index.js';
import { importRuffSarif, createScanEvidence, createReviewSide, createFindingAnchors, indexFindingContexts, createFindingReview } from '../packages/graph/dist/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.includes('--sample')) {
  const started = performance.now();
  const body = '# padding one\n# padding two\n' + Array.from({ length: 4096 }, (_, i) => `print(missing${i})\n`).join('') + '# tail one\n# tail two\n';
  const profile = { format: 'atlas.ruff-profile/1', isolated: true, ignoreNoqa: true, respectGitignore: false, forceExclude: false, targetVersion: 'py314', rules: ['F821'] };
  const prepared = (tag, shift) => {
    const text = (shift ? '# shifted\n' : '') + body;
    const target = { analysisId: makeId('analysis', ['review-capacity']), repoId: makeId('repository', ['review-capacity']), snapshotId: makeId('snapshot', [tag]), commitOid: tag.repeat(40),
      files: [{ path: 'sample.py', nodeId: makeId('node', [tag]), lineageId: makeId('lineage', ['same']), blobOid: tag.repeat(40), lines: 4100 + shift }] };
    const report = importRuffSarif(JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'ruff', version: '0.17.3' } }, results: Array.from({ length: 4096 }, (_, i) => ({ ruleId: 'F821', locations: [{ physicalLocation: { artifactLocation: { uri: 'sample.py' }, region: { startLine: i + 3 + shift, startColumn: 7 } } }] })) }] }), target, target.commitOid);
    const scan = createScanEvidence(report, profile, { format: 'atlas.scan-scope/1', files: [{ path: 'sample.py', blobOid: tag.repeat(40) }] }, 1, target);
    return { target, scan, text };
  };
  const old = prepared('a', 0), now = prepared('b', 1);
  const indexes = new Map([old, now].map((p) => [p.target.files[0].blobOid, indexFindingContexts(p.text, REVIEW_LIMITS.contextWindows)]));
  const side = (p, other) => createReviewSide(p.scan, 'f'.repeat(64), p.target, createFindingAnchors(p.scan.report, p.target, other.target, indexes));
  const review = createFindingReview(side(now, old), side(old, now));
  assert.equal(review.issues.length, 4096); assert(review.issues.every((r) => r.state === 'continuing'));
  const bytes = Buffer.byteLength(canonicalJson(review)); assert(bytes <= REVIEW_LIMITS.bytes);
  console.log(JSON.stringify({ ms: performance.now() - started, bytes, findingsPerSide: 4096, continuing: 4096,
    rssMiB: process.memoryUsage().rss / 2 ** 20, maxRssMiB: process.resourceUsage().maxRSS > 0 ? process.resourceUsage().maxRSS / 1024 : null }));
} else {
  const samples = [];
  for (let i = 0; i < 20; i++) {
    const sample = JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--sample'], { cwd: root,
      env: { NO_COLOR: '1', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
      encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 }));
    samples.push(sample);
    console.log(`sample ${i + 1}/20: ${sample.ms.toFixed(1)} ms; ${sample.continuing} continuing`);
  }
  const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
  const report = { task: 'Q2.2 synthetic pure finding-review capacity', recordedAt: new Date().toISOString(), node: process.version,
    platform: `${os.type()} ${os.release()} ${os.arch()}`, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(),
    workingTreeDirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim().length > 0,
    method: '20 fresh Node processes; timing starts after module load and includes authored report preparation, context indexing, matching and canonical round-trip validation. Synthetic source metadata, no Git ingestion or real Ruff/signatures in this benchmark.',
    p50Ms: sorted[9], p95Ms: sorted[18], worstMs: sorted[19], samples,
    limits: ['Functional comparison capacity only; no reference-machine, GPU or browser latency claim.', 'Dirty development observations are not clean-tree release acceptance.', 'Producer and cryptographic evidence have separate tests. No clean/resolved verdict.'] };
  const base = path.join(root, 'docs/benchmarks/finding-review-capacity');
  await writeFile(base + '.json', JSON.stringify(report, null, 2) + '\n');
  await writeFile(base + '.md', ['# Contextual finding review: synthetic capacity', '',
    `Recorded ${report.recordedAt}; ${report.node} on ${report.platform}. Base \`${report.sourceCommit}\`; dirty: ${report.workingTreeDirty}.`, '', report.method, '',
    `All 20 samples retain exactly 4,096 findings per side and 4,096 continuing tracking IDs. Canonical output is ${samples[0].bytes} bytes, below the 8 MiB cap.`, '',
    `p50 ${report.p50Ms.toFixed(1)} ms; p95 ${report.p95Ms.toFixed(1)} ms; worst ${report.worstMs.toFixed(1)} ms. These are development observations, not a product latency budget.`, '',
    'Reproduce after building: `node scripts/bench-finding-review.mjs`. [Raw observations](finding-review-capacity.json).', '', ...report.limits.map((x) => `- ${x}`), ''].join('\n'));
}
