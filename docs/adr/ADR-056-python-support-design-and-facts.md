# ADR-056: Python support: design, parser and syntax facts

Date: 2026-10-14. Status: accepted. Follows [ADR-048](ADR-048-editions-and-free-parity.md),
which named more languages as the largest gap. This ADR records the owner's direction and
the design. It delivers the first part: a Python adapter that extracts syntax facts.
Resolution and the artifact contract follow in their own ADRs. No artifact byte changes
until those land.

## Evidence and cause

- **The owner's direction (2026-10-14).** Start development for Python. Current quality
  must not be hindered, and Python must be "just as deep" as TypeScript and JavaScript.
- **What "as deep" means here.** The TS/JS adapter provides, per file:
  - every import statement with its kind, exact source range, and resolution provenance:
    internal file, external package, built-in, or unresolved or unsupported with a reason;
  - top-level declarations, with whether each is exported;
  - physical and code lines;
  - per-callable cyclomatic complexity with the decisions that make it up;
  - parse failures as findings, never silent;
  - the same graph, metrics, findings, history and city as every other file.

  Python must reach each of these. The definitions below are written for Python's own
  semantics, not copied from TS where they would be wrong.
- **Constraints.**
  - Analyzed repositories are data and never run; analysis is offline.
  - Output is deterministic and cross-platform.
  - The TS/JS baseline stays byte-exact until a deliberate, versioned change.
  - Parsers run in bounded child processes (plan §15.3).

## Decision

### 1. Parser

- **Grammar.** Python is parsed by the official tree-sitter Python grammar 0.25.0,
  compiled to WebAssembly, through `web-tree-sitter` 0.25.10 (MIT, no dependencies, no
  install scripts).
- **The grammar file is vendored.** Only `tree-sitter-python.wasm` and its licence are
  taken from the registry tarball, into `packages/analyzer-py/grammar/`.
  - The tarball matched its published integrity
    `sha512-eCmJx6zQa35GxaCtQD+wXHOhYqBxEL+bp71W/s3fcDMu06MrtzkVXR437dRrCrbrDbyLuUDJpAgycs7ncngLXw==`.
  - The WASM file's SHA-256 is recorded and checked by a test:
    `16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47`.
  - The npm package is not a dependency, because it pulls native build tooling that the
    workspace never runs (`onlyBuiltDependencies: []`).
- **Why tree-sitter rather than a hand-written parser.**
  - It is a complete, maintained grammar: `match`, PEP 695 type parameters, PEP 701
    f-strings, `except*` and async.
  - Its node offsets are UTF-16 code units, exactly like the TypeScript compiler's, so
    Python source ranges use the same convention.
  - It is deterministic and runs inside WebAssembly memory.
- **Running CPython is rejected.** It would add an interpreter to the analysis sandbox and
  ties results to the installed version.
- **Parse failures.** A syntax tree with any `ERROR` or `MISSING` node is a failed parse,
  reported with up to 100 error ranges. As for TS, no dependency, declaration or complexity
  claim is made from a malformed tree. Physical lines are still counted.

### 2. Facts: the same record as TS/JS

`analyzeFile` in `@atlas/analyzer-py` returns the existing `FileFacts` shape, with
language `python`.

1. **Imports.** One raw import per imported module:

   | Statement | Kind | Specifier | Range |
   |---|---|---|---|
   | `import a.b as c` | `imports-value` | `a.b` | the dotted name |
   | `from a.b import x, y` | `imports-value` | `a.b` | the module name |
   | `from .p import x` | `imports-value` | `.p` (dots carry the level) | the module name |

   - A from-import also carries the imported names with their ranges, because a name may
     be a submodule that resolution must reach.
   - `from __future__ import …` is a compiler directive, not a dependency, and is not
     recorded.
   - **Type-only** (`imports-type`): imports inside `if TYPE_CHECKING:` (bare name or
     `typing.TYPE_CHECKING`), but not its `else` branch, and every import in a `.pyi` stub.
   - **Re-exports** (`reexports-value` or `reexports-type`), only in `__init__.py` and
     `__init__.pyi`, by the PEP 484 rule: a wildcard, a redundant alias (`x as x`), or a
     name listed in `__all__`.
   - **Dynamic** (`imports-dynamic-literal`) covers three call forms, each only where its
     name is actually bound:
     - `importlib.import_module("m")` where `importlib` is imported;
     - `import_module("m")` where it is imported from `importlib`;
     - `__import__("m")`.

     A non-literal argument is `unsupported` with `NONLITERAL_DYNAMIC_IMPORT`.
   - **Guarded imports.** An import inside a `try` that catches `ImportError`,
     `ModuleNotFoundError`, `Exception` or everything is marked guarded. A missing optional
     target is then reported as such, not as a broken local import (ADR-057).
