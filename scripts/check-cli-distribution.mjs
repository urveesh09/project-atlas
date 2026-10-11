#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packed = JSON.parse(execFileSync(process.execPath, [path.join(root, 'scripts/package-cli.mjs')], { cwd: root, encoding: 'utf8', windowsHide: true }));
const result = path.join(path.dirname(packed.bundle), 'package-result.json');
execFileSync(process.execPath, [path.join(root, 'scripts/verify-cli-package.mjs'), result], { cwd: root, stdio: 'inherit', windowsHide: true });
// Convenient stable pointer for maintainers and CI; all builds use fresh directories.
await writeFile(path.join(root, '.atlas-tmp/cli-distribution-result.json'), `${JSON.stringify(packed, null, 2)}\n`);
