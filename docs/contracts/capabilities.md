# Language and configuration capabilities: implementation status

This tracks plan §4.1 against code through Phase 4. TS/JS analysis uses isolated parsing and a tested virtual resolver; the production city consumes the same validated artifacts. First-parent history, sampled frames, conservative lineage, prior-window churn/hotspots and fixed-plot A/B comparison are implemented. Unsupported/missing historical data retains availability labels. Unsupported languages remain visible opaque buildings and are not claimed as analyzed.

| Input | Treatment | Status |
|---|---|---|
| `.ts .tsx .mts .cts .js .jsx .mjs .cjs` | Parse with TypeScript 6.0.3; imports; declarations; line/complexity metrics | Done (P2.1): `extract.ts`, `complexity.ts` |
| `.d.ts .d.mts .d.cts` | Declaration role; parsed; excluded from executable complexity | Done (P1.2/P2.1) |
| ESM value/type/mixed, side effect, namespace, `export *`, `export * as`, type re-exports, import-equals, `import()` types | Edge kinds per plan §6.3 | Done (P2.1), tested |
| Literal dynamic `import()` and unshadowed literal `require()` | Static candidates | Done (P2.1), lexical shadowing tests |
| Non-literal dynamic import/require, `require.resolve`, `import.meta.glob` | Unsupported observation, no specifier | Done (P2.1), tested |
| `tsconfig.json`/`jsconfig.json` JSONC, relative `extends`, `paths`, references | Virtual-FS parse; depth/cycle/escape checks; plugins stripped | Done (P2.2), zero host/network access instrumented |
| Package `extends` | Context marked incomplete (`CONFIG_EXTENDS_EXTERNAL`) | Done (P2.2), tested |
| npm/pnpm workspaces | Workspace map from `workspaces` and `pnpm-workspace.yaml` | Done (P1.3/P2.2), tested |
| `exports` conditions, self-name imports | Through the compiler with the virtual workspace map | Done (P2.2), tested |
| Node built-ins | Pinned list from Node 24.15.0; `node:`-only modules handled | Done (P2.2), tested |
| External npm packages | Declared (exact) or undeclared (inferred) | Done (P2.2), tested |
| URL imports | Unsupported, never fetched | Done (P2.2), tested |
| Flow, Vue/Svelte SFC, MDX, Astro, CoffeeScript | Opaque files with `FLOW_UNSUPPORTED` / `LANGUAGE_UNSUPPORTED` | Done (P1.2) |
| Lockfiles | Structural only, content never read (`LOCKFILE_STRUCTURAL`) | Done (P1.2) |
| JSON, styles, images, fonts, media | Asset buildings; byte size only | Done (P1.2) |
| Symlinks, submodules, LFS pointers | Excluded (`SYMLINK`, `SUBMODULE`) or opaque (`LFS_NOT_FETCHED`); never followed or fetched | Done (P1.2) |
| `atlas.config.json` | Versioned `exclude` globs; unknown keys warn. Unspecified display overrides deferred beyond V0.1 (ADR-020) | Exclusions done (P1.2); no arbitrary styling/metric plugins |
