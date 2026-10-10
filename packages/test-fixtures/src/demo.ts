import { createGitFixture, type FixtureCommit, type GitFixture } from './git-fixture.js';

/**
 * "Harbor" — the authored ATLAS demo repository (plan §3.4). It is ordinary TS/JS data
 * with a real Git history, analyzed by the same analyzer as any other repository. It
 * contains two workspace packages, a UI folder, a server folder, tests, assets, a barrel,
 * a static import cycle, a complex file that grows over time and a renamed file.
 *
 * Commit dates and the fixture identity are fixed, so commit IDs are reproducible.
 */

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function pricing(version: 1 | 2 | 3 | 4): string {
  const rules = [
    `  if (cargo.weightKg <= 0) throw new RangeError('weight must be positive');`,
    `  let fee = base(cargo.weightKg);`,
    version >= 2 ? `  if (cargo.hazardous) fee *= 1.5;\n  if (cargo.refrigerated && cargo.weightKg > 500) fee += 120;` : '',
    version >= 3
      ? [
          `  for (const leg of cargo.legs ?? []) {`,
          `    if (leg.nights > 2 || (leg.port === 'north' && !cargo.priority)) fee += leg.nights * 15;`,
          `    else if (leg.port === 'south') fee += 10;`,
          `  }`,
          `  fee = cargo.discount ? fee - (cargo.discount ?? 0) : fee;`,
        ].join('\n')
      : '',
    version >= 4
      ? [
          `  switch (cargo.season) {`,
          `    case 'peak':`,
          `      fee *= 1.2;`,
          `      break;`,
          `    case 'storm':`,
          `      fee *= cargo.priority ? 1.4 : 1.6;`,
          `      break;`,
          `    default:`,
          `      break;`,
          `  }`,
          `  while (fee > 10_000 && cargo.capped) fee -= 500;`,
          `  try {`,
          `    fee = roundToCents(fee);`,
          `  } catch {`,
          `    fee = Math.round(fee);`,
          `  }`,
        ].join('\n')
      : '',
    `  return fee;`,
  ].filter((line) => line !== '');
  return [
    `import type { Cargo } from './handlers';`,
    `import { roundToCents } from '@harbor/ledger';`,
    ``,
    `const base = (kg: number) => (kg < 100 ? 25 : kg < 1000 ? 60 : 140);`,
    ``,
    `export function quote(cargo: Cargo): number {`,
    ...rules,
    `}`,
    ``,
  ].join('\n');
}

const DATE = (day: string) => `${day}T09:30:00Z`;

