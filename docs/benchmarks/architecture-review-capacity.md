# Architecture review: bounded development observations

Recorded 2026-10-29T17:36:27.467Z, Node v24.22.1, Intel(R) Core(TM) i5-10400 CPU @ 2.90GHz. Source 16f20dfd61491bc82818ec3d8ec914fb7d6c5c71; dirty tree: true.

20 fresh processes; prepare 10,000-file/100,000-edge baseline and current graphs before timing; 16 matching rules, 1,600,000 continuing matches; time includes normalization/evaluation/retention/schema/canonical serialization. No Git/parser/browser/resource-container or reference-hardware acceptance claim.

- p50: 3569.3 ms; p95: 3674.0 ms; worst: 3733.1 ms.
- Serialized JSON: 1975044 bytes; 2,000 rows retained and 1,598,000 omitted explicitly. All 16 rules count every 100,000 matches.
- Largest end-of-sample process RSS: 570695680 bytes. This is a sampled RSS, not whole-job peak/container evidence.

No existing analyzer/render budget is redefined. This does not close G6/R6 or establish a new production SLA.
