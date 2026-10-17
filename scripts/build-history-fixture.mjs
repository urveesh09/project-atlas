#!/usr/bin/env node
/** Prepared trusted synthetic objects for an offline, resource-constrained capacity run. */
import { mkdirSync, chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitFixture } from '../packages/test-fixtures/dist/index.js';
import { buildMediumHistoryCommits } from './lib/medium-history.mjs';
import { capacityLanguage } from './lib/capacity-language.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const i = process.argv.indexOf('--files');
const files = i < 0 ? 9740 : Number(process.argv[i + 1]);
const head = process.argv.includes('--head');
const at = process.argv.indexOf('--language');
const language = capacityLanguage(at < 0 ? 'typescript' : process.argv[at + 1] ?? '');
if (!Number.isInteger(files) || files < 1 || files > (head ? 9850 : 9740)) throw new Error('Fixture exceeds the source-file allowance for this capacity mode');
const parent = path.join(root, '.atlas-tmp', 'capacity-fixtures');
mkdirSync(parent, { recursive: true });
const { commits } = buildMediumHistoryCommits({ files, commits: head ? 1 : 40, packages: 10, language });
const fixture = createGitFixture(commits, { parent });
// Generated synthetic data can be read by the production sandbox UID via a
// read-only bind mount on Linux. Other fixtures or repositories are untouched.
chmodSync(fixture.dir, 0o755);
const metadata = { directory: fixture.dir, selectedCommit: fixture.commits.at(-1), files, commits: commits.length, language, mode: head ? 'head' : 'history' };
writeFileSync(path.join(fixture.dir, 'atlas-capacity-fixture.json'), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(JSON.stringify(metadata));
