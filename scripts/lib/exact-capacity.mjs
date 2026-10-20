import assert from 'node:assert/strict';

/**
 * The plan's exact capacity fixtures (plan §15.1, ADR-082), as deterministic TypeScript
 * repositories. Unlike the near-limit fixture (medium-history.mjs), every count is
 * constructed, not sampled, so a report can assert it:
 *
 * - `exact`: 40 mainline commits whose 12 selected frames each hold exactly `files`
 *   included files and `edges` dependency edges, and whose frames together hold exactly
 *   `union` file lineages. Stable modules are the only import targets and never move.
 *   Churning modules are leaves, replaced first in, first out: deleted in one commit and
 *   succeeded by new paths in the next, so no diff can pair them as renames.
 * - `dense`: one commit with `files` included files whose distinct imports (`imports` per
 *   module, ten hubs imported by every module) exceed the edge and evidence-row ceilings and
 *   the decoded chunk ceiling, which the analyzer meets with fewer evidence rows (ADR-083).
 *
 * Pure: the same options always produce identical commits. `expected` states the counts
 * the analyzer must report.
 */
export const EXACT_CAPACITY_POLICY = 'atlas.capacity.exact/1';
export const EXACT_CAPACITY_SHAPES = ['exact', 'dense'];

const PACKAGES = 10;
const DIRECTORIES = 12;
const COMMITS = 40;
const FRAMES = 12;
const EXTERNALS = ['react', 'zod', 'lodash', 'node:fs'];

/** The structural frame indices of `selectFrameIndices` (packages/history) for 40 commits. */
export function frameCommitIndices(commits = COMMITS, frames = FRAMES) {
  const k = Math.min(commits, frames);
  const indices = new Set(Array.from({ length: k }, (_, i) => Math.floor((i * (commits - 1)) / (k - 1))));
  return [...indices, commits - 1].filter((v, i, all) => all.indexOf(v) === i).sort((a, b) => a - b);
}

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

