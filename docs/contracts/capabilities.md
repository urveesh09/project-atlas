# Language and configuration capabilities: implementation status

This tracks plan §4.1 against code through Phase 5. The hosted service runs the identical analyzer, options profile and limits inside an offline sandbox ([ADR-031](../adr/ADR-031-hosted-acquisition-and-analysis-pipeline.md)), so every row below applies to both routes. A blob absent from the object store is an explicit `LOCAL_OBJECT_MISSING` failure, never a file of unknown or zero size. TS/JS and Python analysis use isolated parsing and tested static resolvers; the production city consumes the same validated artifacts. First-parent history, sampled frames, conservative lineage, prior-window churn/hotspots and fixed-plot A/B comparison are implemented. Unsupported/missing historical data retains availability labels. Unsupported languages remain visible opaque buildings and are not claimed as analyzed.

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
| `.py .pyi` | Parse with tree-sitter-python 0.25.0 (vendored WASM, hash-checked); imports, declarations, line/complexity metrics; `.pyi` is a declaration | Done ([ADR-056](../adr/ADR-056-python-support-design-and-facts.md), [ADR-060](../adr/ADR-060-python-integration.md)) |
| Python imports | Relative, absolute, from-import submodules, type-only (`TYPE_CHECKING`, stubs), re-exports, literal `importlib` calls; Python `sys.path` precedence | Done ([ADR-057](../adr/ADR-057-python-resolution.md)), tested on a fixture and pallets/flask |
| Python projects | `pyproject.toml` (PEP 621, Poetry, uv, PDM, setuptools, Hatch, maturin), `setup.cfg`, `setup.py` literals only, requirements files, Pipfile; never executed | Done (ADR-057/060) |
| Python standard library and PyPI | Standard library (CPython 3.14 names), other runtimes inferred; PyPI declared (exact) or undeclared (inferred, or optional when guarded) | Done (ADR-057/060) |
| Python environments and caches | `.venv/`, `venv/`, `.tox/`, `.nox/`, `site-packages/`, `__pycache__/`, tool caches, `*.pyc`, `*.egg-info/` excluded | Done (ADR-060) |
| Flow, Vue/Svelte SFC, MDX, Astro, CoffeeScript, Cython, notebooks | Opaque files with `FLOW_UNSUPPORTED` / `LANGUAGE_UNSUPPORTED` | Done (P1.2, ADR-060) |
| Lockfiles | Structural only, content never read (`LOCKFILE_STRUCTURAL`) | Done (P1.2) |
| JSON, styles, images, fonts, media | Asset buildings; byte size only | Done (P1.2) |
| Symlinks, submodules, LFS pointers | Excluded (`SYMLINK`, `SUBMODULE`) or opaque (`LFS_NOT_FETCHED`); never followed or fetched | Done (P1.2) |
| `atlas.config.json` | Versioned `exclude` globs; unknown keys warn. Unspecified display overrides deferred beyond V0.1 (ADR-020) | Exclusions done (P1.2); no arbitrary styling/metric plugins |
