# ATLAS editions and how ATLAS compares with CodeCharta

Last reviewed: 2026-10-14, against the CodeCharta documentation in its public repository
([maibornwolff/codecharta](https://github.com/maibornwolff/codecharta), `gh-pages/src/content/docs`).
The comparison is updated whenever either product changes; a claim without a source here
is not a claim. Decision record: [ADR-048](../adr/ADR-048-editions-and-free-parity.md).

## Editions

| | **ATLAS Free** (MIT, today) | **ATLAS Team** (paid, not built yet) |
|---|---|---|
| Who | Anyone, for any repository, locally | Teams that return to the same map weekly |
| Analysis | Local CLI; source never leaves the machine | The same CLI, run locally or in the team's own CI |
| Viewer | Every feature on this page | The same viewer |
| Sharing | Files: artifacts, saved-view files, PNGs with provenance, deep links | A private, access-controlled workspace |
| Continuity | What you keep on disk | Retained baselines, scheduled refresh, change-review history |
| Collaboration | Exported views and annotations | Shared views, onboarding routes and annotations; comments |
| Support | Community issues | Support with response times |

**Rule:** no feature that ships free is ever moved to the paid edition. The paid edition
adds hosting, continuity and collaboration that cost money to run. Billing is deliberately
not built until pilots show repeated team use (ADR-048).

## Feature comparison (free editions)

CodeCharta is free and MIT-licensed; its maker sells consulting. ✓ = available, ◐ =
partial, — = absent. "Since" names the ATLAS ADR.

| Capability | CodeCharta | ATLAS Free |
|---|---|---|
| **Languages** | Many, through parsers and importers (SonarQube, tokei, coverage, CSV and others) | ◐ TypeScript and JavaScript deeply; other files as sized plots without metrics |
| **Dependency accuracy** | Dependency parser, experimental dependency view | ✓ Compiler-grade TS/JS resolution: every import statement with its line, kind, confidence and an unresolved reason; type-only kept separate |
| **Evidence for each number** | Metric values per building | ✓ Every count names its unit and policy (ADR-047); findings with rule, threshold, evidence and limits; hotspot factors listed |
| **History** | Compare two loaded maps (delta colours) | ✓ Up to 12 sampled snapshots on fixed plots, lineage across renames, tombstones; exact added/deleted/changed lists between any two snapshots; change colouring in six metrics with signed values in the table and cards (ADR-050) |
| **Metric mapping** | Choose the metric for area, height and colour; thresholds, gradient modes, distribution chart | ✓ Ten colour lenses (size, complexity, dependencies, history), editable bands with a distribution chart and even split, built-in views (ADR-052). Height stays code lines and area stays the history-stable layout by design |
| **Layouts** | Five (treemap, street, sunburst, radial…) | ◐ One deterministic, history-stable city; 3D, 2D map and an accessible table |
| **Search and filters** | Glob search greys out misses; flatten and exclude rules | ✓ Search by file, package or declaration; glob highlight with `!` excludes and exact counts (ADR-048); role and findings filters; focus on a folder and hide paths with plots kept fixed (ADR-051) |
| **Saved configurations** | Scenarios: built-in and custom, import/export | ✓ Saved views with import/export, validated on import (ADR-048); seven built-in views (ADR-052) |
| **Folder marking** | Folder colours, keep highlight | — Planned as local annotations |
| **Labels** | Top-N labels, configurable | ✓ Priority labels with direction marks in 3D (ADR-042, ADR-045); overlap-free map labels (ADR-047) |
| **Navigation** | Mouse, view cube | ✓ Mouse, touch, keyboard driving, previous/next view, expanded workspace with evidence (ADR-045, ADR-047) |
| **Export** | Screenshot to file or clipboard; 3D print model | ✓ PNG with embedded provenance, metadata JSON, copy image (ADR-047, ADR-048). — No 3D print yet |
| **Accessibility** | Not documented | ✓ WCAG 2.2 AA target: keyboard everywhere, semantic table, automated axe checks in CI |
| **Safety** | Local analysis | ✓ Never runs repository code; offline analysis; source-free, hash-verified artifacts |
| **Hosted analysis of public repositories** | — | ◐ Implemented and tested, not deployed (R6-06) |
| **Onboarding** | Documentation | ✓ Guided start with tasks on real targets, live demo (ADR-047) |

## Where ATLAS must catch up, in order

These are the free-edition gaps, ordered by user value against effort. Each needs an ADR
before it ships.

1. ~~**Delta colouring in Compare.**~~ Done in [ADR-050](../adr/ADR-050-change-colouring-in-compare.md):
   six metrics, signed numbers, unknowns kept unknown.
2. ~~**Hide and focus.**~~ Done in [ADR-051](../adr/ADR-051-scope-focus-and-hide.md). Originally: exclude paths from view (a stable plot stays empty, so history
   stays comparable), and focus on one folder.
3. ~~**Metric choice and thresholds.**~~ Done in [ADR-052](../adr/ADR-052-metric-lenses-bands-and-presets.md). Originally: more colour metrics (code lines, total complexity,
   functions, lines changed), adjustable band thresholds, a distribution chart, built-in
   view presets.
4. **Annotations:** local folder colours and notes, exportable with saved views.
5. **Package dependency view:** layered package graph with cycles and upward edges.
6. **More languages:** the largest gap. It needs the owner's direction and a resolver
   design per language (AGENTS.md: new scope needs an ADR).
7. **3D print export.**

## Where ATLAS is already ahead

- **Trust:** each number names its unit and policy and links to the statement or
  rule behind it.
- **Time:** a stable city across history, with lineage through renames.
- **Safety:** analysis is offline, the analyzed repository never runs, and artifacts
  are verifiable.
- **Access:** keyboard-first and checked in CI.
- **First use:** a guided start and an evidence workspace.
