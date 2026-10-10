# Metric definitions: atlas.metrics/1

The normative text is plan §10; this page is the implementation index. P2.1–P2.4 syntax, dependency and static findings are implemented. Churn, full hotspots and structure attention remain Phase 4. Thresholds are versioned product defaults, not quality standards.

| Metric | Definition | Task |
|---|---|---|
| Physical lines | LF-delimited lines; an empty file has 0; a trailing LF adds no line | P2.4 |
| Code lines | Distinct physical lines intersecting a non-trivia token | P2.4 |
| Cyclomatic (per callable) | 1 + `if`, loops, `catch`, conditional expressions, non-default `case`, `&&`, `||`, `??`; optional chaining is not counted | P2.4 |
| Max/sum complexity | Over callables; parsed with no callables = 0/0; failed or unsupported = null | P2.4 |
| Fan-out / fan-in | Unique included file targets/sources over `DEGREE_EDGE_KINDS` (value import, value re-export, literal require, literal dynamic import) | P2.3 |
| Static cycle | SCC larger than one file, or a self-edge, over `CYCLE_EDGE_KINDS` (value import, value re-export, literal require) | P2.4 |
| Churn | Changed commits and numstat lines in the bounded prior window | P4.4 |
| Hotspot | `round(100 × (0.40·pComplexity + 0.25·pFanIn + 0.35·pChangedCommits))` over the HEAD cohort; null without usable history | P4.4 |
| Structure attention | `0.60·pComplexity + 0.40·pFanIn`, labeled distinctly | P4.4 |

The edge policies are exported constants in `@atlas/schema`, so the viewer and the analyzer cannot drift. The graph validator already rejects a hotspot score whose history availability is `unavailable`.

## Implemented semantics and evidence

Nested callable bodies are excluded from their enclosing callable's complexity traversal. Each callable starts at 1; its counted contributions are retained for findings. Declaration-only files have unavailable executable complexity. A parsed source with no callables has 0 max/sum; failed or unsupported syntax never becomes zero complexity. A failed parse may retain text-based physical lines, but has no dependency claims and null token/complexity metrics.

Fan-in/out deduplicate file endpoints even when multiple statements or kinds reference them. Default degree includes literal dynamic imports; default SCC cycles exclude them along with type-only/resource imports. A cycle finding includes its policy, members and a witness, and describes a static cycle rather than observed runtime behavior.

The shared `RULE_CATALOG` supplies version, severity, category and explanation to both analyzer and viewer. Implemented findings cover parse failure, missing local import, incomplete resolver context, static cycle, callable complexity >=20, source size >=500 code lines, high fan-in (>=20 and source-cohort nearest-rank p95), and analysis limits. Findings retain source ranges or observation/member evidence. The history change-concentration rule is reserved until P4.4.

Independent expectations: `analyzer-ts/test/complexity.test.ts`, `analyzer-ts/test/extract.test.ts`, `graph/test/graph.test.ts` and `analyzer-core/test/analyze.test.ts`. [ADR-019](../adr/ADR-019-phase2-static-analysis-and-viewer.md) records the Phase 2 gate and its limitations.

## Phase 3 city encodings

Structure facade colors derive from stable layout package districts, independent of snapshot occurrence IDs. Roof silhouettes identify source, test, config, declaration, asset and opaque roles without relying on color. Height uses stored code lines: `clamp(1 + 1.5 * log2(1 + codeLines / 25), 1, 14)`, rounded to thousandths; declarations are 0.6, opaque/unavailable executable height is 0.8. Footprints never change with a lens or display filter.

Complexity uses maximum callable complexity with band starts **0, 5, 10, 20, 40**. Fan-in uses the canonical unique-source default degree with band starts **0, 1, 5, 10, 25**. Neutral marked buildings mean missing metrics; zero is a measured value. These are raw metrics, not percentiles or a fabricated hotspot score. Filters and type-only overlay toggles do not recalculate metrics.

An arrow runs from importer to imported target. Solid/dashed class and legend retain value, type, dynamic and resource kinds; inspector evidence retains confidence. Roads and district gates are navigation geometry, never inferred imports. File arcs cap at 200 with explicit omitted/unplaced counts and pinning. Package aggregation counts unique file endpoint pairs under the selected edge policy. Reach queries cap depth at 5 and visits at 2,000 and describe static reachability, not observed runtime impact. The full external list remains HTML-accessible when only 50 terminals are visible.
