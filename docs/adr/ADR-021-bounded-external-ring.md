# ADR-021: Keep external terminals within a bounded perimeter

Date: 2026-10-10. Status: accepted.

The spike's layout v1 placed successive terminals every three cells, even after exhausting a side. A small repository with many externals could have terminals hundreds of cells beyond the island, making them unreachable with bounded camera controls. This is a production defect, not a reason to disable bounds or invent new frontend coordinates.

New analyses emit `atlas.layout/1.1.0`. Canonical terminal names remain sorted and distributed north/east/south/west; each side's slots are evenly spaced at integer-rounded interior positions along the corresponding root side. The road/ring offset is unchanged. File plots, district packing constants and graph identities/metrics are unchanged. The layout ID includes the new algorithm version. Exact independent terminal-coordinate tests cover sparse and dense rings. The browser draws at most 50 terminals and can promote the terminal of a pinned omitted edge into that same budget.

Readers accept both 1.0.0 and 1.1.0 layouts. The handcrafted legacy fixture and its canonical hashes remain unchanged; the new analyzer's layout golden intentionally changes, independently of graph/history hashes. Generated JSON Schema and OpenAPI declare the new current version and the accepted version alternatives. Previously imported layouts keep their stored coordinates.

When more than 50 anchors exist, the visible subset samples evenly across the complete sorted perimeter list, rather than taking its first 50 names and crowding one section. Omitted names remain in the HTML list and their real edges can promote a terminal without increasing the cap. This changes only the bounded display subset, not stored coordinates.
