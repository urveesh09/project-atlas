# ADR-065: Python workspace and mixed-repository corpus evidence

Date: 2026-10-17. Status: accepted, merged in [PR #33](https://github.com/urveesh09/project-atlas/pull/33) on 2026-10-17.
Extends ADR-057/060 for production M2.6. No analysis or artifact semantic change.

## Evidence and cause

Flask exercises one Python `src/` project. Workspace boundaries and mixed Python/TS
projects also need evidence from real, committed source, independently of generated
fixtures and repeat-hash determinism.

## Decision

Add two public MIT-licensed repositories, pinned immutably:

| Repository | Exact commit | Shape | Committed blobs / total bytes |
|---|---|---|---|
| `pydantic/pydantic-ai` v0.0.49 | `a5a471e1cd8571c6b691bbb07fcf60f83432d772` | uv workspace with five declared members | 373 / 23,766,594 |
| `fastapi/full-stack-fastapi-template` | `b1125d8839482cb7bbae603ddc6d0081bf87532e` | Python FastAPI backend plus TS/React frontend | 252 / 1,886,624 |

The current Pydantic AI HEAD considered during selection has 4,495 blobs totalling
305,149,519 bytes. Choose the smaller historical release deliberately; do not claim
this tests the current project's entire syntax or dependency configuration. Both
selected whole blob trees are below 10,000 files and 64 MiB, before any exclusions.
License text is read from each pinned `LICENSE`, not inferred from a repository name.

Acquisition uses `packages/ingest`, depth 201 and the existing 256 MiB acquisition
cap. Stored Git data is 9,455,296 and 1,847,358 bytes respectively. Read the pinned
tree, project manifests and selected import statements with offline `SafeGit` and
`readObjects`. Never check out, install, build or execute either repository.

Before the first analysis, author eighteen new checks in `repository-corpus.json`:
six file roles/languages/parse statuses and twelve import resolutions. These cover
Python workspace imports between projects, package `__all__` re-exports, relative
imports, standard-library modules, a declared PyPI underscore/hyphen mapping, and
the mixed backend/frontend's internal, PyPI and npm dependencies. Preserve the
existing 28 source-derived checks and four repository pins exactly.

Dynamic build-backend dependency hooks remain data and are never evaluated. Counts,
partial coverage and unsupported/unresolved imports must be reported as observed,
without changing expectations to match output.

## Verification

The first dev.7 run failed the independently authored `agent.py` → `pydantic_graph`
check. The outer namespace directory incorrectly masked a later regular package.
The expectations were retained. ADR-066 and prerequisite PR #30 fix component-wise
PEP 420 precedence, with nine regressions including an isolated CPython path oracle,
and bump the analyzer to dev.8. This corpus change itself changes no analyzer code.

All six repositories then pass five cold offline repeats on dev.8, exported streaming
artifact validation and all 46 authored checks. The original four repositories'
canonical/wire digests and 28 expectations match the prerequisite's baseline exactly.

| New repository | Parsed / supported | Internal / external / builtin / unresolved / unsupported / excluded imports | History | Artifact |
|---|---|---|---|---|
| Pydantic AI | 187 / 187 (177 Python, 6 TS, 4 JS) | 650 / 522 / 596 / 1 / 5 / 0 | 200 commits, 12 frames; commit-cap boundary | 0.728 MiB |
| Full Stack FastAPI | 135 / 135 | 322 / 276 / 44 / 31 / 0 / 4 | 145 commits, 12 frames; day boundary | 0.252 MiB |

These are bounded static analyses, not claims that every import resolves. Pydantic AI
has four nonliteral dynamic imports, a URL import and one missing generated target.
FastAPI has unresolved aliases/assets and four excluded generated-client targets;
the report preserves all categories and examples. No dependency hooks were evaluated.
Historical timings are corpus observations, not synthetic capacity acceptance.

The path comparator analyzes Harbor plus all six repositories through both builds.
Against the clean dev.8 prerequisite it finds **zero differences in all seven**.
Against pre-fix main/dev.7, the original four, Harbor and FastAPI have only the analyzer
version change; Pydantic AI also has the intended namespace-resolution changes.
The comparator's nonzero exit for that semantic comparison is retained, not bypassed.

Both new exported artifacts open through the actual local CLI server and Chromium:
search their authored file paths, select, inspect dependencies, no page errors, no
attached source and only loopback GET requests (16 per journey). Screenshots were
inspected. This is functional viewer evidence, not reference-device performance.

The machine-readable and Markdown reports contain pins, checks, digests, exclusions
and limitations. Required Windows/Linux corpus jobs and their independent comparison
must pass on the PR before M2.6 closes. G6 stays open.
