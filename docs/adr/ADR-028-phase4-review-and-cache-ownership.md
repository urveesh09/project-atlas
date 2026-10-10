# ADR-028: Phase 4 verification, capacity omissions and frame ownership

Date: 2026-10-10. Status: accepted. Amends ADR-025 and ADR-027.

## Review findings and decisions

The independent full verification initially passed 524 tests. Additional review found cases the existing fixtures did not exercise:

1. A retained worker survives its query client. Reusing request IDs after client disposal could deliver an old response to a new client. Request IDs now increase per worker, with a WeakMap rather than per-client numbering. The regression deliberately delivers the old response after replacement.
2. Selecting another snapshot while comparing could leave the comparison legend naming B while the city displayed C. Explicit snapshot navigation now updates B, or closes a degenerate A=A comparison. Compare preparation uses a request ticket and loads both sides before applying the pair; late requests cannot reopen a closed comparison. Idle prefetch pauses during comparison.
3. The artifact reader held a hidden historical cache in addition to the viewer's LRU. Decode-chain reuse is now request-scoped. The caller alone owns retained historical graphs. The history benchmark measures retained and pre-collection allocations across the main realm **and** its owned worker; main-only `performance.memory` did not prove the joint memory budget.
4. An older snapshot exceeding an inventory/graph cap was published as a partial graph. Plan §7.2 requires an unavailable frame instead. Such frames now remain in requested-frame coverage with `FRAME_RESOURCE_LIMIT` and are omitted from rendering. The selected commit remains a useful complete or explicitly partial checkpoint. An authored two-commit fixture independently tests this boundary and exact export round trip.
5. The loader now enforces ADR-026's maximum three delta links, rather than merely rejecting cycles/older bases.
6. Co-change with uncertain rename/path continuity now retains its useful pairs under a partial availability label. A missing diff is not the only cause of partial pairing certainty. An authored three-change fixture pins the distinction.
7. A real-Git blob-cache regression proves repeated objects count once toward the shared history byte budget, a third unique object cannot exceed that budget, and the selected-graph cache remains usable afterward.

## Identity and evidence

Analyzer version is `0.1.0-dev.5`. Changing availability/frame derivations must invalidate analysis identities and cache keys (plan §20.1 rule 9). Harbor's version-dependent hash golden was updated after its authored structural, churn, lineage, compare and round-trip expectations passed. Old immutable artifacts remain readable with their recorded versions.

The first saved history analysis report measured the preceding transport and failed the 5 MiB target; it is not evidence for the final compact format. The complete benchmark is rerun against dev.5 and retains its actual output. Cached, prefetched and first-visit latency are reported separately. Human screen-reader and exact reference-device audits remain release requirements.

This records local verification, not public hosted launch approval. Phase 5 still needs isolated acquisition/analysis, visibility-gated publication and expiry/purge before any public artifacts can be served.
