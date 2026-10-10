# Metric definitions: atlas.metrics/1

The normative text is plan §10; this page is the implementation index. Thresholds are versioned product defaults, not quality standards.

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