2. **Declarations.**
   - Module-level definitions, including those inside module-level `if`, `try`, `with`
     and `match` blocks, but not inside functions or classes.
   - Kinds:
     - `def` → `function`;
     - `class` → `class`, but `interface` for a `Protocol` and `enum` for an `Enum`,
       `IntEnum`, `StrEnum`, `Flag` or `IntFlag`;
     - `type X = …` or `X: TypeAlias = …` → `type`;
     - assigned names → `variable`.
   - *Exported*: listed in a literal `__all__` when one exists; otherwise a name not
     starting with `_`.
3. **Lines.**
   - Physical lines as for TS.
   - Code lines: distinct physical lines touched by a token other than a comment or a
     docstring.
   - A docstring is a bare string literal as the first statement of a module, class or
     function. It is documentation, like a JSDoc comment.
4. **Cyclomatic complexity per callable.** Callables are `def`, `async def` and `lambda`.
   Each counts 1, plus:
   - `if`: `if` and `elif` statements, and comprehension `if` clauses;
   - `loop`: `for`, `async for` and `while` statements, and comprehension `for` clauses;
   - `catch`: each `except` or `except*` clause;
   - `conditional`: each conditional expression;
   - `case`: each `case` clause except an irrefutable `case _:` without a guard, which is
     Python's default;
   - `logical`: each `and` or `or` operator.

   Nested callables are separate, and class bodies and module statements belong to no
   callable, as for TS.

   Callable kinds:
   - a method is a `def` in a class body, with `__init__` as the constructor;
   - `@property` makes a getter, and `@x.setter` a setter;
   - a `lambda` takes the name it is assigned to, otherwise "lambda (line N)".

### 3. What follows

1. **ADR-057, resolution.** Static import roots from `pyproject.toml`, `setup.cfg`,
   `setup.py` literals and src layouts. Then relative imports, submodule names, namespace
   packages, the standard library, and declared and undeclared PyPI distributions, with
   the same statuses, confidences and reasons as TS.
2. **ADR-058, integration.** `language: python`, the `pypi` ecosystem, Python built-ins,
   roles, packages and findings. It deliberately bumps the artifact, graph-schema and
   analyzer versions and updates the baseline in the same change.
3. **Quality bar.**
   - Every extraction rule is checked against CPython's own `ast`, used only as an
     offline test oracle on committed fixtures and on pinned real repositories.
   - Pinned real Python repositories join the validation corpus.

## Verification (this change)

- **Unit tests.** `packages/analyzer-py/test/extract.test.ts` has 14 tests covering:
  - the grammar's SHA-256;
  - modern syntax (`match`, PEP 695, PEP 701, `except*`, async, walrus);
  - syntax errors as failed facts;
  - UTF-16 ranges with non-ASCII text;
  - every import form, including type-only, re-export, stub, dynamic, unbound
    look-alikes, guarded and non-literal;
  - declarations, kinds and `__all__` (`=`, `+=`, `extend`, dynamic);
  - code lines;
  - per-callable complexity with contributions and kinds;
  - the three details the oracle found below.
- **CPython oracle.** `packages/analyzer-py/test/oracle.test.ts` runs CPython's `ast` and
  `tokenize` with `-I`, on the files read as data, over the standard library of the
  interpreter it finds.
  - The test is skipped, and says so, only when no Python 3.10+ is present. GitHub's
    Ubuntu and Windows runners ship one, so it runs in CI.
  - Result on CPython 3.14.5, 1,848 files:
    - 1,841 parsed by both;
    - imports, declarations, complexity and code lines agree on every one of them,
      with 0 mismatches.
- **What the oracle caught** while the extractor was written. Each is fixed and pinned
  by a unit test:
  1. A string's content node is not a leaf when it holds escape sequences, so code lines
     missed the text around them (167 files). String content now counts on every line it
     covers.
  2. A comment inside an f-string replacement field (PEP 701) was counted once strings
     were treated as one token (1 file). Interpolations are now walked as code.
  3. Capture patterns (`case name:`, `case (name):`) are Python's default and add no
     decision, but a one-element sequence (`case y,:`) does (2 files).
- **Known grammar gaps.** CPython 3.14 accepts 3 of the 1,844 parseable files that the
  grammar rejects (0.16 %). Each such file is reported as a failed parse with its error
  range, never analyzed from a broken tree. The causes:
  - PEP 646 unpacking in a subscript (`Union[*args]`);
  - PEP 696 type-parameter defaults (`[T = int]`);
  - a deliberately dedented continuation line inside nested parentheses, in a CPython
    test of exactly that.

  The oracle test asserts that such gaps stay under 1 %.
- **Speed.** On this machine, extraction of the largest standard-library file (406 KB)
  takes 0.45 s.
