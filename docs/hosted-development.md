# Hosted control-plane development

Phase 5 is in progress. The local four-pillar product works independently. This development API implements session admission, capabilities, job status/events and cancellation; workers have a durable PostgreSQL queue. There is no hosted analyzer coordinator or public publication yet. Artifact routes fail closed. Do not expose this preview as the finished hosted service.

## Run the database acceptance checks

Use a dedicated disposable PostgreSQL 17 database. Tests create their own random `atlas_test_*` schemas, then remove only those schemas. They never truncate tables in your default schema. The test user requires schema create/drop permission; production users should not have that permission.

```sh
docker run --detach --name atlas-phase5-postgres --publish 127.0.0.1:55432:5432 \
  --env POSTGRES_PASSWORD=atlas-local-test --env POSTGRES_DB=atlas_test postgres:17-alpine
pnpm install --frozen-lockfile
ATLAS_TEST_DATABASE_URL=postgres://postgres:atlas-local-test@127.0.0.1:55432/atlas_test \
ATLAS_REQUIRE_HOSTED_TESTS=1 pnpm exec vitest run apps/api/test/hosted.test.ts apps/worker/test/queue.test.ts
```

These credentials are exclusively for a loopback test container. In PowerShell, set variables with `$env:ATLAS_TEST_DATABASE_URL = '...'` and `$env:ATLAS_REQUIRE_HOSTED_TESTS = '1'`. Without a database, integration tests explicitly skip; the dedicated CI job requires them. To include them in the whole suite, set the same variables before `pnpm verify`.

The API library exports `migrate(pool)`, `AdmissionStore` and `startApi`. Migrate explicitly before admission. `developmentLoopback: true` permits the local HTTP cookie only; otherwise an exact HTTPS public `origin` and a secret of at least 32 bytes are required. Database connections must use bounded pools, connection timeouts and statement timeouts in deployment configuration. A reverse proxy must forward the configured Host and enforce request/read rate limits. Never log headers, bodies, full client IPs or tokens.

## API preview

1. `POST /api/v1/session`, with exact same-origin `Origin`, establishes an HttpOnly session. A valid cookie reuses the session.
2. `POST /api/v1/analyses`, with session cookie, JSON body from plan §13 and UUID `Idempotency-Key`, queues one job and returns its management token once. The URL must be a GitHub root; no arbitrary refs, destinations or raised limits are accepted.
3. `GET /api/v1/jobs/:id` and `/events` use that session or a Bearer capability. SSE accepts `Last-Event-ID`; polling is always available. No query token is accepted.
4. `POST /api/v1/jobs/:id/cancel` requires management access and exact Origin. Queued jobs become cancelled immediately; leased jobs request cancellation. The future coordinator must kill containers before acknowledging cancellation.

Default admission: one active job per session/client bucket, five jobs per hour, 20 queued jobs globally. Idempotent replays do not consume additional admission. No cache reuse occurs yet. Queue time is reported separately; the execution deadline starts at first claim, covers acquisition/analysis, and survives the one crash retry.

## Recovery and rollout

- Every running coordinator must heartbeat at most 10 seconds apart; leases expire in 30 seconds. On failed heartbeat it must stop its containers and scratch work. It cannot assume ownership from local process state.
- Call `reap` regularly. It fences expired generations, requeues one safe retry, and terminalizes cancellations/deadlines. Fresh scratch is required on each attempt; never reuse an interrupted parser/container.
- Use `withLease` for the later publication transaction. Cancellation and publication serialize on the same row; the loser must observe terminal/cancelled state, and storage prefixes are collected separately.
- Run `sweepAdmissions` at least hourly. It deletes expired sessions/admissions and clears client buckets older than 24 hours. It does not delete immutable job outcomes or resurrect publications.
- Failed migration checksum: stop rollout, compare the applied migration, and issue a new additive migration. Never silently rewrite an applied migration. Restore must preserve cancellation and eventual expiry/revocation.
- Database outage: admission/readiness fails, liveness remains independent. Do not retry a submission with a new idempotency key automatically; reconnect with the same key/session.
- Close the API on shutdown; event streams close and idle connections drain. Deployment secret rotation, TLS, PostgreSQL roles, backups, upstream budgets and publication runbooks are remaining P5.6 work.

## Next dependencies

P5.3: prove network-free analysis, broker-only DNS-pinned GitHub acquisition, external byte/memory/PID/CPU/disk/deadline enforcement, HEAD checkpoint recovery and process-group/container cleanup. P5.4: private validated storage, lease-fenced atomic publication, expiry/revocation/visibility access checks, purge and cache ownership. P5.5: wire the real hosted result to the existing validating viewer, then browser success/partial/failure/cancel/reconnect journeys. P5.6: complete deployment definitions and operator rehearsals. G5 stays open until all mandatory security gates pass.

## Offline container spike

`apps/worker/src/sandbox.ts` encodes the external offline policy and kills the actual container on deadline/cancel. Seven checks exercise real cgroup limits, read-only/non-root runtime, blocked public/private/metadata egress, scratch ENOSPC, OOM, PID exhaustion and child-process cleanup. [ADR-030](adr/ADR-030-offline-container-isolation-spike.md) states what this proves and what is still unimplemented.

```sh
docker pull node@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d
ATLAS_CONTAINER_TESTS=1 ATLAS_TEST_SANDBOX_IMAGE=<docker-image-inspect-immutable-id> \
  pnpm exec vitest run apps/worker/test/sandbox.test.ts
```

Set `ATLAS_DOCKER_EXECUTABLE` to the trusted Docker binary path if it is absent from PATH. This command runs trusted probes only; it does not acquire/execute a submitted repository. The image is pinned and pulled by the operator/CI before the test, not by analysis (`--pull=never`). Containers are removed after every test. The local PostgreSQL container can be stopped and removed by its exact documented name after checks; it contains test data only.
