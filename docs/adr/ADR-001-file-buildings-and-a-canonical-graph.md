# ADR-001: File buildings and a canonical graph

**Status:** Accepted (baseline from the V0.1 master plan, 10 October 2026)

**Context:** symbol-level cities inflate scale and have unstable identities.

**Decision:** one included file lineage per plot; declarations remain bounded metadata; graph schema independent of renderer.

**Alternatives rejected:** function/class buildings; renderer-specific JSON as the only model.

**Consequences:** useful structural exploration with predictable size; no symbol/call-graph promise.

**Review trigger:** a separate, validated symbol navigation feature after V0.1.
