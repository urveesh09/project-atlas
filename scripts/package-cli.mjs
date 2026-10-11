#!/usr/bin/env node
/** P6 distribution candidate: self-contained JS, bundled viewer, Node/Git prerequisites.
 * No npm publication or install hooks. Output is a fresh directory below .atlas-tmp/releases.
 * Workspace packages keep their module/worker layout; only static files from @atlas/web
 * are needed at runtime. Native build tools and service secrets never enter the bundle.
 */
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releases = path.join(root, '.atlas-tmp/releases');
await mkdir(releases, { recursive: true });
const staging = await mkdtemp(path.join(releases, 'candidate-'));
const bundle = path.join(staging, 'atlas-cli');
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const copied = new Map();
const notices = new Map();
const workspace = (name) => name === '@atlas/web' ? path.join(root, 'apps/web') : path.join(root, 'packages', name.slice('@atlas/'.length));
const noticeNames = (entries) => entries.filter((e) => e.isFile() && /^(?:licen[sc]e|copying|notice|thirdparty)/i.test(e.name)).map((e) => e.name);
async function dependencyDirectory(dir, name) {
  if (name.startsWith('@atlas/')) return workspace(name);
  const require = createRequire(path.join(dir, 'package.json'));
  try { return path.dirname(require.resolve(`${name}/package.json`)); }
  catch (error) {
    if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
    let current = path.dirname(require.resolve(name));
    for (;;) {
      if ((await json(path.join(current, 'package.json')).catch(() => null))?.name === name) return current;
      const parent = path.dirname(current);
      assert(parent !== current, `No package boundary for ${name}`);
      current = parent;
    }
  }
}

async function collectNotices(dir, seen = new Set()) {
  dir = await realpath(dir);
  const pkg = await json(path.join(dir, 'package.json'));
  const id = `${pkg.name}@${pkg.version}`;
  if (seen.has(id)) return;
  seen.add(id);
  if (!pkg.name.startsWith('@atlas/')) {
    const names = noticeNames(await readdir(dir, { withFileTypes: true }));
    const supplied = id === '@react-three/fiber@9.8.1' ? 'react-three-fiber-9.8.1-LICENSE' : null;
    assert(names.length > 0 || supplied, `Missing third-party license text: ${id}`);
    const relative = `third-party/${pkg.name.replaceAll('/', '_')}@${pkg.version}`;
    await mkdir(path.join(bundle, relative), { recursive: true });
    for (const name of names) await cp(path.join(dir, name), path.join(bundle, relative, name));
    if (supplied) await cp(path.join(root, 'docs/release/licenses', supplied), path.join(bundle, relative, 'LICENSE'));
    notices.set(id, { name: pkg.name, version: pkg.version, license: pkg.license ?? 'SEE LICENSE', noticeDirectory: relative });
  }
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    await collectNotices(await dependencyDirectory(dir, name), seen);
  }
}

