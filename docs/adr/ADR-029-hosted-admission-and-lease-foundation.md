# ADR-029: PostgreSQL control-plane foundation for Phase 5

Date: 2026-10-10. Status: accepted for development; G5 remains open.

## Scope and boundaries

Implement the admission/management part of P5.1 and database/lease part of P5.2 first. The API never executes repositories or runs analysis. Public artifact routes deliberately return 503 until P5.3 isolation and P5.4 publication gates exist. `startApi` binds loopback only; production requires an explicit HTTPS origin behind a same-origin reverse proxy. This is a development control plane, not a deployed public service.

## Decisions

- Additive migration 001 runs under a transaction advisory lock and stores a SHA-256 checksum. Reapplication is idempotent; unexpected schema/migration drift fails closed. Sessions, repositories, jobs, admissions, events, artifact objects and publications have separate durable records.
- Admission uses a short PostgreSQL transaction advisory lock to serialize service queue capacity, hourly client limits, active-job limits and idempotency. This favors correctness at V0.1 volume; revisit only after measuring contention. Worker claims use row locks with `SKIP LOCKED` and never acquire the admission lock. The database transaction ends before any analysis.
- A random 256-bit management token is returned once and stored as a domain-separated one-way hash. Constant-size digest comparisons use `timingSafeEqual`. HttpOnly SameSite=Strict sessions use a separate token domain; production cookies are Secure and use the `__Host-` prefix. No management/session token enters URLs or progress rows.
- Mutation requests require the configured Origin and Host. Queries, encoded paths, foreign origins and cross-site Fetch Metadata are rejected. Bodies are strictly UTF-8 JSON, at most 16 KiB, and cannot use content compression. Raw IPs are never stored; HMAC daily client buckets expire from admission records within 24 hours. Do not trust forwarded IP headers without a separately designed trusted-proxy boundary.
- UUID idempotency keys are session-scoped for 24 hours. Equivalent GitHub repository roots are normalized before hashing. Replays return the original job without another token; mismatched inputs return 409. Queue/client capacity is checked atomically. Sessions themselves have per-client and service capacity bounds.
- Claims increment an attempt and fencing generation, with 30-second leases; owners heartbeat every 10 seconds. Lease checks use PostgreSQL time, current owner/generation, live lease, allowed state and the original 300-second execution deadline. A transaction checks time again before commit, so slow fenced work cannot outlive its authority. Heartbeats do not mutate user-visible progress revision.
- Cancellation wins by changing the locked job state. Fenced transactions cannot advance/publish after cancellation or expiry. A crashed attempt retries at most once inside its original deadline. The reaper fences before requeueing; cancelled work never retries. Actual container process termination belongs to the P5.3 coordinator.
- Progress revisions are monotonic and durable; each job retains at most 100 events. Old reconnections receive authoritative current state. SSE reauthorizes the session while polling, closes on terminal state, has a five-minute lifetime and a service stream cap, and disconnects slow clients rather than buffering unlimited output. Polling remains available. Publication state is separate from job state.

## Evidence and consequences

Thirty-one admission/queue checks pass against actual PostgreSQL 17 in isolated random schemas, including concurrent admission/claims/reapers, idempotency conflicts, quota races, stale lease callbacks, cancel-before-commit, transaction rollback, retry/deadline boundaries, SSE replay/stream caps, cookie/token isolation and simulated expiry. The session bootstrap is in the generated OpenAPI contract and validates its response through the shared runtime schema. Idempotency headers also use one runtime/generated UUID schema: an older v1–v5-only regex was narrower than the documented contract. UUIDv7 and case-equivalent replay are independently tested; clients cannot derive or alter the database admission time through a UUID timestamp. Worker tests may depend on the API's migration/admission **only in tests**; runtime dependency direction remains unchanged. `pg` and `@types/pg` are pinned to 8.23.1.

This phase does not implement cache reuse, GitHub visibility resolution, sandbox orchestration, object storage, public viewer loading or a production deployment. The baseline schema reserves those contracts but does not claim they work. Tokens remain usable as management capabilities after a browser session expires; session admission records and client buckets do not persist indefinitely.

References: [PostgreSQL locking](https://www.postgresql.org/docs/17/explicit-locking.html), [Node cryptography](https://nodejs.org/api/crypto.html). Advisory locks coordinate application invariants; row locks and generations fence worker writes. Docker resource/network enforcement must be independently exercised before G5.
