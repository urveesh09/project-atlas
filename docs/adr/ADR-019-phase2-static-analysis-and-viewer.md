# ADR-019 — Phase 2 static analysis and functional viewer gate

**Status:** accepted. **Date:** 2026-10-10. **Scope:** P2.1–P2.6 / M2 / Gate G2.

## Decisions confirmed

1. Keep the pinned TypeScript Compiler API and constrained virtual resolver from ADR-013/015. Real filesystem/network watchers in resolver tests observe zero calls; the filesystem control proves that the instrumentation is active. No repository install, executable config or host `node_modules` fallback is added.
2. Parse in dedicated bounded child processes, retain only plain facts, and validate cached facts against their source/version identity. Syntax/stack/timeout/crash failure carries unavailable metrics; no guessed dependencies from broken syntax. Timeout tests prove the child process is gone rather than only rejecting a promise.
3. Treat static dependencies as directed importer-to-target relationships with grouped observations. Degree includes literal dynamic imports; synchronous value-cycle policy excludes dynamic/type/resource edges. Iterative graph algorithms avoid recursion limits and retain deterministic witnesses and bounded reach.
4. Share one authored rule catalog between analyzer and viewer. A finding supplies raw values/ranges/import evidence/member lists, severity/version and the applicable limitations. Historical change concentration and hotspot scores remain unavailable until Phase 4.
5. Deliver a semantic HTML explorer first, with keyboard search/tree/inspector/dependencies/findings and explicitly attached read-only source. Production 3D rendering remains Phase 3. Local artifact opening validates in a browser worker without uploading data.
6. Keep `atlas serve` loopback-only with single-use capability bootstrap, session cookie, Host/Origin protections and exact listed artifact/source access. Commit/source mismatch disables source without losing graph navigation.
7. Adopt ADR-018's lossless indexed transport to meet the original 5 MiB medium target. Full canonical SHA-256 IDs, evidence, declarations, coverage and metrics remain unchanged. Existing artifacts are readable; hostile indexed inputs have separate expansion/integrity gates.
8. CI installs Chromium before `pnpm verify`; verification builds the viewer before browser tests. CI requires browser tests explicitly, preventing a missing prerequisite from silently skipping the gate. Test-only DOM declarations type-check the browser helper callbacks without widening production Node packages.

## Evidence

- Syntax/complexity: `packages/analyzer-ts/test/{extract,complexity}.test.ts` with independent expectations.
- Resolution: `packages/analyzer-ts/test/resolve.test.ts`, including armed filesystem/network instrumentation.
- Graph: `packages/graph/test/graph.test.ts`, including 20,000-node/100,000-edge internal scale fixtures.
- Findings/Harbor: `packages/analyzer-core/test/analyze.test.ts`, independent import/cycle/degree expectations and metric/null checks.
- Child isolation/cache: `packages/analyzer-core/test/parse-pool.test.ts`.
- Transport: `packages/artifact/test/{artifact,indexed-graph}.test.ts`, Node/browser and legacy round trips plus hostile metadata/indices/limits/hashes.
- Local server: 13 security tests in `packages/cli/test/serve.test.ts`.
- Viewer: 8 real Chromium journeys in `packages/cli/test/viewer.e2e.test.ts`, keyboard navigation, source, deep links and no-upload file import.
- Performance: [Phase 2 analysis report](../benchmarks/phase2-analysis.md), 20 measured cold-cache runs after warm-up, time and size required together. [Legacy report](../benchmarks/phase2-analysis-legacy.md) records the pre-codec baseline and its size failure.
- Visual evidence: `docs/images/phase2-{overview,dependencies,findings}.png`, captured from the actual Harbor artifact with Playwright.

## Limits retained

Full verification passes 417 tests across 20 files on local Windows and on Windows/Linux CI. [CI run 38053717357](https://github.com/urveesh09/project-atlas/actions/runs/38053717357) also passes the separate live-acquisition job (41/41, including the two opt-in tests) and informational software-GL rendering. The benchmark records actual hardware and does not imply hosted isolation/reference-GPU budgets have already passed. Product file limits are unchanged despite larger internal graph test fixtures. History flags are validated/recorded but their implementation is Phase 4. The local functional viewer is not the production miniature city; no hosted product, private repository access, runtime instrumentation, AI inference or repository execution is introduced.
