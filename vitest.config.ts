import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const packagesDir = fileURLToPath(new URL('./packages/', import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against package sources so a stale dist/ can never mask a regression.
    alias: [
      { find: /^@atlas\/artifact\/node$/, replacement: `${packagesDir}artifact/src/node-entry.ts` },
      { find: /^@atlas\/([a-z-]+)$/, replacement: `${packagesDir}$1/src/index.ts` },
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/api/test/**/*.test.ts', 'apps/worker/test/**/*.test.ts', 'apps/web/test/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['scripts/vitest-global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
});