/** Files every frame shares that carry no imports: manifests, package entries and type modules. */
function fixedFiles() {
  const files = {
    'package.json': JSON.stringify({ name: 'bench', private: true, workspaces: ['packages/*'] }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler', strict: true }, include: ['packages'] }),
  };
  for (let p = 0; p < PACKAGES; p++) {
    files[`packages/p${p}/package.json`] = JSON.stringify({ name: `@bench/p${p}`, exports: { '.': './src/index.ts', './*': './src/*.ts' } });
    files[`packages/p${p}/src/index.ts`] = 'export const version = 1;\n';
    for (let d = 0; d < DIRECTORIES; d++) files[`packages/p${p}/src/m${d}/types.ts`] = `export interface T${d} { a: number }\n`;
  }
  return files;
}
const FIXED = 2 + PACKAGES * (2 + DIRECTORIES);

/** A stable module: an import target that exists, unchanged in path, in every commit. */
const stablePath = (n) => `packages/p${n % PACKAGES}/src/m${Math.floor(n / PACKAGES) % DIRECTORIES}/s${n}.ts`;
const packageOf = (file) => Number(/^packages\/p(\d+)\//.exec(file)[1]);
const directoryOf = (file) => Number(/\/src\/m(\d+)\//.exec(file)[1]);

function specifier(from, target) {
  const p = packageOf(target);
  const module = target.replace(/^packages\/p\d+\/src\//, '').replace(/\.ts$/, '');
  return p === packageOf(from) ? `../${module}` : `@bench/p${p}/${module}`;
}

/**
 * One module with exactly `targets.length` distinct dependency edges: a type import, value
 * imports of stable modules and at most one external module. `variant` changes only the
 * body, so edits keep the edge set.
 */
function moduleText(file, name, targets, variant) {
  const lines = targets.map((target, k) => {
    if (target.external) return `import * as ext${k} from '${target.external}';`;
    if (target.type) return `import type { T${directoryOf(target.file)} } from '${specifier(file, target.file)}';`;
    const imported = /\/(s\d+)\.ts$/.exec(target.file)[1];
    return `import { ${imported} as v${k} } from '${specifier(file, target.file)}';`;
  });
  const branches = 1 + (variant % 14);
  const body = Array.from({ length: branches }, (_, b) => `  if (x > ${b} && x < ${b * 3 + 5 + variant}) return ${b};`).join('\n');
  lines.push(`export function ${name}(x: number): number {\n${body}\n  return x ? ${variant} : 0;\n}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Distinct targets for one module: one type module of its own package, up to one external,
 * then stable modules (two in three in its own package). `hubs` are imported first.
 */
function chooseTargets(file, count, stable, next, { hubs = [], self = -1 } = {}) {
  const p = packageOf(file);
  const targets = [{ type: true, file: `packages/p${p}/src/m${next() % DIRECTORIES}/types.ts` }];
  const chosen = new Set([self]);
  for (const hub of hubs) if (targets.length < count && !chosen.has(hub)) { chosen.add(hub); targets.push({ file: stablePath(hub) }); }
  if (targets.length < count && next() % 4 === 0) targets.push({ external: EXTERNALS[next() % EXTERNALS.length] });
  const local = stable.filter((n) => n % PACKAGES === p);
  while (targets.length < count) {
    const pool = next() % 3 < 2 && local.length > 1 ? local : stable;
    const n = pool[next() % pool.length];
    if (chosen.has(n)) continue;
    chosen.add(n);
    targets.push({ file: stablePath(n) });
  }
  return targets;
}

function day(n) {
  return new Date(Date.UTC(2026, 7, 1) + n * 36 * 3_600_000).toISOString();
}

/**
 * Options default to the plan's large tier and the analyzer's ceilings: 10,000 files and
 * 100,000 edges per frame, 20,000 lineages across frames. Smaller values build the same
 * shape for tests.
 */
export function buildExactCapacityCommits({ shape = 'exact', files = 10_000, edges = 100_000, union = 20_000, stable = 2_000, imports = 30, head = false } = {}) {
  assert(EXACT_CAPACITY_SHAPES.includes(shape), 'Shape must be exact or dense');
  const sources = files - FIXED;
  assert(Number.isInteger(sources) && sources > stable && stable > PACKAGES * 2, 'Too few files for the stable and churning modules');
  const next = random(0x2545f491);
  const stableIds = Array.from({ length: stable }, (_, n) => n);
  const base = fixedFiles();
  if (shape === 'dense') {
    // Ten hubs that every module imports, so the highest fan-in is the whole repository.
    const hubs = stableIds.slice(0, 10);
    assert(imports > hubs.length + 2 && imports <= stable, 'Dense modules need more distinct imports than hubs');
    let candidates = 0;
    for (let n = 0; n < sources; n++) {
      const file = n < stable ? stablePath(n) : `packages/p${n % PACKAGES}/src/m${n % DIRECTORIES}/c${n}.ts`;
      const targets = chooseTargets(file, imports, stableIds, next, { hubs, self: n < stable ? n : -1 });
      candidates += targets.length;
      base[file] = moduleText(file, n < stable ? `s${n}` : `c${n}`, targets, 0);
    }
    return { commits: [{ date: day(0), message: 'base', files: base }], expected: { shape, policy: EXACT_CAPACITY_POLICY, files, frames: 1, imports, edgeCandidates: candidates, hubFanIn: sources - 1 } };
  }

  // Exact: each module has `perModule` imports; the first `extra` stable modules one more.
  const perModule = Math.floor(edges / sources);
  const extra = edges - perModule * sources;
  assert(perModule >= 2 && extra <= stable, 'The edge target cannot be met with these module counts');
  const replacements = union - files;
  assert(replacements >= 0, 'The union cannot be smaller than one frame');
  const frameIndices = frameCommitIndices();
  const intervals = frameIndices.length - 1;
  const perInterval = Array.from({ length: intervals }, (_, j) => Math.floor(replacements / intervals) + (j < replacements % intervals ? 1 : 0));

  const texts = new Map();
  const targetsOf = new Map();
  for (const n of stableIds) {
    const file = stablePath(n);
    targetsOf.set(file, chooseTargets(file, perModule + (n < extra ? 1 : 0), stableIds, next, { self: n }));
    texts.set(file, { name: `s${n}`, variant: 0 });
  }
  let created = 0;
  const churnPath = (p, d, id) => `packages/p${p}/src/m${d}/c${id}.ts`;
  const newChurn = () => {
    const id = created++;
    const file = churnPath(id % PACKAGES, (id * 7) % DIRECTORIES, id);
    targetsOf.set(file, chooseTargets(file, perModule, stableIds, next));
    texts.set(file, { name: `c${id}`, variant: 0 });
    return file;
  };
  const queue = Array.from({ length: sources - stable }, newChurn); // oldest churning module first
  const render = (file) => moduleText(file, texts.get(file).name, targetsOf.get(file), texts.get(file).variant);
  for (const file of texts.keys()) base[file] = render(file);
  const commits = [{ date: day(0), message: 'base', files: base }];
  const live = () => [...stableIds.map(stablePath), ...queue];
  let renames = 0;

  for (let c = 1; c < COMMITS; c++) {
    const files = {};
    const commitRenames = [];
    const interval = frameIndices.findIndex((f, j) => f < c && c < (frameIndices[j + 1] ?? Infinity));
    const offset = interval < 0 ? -1 : c - frameIndices[interval];
    if (offset === 1) {
      // Retire the oldest churning modules: they were present in the previous frame.
      for (const file of queue.splice(0, perInterval[interval])) { files[file] = null; texts.delete(file); targetsOf.delete(file); }
    } else if (offset === 2) {
      // Their successors are new paths and new lineages, present from the next frame on.
      for (let k = 0; k < perInterval[interval]; k++) { const file = newChurn(); queue.push(file); files[file] = render(file); }
    } else if (frameIndices.includes(c) && c > 0) {
      // Frame commits rename a few churning modules within their directory; nothing imports them.
      const picked = new Set();
      for (let k = 0; k < 7 && picked.size < queue.length; k++) {
        const at = next() % queue.length;
        if (picked.has(at)) { k--; continue; }
        picked.add(at);
        const from = queue[at];
        const to = from.replace(/\/c(\d+)(?:r\d+)?\.ts$/, `/c$1r${c}.ts`);
        queue[at] = to;
        texts.set(to, texts.get(from)); texts.delete(from);
        targetsOf.set(to, targetsOf.get(from)); targetsOf.delete(from);
        commitRenames.push([from, to]);
        renames++;
      }
    }
    // About 40 body edits per commit, skewed towards a few hot modules; imports never change.
    const present = live();
    const changed = new Set([...Object.keys(files), ...commitRenames.flat()]);
    for (let k = 0; k < 40; k++) {
      const file = present[next() % 10 === 0 ? next() % 60 : next() % present.length];
      if (changed.has(file)) continue;
      texts.get(file).variant = c;
      files[file] = render(file);
    }
    commits.push({ date: day(c), message: `change ${c}`, files, renames: commitRenames });
  }
  const finalFiles = { ...fixedFiles(), ...Object.fromEntries(live().map((file) => [file, render(file)])) };
  const expected = { shape, policy: EXACT_CAPACITY_POLICY, files, edgesPerFrame: edges, union, frames: head ? 1 : frameIndices.length, renames: head ? 0 : renames };
  if (head) return { commits: [{ date: day(COMMITS - 1), message: 'head', files: finalFiles }], expected: { ...expected, union: files } };
  return { commits, expected };
}
