# ADR-073: Operator monitoring with Prometheus

Date: 2026-10-18. Status: proposed for M4.2; exact-head CI and owner merge required.
Builds on the operator metrics of plan §15.4 and the reference kit of
[ADR-072](ADR-072-reference-hosted-deployment.md). Analyzer and artifact versions unchanged.

## Evidence and cause

- **No standard format.** The operator listener served its aggregates as JSON only.
  [Operations](../hosted-operations.md#metrics) names four alerts, but nothing could
  evaluate them, and no standard monitoring system reads that JSON.
- **The listener is loopback-only, by design.** It binds `127.0.0.1` inside the API
  container, and ADR-072 publishes neither the API port nor the operator port. A
  Prometheus elsewhere cannot reach it. Exposing the listener on the Compose network
  would also expose it to the proxy.
- **A failed scrape silences every alert.** When the database is down, the listener answers
  503. An alert on a metric that is no longer scraped never fires.

## Decision

1. **Prometheus text on the same endpoint.**
   - `GET /metrics` answers the text format 0.0.4 when the request prefers `text/plain`
     to JSON, as Prometheus's scrape request does. It answers JSON otherwise, including
     curl's `*/*`, so existing runbooks and `atlas-ops metrics` are unchanged. It sends
     `Vary: Accept`.
   - Each JSON field becomes one gauge, `atlas_` plus its path in snake case with the unit
     last. Keyed maps become labels (`state`, `code`, `stage`). Stage durations are
     converted from milliseconds to seconds, Prometheus's base unit.
   - The four terminal states are always written, 0 when none, so dashboards show 0 rather
     than "no data".
   - Null fields are left out, not written as 0. For example, with nothing queued, "no
     oldest job" must not read as a zero-second wait.
   - The names are listed in operations. `promtool check metrics` finds no problems in
     the real output.
2. **The listener cannot be moved off loopback.** `startOperatorServer` no longer
   accepts a host, so no configuration can publish it. It reports its bound address,
   which tests check.
3. **Prometheus shares the API's network namespace.**
   - An optional `prometheus` service (Compose profile `monitoring`) runs pinned
     Prometheus 3.15.0 by its multi-arch index digest, with `network_mode: service:api`.
   - It scrapes `127.0.0.1:9090` and serves its own UI on that namespace's loopback,
     port 9091. It publishes nothing and joins no network of its own.
   - It runs as `nobody`, with a read-only root, read-only configuration mounts, no
     capabilities and `no-new-privileges`. Samples are kept for 15 days in a named volume.
   - Alert delivery (`alerting`) and history elsewhere (`remote_write`) are site-specific.
     They go in the operator's copy of `prometheus.yml`, which ships examples only.
   - `check-profile.mjs` validates the service whenever it is present: immutable image,
     the API namespace, no ports or networks, non-root, read-only binds, no secrets and
     no control socket.
4. **Five alerts.** `alerts.yml` holds the runbook's four alerts, each linked to its
   runbook section: expired leases for 2 minutes, oldest queued job over 10 minutes,
   purging uploads for 1 hour, GitHub back-off for 15 minutes. A fifth,
   `AtlasOperatorMetricsDown`, fires after 5 minutes without a successful scrape.
   `alerts.test.yml` holds promtool unit tests: each threshold and hold time, recovery, and
   no alert when nothing is queued.
5. **An optional Grafana dashboard** charts every gauge and only those.
6. **Consistency is tested.** A test fails if an alert or dashboard names a gauge the
   listener does not write, if the dashboard leaves one out, if operations does not
   document one, or if an alert links a runbook section that does not exist.

## Not decided here

- **Which alerting and history backend to use.** That is the operator's choice (M4.5
  sets targets). The kit proves alerts are evaluated, not that they are delivered.
- **Worker-host metrics.** The worker has no metrics listener. Its health shows through
  leases, the queue and outcomes, which the database already holds.
- **SLO targets.** These are M4.5, based on measured rehearsal numbers.

## Verification

- **Unit tests:**
  - the exact text for a complete sample, omission of null fields and label escaping;
  - negotiation, using Prometheus 3's own `Accept` header and curl's and browsers'
    defaults;
  - the listener answering text or JSON on `127.0.0.1` only;
  - the profile validator's sidecar cases;
  - configuration consistency.
- **promtool 3.15.0:** `check config` and `check rules` pass, and `test rules` passes. A
  deliberately shortened hold time makes the unit tests fail.
- **The production rehearsal** (ADR-072) has two new steps, so it now has 16:
  - promtool validates the shipped configuration, rules and unit tests, offline;
  - against the real production API:
    - the proxy, on the same network, is refused at `api:9090`;
    - the real text output passes `promtool check metrics`;
    - the sidecar reports `up` = 1 for `atlas-operator`, with all five rules healthy;
    - the job the rehearsal cancelled appears in the scraped `atlas_outcomes_24h`.
- Local and CI results are recorded in the implementation status and the pull request.
