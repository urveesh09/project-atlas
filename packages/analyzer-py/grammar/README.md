# Vendored Python grammar

`tree-sitter-python.wasm` is tree-sitter-python 0.25.0 (MIT, licence in
`LICENSE.tree-sitter-python`) with `python-3.15.patch` applied, which adds the Python 3.15
syntax (ADR-080). It is built from source by `node scripts/build-python-grammar.mjs` in one
offline container, and vendored rather than installed because the npm package depends on
native build tooling that this workspace never runs (ADR-056).

| | |
|---|---|
| Upstream source | `https://github.com/tree-sitter/tree-sitter-python`, tag `v0.25.0`, commit `293fdc02038ee2bf0e2e206711b69c90ac0d413f` |
| Patch | `python-3.15.patch`: PEP 810 lazy imports (as upstream PR #336), PEP 798 unpacking in comprehensions, unary plus in literal patterns (gh-145239), and the corpus tests for each |
| Generator | tree-sitter CLI 0.25.9, `tree-sitter-linux-x64.gz` SHA-256 `00ffe4a332a112b6fd7f47d20be61bf76cbf39856fa98c944de51c822d39bdfc` (the generator upstream 0.25.0 used) |
| Compiler | `emscripten/emsdk:4.0.4@sha256:47d573d5a86379a06f850de200d69407e6baa2d2f9c19d9e156a67db57f80f2f` (the version CLI 0.25.9 pins), run with `--network=none` |
| `tree-sitter-python.wasm` SHA-256 | `40f01ba5e3ef4e4ff3d697d00ac290270ca64843b29a7126ba87ad3747aed3bb` (464,346 bytes) |
| Recorded version | `tree-sitter-python@0.25.0+atlas.1` |
| Runtime | `web-tree-sitter@0.27.1` (grammar ABI 15; ADR-062) |

`packages/analyzer-py/test/extract.test.ts` fails if the file's hash changes. The build also
runs upstream's corpus tests, which must all pass. Running the script without arguments
rebuilds the grammar and fails unless the result matches the vendored file byte for byte.

To change the grammar: edit the patch, run `node scripts/build-python-grammar.mjs --install`,
check the rebuild reproduces it, then record the new hash and version here, in `src/parser.ts`
and in a new ADR. Prefer an upstream release that contains the same syntax when one exists.
