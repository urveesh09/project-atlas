# ADR-057: Python import resolution and projects

Date: 2026-10-14. Status: accepted. Part 2 of Python support
([ADR-056](ADR-056-python-support-design-and-facts.md)). Adds resolution to
`@atlas/analyzer-py`; the analyzer pipeline does not use it until ADR-058, so no artifact
byte changes.

## Evidence and cause

- **The TS/JS bar.** Every import is resolved to one of:
  - an internal file;
  - an external package, declared (exact) or not (inferred);
  - a built-in;
  - unresolved or unsupported with a reason that drives findings.

  Python must meet the same bar using Python's own import semantics, read statically: no
  interpreter, no installed packages, no executed `setup.py`.
- **Real code to learn from.** The installed `pip` 26.1.1 (395 files, vendored libraries
  included) was resolved as a check. It exposed four mistakes in the first version:
  - a missing vendored submodule became a phantom external package `pip`;
  - Python 2 compatibility imports (`urllib2`, `httplib`) became PyPI packages;
  - underscore-prefixed modules became malformed names (`-typeshed`);
  - optional (guarded) imports were labelled undeclared.

  Each is fixed below and pinned by a test.

## Decision

1. **Projects** (`discoverPythonProjects`) come from committed manifests:
   - `pyproject.toml`: PEP 621 `[project]`, PEP 735 dependency groups, Poetry, uv
     (including `[tool.uv.workspace] members`), PDM, setuptools, Hatch and maturin;
   - `setup.cfg`;
   - `setup.py`: literal keyword arguments of its `setup()` call only, read from its
     syntax tree. Anything non-literal is a warning, and nothing runs;
   - `requirements*.txt` and `.in` files, with `-r` includes;
   - `Pipfile`.

   Further rules:
   - TOML is parsed by `smol-toml` 1.8.0 (BSD-3-Clause, no dependencies). Values are read
     defensively, own properties only.
   - Manifests under test and fixture directories are sample data, not projects.
   - Names are normalized by PEP 503.
   - Dependency fields map onto the existing contract: `dependencies`,
     `optionalDependencies`, and `devDependencies` (dependency groups, dev requirements).
2. **Import roots** per project:
   - the explicitly configured ones: setuptools `package-dir` and `packages.find.where`,
     Poetry `from`, Hatch wheel packages, PDM `package-dir`, maturin `python-source`;
   - otherwise, like setuptools' discovery, `src/` when it holds Python, else the project
     directory.

   Explicit `package-dir` mappings for single packages are honoured.
3. **Resolution order** follows Python's `sys.path` semantics:
   1. **Relative** imports resolve against the file's package. They are exact.
      - Climbing out of the top-level package is `RELATIVE_BEYOND_TOP_LEVEL`.
      - A namespace portion inside a regular package counts as part of it.
   2. **Standard library.** A standard-library top-level name (CPython 3.14's
      `sys.stdlib_module_names`, plus the modules removed in 3.12 and 3.13) is a built-in.
      The exception is a module of that name in the importing file's own base directory,
      which is a script's first `sys.path` entry. That case is internal, `inferred`,
      `STDLIB_SHADOWED`. A package's `logging.py` never shadows the standard `logging`.
   3. **Import roots, first match wins**, in this order:
      - the file's base directory (the nearest ancestor that is not a package);
      - its project's roots;
      - other projects' roots;
      - the repository root.

      Lookup order is CPython's: package, module, stub package, stub, then namespace
      directory. The match is `exact` from the file's own base or project. Otherwise it is
      `inferred`, as `WORKSPACE_PROJECT_MODULE` or `REPOSITORY_ROOT_MODULE`, and
      `AMBIGUOUS_MODULE_ROOT` when roots disagree.
   4. **A missing submodule** of a package that does exist locally is `LOCAL_TARGET_MISSING`,
      never an external package.
   5. **Other runtimes.** Python 2's standard library, PyPy built-ins and typeshed's
      `_typeshed` are built-ins, `inferred`, with a reason saying which.
   6. **External** distributions:
      - *declared* (exact) when the file's project or the root project declares a
        matching name;
      - otherwise *undeclared* (inferred, `UNDECLARED_EXTERNAL_IMPORT`), or
        `OPTIONAL_EXTERNAL_IMPORT` when the import is guarded.

      Matching an import to a name uses PEP 503 normalization, namespace distributions
      (`google.cloud.storage` → `google-cloud-storage`, `google.protobuf` → `protobuf`,
      `azure.*`), and a short table of widely used differences (`yaml` → `pyyaml`,
      `PIL` → `pillow`, `sklearn` → `scikit-learn` and others). A declared name always
      wins.
4. **From-imports name submodules.** `from p import a, b` resolves `p`, and each name that
   is a submodule becomes its own resolution at its own range, because importing it runs
   that file.
   - A namespace package has no file, so only its submodules appear.
   - `import ns` of a namespace package alone is `unsupported`, `NAMESPACE_PACKAGE`.
5. **Other outcomes.**
   - A guarded import of a missing local module is `OPTIONAL_TARGET_MISSING`, kept apart
     from `LOCAL_TARGET_MISSING`, so it is reported but not flagged as broken.
   - Excluded targets are `excluded-target`.
   - Case-only differences are `CASE_MISMATCH`, because Python imports are case-sensitive
     on every platform.
   - A resolved `.pyi` stub makes the edge type-only.
   - Literal dynamic imports follow the same rules with `resolverMode`
     `python/dynamic`.

## Verification

- `packages/analyzer-py/test/resolve.test.ts` has 10 tests on a monorepo fixture covering:
  - discovery, roots, workspace members, dependency fields and ranges, `-r` includes,
    ignored fixtures, `setup.py` literals only, invalid TOML;
  - requirement parsing, normalization, linear workspace globs (a 200-star pattern stays
    fast), distribution candidates;
  - relative, submodule, standard-library and shadowing cases;
  - source roots from tests, workspace and `setup.py` projects;
  - declared and undeclared externals;
  - namespace, missing, guarded, excluded, case-mismatched and beyond-top-level targets;
  - stubs, dynamic imports, Python 2 and other-runtime modules.
- **On the installed `pip` 26.1.1** (395 files, all parsed), the resolutions break down as:

  | Outcome | Count |
  |---|---|
  | Internal, exact | 1,852 |
  | Standard library | 1,631 |
  | Python 2 standard library (all in compatibility shims) | 14 |
  | PyPy built-ins | 2 |
  | Typeshed-only | 2 |
  | Undeclared external (pip ships no manifest in site-packages) | 40 |
  | Optional external | 22 |
  | Non-literal dynamic imports | 17 |
  | Missing local targets: submodules pip stripped from its vendored copies | 3 |
  | Optional local target missing: msgpack's C accelerator | 1 |

  The table records the result after the four fixes above.
- All 25 analyzer-py tests pass, including the CPython oracle of ADR-056.
