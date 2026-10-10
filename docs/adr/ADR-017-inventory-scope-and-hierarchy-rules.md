# ADR-017: Inventory scope, roles and hierarchy rules

**Status:** Accepted, 10 October 2026 (Phase 1, P1.2/P1.3). Refines plan §4.1, §4.3, §6.2 and §8.5 where the plan leaves an implementation choice.

**Context:** Plan §8.5 requires built-in exclusions for dependency, build/output and cache folders, minified bundles, source maps and generated files, with every applied pattern reported. Several of these words are ambiguous in real repositories. Phase 1 also had to decide how packages, folders and odd tree entries appear in the graph.

**Decisions:**

1. **Built-in exclusions are deliberately narrow.** The rule list in `packages/analyzer-core/src/classify.ts` is reported in every `summary.json`:
   - `node_modules/`, `bower_components/`, `jspm_packages/` and `vendor/` are dependency directories;
   - `dist/` plus framework output folders (`.next/`, `.nuxt/`, `.svelte-kit/`, `.output/`, `.vercel/`, `.netlify/`, `storybook-static/`, `.docusaurus/`, `.expo/`) and `coverage/` are build output;
   - known tool caches are cache directories;
   - `*.min.(js|mjs|cjs|css)` are minified bundles and `*.map` files are source maps.

   `build/`, `out/` and `lib/` are **not** excluded: they often hold hand-written scripts or published source, and wrongly hiding real code is worse than showing some output. Users add them through `atlas.config.json` or `--exclude`.
2. **Generated files** are excluded only when a leading comment within the first KiB carries a recognized marker (`@generated`, `DO NOT EDIT`, `auto-generated`, …). A marker inside code never counts, and filenames alone never imply generation.
3. **Glob language.** Patterns follow a documented gitignore-like subset: `name`, `dir/`, anchored paths, `*`, `**` and `?`. Negation, braces and character classes are rejected with a warning (`ATLAS_CONFIG_PATTERN_UNSUPPORTED`), never approximated.
4. **Symlinks and submodules are excluded entries**, counted with `SYMLINK`/`SUBMODULE` reasons and named in coverage warnings. They are not file buildings because they have no analyzable blob. Unrepresentable paths (invalid UTF-8, control characters, `.git` segments, traversal) are excluded with the path itself withheld.
5. **Opaque but included.** Oversized blobs, binary or invalid-UTF-8 code, Flow files, Git LFS pointers and code beyond the 64 MiB source budget remain buildings, with an `opaqueReason` and a coverage warning naming the path. Lockfiles are structural (`LOCKFILE_STRUCTURAL`) and their content is never read.
6. **Partial means "beyond the profile".** Only `FILE_LIMIT` and `SOURCE_BUDGET` make a frame `partial` (CLI exit 2): files are missing, or supported code went unanalyzed because of a global cap. Per-file profile behavior (oversize, binary, unsupported language) and scope exclusions are routine and reported, but do not make a run partial.
7. **Hierarchy.**
   - Packages are the root package (real, or synthetic with `manifestPath: null`) plus workspace members from `package.json#workspaces` and `pnpm-workspace.yaml`, including `!` negations. All are direct children of the repository.
   - A manifest that is not a workspace member is just a config file inside its owning package.
   - Folders are kept exactly; a folder that is also a package root is represented by the package node.
8. **Ambiguous workspace names are never guessed.** When two workspace manifests declare the same name, the name maps to neither: both are reported (`DUPLICATE_WORKSPACE_PACKAGE_NAME`). Dependencies on it get `AMBIGUOUS_WORKSPACE_DEPENDENCY`, and imports of it resolve as `unresolved/AMBIGUOUS_WORKSPACE_PACKAGE`.
9. **Structural artifacts are honest about parsing.** Phase 1 records TS/JS files as `parseStatus: "skipped"` and `parsedFiles: 0`, with no metrics rows. Phase 2 fills these in; no placeholder values are emitted.

**Evidence:**

- `packages/analyzer-core/test/inventory.test.ts` checks 35 adversarial tree entries against hand-written outcomes, plus limits, determinism and globs.
- `hierarchy.test.ts` covers the monorepo rules.
- `packages/cli/test/cli.test.ts` covers Gate G1 through the CLI.

**Review trigger:** Real-repository validation (P6.1) shows a common output folder that should be built in, or a common pattern the glob subset cannot express.
