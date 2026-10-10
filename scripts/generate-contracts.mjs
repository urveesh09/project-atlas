#!/usr/bin/env node
/**
 * Writes generated contract documents from @atlas/schema (build it first):
 *   packages/schema/generated/<name>.schema.json   JSON Schema 2020-12 per artifact chunk
 *   docs/api/openapi.json                           OpenAPI 3.1 for the hosted API
 * With --check, fails if the committed files differ from freshly generated output.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'packages/schema/dist/index.js');
if (!existsSync(dist)) {
  console.error('Build @atlas/schema first (pnpm build).');
  process.exit(1);
}
const schema = await import(pathToFileURL(dist).href);
const check = process.argv.includes('--check');

const outputs = new Map();
for (const [name, document] of Object.entries(schema.artifactJsonSchemas())) {
  outputs.set(path.join(root, 'packages/schema/generated', `${name}.schema.json`), document);
}
outputs.set(path.join(root, 'docs/api/openapi.json'), schema.openApiDocument());

const stale = [];
for (const [file, document] of outputs) {
  const text = `${JSON.stringify(document, null, 2)}\n`;
  if (check) {
    const current = existsSync(file) ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null;
    if (current !== text) stale.push(path.relative(root, file));
  } else {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}
if (stale.length > 0) {
  console.error(`Generated contracts are out of date; run pnpm contracts:generate:\n${stale.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log(check ? `Contracts up to date (${outputs.size} files).` : `Wrote ${outputs.size} contract files.`);
