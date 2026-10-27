# ADR-080: Python 3.15 syntax

Date: 2026-10-19. Status: accepted, merged in [PR #48](https://github.com/urveesh09/project-atlas/pull/48) on 2026-10-20. Production
M2.7. Supersedes [ADR-056](ADR-056-python-support-design-and-facts.md) §1's choice of the
prebuilt npm grammar file; its vendoring rules (licence, recorded SHA-256, hash test) still
apply. Analyzer `0.1.0-dev.9`; artifact and graph schemas are unchanged.

## Evidence and cause

**The gap.** CPython 3.15.0 (released 2026-10) adds syntax that tree-sitter-python 0.25.0
cannot parse. M3.1 found it on macOS's default 3.15.0: 59 of 2,054 standard-library files
parse only in CPython, 2.96%, above the oracle's 1% bound ([ADR-068](ADR-068-macos-in-ci.md)).
Reproduced here on Windows with CPython 3.15.0 and its complete source standard library
(`Python-3.15.0.tgz`, SHA-256 `438596ca…db0db68` as published by python.org): 2,052 files,
1,988 parsed by both, **59** only by CPython.

**What changed in 3.15's grammar.** Checked against "What's New in Python 3.15" and the
CPython grammar changes behind it:

| Change | Example | Grammar 0.25.0 |
|---|---|---|
| PEP 810 lazy imports (soft keyword `lazy`) | `lazy import json`, `lazy from os import path` | parse error |
| PEP 798 unpacking in comprehensions | `[*L for L in lists]`, `{**d for d in dicts}`, `(*a async for a in agen())` | parse error for most forms |
| Unary plus in literal patterns (gh-145239) | `case +1:`, `case +1 - 2j:` | parse error |

A numeric literal directly followed by a keyword (`1if x else y`) now warns; it is still
valid and still parses.

**No upstream release has them.** The latest tree-sitter-python is 0.25.0 (2025-09-11).
Lazy imports are open upstream PR #336 (not merged); PEP 798 is open issue #352. Waiting
leaves 3.15 files as visible parse failures with no dependency facts, and for a dependency
analyzer a lazy import is a dependency that must be found.

**CPython's checks for lazy imports.** Measured with 3.15.0: `ast.parse` rejects only
`lazy from __future__ import …`. The other restrictions (not in functions, classes or
try blocks; no `*`) are raised when compiling, after parsing succeeds.

## Decision

1. **Build the grammar from source with a recorded patch.** `packages/analyzer-py/grammar/
   python-3.15.patch` changes upstream v0.25.0 (commit `293fdc02…`):
   - lazy imports exactly as in upstream PR #336, so a future upstream release is a
     drop-in replacement;
   - comprehension bodies accept `list_splat`/`dictionary_splat`, as in CodeQL's
     tree-sitter-python fork;
   - an optional `+` before a literal-pattern number, and before the real part of a complex
     pattern. CPython 3.15.0 rejects a `+` on the imaginary part (`case 1 + +2j`), so the
     patch does not accept it either. The CPython pull request proposed it, but it did not
     ship.

   It also adds upstream-format corpus tests for all three.
2. **Reproducible build.** `scripts/build-python-grammar.mjs` fetches the pinned commit,
   applies the patch and verifies the tree-sitter CLI 0.25.9 archive's SHA-256. In one
   `--network=none` emscripten 4.0.4 container pinned by digest, it then generates the
   parser, runs every upstream corpus test and compiles to WebAssembly. Without `--install`
   it fails unless the result equals the vendored file. CLI 0.25.9 is the generator
   upstream used for 0.25.0, and emscripten 4.0.4 is the version that CLI pins.
3. **Identity.** The grammar records itself as `tree-sitter-python@0.25.0+atlas.1` (SHA-256
   `40f01ba5…aed3bb`). The parser version string becomes
   `typescript@6.0.3 tree-sitter-python@0.25.0+atlas.1+wts@0.27.1` (62 of the schema's 64
   characters). It changes artifact provenance and fact-cache keys, so
   `ANALYZER_VERSION` becomes `0.1.0-dev.9` and the corpus baseline is updated in the same
   change.
4. **Lazy imports are ordinary import facts.** A `lazy import`/`lazy from` produces exactly
   the record the same statement without `lazy` would, including kind, names, re-exports,
   `TYPE_CHECKING` and guards. "Lazy" is not kept as evidence:
   - it does not change what depends on what;
   - recording it would need a new artifact field (schema 1.5) and viewer work.

   Lazy imports are often used to break import cycles at run time, and ATLAS reports
   static cycles. A future ADR may add the flag if users need to tell those cycles apart.
5. **Match CPython's parser, not its compiler.** `lazy from __future__ import …` is a failed
   parse (`SYNTAX_ERROR`, with the statement's range), as in `ast.parse`. Lazy imports in
   functions, classes or try blocks, and lazy wildcards, parse and are recorded. They are
   still dependencies, and the CPython oracle compares against `ast` too.
6. **The CPython oracle moves to 3.15.0** in CI and the release workflow, as M2.7 planned
   once 3.15 passes.
7. **One version for both changes.** The edge-budget fix
   ([ADR-067](ADR-067-shared-dependency-edge-budget.md)) also proposed `0.1.0-dev.9`, and
   was left uncommitted on 2026-10-17. It lands in the same pull request, so
   `0.1.0-dev.9` means the 3.15 grammar plus the shared edge budget. Below the cap the
   budget changes nothing.

## Verification

- **Reproducible build.** Two clean builds from the pinned inputs produced the same 464,346
  bytes, SHA-256 `40f01ba5…aed3bb`. All 120 upstream corpus parses pass, including the new
  tests.
  - One upstream expectation changed. With 0.25.0, a list containing a single splat
    followed by an attribute, subscript or call (`[*a.b]`, `[*a[b].c]`, `[*a()]`) parsed
    as `(*a).b`. The patched grammar parses it as `*(a.b)`, as it already did for lists
    with more than one element.
  - This is a correction. It lets ATLAS find, for example,
    `[*importlib.import_module("x").ALL]`, and a test covers it.
  - Rebuilding unmodified 0.25.0 the same way gives a different file from the npm one: 23
    bytes larger, SHA-256 `a4315341…`. So equivalence was checked by trees, not bytes.
- **Old and new trees, file by file.**
  - CPython 3.14.5's installed standard library: all 720 files give identical trees.
  - CPython 3.15.0's installed standard library: 571 of 598 files are identical. The other
    27 failed to parse before and now parse. No file that parsed before changed or failed.
- **CPython oracle, 3.15.0, full source standard library (2,052 files).**

  | Grammar | Parsed by both | Only CPython | Only ATLAS | Mismatches |
  |---|---:|---:|---:|---:|
  | 0.25.0 | 1,988 | 59 (2.97%) | 0 | 0 |
  | 0.25.0+atlas.1 | 2,044 | 3 (0.15%) | 0 | 0 |

  - **The three remaining files are not 3.15 syntax.** CI's CPython 3.14.8 oracle
    (run 39150097390) lists the same three. Each is an older gap in the upstream grammar:
    - `test/test_annotationlib.py`: a starred parenthesized item in a subscript,
      `Union[*args, *(kwargs.values())]` (PEP 646, 3.11);
    - `test/test_type_params.py`: type-parameter defaults,
      `def f[T: int = int, **P = int, *Ts = int]()` (PEP 696, 3.13);
    - `test/test_compile.py`: a deliberately unbalanced dedent inside parentheses (the
      `test_weird_attribute_position_regressions` case), which the indentation scanner
      does not accept.
  - **"Only ATLAS" is 0** because `lazy from __future__` is a failed parse (decision 5).
    That case is CPython's own bad-syntax test,
    `test_lazy_import/data/badsyntax/lazy_future_import.py`.
  - CPython 3.14.5 locally: 720 files, all parsed by both, 0 mismatches.
- **Extractor tests.** 69 Python analyzer tests pass (one oracle skip without an
  interpreter). The new tests cover:
  - lazy imports of every form, re-exports, `TYPE_CHECKING` and guards;
  - complexity with unpacking comprehensions;
  - unary-plus patterns;
  - the lazy `__future__` failure;
  - the single-splat dynamic import.
- **Corpus.** The six pinned repositories were acquired fresh and analyzed 5 times each
  offline. All are deterministic and pass exported streaming verification, with the
  authored checks unchanged. Every digest changes because IDs include the analyzer version.
  - The path comparator against main's dev.8 build (`compare-analysis-paths.mjs`, Harbor
    plus all six) finds exactly one difference per repository: the analyzer version. No
    dependency, finding, metric or layout changed. None of the pinned repositories uses
    3.15 syntax or the single-splat form.