async function copyRuntime(dir) {
  dir = await realpath(dir);
  const pkg = await json(path.join(dir, 'package.json'));
  if (copied.has(pkg.name)) {
    assert.equal(copied.get(pkg.name), pkg.version, `Conflicting runtime versions: ${pkg.name}; use a version-aware deployment instead`);
    return;
  }
  copied.set(pkg.name, pkg.version);
  const target = pkg.name === '@atlas/cli' ? bundle : path.join(bundle, 'node_modules', pkg.name);
  await mkdir(target, { recursive: true });
  if (pkg.name.startsWith('@atlas/')) {
    await cp(path.join(dir, 'dist'), path.join(target, 'dist'), { recursive: true });
    if (pkg.bin) await cp(path.join(dir, 'bin'), path.join(target, 'bin'), { recursive: true });
  } else {
    // Third-party npm contents are shipped with their license text, without their
    // install-time node_modules or lifecycle execution.
    await cp(dir, target, { recursive: true, filter: (file) => path.basename(file) !== 'node_modules' });
  }
  // Workspace dependencies are satisfied by the copied closure. The viewer's React/
  // Three.js code is already inside its production assets; no server-side imports use it.
  const dependencies = pkg.name === '@atlas/web' ? {} : Object.fromEntries(Object.entries(pkg.dependencies ?? {}).map(([name, version]) => [name, version.startsWith('workspace:') ? '0.1.0-dev' : version]));
  const metadata = { ...pkg, private: true, dependencies };
  delete metadata.devDependencies;
  delete metadata.scripts;
  await writeFile(path.join(target, 'package.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  if (pkg.name === '@atlas/web') return;
  for (const name of Object.keys(pkg.dependencies ?? {})) await copyRuntime(await dependencyDirectory(dir, name));
}

await copyRuntime(workspace('@atlas/cli'));
await collectNotices(workspace('@atlas/cli'));
await cp(path.join(root, 'LICENSE'), path.join(bundle, 'LICENSE'));
await mkdir(path.join(bundle, 'docs'), { recursive: true });
for (const file of ['docs/contracts/cli.md', 'docs/contracts/capabilities.md', 'docs/contracts/metrics.md']) await cp(path.join(root, file), path.join(bundle, 'docs', path.basename(file)));
await writeFile(path.join(bundle, 'README.md'), [
  '# ATLAS CLI distribution candidate', '',
  'Prerequisites: Node 24.15.x and Git >= 2.38 on PATH. No package manager or dependency install is needed after extraction. This candidate is not a signed-off V0.1 release; see the repository release audit.', '',
  '```sh', 'node bin/atlas.js doctor', 'node bin/atlas.js analyze /path/to/repository --out /path/to/artifact', 'node bin/atlas.js verify /path/to/artifact', 'node bin/atlas.js serve /path/to/artifact --repo /path/to/repository --no-open', '```', '',
  'Committed data only; local commands never upload or fetch. To analyze another historical commit, pass --ref <sha>. To skip history, pass --no-history. Exit 0 = complete, 2 = useful partial, 1 = failure, 64 = usage error, 130 = cancelled.', '',
  'Exported artifacts reveal relative paths, declaration/package names, metrics and commit IDs even though source is omitted. Share them explicitly. Runtime tracing is deferred. Third-party licenses are under third-party/.', '',
].join('\n'));
await writeFile(path.join(bundle, 'third-party.json'), `${JSON.stringify([...notices.values()].sort((a, b) => a.name.localeCompare(b.name)), null, 2)}\n`);
const files = [];
async function inventory(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    assert(!(await lstat(full)).isSymbolicLink(), `Distribution must not depend on symlinks: ${full}`);
    if (entry.isDirectory()) await inventory(full);
    else {
      const bytes = await readFile(full);
      files.push({ path: path.relative(bundle, full).replaceAll('\\', '/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  }
}
await inventory(bundle);
files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const manifest = {
  format: 'atlas.cli-distribution/1', candidate: '0.1.0-candidate.1', node: process.version,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  workingTreeDirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0,
  lockfileSha256: createHash('sha256').update(await readFile(path.join(root, 'pnpm-lock.yaml'))).digest('hex'),
  packages: [...copied].map(([name, version]) => ({ name, version })), files,
};
await writeFile(path.join(bundle, 'distribution.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const archive = path.join(staging, 'atlas-cli-candidate.tar.gz');
execFileSync('tar', ['-czf', archive, '-C', staging, 'atlas-cli'], { windowsHide: true });
const archiveBytes = await readFile(archive);
const result = { bundle, archive, sha256: createHash('sha256').update(archiveBytes).digest('hex'), archiveBytes: archiveBytes.length, files: files.length, sourceCommit: manifest.sourceCommit, workingTreeDirty: manifest.workingTreeDirty };
await writeFile(path.join(staging, 'package-result.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
