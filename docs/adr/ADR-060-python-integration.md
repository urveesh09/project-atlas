# ADR-060: Python support, part 3: integration into analysis, artifacts and the viewer

Date: 2026-10-15. Status: accepted. Part 3 of Python support. Follows
[ADR-056](ADR-056-python-support-design-and-facts.md) (syntax facts) and
[ADR-057](ADR-057-python-resolution.md) (resolution). Both of those call this step
"ADR-058"; that number went to the interface polish, so it is recorded here as ADR-060.

This is a deliberate contract change:
- analyzer `0.1.0-dev.5` → `0.1.0-dev.6`;
- graph schema `atlas.graph/1.0.0` → `1.1.0`;
- artifact `atlas.artifact/1.3.0` → `1.4.0`.

The repository baseline is regenerated in the same change. TS/JS results are proven unchanged
at path level (below).

## Evidence and cause

- ADR-056 and ADR-057 built a Python adapter, but analysis did not use it. Python files were
  opaque buildings with no imports, metrics or findings.
- The owner's direction (ADR-056): Python as deep as TS/JS, without hindering current
  quality.
- **Two identity bugs, found while integrating.** The mixed-language test below has an npm
  package and a PyPI distribution both named `six`. Node IDs were derived in three separate
  places, and none of them included the ecosystem:
  - the validator rejected every Python artifact with `ID_MISMATCH`, because it re-derives
    IDs from `packageName` alone;
  - the delta and indexed wire encodings collided on the shared name: "Delta graph repeats
    a node".

## Decision

### 1. Contract (graph 1.1.0, artifact 1.4.0)

- A file's `language` may be `python`.
- An external package's `ecosystem` may be `pypi`, named by its PEP 503 normalized name.
- A built-in may carry `runtime: 'python'`. It is absent for Node.js built-ins, which keep
  their original meaning.
- **Node identity.** `nodeIdentityKey` in `graph.ts` is now the one function that the
  validator and both wire encodings use.
  - PyPI packages hash `pypi:<name>` and Python built-ins hash `python:<module>`.
  - npm and Node.js keys are unchanged, so TS/JS IDs do not move.
- **Perimeter names** (layout anchors, frame comparison, the viewer) come from
  `perimeterName`: `npm:react` and `builtin:fs` as before, plus `pypi:requests` and
  `builtin:python:os`.
- Readers accept artifacts 1.0–1.4 and graph schemas 1.0.0 and 1.1.0.

### 2. Inventory

- **Code and roles.**
  - `.py` and `.pyi` are code.
  - Tests are files under a test directory, or files named by pytest's discovery rules
    (`test_*.py`, `*_test.py`) or `conftest.py`.
  - `.pyi` stubs are declarations.
  - Python manifests (`pyproject.toml`, `setup.cfg`, `setup.py`, `Pipfile`, requirements
    files) and tool configuration are config.
  - `poetry.lock`, `Pipfile.lock`, `uv.lock` and `pdm.lock` are lockfiles.
- **Built-in exclusions.**
  - Dependency directories: virtual environments (`.venv/`, `venv/`), `.tox/`, `.nox/` and
    `site-packages/`.
  - Build output: `*.egg-info/` and `.eggs/`.
  - Caches: `__pycache__/`, the mypy, pytest and ruff caches, and `*.pyc` and `*.pyo`.
- **Generated files.** The generated-file header check reads `#` comments for Python, which
  is how protobuf marks `_pb2.py` files "DO NOT EDIT!". A `//` line is not a Python comment.
- **Unsupported.** Cython (`.pyx`, `.pxd`) and notebooks (`.ipynb`) stay visible as opaque
  `LANGUAGE_UNSUPPORTED` files.

### 3. Pipeline

- **Parsing.**
  - One parser child process parses both languages. The analyzer-core child loads the
    hash-checked grammar before it reports ready, and keeps the same deadlines, memory
    limits and crash handling.
  - A Python stack overflow is `PARSER_STACK_LIMIT`.
  - The TS-only child in analyzer-ts was unused afterwards, so it was removed.
- **Fact cache.** Python facts are keyed by the Python parser and extractor versions. TS/JS
  keys are unchanged.
- **Parser record.** Manifests record both parsers, for example
  `typescript@6.0.3 tree-sitter-python@0.25.0+wts@0.25.10`.
- **Packages.** These rules run only when a snapshot holds Python.
  - A Python project (ADR-057) becomes a package when it holds Python source and no
    package exists at its root.
  - A root project names the root package when there is no `package.json`.
  - Declared dependencies become `declares-package` edges, to a PyPI node or to another
    project in the repository.
- **Imports.** Every ADR-057 resolution becomes an observation. A from-import that names
  submodules yields one observation per submodule.
