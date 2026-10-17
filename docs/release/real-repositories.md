# P6.1: pinned real-repository validation

Recorded 2026-10-17T03:08:52.759Z; analyzer 0.1.0-dev.8, 5 cold repeats per repository.

Unfiltered depth-201 acquisition capped at 256 MiB; offline SafeGit reads; cold parser facts per repeat; canonical and compressed chunk hashes include every frame. Envelope IDs/time excluded. Authored examples check facts, repeat hashes check determinism only. Timings are corpus observations, not the synthetic capacity gate.

Artifacts are retained locally under the ignored `.atlas-tmp/release-corpus/`. Recreate them with the commands below; source is never tracked or exported. A source-free artifact still exposes paths, declarations and relationships, so any onward sharing is explicit.
Resolution follows TypeScript compiler lookup, including declaration-file substitution: `test.js` → `./index.js` in is-plain-obj resolves to committed `index.d.ts` ahead of `index.js`. This is a compiler dependency graph. The initial source-based expectation of `index.js` failed; rereading plan §9.2 and the [TypeScript extension-substitution contract](https://www.typescriptlang.org/docs/handbook/modules/reference.html#file-extension-substitution) explained the discrepancy. The expectation was corrected to that independently documented contract before acceptance repeats. Root `test.js` does not match conventional test-role patterns, so it retains the source role; role heuristics do not infer repository test-script meaning.


| Repository / category | Pinned commit | Files supported/included | Imports internal/external/builtin/unresolved/unsupported/excluded | Status | Size MiB | Checks |
|---|---|---|---|---|---|---|
| [sindresorhus/is-plain-obj](https://github.com/sindresorhus/is-plain-obj/tree/666df7c10035f7e26f27ec214fe5ae3173435f34) (single-package JavaScript) | `666df7c10035f7e26f27ec214fe5ae3173435f34` | 5/14 | 3/2/3/0/0/0 | complete | 0.01 | 5 |
| [vuejs/core](https://github.com/vuejs/core/tree/4ab865a848a1da3d10fb674f857e5fff13094644) (TypeScript workspace monorepo) | `4ab865a848a1da3d10fb674f857e5fff13094644` | 527/702 | 2267/147/76/35/1/0 | complete | 0.75 | 5 |
| [vitejs/vite](https://github.com/vitejs/vite/tree/3b72997d42e7dd2b31898d0e68461e3025e836b6) (mixed TypeScript/JavaScript workspace) | `3b72997d42e7dd2b31898d0e68461e3025e836b6` | 1595/2842 | 2383/774/492/263/124/3 | partial | 2.74 | 6 |
| [pallets/flask](https://github.com/pallets/flask/tree/d086db856be187255b8ec61ef409357393020f32) (Python project with src layout) | `d086db856be187255b8ec61ef409357393020f32` | 83/236 | 328/158/178/0/2/0 | complete | 0.22 | 12 |

## Independent source examples and limitations

### sindresorhus/is-plain-obj

Canonical/wire chunk digest: `c91d8fc21668fcfbfcf850c8f326d428126da7db99d823a9f8046873416c9c49`. All 5 repeats and exported streaming validation passed.

- `index.js`: source, javascript, parsed.
- `index.d.ts`: declaration, typescript, parsed.
- `test.js` → `./index.js` (imports-value): resolved-internal → `index.d.ts`.
- `test.js` → `node:vm` (imports-value): builtin → `vm`.
- `test.js` → `ava` (imports-value): resolved-external → `ava`.

HEAD parsing: 5 parsed, 0 failed. No parse failures.

Unresolved/unsupported/excluded categories (all counts and representative observations are in the JSON):

- None observed in this bounded corpus.

History: complete, 1 commits, 1 frames; boundary days.

### vuejs/core

Canonical/wire chunk digest: `6a63f3050505cc8afae86dcc7080e5505dcc48b345b2d27e52dad5c8b7df79cb`. All 5 repeats and exported streaming validation passed.

- `packages/reactivity/src/ref.ts`: source, typescript, parsed.
- `packages/reactivity/__tests__/ref.spec.ts`: test, typescript, parsed.
- `packages/reactivity/src/index.ts` → `./ref` (reexports-value): resolved-internal → `packages/reactivity/src/ref.ts`.
- `packages/reactivity/src/ref.ts` → `@vue/shared` (imports-value): resolved-internal → `packages/shared/src/index.ts`.
- `packages/reactivity/src/ref.ts` → `./computed` (imports-type): resolved-internal → `packages/reactivity/src/computed.ts`.

HEAD parsing: 527 parsed, 0 failed. No parse failures.

Unresolved/unsupported/excluded categories (all counts and representative observations are in the JSON):

- unresolved:LOCAL_TARGET_MISSING: 34; e.g. `packages-private/sfc-playground/src/download/download.ts` → `./template/README.md?raw`, `packages/reactivity/__benchmarks__/reactiveMap.bench.ts` → `../dist/reactivity.esm-browser.prod`, `packages/runtime-test/index.js` → `./dist/runtime-test.cjs.prod.js`.
- unsupported:NONLITERAL_DYNAMIC_IMPORT: 1; e.g. `scripts/size-report.js` → `(nonliteral)`.
- unresolved:GENERATED_TARGET_MISSING: 1; e.g. `packages-private/sfc-playground/src/vue-dev-proxy-prod.ts` → `vue/dist/vue.runtime.esm-browser.prod.js`.

History: complete, 119 commits, 12 frames; boundary days.

### vitejs/vite

Canonical/wire chunk digest: `c056c8704d536191a9e81c313009f0c3afd9110622ace27329bbaeeedbf46e2f`. All 5 repeats and exported streaming validation passed.

- `packages/vite/src/node/index.ts`: source, typescript, parsed.
- `playground/alias/vite.config.js`: config, javascript, parsed.
- `playground/alias/dir/from-script-src.js`: source, javascript, parsed.
- `packages/vite/src/node/index.ts` → `./config` (reexports-value): resolved-internal → `packages/vite/src/node/config.ts`.
- `playground/alias/vite.config.js` → `node:path` (imports-value): builtin → `path`.
- `packages/vite/src/node/index.ts` → `rolldown` (imports-type): resolved-external → `rolldown`.

HEAD parsing: 1593 parsed, 2 failed. Failed paths: `packages/vite/src/node/ssr/__tests__/fixtures/errors/syntax-error.js`, `packages/vite/src/node/ssr/__tests__/fixtures/errors/syntax-error.ts`.

Unresolved/unsupported/excluded categories (all counts and representative observations are in the JSON):

- unresolved:LOCAL_TARGET_MISSING: 55; e.g. `playground/environment-react-ssr/src/entry-server.tsx` → `/dist/client/index.html?raw`, `playground/worker/worker/main-url.js` → `../simple-worker?worker&url`, `playground/hmr-ssr/queries/index.js` → `./multi-query?query1`.
- unresolved:GENERATED_TARGET_MISSING: 198; e.g. `packages/create-vite/index.js` → `./dist/index.js`, `playground/hmr-full-bundle-mode/__tests__/build-hooks.spec.ts` → `vite`, `playground/ssr-html/server.js` → `vite`.
- unsupported:NONLITERAL_DYNAMIC_IMPORT: 57; e.g. `playground/legacy/__tests__/ssr/serve.ts` → `(nonliteral)`, `packages/vite/src/node/ssr/runtime/__tests__/fixtures/dynamic-import.js` → `(nonliteral)`, `playground/worker/classic-worker.js` → `(nonliteral)`.
- excluded-target:TARGET_EXCLUDED: 3; e.g. `playground/ssr-wasm/src/direct-add.js` → `./add.wasm`, `playground/ssr-wasm/src/direct-light.js` → `./imports.js`, `playground/ssr-wasm/src/direct-light.js` → `./light-with-imports.wasm`.
- unsupported:IMPORT_META_GLOB_UNSUPPORTED: 50; e.g. `packages/vite/src/node/__tests__/plugins/importGlob/fixture-a/index.ts` → `(nonliteral)`, `packages/vite/src/node/__tests__/plugins/importGlob/fixture-a/index.ts` → `(nonliteral)`, `packages/vite/src/node/__tests__/plugins/importGlob/fixture-a/index.ts` → `(nonliteral)`.
- unsupported:REQUIRE_RESOLVE_UNSUPPORTED: 2; e.g. `playground/css/__tests__/tests.ts` → `(nonliteral)`, `playground/json/__tests__/csr/json-csr.spec.ts` → `(nonliteral)`.
- unsupported:URL_IMPORT_UNSUPPORTED: 14; e.g. `playground/hmr/hmr.ts` → `virtual:file`, `playground/hmr/hmr.ts` → `virtual:file-dep`, `packages/vite/src/node/ssr/runtime/__tests__/fixtures/virtual.js` → `virtual0:test`.
- unsupported:NONLITERAL_REQUIRE: 1; e.g. `playground/ssr-deps/require-absolute/index.js` → `(nonliteral)`.
- unresolved:PACKAGE_EXPORT_UNSUPPORTED: 6; e.g. `playground/backend-integration/frontend/entrypoints/main.ts` → `vite/modulepreload-polyfill`, `playground/ssr-deps/src/app.js` → `@vitejs/test-pkg-exports/virtual`, `playground/css/main.js` → `#alias-module`.
- unresolved:AMBIGUOUS_WORKSPACE_PACKAGE: 3; e.g. `playground/ssr-deps/src/app.js` → `@vitejs/test-nested-exclude`, `playground/ssr-deps/nested-exclude/index.js` → `@vitejs/test-nested-include`, `playground/optimize-deps/nested-exclude/index.js` → `@vitejs/test-nested-include`.
- unresolved:ALIAS_UNSUPPORTED: 1; e.g. `playground/resolve-tsconfig-paths/__tests__/resolve.spec.ts` → `~utils`.

History: complete, 200 commits, 12 frames; boundary commit-cap.

### pallets/flask

Canonical/wire chunk digest: `49b5f8c51d67f12423a2e3fb8cab3699be75575db2608270fcd810109c01f82f`. All 5 repeats and exported streaming validation passed.

- `src/flask/app.py`: source, python, parsed.
- `src/flask/json/__init__.py`: source, python, parsed.
- `tests/test_json.py`: test, python, parsed.
- `src/flask/__init__.py` → `.app` (reexports-value): resolved-internal → `src/flask/app.py`.
- `src/flask/json/__init__.py` → `json` (imports-value): builtin → `json`.
- `src/flask/json/__init__.py` → `..globals` (imports-value): resolved-internal → `src/flask/globals.py`.
- `src/flask/json/__init__.py` → `..wrappers` (imports-type): resolved-internal → `src/flask/wrappers.py`.
- `tests/test_json.py` → `flask.json.provider` (imports-value): resolved-internal → `src/flask/json/provider.py`.
- `tests/test_json.py` → `werkzeug.http` (imports-value): resolved-external → `werkzeug`.
- `tests/test_json.py` → `pytest` (imports-value): resolved-external → `pytest`.
- `examples/tutorial/flaskr/blog.py` → `.auth` (imports-value): resolved-internal → `examples/tutorial/flaskr/auth.py`.
- `examples/tutorial/flaskr/blog.py` → `flask` (imports-value): resolved-internal → `src/flask/__init__.py`.

HEAD parsing: 83 parsed, 0 failed. No parse failures.

Unresolved/unsupported/excluded categories (all counts and representative observations are in the JSON):

- unsupported:NONLITERAL_DYNAMIC_IMPORT: 2; e.g. `src/flask/cli.py` → `(nonliteral)`, `src/flask/helpers.py` → `(nonliteral)`.

History: complete, 13 commits, 12 frames; boundary days.

## Reproduce

```sh
pnpm install --frozen-lockfile && pnpm build
node scripts/validate-real-repositories.mjs --acquire # explicit network acquisition only
node scripts/validate-real-repositories.mjs           # five fully offline cold repeats
```

Expected examples in `repository-corpus.json` were authored by reading pinned committed blobs before running the analyzer. They are not analyzer-generated correctness goldens. Counts describe this empirical corpus; external package resolution does not prove installed dependency contents exist, and framework transforms/nonliteral imports remain limitations. This report does not complete human usability, assistive-technology, integrated-GPU or public-infrastructure release gates.
