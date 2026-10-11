/**
 * The deterministic medium history fixture (bench-history.mjs, hosted rehearsal): about
 * 3,000 TypeScript files, ~30,000 imports and a mainline of edits, additions, renames and
 * deletions. Pure: the same arguments always produce identical commits.
 */
export function buildMediumHistoryCommits({ files: FILES = 3000, commits: COMMITS = 40, packages: PACKAGES = 10 } = {}) {
  let state = 0x2545f491;
  const next = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };

  const perPackage = Math.ceil(FILES / PACKAGES);
  function sourceFile(p, i, variant) {
    const lines = [];
    for (let k = 0; k < 10; k++) {
      const r = next() % 100;
      if (r < 70) {
        const j = next() % perPackage;
        lines.push(`import { f${j} } from '../m${j % 12}/f${j}';`);
      } else if (r < 85) lines.push(`import { f${next() % perPackage} as g${k} } from '@bench/p${next() % PACKAGES}/m0/f0';`);
      else if (r < 93) lines.push(`import type { T${k} } from '../m${(i + k) % 12}/types';`);
      else lines.push(`import * as ext${k} from '${['react', 'zod', 'node:fs', 'lodash'][next() % 4]}';`);
    }
    const branches = 1 + ((next() + variant) % 14);
    const body = Array.from({ length: branches }, (_, b) => `  if (x > ${b} && x < ${b * 3 + 5 + variant}) return ${b};`).join('\n');
    lines.push(`export function f${i}(x: number): number {\n${body}\n  return x ? ${variant} : 0;\n}`);
    return `${lines.join('\n')}\n`;
  }

  const base = {
    'package.json': JSON.stringify({ name: 'bench', private: true, workspaces: ['packages/*'] }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler', strict: true }, include: ['packages'] }),
  };
  const live = [];
  for (let p = 0; p < PACKAGES; p++) {
    base[`packages/p${p}/package.json`] = JSON.stringify({ name: `@bench/p${p}`, exports: { '.': './src/index.ts', './*': './src/*.ts' } });
    base[`packages/p${p}/src/index.ts`] = 'export const version = 1;\n';
    for (let d = 0; d < 12; d++) base[`packages/p${p}/src/m${d}/types.ts`] = 'export interface T0 { a: number }\n';
    for (let i = 0; i < perPackage; i++) {
      const file = `packages/p${p}/src/m${i % 12}/f${i}.ts`;
      base[file] = sourceFile(p, i, 0);
      live.push({ file, p, i });
    }
  }
  const day = (n) => new Date(Date.UTC(2026, 7, 1) + n * 36 * 3_600_000).toISOString();
  const commits = [{ date: day(0), message: 'base', files: base }];
  for (let c = 1; c < COMMITS; c++) {
    const files = {};
    const renames = [];
    // ~40 edits, hot files edited often (skewed), a few additions, deletions and renames.
    for (let k = 0; k < 40; k++) {
      const pick = live[(next() % 10 === 0 ? next() % 60 : next() % live.length)];
      if (pick) files[pick.file] = sourceFile(pick.p, pick.i, c);
    }
    for (let k = 0; k < 3; k++) {
      const p = next() % PACKAGES;
      const i = perPackage + c * 10 + k;
      const file = `packages/p${p}/src/m${i % 12}/f${i}.ts`;
      files[file] = sourceFile(p, i, c);
      live.push({ file, p, i });
    }
    if (c % 5 === 0) {
      const victim = live.splice(100 + (next() % 500), 1)[0];
      if (victim) files[victim.file] = null;
      const moved = live[200 + (next() % 500)];
      if (moved && !files[moved.file]) {
        const to = moved.file.replace('/src/', '/src/moved/');
        renames.push([moved.file, to]);
        moved.file = to;
      }
    }
    commits.push({ date: day(c), message: `change ${c}`, files, renames });
  }
  return { commits, baseFiles: Object.keys(base).length };
}
