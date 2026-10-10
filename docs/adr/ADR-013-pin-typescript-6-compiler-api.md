# ADR-013: Pin the TypeScript 6.0 compiler API for analysis

**Status:** Accepted, 10 October 2026 (Phase 0, P0.1/P0.2). Refines ADR-002.

**Context:** ADR-002 chooses the TypeScript Compiler API for syntax and module resolution. At implementation start the npm `latest` tag is `typescript@7.0.2`, the native (Go) compiler. Its npm package ships platform binaries and has no `main` entry: there is no in-process JavaScript API for `createSourceFile`, `resolveModuleName` or `parseJsonConfigFileContent`. The 6.0 line is the last JavaScript implementation and provides all three.

**Decision:**

- `@atlas/analyzer-ts` depends on exactly `typescript@6.0.3`. The workspace type-checks its own code with the same version, so there is one compiler in the lockfile.
- The parser version recorded in artifacts is `typescript@6.0.3`. Changing it creates new analyzer and cache keys (plan §9.4) and new immutable artifacts.
- `packages/analyzer-ts/src/internal.ts` holds every use of API surface missing from the public typings. Each accessor throws at load time if the pinned version stops providing it:
  - `getEmitModuleResolutionKind`: the compiler's own derivation of the effective resolution mode.
  - `matchFiles`: the compiler's own include/exclude glob engine, run only over virtual entries.
  - `SourceFile.parseDiagnostics`: the parser's syntax diagnostics from `createSourceFile`, so no `Program` is built.
  - `ResolvedModuleFull.originalPath`: detects resolution through the virtual workspace mapping.

**Alternatives rejected:**

- Building the analyzer on TS 7 through a subprocess or an LSP. This adds an IPC boundary per file and does not provide the virtual-filesystem resolver hooks ATLAS needs.
- Reimplementing resolution. This contradicts ADR-002 and loses compiler fidelity.
- Floating `^6`. This violates the plan's no-floating-versions rule.

**Consequences:** Analysis tracks TS 6 semantics, which are what most repositories target in 2026. Syntax that only TS 7 understands becomes parse diagnostics, as the plan's capability matrix already requires. Upgrading is an explicit ADR plus a re-run of every resolver fixture.

**Review trigger:** TS 7 publishes an in-process API with custom-host resolution, or TS 6 stops receiving security fixes.
