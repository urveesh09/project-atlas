# ADR-067: Apply the existing edge ceiling to the complete dependency graph

Date: 2026-10-17; landed with M2.2 on 2026-10-19. Status: accepted,
merged in [PR #48](https://github.com/urveesh09/project-atlas/pull/48) on 2026-10-20. Production M2.2 prerequisite. Analyzer dev.8 → dev.9, shared with
[ADR-080](ADR-080-python-3-15-syntax.md) in the same change; graph/artifact schemas and
every resource, size and timing ceiling remain unchanged.

## Evidence and cause

The clean dev.8 near-limit Python history diagnostic finishes its twelve graphs and
layout, then fails export: `SCHEMA edges Too big: expected array to have <=100000 items`.
The source aggregator retains at most 100,000 edges, but `analyzeStaticSnapshot` adds
package declarations and project references afterwards. Canonical, indexed and delta
graph readers all apply the same existing 100,000-row bound to the combined array.
Consequently analysis can construct a graph that its own exporter rejects. Peak
cgroup memory is 1,372,721,152 bytes with zero OOM events; this failure is not an OOM.
The failed diagnostic is retained and is not an acceptance sample.

An independently authored regression reproduces the exception with 100 package
manifests × 1,001 distinct dependencies: exactly 100,100 package relationships,
one parsed TS file, no source imports or executable configuration. It fails before
the correction. This also demonstrates the issue independently of the Python fixture.

## Decision

- Keep all existing canonical/wire limits and compatibility. Do not enlarge a schema
  bound, lower the required workload or claim an over-cap graph is complete.
- Apply the existing dependency-relationship budget to the merged source/package
  edge array, ordered by canonical edge ID. Package declarations and project
  references are dependency relationships too; parent/containment is represented
  by node fields and consumes no edge rows. No kind gets preferential retention.
- Source aggregation already retains its lowest 100,000 IDs. A discarded source ID
  cannot enter the joint lowest 100,000 after more IDs are added, so the bounded
  source prefix is sufficient; no unbounded second aggregation is needed.
- Record `EDGE_LIMIT` with the exact number of omitted aggregate edges, including
  omissions already made by source aggregation. Record `EDGE_RELATIONSHIPS_OMITTED`
  with their exact statement/declaration multiplicities, not just a unique-edge count.
  Retain existing bounded observation evidence and its independent evidence cap.
- The existing coverage/diagnostic path marks analysis partial and emits the limit
  finding. Dependency metric availability is partial when edges were dropped:
  observed degrees and detected SCCs remain useful, but omitted edges can affect
  counts and connectivity beyond their own endpoints. Syntax remains independent.
- This changes over-cap analysis semantics. Bump the analyzer identity and refresh
  version-derived goldens and the six-repository baseline deliberately in the same
  implementation commit. No format bump is necessary: the result obeys the same
  pre-existing schema, and coverage reason codes are extensible.

The synthetic fixture separately added a typing import to every function module,
including those without type guards. It also translated every TS class-only import
to a guard, adding thousands of edges beyond the original large fixture's near-cap
load. Keep that over-cap failure as a negative resource case, not a complete-input
capacity pass. The capacity PR defines a distinct, recorded fixture variant before
new measurements: keep all ten original dependency statements and targets; represent
Python's runtime class imports and guarded class imports (one in four modules by
function number), and add the real typing import only when used. File counts,
function bodies, history and every original dependency survive. Runtime class imports
also participate in degree/cycle computation. Do not claim this variant matches
the TS type-only edge-kind distribution, or relabel prior measurements as its evidence.
Record the policy in fixture metadata and reports, reject stale prepared Python
fixtures, and rerun every acceptance row from clean dev.9 source/image. No original
import is dropped and no schema, omission or performance gate is relaxed.

## Verification

Three focused checks pass: the real 100,000-row joint boundary with exact omitted
multiplicities and input ownership; below-cap canonical preservation; and the full
100,100-declaration inventory → hierarchy → exported partial artifact regression.
The latter retains exactly 100,000 edges, reports 100 omitted relationships, emits
the limit finding, keeps syntax complete and marks dependency metrics partial.
Before correction it fails with the same export exception as the history diagnostic.

Fresh six-repository/five-repeat evidence, comparison against clean dev.8, narrow
golden refresh, full verification and required CI are recorded before acceptance.
Capacity samples restart separately; neither this regression nor a one-shot
diagnostic is a twenty-sample pass. G6 stays open.

## Landing (2026-10-19)

This decision was written on 2026-10-17 and left uncommitted in a local checkout. It lands
unchanged in the M2.2/M2.7 pull request.
- **The defect recurred on the clean M2.7 commit.** On `6ad88a6` (analyzer dev.9 with the
  3.15 grammar, without this fix), the Python large-HEAD capacity row failed in its warm-up
  with the same exception: `SCHEMA edges Too big: expected array to have <=100000 items`.
  - Zero OOM events were recorded.
  - The structured failure report is retained as
    [production-python-head-large-edge-overflow-6ad88a6](../benchmarks/production-python-head-large-edge-overflow-6ad88a6.md).
- **Two medium HEAD rows from that superseded fixture passed**, before the matrix was
  stopped. They are not acceptance evidence for the new fixture and are not published as
  rows:
  - Python: p95 6.27 s, parser child 168.79 MiB, job 483.01 MiB;
  - mixed: exit 0.
- **The fixture variant described above is implemented as policy
  `atlas.capacity.python/2`.**
  - Every module keeps its ten authored statements and targets.
  - Type-only imports become runtime class imports, except in modules whose function
    number is divisible by four, which guard them with `TYPE_CHECKING`.
  - Only those modules import `typing`.
- **Fixture metadata and reports record the policy.** The container runner rejects a
  prepared Python or mixed fixture without it, and reports also record HEAD edge counts and
  limits hit.
- **Verification on 2026-10-19.**
  - The three regressions above pass, as does the updated fixture test: each module's
    authored imports survive, and the typing import appears exactly where a guard uses it,
    in at most a quarter of modules.
  - One diagnostic analysis per language of the 9,850-file HEAD fixture is `complete`, with
    no limit hit, for TypeScript, Python and mixed. It is a diagnostic, not a sample.
  - The version-derived Harbor golden changes only with the shared dev.9 bump.
- **Capacity rows are rerun** from a clean image of the commit containing this fix
  ([ADR-081](ADR-081-python-capacity.md)).
