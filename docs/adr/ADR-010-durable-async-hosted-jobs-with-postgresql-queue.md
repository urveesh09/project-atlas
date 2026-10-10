# ADR-010: Durable async hosted jobs with PostgreSQL queue

**Status:** Accepted (baseline from the V0.1 master plan, 10 October 2026)

**Context:** analysis exceeds request lifetimes and needs cancellation/recovery/resource isolation.

**Decision:** small REST/SSE API, leased DB queue, separate worker/sandbox, private object storage.

**Alternatives rejected:** parse in API/serverless request; premature Redis/Kafka/distributed graph store.

**Consequences:** fewer moving parts but explicit lease/reaper implementation.

**Review trigger:** measured queue contention or scale exceeds Postgres design; migrate with preserved job semantics.