export const DEMO_COMMITS: readonly FixtureCommit[] = [
  {
    date: DATE('2026-07-20'),
    message: 'Scaffold harbor workspace',
    files: {
      'package.json': json({
        name: 'harbor',
        private: true,
        type: 'module',
        workspaces: ['packages/*'],
        dependencies: { react: '^19.0.0', zod: '^4.0.0' },
        devDependencies: { vitest: '^5.0.0', typescript: '^6.0.0' },
      }),
      'tsconfig.json': `{
  // Root project: application, UI, server and tests.
  "compilerOptions": {
    "module": "esnext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "paths": { "@ui/*": ["./src/ui/*"] },
  },
  "include": ["src", "tests"],
}
`,
      'README.md': '# Harbor\n\nA tiny port-logistics demo used by ATLAS.\n',
      '.gitignore': 'node_modules/\ndist/\n',
      'packages/geo/package.json': json({ name: '@harbor/geo', type: 'module', exports: { '.': './src/index.ts' } }),
      'packages/geo/src/index.ts': `export * from './distance';\n`,
      'packages/geo/src/distance.ts': `export const toRadians = (deg: number) => (deg * Math.PI) / 180;\n\nexport function haversineKm(a: [number, number], b: [number, number]): number {\n  const [lat1, lon1] = a.map(toRadians) as [number, number];\n  const [lat2, lon2] = b.map(toRadians) as [number, number];\n  const h = Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2;\n  return 2 * 6371 * Math.asin(Math.sqrt(h));\n}\n`,
      'src/main.tsx': `import { haversineKm } from '@harbor/geo';\n\nexport const distance = haversineKm([0, 0], [1, 1]);\n`,
    },
  },
  {
    date: DATE('2026-07-24'),
    message: 'Add ledger package',
    files: {
      'packages/ledger/package.json': json({ name: '@harbor/ledger', main: 'dist/index.js', types: 'dist/index.d.ts', dependencies: { 'decimal.js': '^10.4.0' } }),
      'packages/ledger/tsconfig.json': json({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler', outDir: 'dist', rootDir: 'src', declaration: true }, include: ['src'] }),
      'packages/ledger/src/index.ts': `export * from './money';\n`,
      'packages/ledger/src/money.ts': `import Decimal from 'decimal.js';\n\nexport interface Money { cents: number; currency: 'EUR' | 'USD' }\n\nexport const roundToCents = (value: number) => new Decimal(value).toDecimalPlaces(2).toNumber();\n`,
    },
  },
  {
    date: DATE('2026-07-29'),
    message: 'Add dock and cargo UI',
    files: {
      'src/ui/index.ts': `export * from './Dock';\nexport * from './Cargo';\n`,
      'src/ui/Dock.tsx': `import './styles.css';\nimport { useState } from 'react';\n\nexport function Dock({ berth }: { berth: number }) {\n  const [open, setOpen] = useState(false);\n  return <button onClick={() => setOpen(!open)}>Berth {berth} {open ? 'open' : 'closed'}</button>;\n}\n`,
      'src/ui/Cargo.tsx': `import type { Money } from '@harbor/ledger';\n\nexport function CargoRow({ label, value }: { label: string; value: Money }) {\n  return <tr><td>{label}</td><td>{value.cents / 100}</td></tr>;\n}\n`,
      'src/ui/styles.css': `.dock { padding: 8px; }\n`,
      'src/ui/legacy.ts': `export const LEGACY_BANNER = 'old banner';\n`,
    },
  },
  {
    date: DATE('2026-08-03'),
    message: 'Add server router, handlers and pricing',
    files: {
      'src/server/router.ts': `import { handleQuote } from './handlers';\n\nexport const routes = { '/quote': handleQuote };\nexport type Route = keyof typeof routes;\n`,
      'src/server/handlers.ts': `import { routes } from './router';\nimport { quote } from './pricing';\n\nexport interface Cargo {\n  weightKg: number;\n  hazardous?: boolean;\n  refrigerated?: boolean;\n  priority?: boolean;\n  capped?: boolean;\n  discount?: number;\n  season?: 'peak' | 'storm' | 'calm';\n  legs?: { port: string; nights: number }[];\n}\n\nexport function handleQuote(cargo: Cargo) {\n  return { fee: quote(cargo), known: Object.keys(routes).length };\n}\n`,
      'src/server/pricing.ts': pricing(1),
    },
  },
  { date: DATE('2026-08-10'), message: 'Price hazardous and refrigerated cargo', files: { 'src/server/pricing.ts': pricing(2) } },
  {
    date: DATE('2026-08-17'),
    message: 'Add tests and assets',
    files: {
      'tests/pricing.test.ts': `import { describe, expect, it } from 'vitest';\nimport { quote } from '../src/server/pricing';\n\ndescribe('quote', () => {\n  it('charges a base fee', () => expect(quote({ weightKg: 10 })).toBe(25));\n});\n`,
      'assets/logo.svg': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>\n`,
      'assets/harbor.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]),
    },
  },
  {
    date: DATE('2026-08-25'),
    message: 'Rename cargo row to manifest',
    renames: [['src/ui/Cargo.tsx', 'src/ui/Manifest.tsx']],
    files: { 'src/ui/index.ts': `export * from './Dock';\nexport * from './Manifest';\n` },
  },
  {
    date: DATE('2026-09-02'),
    message: 'Add route planning to geo',
    files: {
      'packages/geo/src/index.ts': `export * from './distance';\nexport * from './route';\n`,
      'packages/geo/src/route.ts': `import { haversineKm } from './distance';\n\nexport function routeKm(points: [number, number][]): number {\n  let total = 0;\n  for (let i = 1; i < points.length; i++) total += haversineKm(points[i - 1]!, points[i]!);\n  return total;\n}\n`,
    },
  },
  { date: DATE('2026-09-09'), message: 'Charge per leg', files: { 'src/server/pricing.ts': pricing(3) } },
  {
    date: DATE('2026-09-16'),
    message: 'Add legacy storage adapter and theme',
    files: {
      'src/server/db.cjs': `const path = require('node:path');\nconst store = require('./store.json');\n\nmodule.exports = { file: path.join('data', 'harbor.db'), store };\n`,
      'src/server/store.json': json({ berths: 12 }),
      'src/ui/theme.json': json({ accent: '#2f4f78' }),
    },
  },
  {
    date: DATE('2026-09-23'),
    message: 'Wire app shell',
    files: {
      'src/main.tsx': `import { haversineKm, routeKm } from '@harbor/geo';\nimport type { Money } from '@harbor/ledger';\nimport { Dock, CargoRow } from '@ui/index';\nimport theme from './ui/theme.json';\nimport { routes } from './server/router';\n\nexport const distance = haversineKm([0, 0], [1, 1]) + routeKm([]);\nexport const budget: Money = { cents: 0, currency: 'EUR' };\nexport const app = { Dock, CargoRow, theme, routes };\n\nexport async function loadPricing() {\n  const { quote } = await import('./server/pricing');\n  return quote;\n}\n`,
    },
  },
  {
    date: DATE('2026-10-01'),
    message: 'Seasonal pricing; drop legacy banner',
    files: { 'src/server/pricing.ts': pricing(4), 'src/ui/legacy.ts': null },
  },
];

export function buildDemoRepository(options: { parent?: string } = {}): GitFixture {
  return createGitFixture(DEMO_COMMITS, options);
}
