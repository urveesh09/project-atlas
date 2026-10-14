# Vendored Python grammar

`tree-sitter-python.wasm` is the prebuilt WebAssembly grammar from the npm package
`tree-sitter-python@0.25.0` (MIT, licence in `LICENSE.tree-sitter-python`). It is vendored
rather than installed because the package depends on native build tooling that this
workspace never runs (ADR-056).

| | |
|---|---|
| Source tarball | `https://registry.npmjs.org/tree-sitter-python/-/tree-sitter-python-0.25.0.tgz` |
| Tarball integrity (as published) | `sha512-eCmJx6zQa35GxaCtQD+wXHOhYqBxEL+bp71W/s3fcDMu06MrtzkVXR437dRrCrbrDbyLuUDJpAgycs7ncngLXw==` |
| `tree-sitter-python.wasm` SHA-256 | `16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47` |
| Runtime | `web-tree-sitter@0.25.10` (grammar ABI 15) |

`packages/analyzer-py/test/grammar.test.ts` fails if the file's hash changes. To update,
download the new tarball, check its published integrity, replace the file and licence, and
record the new values here, in `src/parser.ts` and in a new ADR.
