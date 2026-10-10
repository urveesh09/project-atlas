/**
 * Independent expected facts for the Harbor demo at HEAD, written by hand from the demo
 * sources and the plan's resolution rules (§9.3) — never by running the analyzer.
 *
 * Tuple: [kind, specifier, status, target (path, package or builtin), confidence, reason]
 */
export type ExpectedImport = readonly [
  kind: string,
  specifier: string,
  status: string,
  target: string | null,
  confidence: string | null,
  reason: string | null,
];

export const DEMO_HEAD_FILES: readonly string[] = [
  '.gitignore',
  'README.md',
  'assets/harbor.png',
  'assets/logo.svg',
  'package.json',
  'packages/geo/package.json',
  'packages/geo/src/distance.ts',
  'packages/geo/src/index.ts',
  'packages/geo/src/route.ts',
  'packages/ledger/package.json',
  'packages/ledger/src/index.ts',
  'packages/ledger/src/money.ts',
  'packages/ledger/tsconfig.json',
  'src/main.tsx',
  'src/server/db.cjs',
  'src/server/handlers.ts',
  'src/server/pricing.ts',
  'src/server/router.ts',
  'src/server/store.json',
  'src/ui/Dock.tsx',
  'src/ui/Manifest.tsx',
  'src/ui/index.ts',
  'src/ui/styles.css',
  'src/ui/theme.json',
  'tests/pricing.test.ts',
  'tsconfig.json',
];

const LEDGER = 'packages/ledger/src/index.ts';

export const DEMO_HEAD_IMPORTS: Readonly<Record<string, readonly ExpectedImport[]>> = {
  // geo has no tsconfig and the root config includes only src/ and tests/: ancestor context.
  'packages/geo/src/index.ts': [
    ['reexports-value', './distance', 'resolved-internal', 'packages/geo/src/distance.ts', 'inferred', null],
    ['reexports-value', './route', 'resolved-internal', 'packages/geo/src/route.ts', 'inferred', null],
  ],
  'packages/geo/src/route.ts': [['imports-value', './distance', 'resolved-internal', 'packages/geo/src/distance.ts', 'inferred', null]],
  'packages/geo/src/distance.ts': [],
  'packages/ledger/src/index.ts': [['reexports-value', './money', 'resolved-internal', 'packages/ledger/src/money.ts', 'exact', null]],
  'packages/ledger/src/money.ts': [['imports-value', 'decimal.js', 'resolved-external', 'decimal.js', 'exact', null]],
  'src/main.tsx': [
    ['imports-value', '@harbor/geo', 'resolved-internal', 'packages/geo/src/index.ts', 'inferred', 'WORKSPACE_PACKAGE_MAP'],
    // The ledger's declared entry points live in an uncommitted dist/; mapped through its tsconfig.
    ['imports-type', '@harbor/ledger', 'resolved-internal', LEDGER, 'inferred', 'WORKSPACE_SOURCE_FALLBACK'],
    ['imports-value', '@ui/index', 'resolved-internal', 'src/ui/index.ts', 'exact', null],
    ['imports-resource', './ui/theme.json', 'resolved-internal', 'src/ui/theme.json', 'exact', null],
    ['imports-value', './server/router', 'resolved-internal', 'src/server/router.ts', 'exact', null],
    ['imports-dynamic-literal', './server/pricing', 'resolved-internal', 'src/server/pricing.ts', 'exact', null],
  ],
  'src/ui/index.ts': [
    ['reexports-value', './Dock', 'resolved-internal', 'src/ui/Dock.tsx', 'exact', null],
    ['reexports-value', './Manifest', 'resolved-internal', 'src/ui/Manifest.tsx', 'exact', null],
  ],
  'src/ui/Dock.tsx': [
    ['imports-resource', './styles.css', 'resolved-internal', 'src/ui/styles.css', 'inferred', null],
    ['imports-value', 'react', 'resolved-external', 'react', 'exact', null],
  ],
  'src/ui/Manifest.tsx': [['imports-type', '@harbor/ledger', 'resolved-internal', LEDGER, 'inferred', 'WORKSPACE_SOURCE_FALLBACK']],
  'src/server/router.ts': [['imports-value', './handlers', 'resolved-internal', 'src/server/handlers.ts', 'exact', null]],
  'src/server/handlers.ts': [
    ['imports-value', './router', 'resolved-internal', 'src/server/router.ts', 'exact', null],
    ['imports-value', './pricing', 'resolved-internal', 'src/server/pricing.ts', 'exact', null],
  ],
  'src/server/pricing.ts': [
    ['imports-type', './handlers', 'resolved-internal', 'src/server/handlers.ts', 'exact', null],
    ['imports-value', '@harbor/ledger', 'resolved-internal', LEDGER, 'inferred', 'WORKSPACE_SOURCE_FALLBACK'],
  ],
  // .cjs is outside the root config's TS-only include set (allowJs is off): ancestor context.
  'src/server/db.cjs': [
    ['requires-literal', 'node:path', 'builtin', 'path', 'exact', null],
    ['imports-resource', './store.json', 'resolved-internal', 'src/server/store.json', 'inferred', null],
  ],
  'tests/pricing.test.ts': [
    ['imports-value', 'vitest', 'resolved-external', 'vitest', 'exact', null],
    ['imports-value', '../src/server/pricing', 'resolved-internal', 'src/server/pricing.ts', 'exact', null],
  ],
};

/** The rename in commit 7 (index 6) is a pure rename detected by Git at 100%. */
export const DEMO_RENAME = { commitIndex: 6, from: 'src/ui/Cargo.tsx', to: 'src/ui/Manifest.tsx', similarity: 100 } as const;
