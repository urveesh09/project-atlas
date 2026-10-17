# ADR-066: Python namespace precedence and component-wise package lookup

Date: 2026-10-17. Status: accepted; required CI and owner merge tracked in the fix PR.
Supersedes ADR-057's interpretation of first-match import-root lookup. Analyzer
`0.1.0-dev.8`; artifact and graph schemas remain unchanged.

## Evidence and cause

M2.6's independently authored Pydantic AI check fails at immutable commit
`a5a471e1cd8571c6b691bbb07fcf60f83432d772`:
`pydantic_ai_slim/pydantic_ai/agent.py` imports `pydantic_graph`, which should point
to `pydantic_graph/pydantic_graph/__init__.py`. The original graph instead emits
four unresolved imported names (`End`, `Graph`, `GraphRun`, `GraphRunContext`).
The raw parser correctly extracts the statement. Root lookup chooses the outer
repository directory `pydantic_graph` as a namespace before considering the later
workspace source root containing the regular package. No corpus expectation changes.

[PEP 420's specification](https://peps.python.org/pep-0420/#specification) requires
collecting namespace portions while continuing the path search. A regular package
or module wins if found later. Only when none wins are the portions combined.
Searching the entire dotted name independently under each root is also wrong: it
can borrow a child from a discarded namespace or bypass a parent module file.

## Decision

- Search absolute import roots one module component at a time. Retain the existing
  package/module/stub ordering within each root. A first regular match wins over
  accumulated namespaces; another regular match retains the existing ambiguity
  confidence. Descend solely through the selected regular package, or all surviving
  namespace portions. A module file cannot provide child modules.
- Resolve `from ns import child` across all surviving namespace portions, retaining
  each imported name's exact source range. Carry the original import root through
  traversal so own-project/workspace/repository confidence remains truthful.
- Preserve relative imports, explicit package-dir mapping, standard-library policy,
  exclusion/case diagnostics, inferred external distribution policy and the
  unsupported result for a file-less namespace imported alone.
- Do not execute analyzed repositories or consult an installed Python environment.
  The resolver still uses only its in-memory committed-path index.
- This deliberately changes resolution semantics. Bump analyzer dev.7 → dev.8 to
  invalidate cached facts/analysis identities and update version-derived goldens
  and the existing four-repository baseline in the same implementation commit.
  New-repository corpus expansion stays in its separate M2.6 PR.
- Retain the three completed dev.7 capacity reports as historical measurements.
  Finish M2.2 using a clean image and measurement source containing this correction;
  do not relabel old runs as measurements of dev.8.

## Verification

Before the fix, seven of nine new checks fail. Two pass, including an independent
CPython PathFinder oracle for six authored lookup cases. After the fix, all nine
and the existing eleven resolver tests pass. The oracle uses isolated Python and
only `find_spec`; it never imports or executes any fixture module. Its expected
paths are authored independently, including namespace/regular precedence,
discarded-parent blocking and composition of namespace portions.

Fresh existing corpus: four repositories × five cold repeats, all 28 authored
checks unchanged, exact repeat payloads and verified exports. The dev.8 baseline
is refreshed deliberately. A comparison against clean main `4d0f6ee` finds only
the five declared `summary.analyzerVersion` transitions (Harbor plus four repos);
all other normalized facts agree. Preserve the comparator's expected exit 1.
Refresh only the four Harbor golden hashes after this proof; the original mismatch
is retained. No comparator rule changes.

Full verification passes 760 tests with 81 explicit service-gated skips, including
the CPython oracle and all 39 viewer journeys. Typecheck, viewer build, dependency
direction and generated contracts pass. A separate static Pydantic diagnostic
resolves the expected package and reduces unresolved observations from 64 to one
while parsing the same 187 Python files. It is not a five-repeat corpus or capacity
gate. Sandbox/distribution checks and required CI remain tracked in the PR as they
complete. No deadline, capacity budget, source expectation or validation rule is loosened.