- **Findings.**
  - A Python syntax error reports its line (`PYTHON_SYNTAX_ERROR`).
  - `RELATIVE_BEYOND_TOP_LEVEL` counts as a missing local import.
  - A guarded import of a missing local module (`OPTIONAL_TARGET_MISSING`) is shown, but not
    flagged as broken.
  - The parse-error explanation names the parser for each language.

### 4. Viewer, CLI and service

- **Labels.** `codeLabels` names what a snapshot analyzed, in the overview and in
  `atlas inspect`:
  - "Parsed TS/JS", "Parsed Python" or "Parsed TS/JS and Python";
  - "npm packages", "PyPI packages" or "npm and PyPI packages";
  - and the matching built-ins label.

  A snapshot without Python keeps its exact previous wording.
- **Inspector.** It shows a Python language chip. Package rows:
  - name PyPI;
  - say "optional" for an undeclared guarded import;
  - say "Python standard library" for a Python built-in, or the runtime reason for an
    inferred one.
- **CLI.** `inspect --json` lists PyPI packages as `pypi:<name>`; npm names stay bare.
- **Service.** Hosted capabilities list a `python` language (`.py .pyi`), and the hosted
  landing names every listed language.
- **Packaging.** The CLI package copies each workspace package's `files` list, which brings
  analyzer-py's vendored grammar. The worker image's `pnpm deploy` already follows `files`.

## Verification

- **TS/JS is unchanged at path level.**
  - `scripts/compare-analysis-paths.mjs` analyzes the Harbor fixture and the three pinned
    TS/JS repositories with main's build and with this one.
  - It rewrites version-derived IDs to the paths and names they stand for. It names three
    ID-ordered choices by content:
    - a cycle's ID and fingerprint;
    - its witness, which starts at the member with the lowest node ID;
    - the observation a fan-in finding cites for each consumer edge.
  - It then compares every node, edge, observation, finding, metric, history row and
    layout row.
  - Result: 0 differences in any of the four. The only changes are in the analysis
    summary: the analyzer version, and 13 new built-in exclusion patterns that match no file
    in these repositories.
  - Example: vuejs/core's 180 high-fan-in findings across 12 frames cite the same consumer
    edges before and after.
  - The cross-platform Harbor golden is updated for the new hashes.
- **Mixed repository.** `packages/analyzer-core/test/python.test.ts` (7 tests) analyzes a
  repository with a TS web app and a Python service in two commits. It checks:
  - every invariant, including derived IDs;
  - an npm `six` and a PyPI `six` with distinct identities;
  - roles, and exclusion of `.venv/` and a `_pb2.py` file;
  - the project package and its declared ranges;
  - each import against ADR-057: standard library, declared, undeclared and optional
    externals, relative and submodule imports, type-only imports, re-exports, and
    script-directory shadowing;
  - complexity, and the syntax-error finding;
  - perimeter anchors and determinism.

  The resolution expectations were written from ADR-057 before the first run, and every
  one held. The first run corrected three expectations about existing conventions:
  - config files are `unsupported`, not `not-applicable`;
  - a requirement without a version is recorded as `*`;
  - TS without a tsconfig resolves as `inferred`.
- **A real Python repository joins the corpus.** pallets/flask at `d086db8` (2026-10-07) is
  pinned in `repository-corpus.json`, with checks authored from its source.
  - The 3 file checks and 9 import checks all pass, including:
    - `import typing as t` … `if t.TYPE_CHECKING:` as type-only;
    - `import json` inside the `flask.json` package as the standard library;
    - tests reaching `src/flask` through the project's source root;
    - the tutorial example's `import flask` resolving to the repository's own package, as
      `WORKSPACE_PROJECT_MODULE`.
  - The pinned commit at HEAD: 83 Python files, all parsed. Its 666 imports:

    | Outcome | Count |
    |---|---|
    | Internal, exact | 299 |
    | Internal, workspace project (inferred) | 29 |
    | Standard library | 170 |
    | Typeshed-only built-ins | 8 |
    | Declared external | 142 |
    | Undeclared external (inferred) | 16 |
    | Non-literal dynamic imports | 2 |
    | Unresolved | 0 |

  - **Known limit.** 10 of the 16 undeclared imports are test modules that Flask's tests
    put on `sys.path` at runtime, either `tests/test_apps` or temporary directories.
    Static analysis cannot see that, so they are labelled undeclared and `inferred`, never
    claimed as installed packages. The other 6 really are undeclared:
    - `typing_extensions` in `src/` (3 imports);
    - `packaging` and `docutils` in `docs/conf.py`.
- **Baseline.** `docs/release/real-repositories.json` is regenerated for analyzer
  `0.1.0-dev.6` with four repositories, five cold repeats each, and exact determinism.
- **Cross-platform comparison.** `compare-repository-reports.mjs` asserted exactly three
  repositories, so the first CI run failed on four. It now requires both the Windows and the
  Linux report to cover exactly the committed corpus, each repository once, by numeric ID
  and commit. A report missing a repository still fails.
