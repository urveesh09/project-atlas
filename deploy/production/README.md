# Reference hosted deployment (M4.1)

This kit is for a **dedicated Linux worker host** and a separate API host. It does
not create a public service. R6-06 deployment acceptance and G6 remain open.
Optional monitoring is [below](#monitoring) (M4.2). Private backup automation and the
scratch-only restore drill are documented in [Production backups](../../docs/production-backups.md)
(M4.3). [Image supply chain](../../docs/image-supply-chain.md) covers M4.4's scan and
signed-origin release gates. SLOs and legal pages remain M4.5–M4.6.
Read [operations](../../docs/hosted-operations.md) and [ADR-072](../../docs/adr/ADR-072-reference-hosted-deployment.md).

## Prerequisites and boundaries

- A supported Linux host with systemd 257 or later and nftables 1.1.3 or later;
  Docker Engine with the normal rootful bridge networking/firewall enabled, Compose v2.
  Rootless Docker is not a drop-in replacement: its networking bypasses this bridge policy.
- Node 24.22.0, pnpm 10.34.6, reviewed source and lockfile. Prepare releases in a
  trusted build environment, never on an analyzed repository.
- Operator-provisioned PostgreSQL and a private HTTPS S3-compatible bucket, reachable
  by both hosts. API and worker use different database and storage credentials.
- A public hostname, valid TLS certificate/full chain and private key, an ingress
  firewall exposing only HTTPS on the API host, and restricted administration access.
- DNS on the worker resolves through **one fixed resolver IPv4 address**. Database
  and storage endpoints have stable operator-controlled IPv4 addresses. Use verified
  TLS names in their URLs; never substitute IPs to bypass certificate verification.
  The reference broker bridge is IPv4-only; host GitHub metadata calls may also use IPv6.
- Docker control grants root-equivalent host authority. The coordinator has it;
  the API and sandboxes do not. No unrelated workloads or coordinators may share the
  worker engine. Its uid 10001 must be reserved for ATLAS.

All addresses in the example site files are documentation addresses. Replace them
in **operator-owned copies outside this checkout**. No production secret, real domain
or completed configuration belongs in Git or a build context.

## Build immutable runtime images and worker package

From the reviewed commit with a clean tree:

```sh
pnpm install --frozen-lockfile
pnpm build && pnpm build:web
docker build -f deploy/api.Dockerfile -t atlas-api:candidate .
docker build -f deploy/sandbox.Dockerfile -t atlas-sandbox:candidate .
docker build -f deploy/production/proxy.Dockerfile -t atlas-proxy:candidate .
docker image inspect atlas-api:candidate atlas-sandbox:candidate atlas-proxy:candidate --format '{{.Id}}'
pnpm --filter @atlas/worker deploy --prod --legacy --config.strict-peer-dependencies=false .atlas-tmp/worker-runtime
```

Record image IDs, Git/lockfile identities and OS/runtime audit. Transfer the worker
package and preloaded sandbox image to the worker; do not allow the running worker
host to fetch arbitrary registries. Install the package, root-owned and unwritable by
uid 10001, under `/opt/atlas/releases/<identity>`. `/opt/atlas/current` points there;
its entrypoint is `dist/bin.js`, with production `node_modules/`. Install the pinned
Node distribution under `/opt/atlas/node` and the root-owned operator `.mjs` files
from this directory under `/opt/atlas/production`.

The proxy image removes upstream Caddy's `cap_net_bind_service` file capability.
It listens on 8443 inside the container with **all capabilities dropped**; Docker
publishes external 443. The unmodified upstream binary cannot execute under that
empty bounding set. Both image bases and the validation package versions are pinned.

## API host

1. Copy `api.env.example` outside the repository and fill in immutable API/proxy image
   IDs, domain, exact HTTPS origin, S3 settings and absolute `ATLAS_SECRET_DIR`.
   The proxy address must be inside `ATLAS_API_SUBNET` and **outside**
   `ATLAS_API_DYNAMIC_POOL`; choose non-overlapping local ranges for the site.
2. Provision these files in the secret directory:

   | File | Contents |
   |---|---|
   | `tls_certificate`, `tls_key` | Public hostname's PEM certificate/full chain and private key |
   | `migration_url` | Schema-owner PostgreSQL URL, including verified TLS settings |
   | `api_role_password`, `worker_role_password` | Different random login passwords, used only by migration |
   | `api_database_url` | `atlas_api` PostgreSQL URL, `sslmode=verify-full`, appropriate CA configuration |
   | `quota_secret` | At least 32 random bytes (for example a 64-character random hex string) |
   | `api_storage_access_key`, `api_storage_secret` | API's bucket credentials |

   Directories are root-owned, mode 0750 or tighter; secret files are `root:10001`,
   mode 0440. Provision copies through your secret manager. Compose file-backed
   secrets do not remap host uid/gid; check readability as uid 10001. Only explicitly
   named files enter each container. Never pass secrets as command-line arguments.
3. Preflight and start, substituting the absolute path to your environment file:

   ```sh
   node deploy/production/check-profile.mjs --env-file /etc/atlas/api.env
   docker compose -f deploy/production/compose.yaml --env-file /etc/atlas/api.env --profile api-host up -d --wait
   ```

   The preflight validates the resolved Compose model, including immutable images,
   dropped capabilities, file secrets, hostname/trust alignment and the allocation
   collision found during rehearsal. The migration job completes before API startup;
   the proxy starts after API health passes. Neither API port 8080 nor operator port
   9090 is published. Operator metrics stay on the API container's loopback interface.
   Private CA mounts, PostgreSQL CA files and an optional public-metadata GitHub token
   are site-specific **read-only secret-file overrides**, never relaxed TLS checks.
4. Check the real domain/certificate, health, canary, session and deletion paths in
   [operations](../../docs/hosted-operations.md). API/worker runtime roles must not
   have DDL or the other's grants. Grant each storage credential only the operations
   its role needs on the private bucket. Do not configure public bucket access.

Only GET, POST and DELETE are accepted. The request ceiling is exactly 16,384 bytes;
header/body reads time out in 10 seconds. SSE is unbuffered and may last 300 seconds;
it intentionally has no 10-second response deadline. Host is preserved. Incoming
untrusted XFF is discarded before Caddy adds the real client address; the API trusts
only the proxy's fixed address and the final hop. Unknown HTTP hosts return 421.
API responses are not cached. HSTS is one year, without premature subdomain/preload
commitments. Caddy access **and error** logs are discarded because proxy errors can
contain URLs/addresses; use the API's safe codes, health and operator metrics.

Certificate renewal is external. Atomically replace the files, then **recreate** the
proxy with `up -d --no-deps --force-recreate proxy` and the same Compose options.
A bind-mounted file can retain the old inode after replacement; a restart/reload is
insufficient. Verify the new certificate. Existing streams reconnect or poll.
Recreate affected API/migration containers after secret rotation for the same reason.

## Monitoring

The operator listener binds only the API container's `127.0.0.1:9090`. The optional
`prometheus` service (pinned Prometheus 3.15.0) runs in the API's network namespace
(`network_mode: service:api`) to scrape it, and evaluates [`alerts.yml`](alerts.yml).
It publishes nothing, joins no network of its own, runs as `nobody` with a read-only
root and no capabilities, and keeps 15 days of samples in the `prometheus-data` volume.
Its UI listens on that namespace's loopback, port 9091.

1. Copy `prometheus.yml` into the operator-owned configuration. Add your Alertmanager
   under `alerting`, and `remote_write` if dashboards or history live elsewhere. Without
   them, alerts are evaluated but delivered nowhere.
2. Start it with the API host, adding the profile to the same command:

   ```sh
   docker compose -f deploy/production/compose.yaml --env-file /etc/atlas/api.env --profile api-host --profile monitoring up -d --wait
   ```

   The preflight checks this service too: immutable image, shared API namespace, nothing
   published, non-root, read-only configuration.
3. Recreating the API container also needs Prometheus recreated, because it joined the
   old container's namespace. `up` with both profiles does this.
4. Import [`grafana-dashboard.json`](grafana-dashboard.json) into Grafana if you use it.
   It asks for the Prometheus data source that receives these metrics.

The metrics, the five alerts and their runbooks are in
[operations → Metrics](../../docs/hosted-operations.md#metrics). Check changed rules with
`promtool check rules alerts.yml` and `promtool test rules alerts.test.yml` in the
same pinned image.

## Worker host and firewall

1. Reserve uid/gid 10001, create `/var/lib/atlas/jobs` owned by it (0700), and install
   the root-owned release/Node/operator tooling above. Give the worker user access
   to this dedicated Docker engine's Unix socket through the `docker` group.
2. Copy `docker-daemon.example.json` into the operator's daemon configuration, merging
   reviewed site options. The default `docker0` bridge is **broker-only**, subnet
   `172.28.0.0/24`. Dynamic per-job internal bridges use the `172.29.0.0/16` pool in
   /28 slices. Both the daemon DNS and the host resolver must use the same fixed
   address. Change the ranges consistently in the firewall if the site requires it.
   Do not disable Docker's firewall or use host/macvlan/overlay networking.
3. Edit a copy of `worker-egress.nft` under `/etc/atlas/`, substituting the fixed
   DNS/database/storage IPv4 addresses. Validate it with `nft -c -f` before an
   operator installs it on this dedicated host. **Never apply it on a shared host.**
   It owns only `inet atlas_egress`, atomically replaces that table, and leaves
   Docker-owned tables alone. Keep out-of-band console access for initial rollout.
4. Create `/etc/atlas/worker.env` from the example: HTTPS S3 origin/bucket/region,
   immutable local sandbox image ID, worker slots. No development switches or secrets.
   Provision root-only secret files `worker_database_url` (`atlas_worker`, verified
   TLS), `worker_storage_access_key`, `worker_storage_secret` under
   `/etc/atlas/secrets`. systemd `LoadCredential` supplies private snapshots on startup.
5. Install the four `.service`/`.timer` files in `/etc/systemd/system`, and
   `docker.service.d/atlas-egress.conf` under that directory's `docker.service.d/`,
   all root-owned, mode 0644. Reload units. Enable/start `atlas-egress.service`, its
   refresh timer, then `atlas-worker.service`. The base filter precedes networking
   and Docker; the worker additionally requires a successful online refresh. Check
   unit status and safe worker logs before submitting a canary. Confirm this ordering
   on a real host boot as part of R6-06; static validation cannot demonstrate it.

The filter denies new host output except loopback, fixed DNS, GitHub TCP 443 for
root/coordinator, and the coordinator's fixed PostgreSQL:5432/S3:443 endpoints.
Forwarding permits only brokers to the fixed resolver and current GitHub git/API
ranges on 443, plus private acquisition-to-broker TCP 3128 subject to Docker's
per-network isolation. It blocks container-to-host relay paths. Analysis stays
`--network=none`; acquisition has only its own internal network.

`refresh-github-ranges.mjs` fetches only `https://api.github.com/meta`, without tokens
or redirects, within 10 seconds/1 MiB. It validates routable canonical CIDRs, removes
overlaps, and checks/applies both sets as **one transaction**. Failed refreshes retain
the last sets, which expire after 24 hours. Existing admitted connections can finish;
brokers still have the job's hard deadline. Bootstrap API ranges, recorded 2026-10-18,
expire in 15 minutes; they permit the first refresh. If GitHub moves outside them,
the initial refresh fails and the worker cannot start. Refresh the reviewed bootstrap
from current official metadata; never use an allow-all fallback. Alert on refresh
failure; the hourly timer must not silently fail for a day.

This policy also blocks registry pulls, OS package updates and arbitrary time servers.
Preload artifacts, use a maintained host/hypervisor clock, and plan operator-controlled
maintenance after draining the service. It is an egress policy, not a complete SSH or
host-ingress firewall. Kernel, Docker, resolver, TLS/CA and site ACL acceptance are R6-06.

## Drain, recovery and validation

`systemctl stop atlas-worker` stops claims and drains existing attempts. Jobs have a
300-second deadline, but maintenance batches have per-operation timeouts and no
single batch-wide deadline. The unit uses `TimeoutStopSec=infinity` so systemd does
not kill a valid drain based on an invented upper bound. Observe leases/queue progress
during upgrades. If an actual stuck process needs forced termination, use the existing
[worker crash/reaper runbook](../../docs/hosted-operations.md#worker-crash), record the
incident and verify cleanup/retry before reopening admission. Engine ownership prevents
two coordinators from reconciling one engine concurrently. Do not run rolling replicas
on the same engine or move job scratch into `PrivateTmp`.

For local/CI validation (Docker required), build `validation.Dockerfile`, then run:

```sh
docker build -f deploy/production/validation.Dockerfile -t atlas-validation:candidate .
node scripts/hosted-rehearsal.mjs --production-profile \
  --api-image <immutable-api-id> --proxy-image <immutable-proxy-id> \
  --validation-image <immutable-validation-id> --out .atlas-tmp/production-report.json
```

This validates the actual Caddy/nft/systemd files in pinned containers, then exercises
the production Compose API under trusted loopback TLS with **no** development flag.
It proves TLS trust rejection, HSTS, secure sessions, size boundaries, Host/Origin,
unbuffered queued events, cancellation, XFF quota resistance and the runtime role's
DDL denial. Its disposable PostgreSQL/S3 backend fixtures are not a production database
TLS or cloud IAM acceptance test. No repository is acquired in this transport test.
The separate existing hosted gates prove real acquisition/analysis, Python history,
offline sandboxes, egress broker isolation, publication and browser journeys.

The packet probe uses two private Docker networks and a router container. Only the
router's own namespace receives nft rules, with fixture destinations/interfaces.
Positive controls, allowed broker traffic, denied ports/nonbroker traffic/host relay,
coordinator roles, atomic failed updates, stale-set expiry and deny counters are checked.
Neither this probe nor CI ever alters the host firewall. systemd verification validates
syntax/dependencies with an inert Docker stand-in; a real boot/drain is operator acceptance.
Reports record source/dirty state, configuration hashes and image IDs; generated secrets
stay in ignored scratch. Only the report is uploaded by CI. All owned containers and
networks must be removed; unrelated Docker resources are never removed.
