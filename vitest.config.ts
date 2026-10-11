import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const packagesDir = fileURLToPath(new URL('./packages/', import.meta.url));
const physicalGates = process.env['ATLAS_CONTAINER_TESTS'] === '1'
  || process.env['ATLAS_REQUIRE_HOSTED_TESTS'] === '1'
  || Boolean(process.env['ATLAS_TEST_DATABASE_URL']);

export default defineConfig({
  resolve: {
    // Tests run against package sources so a stale dist/ can never mask a regression.
    alias: [
      { find: /^@atlas\/(api|worker)$/, replacement: `${fileURLToPath(new URL('./apps/', import.meta.url))}$1/src/index.ts` },
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
    // Each file can launch two parser children or cgroup-limited Docker jobs.
    // Bound file concurrency so the complete integration run does not oversubscribe
    // the host and turn functional deadlines into contention failures.
    // Physical fault tests intentionally exhaust memory/PIDs and kill processes.
    // Run their files without unrelated integration files competing for the host;
    // queue/lease/ownership races still create explicit concurrency inside each test.
    maxWorkers: physicalGates ? 1 : 2,
  },
});
