# ADR-062: Python parser runtime and analysis identity

Date: 2026-10-16. Status: accepted (production M1.5; CI tracked in the implementation PR).
Extends ADR-056/060 and ADR-061. Artifact schema stays `atlas.artifact/1.4.0`.

## Evidence and cause

The production plan upgrades `web-tree-sitter` 0.25.10 to 0.27.1. The runtime parses
untrusted Python inside the existing bounded parser child. Review of upstream's
[0.26.1 notes](https://github.com/tree-sitter/tree-sitter/releases/tag/v0.26.1)
(the first published 0.26 release),
[0.27.0 notes](https://github.com/tree-sitter/tree-sitter/releases/tag/v0.27.0) and
[0.27.1 notes](https://github.com/tree-sitter/tree-sitter/releases/tag/v0.27.1)
includes WASM loading/memory and UTF-16 decoding fixes. Named ESM exports and the
`Parser.init` → `Language.load(bytes)` → `setLanguage` interface used here remain
available. New APIs do not require adopting synchronous loading or different grammar
build tools.

The parser identifier is recorded in manifests, graph metadata, fact-cache keys and
the analysis key. Keeping the old identifier to preserve hashes would misidentify
the runtime and reuse old Python facts. An honest runtime update therefore changes
export bytes even if every extracted fact is preserved. The previous golden is
expected to fail; that failure is retained before its deliberate replacement.

## Decision

- Pin runtime 0.27.1 exactly. Use one version constant for its recorded runtime and
  parser identifier, `tree-sitter-python@0.25.0+wts@0.27.1`.
- Keep the vendored Python 0.25.0 grammar, its MIT license and SHA-256
  `16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47`.
  Loading succeeds; tests assert ABI 15 lies inside the new runtime's compatibility
  range. There is no grammar rebuild or claim that known grammar gaps are fixed.
- Bump `ANALYZER_VERSION` from `0.1.0-dev.6` to `0.1.0-dev.7`, recording the runtime
  change explicitly. Analysis IDs/keys and their derived hashes change for TS/JS
  artifacts too because the analyzer records the combined parser set. Python fact
  caches invalidate through their parser identifier; TS/JS fact-cache keys retain
  their TypeScript parser/extractor versions. Existing exported artifacts remain
  readable under the unchanged schema.
- Regenerate the real-corpus baseline and Harbor's version-derived hash golden in
  this same change only after comparing facts against a separately built main.
  Do not change authored source expectations, grammar-gap tolerance, process limits,
  test deadlines, or baseline comparison rules.
- Add UTF-16 regression cases with astral text at several input lengths and EOF;
  assert the import's actual source slice, offsets, line/column and code-line count.

## Verification

Before upgrade, CPython 3.14.5's standard-library oracle covers 1,848 files:
1,841 parse on both sides, three only on CPython, zero only on ATLAS and zero fact
mismatches. The three known gaps are `test_annotationlib.py`, `test_compile.py` and
`test_type_params.py`. The upgraded oracle reproduces those exact counts.

Comparison against the separately built clean `4a39f66` covers Harbor plus all four
pinned repositories. Under the existing ADR-060 normalization, all facts, imports,
metrics, findings, history and layout agree. The existing command exits 1 because
it also compares `summary.analyzerVersion` literally: each repository has exactly
that one dev.6 → dev.7 difference. A separate strict assertion validates the entire
report contains only these five declared transitions. No comparator is weakened.
The fresh four-repository corpus passes five offline cold repeats, unchanged
authored checks and verified deterministic exports. Baseline and golden identities
are deliberately refreshed for dev.7.

All 19 extraction tests pass, including five new cases. A rebuilt sandbox loads ABI
15 and extracts authored Python facts as uid 10001 with no network, read-only root,
no capabilities, no-new-privileges, two CPUs and 512 MiB without swap. This is a
parser smoke, not M2.3's hosted Python journey.

Full verification passes 751 tests, including the oracle and 39 viewer journeys;
81 tests skip explicitly. Typecheck, viewer build, dependency direction and six
generated contracts pass. All six relocated distribution stages pass, followed by
an extra extracted-archive Python analyze/verify/inspect smoke with the authored
import and complexity expectations. The 10,491,077-byte dirty-tree development
archive has SHA-256 `33914566fc0081776e5dd3280db38eedd39544dc650d565a6a20bcc393f447cf`;
it is packaging evidence, not a selected release. Historical candidate reports and
screenshots are restored after retaining these local results. Required CI follows
before handoff. The
[evidence report](../benchmarks/production-python-runtime.md) retains boundaries and
initial failures. No human/device/deployment G6 gate is closed.
