#!/usr/bin/env node
/** Prepared trusted synthetic objects for an offline, resource-constrained capacity run. */
import { mkdirSync, chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitFixture } from '../packages/test-fixtures/dist/index.js';
import { buildMediumHistoryCommits } from './lib/medium-history.mjs';
import { PYTHON_CAPACITY_POLICY, capacityLanguage } from './lib/capacity-language.mjs';
import { EXACT_CAPACITY_SHAPES, buildExactCapacityCommits } from './lib/exact-capacity.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const head = process.argv.includes('--head');
const at = process.argv.indexOf('--language');
const language = capacityLanguage(at < 0 ? 'typescript' : process.argv[at + 1] ?? '');
// --shape exact|dense: the plan's exact fixtures (ADR-082), TypeScript at the analyzer's ceilings.
const s = process.argv.indexOf('--shape');
const shape = s < 0 ? null : process.argv[s + 1];
if (shape !== null && (!EXACT_CAPACITY_SHAPES.includes(shape) || language !== 'typescript' || process.argv.includes('--files')))
  throw new Error('--shape is exact or dense, TypeScript only, and sets its own file count');
if (shape === 'dense' && !head) throw new Error('The dense fixture is a HEAD fixture; pass --head');
const i = process.argv.indexOf('--files');
const files = shape ? 10_000 : i < 0 ? 9740 : Number(process.argv[i + 1]);
if (!shape && (!Number.isInteger(files) || files < 1 || files > (head ? 9850 : 9740))) throw new Error('Fixture exceeds the source-file allowance for this capacity mode');
const parent = path.join(root, '.atlas-tmp', 'capacity-fixtures');
mkdirSync(parent, { recursive: true });
// --imports N (dense only): another density, for diagnostics (ADR-082).
const m = process.argv.indexOf('--imports');
if (m > -1 && shape !== 'dense') throw new Error('--imports applies to --shape dense only');
const { commits, expected } = shape
  ? buildExactCapacityCommits({ shape, head, ...(m > -1 ? { imports: Number(process.argv[m + 1]) } : {}) })
  : buildMediumHistoryCommits({ files, commits: head ? 1 : 40, packages: 10, language });
const fixture = createGitFixture(commits, { parent });
// Generated synthetic data can be read by the production sandbox UID via a
// read-only bind mount on Linux. Other fixtures or repositories are untouched.
chmodSync(fixture.dir, 0o755);
const metadata = { directory: fixture.dir, selectedCommit: fixture.commits.at(-1), files, commits: commits.length, language, mode: head ? 'head' : 'history', policy: shape ? expected.policy : language === 'typescript' ? null : PYTHON_CAPACITY_POLICY, ...(shape ? { shape, expected } : {}) };
writeFileSync(path.join(fixture.dir, 'atlas-capacity-fixture.json'), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(JSON.stringify(metadata));
