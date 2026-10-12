#!/usr/bin/env node
/**
 * Release guard (ADR-044): a tag `vX.Y.Z[-pre]` may only release the exact version every
 * published package declares. Prints the version on success.
 *
 *   node scripts/check-release-version.mjs v0.1.0-beta.1
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tag = process.argv[2] ?? '';
const match = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag);
if (!match) {
  console.error(`Not a release tag: "${tag}". Expected vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-prerelease.`);
  process.exit(1);
}
const version = match[1];
if (version.endsWith('-dev')) {
  console.error(`"${version}" is a development version; set the release version before tagging.`);
  process.exit(1);
}
const manifests = ['package.json', 'packages/cli/package.json', 'apps/web/package.json'];
const mismatched = [];
for (const file of manifests) {
  const declared = JSON.parse(await readFile(path.join(root, file), 'utf8')).version;
  if (declared !== version) mismatched.push(`${file} declares ${declared}`);
}
if (mismatched.length) {
  console.error(`Tag ${tag} does not match: ${mismatched.join('; ')}.`);
  process.exit(1);
}
console.log(version);
