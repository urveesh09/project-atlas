#!/usr/bin/env node
/** Prepared trusted synthetic objects for an offline, resource-constrained capacity run. */
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitFixture } from '../packages/test-fixtures/dist/index.js';
import { buildMediumHistoryCommits } from './lib/medium-history.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const i = process.argv.indexOf('--files');
const files = i < 0 ? 9740 : Number(process.argv[i + 1]);
if (!Number.isInteger(files) || files < 1 || files > 9740) throw new Error('Files must be 1..9740 to keep all evolved frames within the file cap');
const parent = path.join(root, '.atlas-tmp', 'capacity-fixtures');
mkdirSync(parent, { recursive: true });
const { commits } = buildMediumHistoryCommits({ files, commits: 40, packages: 10 });
const fixture = createGitFixture(commits, { parent });
// Generated synthetic data can be read by the production sandbox UID via a
// read-only bind mount on Linux. Other fixtures or repositories are untouched.
chmodSync(fixture.dir, 0o755);
console.log(JSON.stringify({ directory: fixture.dir, selectedCommit: fixture.commits.at(-1), files, commits: 40 }));
