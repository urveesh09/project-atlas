# ADR-007: Occurrence identity separate from bounded lineage

**Status:** Accepted (baseline from the V0.1 master plan, 10 October 2026)

**Context:** paths alone lose renames; content hashes conflate copies and identical files.

**Decision:** snapshot occurrence IDs plus conservative history lineage; delete/recreate is new; copies do not preserve identity.

**Alternatives rejected:** permanent path IDs, blob hashes as file identity, heuristic global name matching.

**Consequences:** honest continuity; cross-window IDs may change.

**Review trigger:** cross-artifact comparisons require an explicit mapping protocol.
