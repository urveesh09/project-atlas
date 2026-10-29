# Contextual finding review: synthetic capacity

Recorded 2026-10-29T14:08:58.310Z; v24.22.0 on Windows_NT 10.0.26200 x64. Base `e518ecf4f0cdf57562a3aed1db305eb592c79a5b`; dirty: true.

20 fresh Node processes; timing starts after module load and includes authored report preparation, context indexing, matching and canonical round-trip validation. Synthetic source metadata, no Git ingestion or real Ruff/signatures in this benchmark.

All 20 samples retain exactly 4,096 findings per side and 4,096 continuing tracking IDs. Canonical output is 6094886 bytes, below the 8 MiB cap.

p50 875.5 ms; p95 899.6 ms; worst 920.8 ms. These are development observations, not a product latency budget.

Reproduce after building: `node scripts/bench-finding-review.mjs`. [Raw observations](finding-review-capacity.json).

- Functional comparison capacity only; no reference-machine, GPU or browser latency claim.
- Dirty development observations are not clean-tree release acceptance.
- Producer and cryptographic evidence have separate tests. No clean/resolved verdict.
