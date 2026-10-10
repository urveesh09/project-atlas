# Language and configuration capabilities: implementation status

This tracks plan §4.1 against code. "Spike" means implemented and tested in Phase 0, then hardened in Phase 2.

| Input | Treatment | Status |
|---|---|---|
| `.ts .tsx .mts .cts .js .jsx .mjs .cjs` | Parse with TypeScript 6.0.3; imports; declarations | Spike (P0.2): `extract.ts` |
| `.d.ts .d.mts .d.cts` | Declaration role; parsed; excluded from complexity | Parsing done; roles in P1.2 |
| ESM value/type/mixed, side effect, namespace, `export *`, `export * as`, type re-exports, import-equals, `import()` types | Edge kinds per plan §6.3 | Spike, tested |
| Literal dynamic `import()` and unshadowed literal `require()` | Static candidates | Spike, with lexical shadowing tests |
| Non-literal dynamic import/require, `require.resolve`, `import.meta.glob` | Unsupported observation, no specifier | Spike, tested |
| `tsconfig.json`/`jsconfig.json` JSONC, relative `extends`, `paths`, references | Virtual-FS parse; depth/cycle/escape checks; plugins stripped | Spike, tested |
| Package `extends` | Context marked incomplete (`CONFIG_EXTENDS_EXTERNAL`) | Spike, tested |
| npm/pnpm workspaces | Workspace map from `workspaces` and `pnpm-workspace.yaml` | Spike, tested |
| `exports` conditions, self-name imports | Through the compiler with the virtual workspace map | Spike, tested |
| Node built-ins | Pinned list from Node 24.15.0; `node:`-only modules handled | Spike, tested |
| External npm packages | Declared (exact) or undeclared (inferred) | Spike, tested |
| URL imports | Unsupported, never fetched | Spike, tested |
| Flow, Vue/Svelte SFC, MDX | Opaque files | P1.2 |
| Lockfiles | Structural only | P1.2 |
