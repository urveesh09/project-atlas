# ADR-072: Reference hosted deployment and enforceable worker egress

Date: 2026-10-18. Status: proposed for M4.1; exact-head CI and owner merge required.
Extends ADR-031/033/034 and production plan M4.1. Analyzer/artifact versions unchanged.

## Evidence and cause

The development Compose profile explicitly enables development HTTP and does not
implement the public TLS proxy, worker service manager or worker-host firewall.
The production plan requires a separate reproducible kit, not a public deployment.

Two production configuration defects were found by executing the first rehearsals:

- Upstream Caddy 2.11.7 carries a `cap_net_bind_service` file capability. Executing it
  with `cap_drop: [ALL]` returned `operation not permitted`, even when binding 8443.
  The derived pinned image strips the unnecessary file capability. Capability drops
  and `no-new-privileges` remain intact; no capability was added to make it pass.
- The proxy's static trusted IP `.2` could first be allocated dynamically to a
  dependency/migration container, causing `Address already in use`. The dynamic IPAM
  pool now excludes the proxy address. The preflight and regression reject that
  exact allocation mistake.

The packet harness also exposed its own unhandled socket reset: closing a successful
test connection could terminate the peer server. The trusted fixture handles socket
errors and retains positive controls before installing any policy. An early HTTPS
probe used an IP without explicit DNS SNI; the rehearsal now uses verified localhost
SNI/Host and a matching CA-signed leaf. Its original report retained only `Error`, so
the exact earlier TLS alert is not claimed. Failed reports are retained in ignored
scratch (`m41-production-first/second/third.json` and their logs), not counted as passes.

Final review replaced a DB-only healthcheck with the real readiness route, covering
storage and exact migrations. Its first draft used Node fetch to set Host; a minimal
server in the exact API image showed the header rewritten to the loopback authority,
so that command could not pass the API's origin guard. Use `node:http` with the exact
configured Host, retain the four-second probe deadline and verify healthy → unavailable
storage → recovered with the actual container health command. The failed
`m41-production-readiness.json` remains alongside the earlier reports.

CodeQL's first review of the pull request (alert #70, `js/file-access-to-http`) flagged
the rehearsal's HTTPS client: the request options held the throwaway CA read from
scratch. The CA only verifies the loopback server, and none of its bytes are sent. The
alert left an unresolved review thread, which blocks merging, so the pull request was
replaced. The client now loads the CA once into a dedicated `https.Agent`, with keep-alive
like the Node global agent it used before. Requests, assertions and destinations are
unchanged.

## Decisions

1. **Separate production profile.** `deploy/production/compose.yaml` publishes only a
   TLS proxy. The API and migration run uid 10001, read-only, with no capabilities,
   no-new-privileges and file secrets. API starts after migration and proxy after API
   readiness (database, exact migrations and storage, not the DB-only operator route).
   The rehearsal stops/restarts storage and executes the actual health command to
   prove failure/recovery. Database and private HTTPS S3 remain operator services, using different
   runtime credentials. The API has no Docker access. `check-profile.mjs` validates
   the resolved model and rejects mutable images, privilege/development overrides,
   plaintext secrets/storage, bad trust/host alignment and proxy allocation collisions.
2. **Caddy transport.** Pin the 2.11.7-alpine multi-arch base index
   `sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f`.
   Certificates are operator file secrets, renewed/recreated externally, avoiding
   ACME credentials/network exceptions in this kit. Exact 16,384-byte requests,
   10-second header/body deadlines, GET/POST/DELETE, HSTS and no-store API responses
   are explicit. Flush immediately; 300-second SSE must not inherit a 10-second
   response timeout. Host is unchanged; untrusted XFF is replaced with the actual
   client address. Unknown HTTP hosts return 421. Discard proxy access/error logs,
   which otherwise risk exposing request paths/addresses; retain safe API codes and
   loopback metrics. This trades detailed proxy logs for the existing privacy contract.
3. **Dedicated worker.** Ship systemd units with uid 10001, systemd file credentials,
   local-disk scratch, read-only system, private tmp, empty capability bounding set
   and restart-on-failure. Docker-group access is root-equivalent, not a sandbox;
   dedicate the engine/host, keep installed code root-owned and retain ADR-034 engine
   ownership. Rootless networking is outside this bridge-policy profile. Worker stop
   also awaits maintenance batches, which have no overall duration bound. Use
   `TimeoutStopSec=infinity` rather than falsely equating drain to the 300-second job
   deadline. Forced recovery follows the existing crash/reaper procedure.
4. **Layered firewall.** Preserve the runner's existing broker-only `docker0` network
   and per-job internal acquisition networks; analysis stays network-none. Document
   matching Docker bridge/address pools. The nft table filters before Docker's normal
   forward chains; accept here cannot bypass a later Docker drop. Default-deny host
   output and forwarding, restrict broker HTTPS to GitHub git/API ranges, and block
   container-to-host relay access. DNS to one fixed resolver, coordinator GitHub
   visibility checks, and fixed database/S3 destinations are necessary infrastructure
   exceptions. They are explicit, not an unrestricted broker/host exemption. The
   broker bridge is IPv4-only; IPv6 host GitHub calls use the validated IPv6 set.
5. **Atomic expiring allowlists.** Fetch only the fixed official metadata URL, no
   credentials/redirects, with byte/deadline bounds; accept canonical public CIDRs,
   deduplicate/subsume overlaps. nft validates then atomically replaces both interval
   sets. Refresh failure keeps previous sets; kernel timeouts expire them in 24 hours.
   Reviewed API bootstrap ranges expire in 15 minutes. Worker startup requires a
   successful refresh; stale bootstrap or upstream outage stops startup. No global
   ruleset flush, Docker-table edit, dynamic hostname injection or allow-all fallback.
6. **Proof boundaries.** Production rehearsal uses the real API image/profile,
   migrations, least-privilege role, private HTTPS S3 fixture and loopback CA, with
   development disabled. Admission/queued-SSE/cancellation prove transport, without
   acquiring repositories. The existing separate container gates prove real jobs,
   offline/egress boundaries, Python history and published artifacts. Packet tests
   enforce remapped fixture routes in an isolated router namespace with positive
   controls/counters; they never install rules on the developer/CI host. Static
   systemd verification uses a Docker unit stand-in; it is not a real host boot/drain.
7. **Reproducible operator evidence.** Reports contain Git/dirty state, configuration
   digests, immutable image identities and individual outcomes. Upload only the report,
   never generated credentials/CA private keys. Cleanup checks owned resources. Exclude
   deployment secret directories/completed `.env` files from Docker build contexts.
   A full site deployment, TLS renewals, firewall boot, clock/OS audit and credentials
   still need operator evidence. Monitoring/backups/SBOM/SLO/legal pages remain later M4.

The reference instructions are [deployment README](../../deploy/production/README.md).
[Caddy proxy documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
supports immediate flushing and forwarding-header handling;
[Docker's nftables guidance](https://docs.docker.com/engine/network/firewall-nftables/)
explains that separate base chains retain later filtering decisions;
[systemd execution documentation](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)
defines credential snapshots and filesystem restrictions. Interface details were checked
against these primary sources, not inferred from development configuration.

## Verification

Local evidence and limits are in
[production reference report](../benchmarks/production-reference-deployment.md).
The hosted CI job repeats configuration validators, the packet probe and production
TLS transport rehearsal, then the existing physical gates. Exact-head checks and review
thread outcomes are recorded on the pull request before it is offered for owner merge.
This decision does not close R6-06, any other human/device requirement, or G6.
