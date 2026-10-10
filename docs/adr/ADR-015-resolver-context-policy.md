# ADR-015: Resolver context policy decided by the P0.2 spike

**Status:** Accepted, 10 October 2026 (Phase 0, P0.2). Refines plan §9.3. It narrows no promise, but makes five implementation-level choices explicit.

**Context:** The P0.2 spike implemented TypeScript resolution over a virtual snapshot. Five situations needed a concrete rule that the plan leaves to implementation.

**Decisions:**

1. **Workspace packages through a virtual `node_modules` map.** The compiler host presents `/repo/node_modules/<name>` for each workspace member (and a named root). It maps to the member's committed root and never to a physical directory. TypeScript then applies the real `exports`/`types`/`main` and condition logic. Outcomes are `inferred` with reason `WORKSPACE_PACKAGE_MAP`, because no installed package was observed.
2. **Source fallback for uncommitted build output.** When a workspace package's declared entry (for example `dist/index.d.ts`) is absent, the entry is mapped back to source through that package's tsconfig `outDir`/`rootDir`. Without a config, conventional `dist|build|lib|out` folders map to `src`. The result is `inferred` with `WORKSPACE_SOURCE_FALLBACK`. A conventional `src/index.*` entry is `heuristic` with `WORKSPACE_CONVENTIONAL_ENTRY`. If neither works, the import is unresolved with `GENERATED_TARGET_MISSING` (the entry was declared) or `PACKAGE_EXPORT_UNSUPPORTED`.
3. **Files outside every config's include set.** A file that no project includes (for example `.cjs` beside a TS-only config, or a workspace package without its own tsconfig) uses the nearest ancestor config's options. Its results are at most `inferred`. With no ancestor config, the documented inferred defaults apply:
   - `bundler` for ordinary files;
   - `nodenext` for `.mts/.cts/.mjs/.cjs`, or when the nearest `package.json` declares `type`, following plan §9.3 literally.
4. **Dependency discovery is not type checking.** When an explicit config cannot resolve a specifier only because `allowJs`/`resolveJsonModule` are off, one retry enables them. A match is `inferred`. An explicit Node context is never reinterpreted as bundler: the extensionless ESM import in the fixture stays `LOCAL_TARGET_MISSING`.
5. **Built-ins after aliases.** A config alias that matches a built-in-looking name wins (precedence step 1). Prefix-only built-ins (`node:test`, `node:sqlite`, `node:sea`) are built-ins only with the `node:` prefix; bare `test` is an npm package. The built-in list is pinned in `builtins.ts` from Node 24.15.0.

**Evidence:**

- `packages/analyzer-ts/test/resolve.test.ts` holds 39 hand-written expectations, covering bundler vs nodenext, `paths` inherited across `extends`, exports conditions, self-name, the workspace map and source fallback, built-ins, declared/undeclared externals, excluded targets, case mismatch, URL imports, extends cycles and external extends.
- `packages/analyzer-core/test/first-session.test.ts` checks the full Harbor demo against `demo-expectations.ts`.

**Consequences:** Every non-compiler inference is visible as `inferred`/`heuristic` plus a reason code, so the UI can explain it. A repository whose aliases live only in executable bundler config still gets `ALIAS_UNSUPPORTED`/`CONFIG_CONTEXT_MISSING` rather than a guess.

**Review trigger:** Real-repository coverage (P6.1) shows a common, safely representable alias pattern that these rules leave unresolved.
