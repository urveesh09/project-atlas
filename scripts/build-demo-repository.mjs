#!/usr/bin/env node
/** Create a fresh authored Harbor repository; never reuse, reset or execute target code. */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildDemoRepository } from '../packages/test-fixtures/dist/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { parent: { type: 'string' } }, allowPositionals: false });
const parent = path.resolve(values.parent ?? path.join(root, '.atlas-tmp/demo'));
await mkdir(parent, { recursive: true });
const demo = buildDemoRepository({ parent });
// Intentionally retained: the user analyzes this committed fixture with the CLI.
console.log(JSON.stringify({ repository: demo.dir, commits: demo.commits.length }));
