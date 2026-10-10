# ADR-006: Bounded first-parent history and sampled frames

**Status:** Accepted (baseline from the V0.1 master plan, 10 October 2026)

**Context:** full Git DAG analysis is expensive and the UI cannot explain every branch at once.

**Decision:** 90-day contiguous first-parent window, 200 commits, at most 12 graph frames; one additional parent for boundary diff when available.

**Alternatives rejected:** every commit graph snapshot; author/branch league tables; full-lifetime churn.

**Consequences:** understandable mainline evolution; merge effects and sampling disclosed.

**Review trigger:** users need branch-specific architecture comparison; design it as new scope.
