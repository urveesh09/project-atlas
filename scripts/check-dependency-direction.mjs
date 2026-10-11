#!/usr/bin/env node
/**
 * Enforces the package dependency direction from plan §5.3 and the runtime deferral from
 * ADR-012. Checks both declared package.json dependencies and actual `@atlas/*` import
 * specifiers in source, so an undeclared cross-package import also fails.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Allowed internal runtime dependencies per package. Dev-only fixtures are always allowed. */
const ALLOWED = {
  '@atlas/schema': [],
  '@atlas/ingest': ['@atlas/schema'],
  '@atlas/analyzer-ts': ['@atlas/schema'],
  '@atlas/graph': ['@atlas/schema'],
  '@atlas/history': ['@atlas/schema', '@atlas/ingest'],
  '@atlas/layout': ['@atlas/schema'],
  '@atlas/artifact': ['@atlas/schema'],
  '@atlas/analyzer-core': ['@atlas/schema', '@atlas/ingest', '@atlas/analyzer-ts', '@atlas/graph', '@atlas/history', '@atlas/layout', '@atlas/artifact'],
  '@atlas/cli': ['@atlas/schema', '@atlas/ingest', '@atlas/analyzer-ts', '@atlas/analyzer-core', '@atlas/artifact', '@atlas/graph', '@atlas/layout', '@atlas/web'],
  '@atlas/test-fixtures': ['@atlas/schema'],
  // The viewer consumes artifacts, schema, graph queries and layout output only.
  '@atlas/web': ['@atlas/schema', '@atlas/artifact', '@atlas/graph', '@atlas/layout'],
  // Hosted control plane shared by the API and workers; it never analyzes source.
  '@atlas/control': ['@atlas/schema', '@atlas/ingest', '@atlas/artifact'],
  '@atlas/api': ['@atlas/schema', '@atlas/ingest', '@atlas/artifact', '@atlas/control'],
  '@atlas/worker': ['@atlas/schema', '@atlas/ingest', '@atlas/analyzer-core', '@atlas/artifact', '@atlas/control'],
};
const DEV_ALLOWED = ['@atlas/test-fixtures'];
// Worker integration fixtures use the API's real migration/admission against Postgres;
// this dependency is forbidden in worker runtime source.
const TEST_ONLY = { '@atlas/worker': ['@atlas/api'] };

/** Runtime instrumentation is out of scope for V0.1 (ADR-012). */
const FORBIDDEN_EXTERNAL = [/^@opentelemetry\//, /^dd-trace$/, /^newrelic$/, /^@sentry\//, /^elastic-apm/, /^applicationinsights$/];

const failures = [];
const packages = [];
for (const group of ['packages', 'apps']) {
  for (const name of readdirSync(path.join(root, group))) {
    const dir = path.join(root, group, name);
    try {
      packages.push({ dir, json: JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) });
    } catch {
      // not a package
    }
  }
}

function sourceFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = path.join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(?:[cm]?[jt]sx?)$/.test(entry)) out.push(full);
    }
  };
  for (const sub of ['src', 'test', 'scripts']) {
    try {
      walk(path.join(dir, sub));
    } catch {
      // absent
    }
  }
  return out;
}

for (const { dir, json } of packages) {
  const name = json.name;
  const allowed = ALLOWED[name];
  if (!allowed) {
    failures.push(`${name}: not listed in the dependency-direction policy`);
    continue;
  }
  const deps = Object.keys(json.dependencies ?? {});
  const devDeps = Object.keys(json.devDependencies ?? {});
  for (const dep of deps.filter((d) => d.startsWith('@atlas/'))) {
    if (!allowed.includes(dep)) failures.push(`${name} must not depend on ${dep}`);
  }
  for (const dep of devDeps.filter((d) => d.startsWith('@atlas/'))) {
    if (!allowed.includes(dep) && !DEV_ALLOWED.includes(dep) && !(TEST_ONLY[name] ?? []).includes(dep)) failures.push(`${name} must not dev-depend on ${dep}`);
  }
  for (const dep of [...deps, ...devDeps]) {
    if (FORBIDDEN_EXTERNAL.some((re) => re.test(dep))) failures.push(`${name} depends on runtime instrumentation (${dep}), deferred by ADR-012`);
  }
  for (const file of sourceFiles(dir)) {
    const text = readFileSync(file, 'utf8');
    const isTest = file.includes(`${path.sep}test${path.sep}`);
    for (const match of text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](@atlas\/[a-z-]+)(?:\/[a-z-]+)?['"]/g)) {
      const target = match[1];
      if (target === name) continue;
      const declared = deps.includes(target) || (isTest && devDeps.includes(target));
      if (!declared) failures.push(`${path.relative(root, file)} imports undeclared ${target}`);
      else if (!allowed.includes(target) && !(isTest && (DEV_ALLOWED.includes(target) || (TEST_ONLY[name] ?? []).includes(target)))) failures.push(`${path.relative(root, file)} imports forbidden ${target}`);
    }
  }
}

if (failures.length > 0) {
  console.error('Dependency direction violations:\n' + failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
console.log(`Dependency direction OK (${packages.length} packages).`);
