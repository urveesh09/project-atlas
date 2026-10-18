# Hosted service development

The hosted service is implemented across these components:

| Component | Implementation | Decision record |
|---|---|---|
| Admission and leases | — | [ADR-029](adr/ADR-029-hosted-admission-and-lease-foundation.md) |
| Sandboxed acquisition and analysis, egress broker, HEAD checkpoint | — | [ADR-031](adr/ADR-031-hosted-acquisition-and-analysis-pipeline.md) |
| Private storage and publication lifecycle | — | [ADR-032](adr/ADR-032-publication-storage-and-lifecycle.md) |
| Hosted browser flow and deployment | — | [ADR-033](adr/ADR-033-hosted-flow-deployment-and-operations.md) |
| Shared control plane: migrations, storage, GitHub budget, publications, roles | `@atlas/control` | — |
| HTTP surface | `@atlas/api` | — |
| Coordinator, sandboxes and sweepers | `@atlas/worker` | — |

Operators should read [hosted-operations.md](hosted-operations.md).

## Run it locally

You need:

- Node and pnpm, as for the CLI;
- a disposable PostgreSQL 17;
- for container isolation, a Linux Docker engine. Docker Desktop works on Windows and macOS.

```sh
docker run --detach --name atlas-phase5-postgres --publish 127.0.0.1:55432:5432 \
  --env POSTGRES_PASSWORD=atlas-local-test --env POSTGRES_DB=atlas_test postgres:17-alpine
pnpm install --frozen-lockfile && pnpm build && pnpm build:web

# Development processes (no container isolation; every job is labelled PROCESS_ISOLATION_ONLY):
ATLAS_DATABASE_URL=postgres://postgres:atlas-local-test@127.0.0.1:55432/atlas_test node scripts/hosted-dev.mjs

# Real sandboxes:
docker build -f deploy/sandbox.Dockerfile -t atlas-sandbox:dev .
ATLAS_DATABASE_URL=... node scripts/hosted-dev.mjs --docker "$(docker image inspect atlas-sandbox:dev --format '{{.Id}}')"
# Add --github to analyze real public repositories through the egress broker (requires --docker).
```

Open `http://127.0.0.1:8080/` and submit `https://github.com/atlas-demo/harbor`. That URL is the authored Harbor demo, served locally as a fixture repository. Operator metrics are at `http://127.0.0.1:8081/metrics`. Credentials in these commands are for loopback test containers only.

### Compose stack

`deploy/compose.yaml` runs four services: PostgreSQL, the S3 gateway, the migration job (which provisions the API and worker roles), and the API image. The worker stays on the host, next to its Docker engine.

```sh
docker build -f deploy/api.Dockerfile -t atlas-api:dev . && docker build -f deploy/sandbox.Dockerfile -t atlas-sandbox:dev .
node deploy/dev-secrets.mjs                               # random secrets in deploy/secrets/ and deploy/.env (gitignored)
echo "ATLAS_HTTP_PORT=18090" >> deploy/.env                # optional; the default is 8080
docker compose -f deploy/compose.yaml --env-file deploy/.env up -d
set -a; . deploy/secrets/worker.env; set +a                # worker role, storage, development flag
ATLAS_SANDBOX_IMAGE="$(docker image inspect atlas-sandbox:dev --format '{{.Id}}')" ATLAS_WORK_ROOT=$PWD/.atlas-tmp/work   node apps/worker/dist/bin.js
docker compose -f deploy/compose.yaml --env-file deploy/.env down --volumes   # tear down
```

The stack analyzes real public repositories through the broker, so it needs GitHub API quota. Anonymous quota is 60 requests per hour per address; set `ATLAS_GITHUB_TOKEN` (a token with public metadata read access only) for both the API and the worker when you need more.

## Test gates

Without services, unit and policy tests run in `pnpm verify` and every integration suite skips explicitly. Each environment variable enables real integrations:

| Variable | Enables |
|---|---|
| `ATLAS_TEST_DATABASE_URL` | PostgreSQL suites: admission, queue, pipeline, publication lifecycle, HTTP journey under least-privilege roles, roles, upstream budget. Each uses a random `atlas_test_*` schema and drops only that schema |
| `ATLAS_REQUIRE_HOSTED_TESTS=1` | Missing database becomes a failure |
| `ATLAS_TEST_S3_ENDPOINT=http://127.0.0.1:7070` | Pipeline and storage tests run on a real S3 gateway (credentials `atlas` / `atlas-test-secret`) |
| `ATLAS_CONTAINER_TESTS=1` with `ATLAS_TEST_RUNTIME_IMAGE=<sandbox image id>` | Container gates: journey, sentinels, lazy fetch, network isolation. Also needs `ATLAS_TEST_SANDBOX_IMAGE`, the pinned offline-probe image from [ADR-030](adr/ADR-030-offline-container-isolation-spike.md) |
| `ATLAS_NETWORK_TESTS=1` | Live GitHub acquisition through the containerized broker, plus the pinned metadata client |
| `ATLAS_REQUIRE_BROWSER_TESTS=1` | The hosted Chromium journeys must run (they need a built viewer) |

Start the S3 gateway:

```sh
docker run --detach --name atlas-phase5-s3 --publish 127.0.0.1:7070:7070 --tmpfs /data \
  --env ROOT_ACCESS_KEY=atlas --env ROOT_SECRET_KEY=atlas-test-secret \
  versity/versitygw@sha256:605de57c0cdc297fc5bc905ece592965d542d8df70d6eedf755734c80f2eb797 --quiet posix /data
```

Run every hosted gate:

```sh
ATLAS_TEST_DATABASE_URL=postgres://postgres:atlas-local-test@127.0.0.1:55432/atlas_test \
ATLAS_TEST_S3_ENDPOINT=http://127.0.0.1:7070 ATLAS_REQUIRE_HOSTED_TESTS=1 ATLAS_REQUIRE_BROWSER_TESTS=1 \
ATLAS_CONTAINER_TESTS=1 ATLAS_TEST_RUNTIME_IMAGE="$(docker image inspect atlas-sandbox:dev --format '{{.Id}}')" \
ATLAS_TEST_SANDBOX_IMAGE="$(docker image inspect node@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d --format '{{.Id}}')" \
pnpm exec vitest run apps/api/test apps/worker/test packages/control/test packages/ingest/test
```

In PowerShell, set each variable with `$env:NAME = '...'`. The dedicated `hosted` CI job runs these gates on Linux.

The gates include the separately authored Harbor Python repository (ADR-064):
two history frames, a pure rename, `.pyi`, internal/builtin/PyPI dependencies and
exact source-derived expectations. Both the container test and the hosted browser
journey load the complete verified published artifact. With container gates enabled,
the Python browser journey also uses the deployed sandbox image. The database-only
development path remains explicitly process-isolated. No Python environment is
installed and fixture code is never executed.

## Operator rehearsal

For the production TLS/profile/firewall rehearsal, use the separate
[reference kit instructions](../deploy/production/README.md#drain-recovery-and-validation).
It runs the actual production API without development mode and never changes the
host firewall. The authored-fixture recovery/backup rehearsal below remains separate.

```sh
node scripts/hosted-rehearsal.mjs --admin-url postgres://postgres:atlas-local-test@127.0.0.1:55432/postgres \
  --postgres-container atlas-phase5-postgres --docker <sandbox image id> --s3 http://127.0.0.1:7070
```

The rehearsal creates a fresh database, runs the real migration job (with roles), starts the API and worker processes, and writes [phase5-rehearsal.md](benchmarks/phase5-rehearsal.md). Its steps are listed in the script's header comment. It drops what it creates.
