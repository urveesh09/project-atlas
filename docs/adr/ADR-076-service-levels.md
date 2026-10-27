# ADR-076: Hosted service levels, their indicators and incidents

Date: 2026-10-18. Status: accepted for M4.5, merged in [PR #44](https://github.com/urveesh09/project-atlas/pull/44) on 2026-10-18.
Builds on [ADR-073](ADR-073-operator-monitoring.md) (operator metrics and Prometheus). It
changes ADR-073's Prometheus retention from 15 to 35 days. Analyzer and artifact versions
are unchanged.

## Evidence and cause

The plan asks for three objectives, each measured from `/metrics`: publication
availability, job success excluding expected outcomes, and queue time p95. The targets
must be based on measured numbers, not wishes.

- **Availability could not be measured.** The operator metrics are database aggregates.
  Nothing counted publication reads or their failures.
- **Queue time could not be measured.** Only the age of the oldest queued job was
  reported, which shows a stalled queue but not a distribution. The jobs table has no
  claim timestamp. However, the claim sets `deadline` once, to claim time plus 300
  seconds, and a retry keeps it. So `deadline - 300 s - created_at` is each job's exact
  wait.
- **Job success was measurable,** from the existing 24-hour outcome and failure-code
  gauges.
- **The rehearsals measure correctness and durations, not real traffic.**
  - [Phase 5](../benchmarks/phase5-rehearsal.md) measured 7.8 s end to end for a small
    repository, 162 s for a 3,252-file repository with history, and 145 s to recover a
    killed worker.
  - Every non-cancelled job ended `READY`.
  - No rehearsal measures availability or queue wait under load.

## Decision

1. **Queue wait p95.**
   - `operatorMetrics` reports `queue.waitSecondsP95_24h`: the p95 wait over jobs first
     claimed in the last 24 hours. In Prometheus it is `atlas_queue_wait_p95_24h_seconds`.
   - The claim's 300 seconds becomes `JOB_DEADLINE_SECONDS` in `@atlas/control`, used by
     both the claim and the metric, so the two cannot drift.
   - Jobs still queued stay in the oldest-queued gauge.
   - No schema change.
2. **Publication read counters.**
   - The API counts each manifest and chunk read by its final status:
     - `ok`: below 400;
     - `ended`: 404/410, deleted, expired, revoked or unknown, as designed;
     - `rejected`: other 4xx;
     - `unavailable`: 5xx, including failing closed when GitHub cannot be reached.
   - The operator listener in the same process reports them as JSON `publicationReads`
     and as the counter `atlas_publication_reads_total{result}`. Prometheus's `rate()`
     and `increase()` handle the reset when the process restarts.
   - Availability is `ok / (ok + unavailable)`.
   - `atlas-ops metrics` runs on the worker and has no such counters.
3. **Objectives,** in [hosted-slo.md](../hosted-slo.md), with their basis:
   - **Publication availability: 99.5% over 30 days.** Stated as unmeasured. It reflects a
     single, non-redundant API host, database and storage, and reads that fail closed
     while GitHub is unreachable.
   - **Job success: 98% per day,** excluding cancelled jobs, refused input and the V0.1
     limits. GitHub failures count, because users experience them. Based on the
     rehearsals' complete success, with room for failures they did not exercise.
   - **Queue wait p95: at most 10 minutes per day.** This matches the existing
     stalled-queue page. Measured durations show it needs no more than about three
     medium jobs queued per worker slot.
   - Every objective is provisional until 30 days of real traffic (R6-06).
4. **Rules.** `slo.yml` holds seven recording rules and four alerts:
   - publication fast burn (14.4×, 1 h and 5 min, page);
   - publication slow burn (6×, 6 h and 30 min, ticket);
   - job success below 98% for 1 h, with at least 20 counted jobs (ticket);
   - queue wait above 10 minutes for 30 min (ticket).

   `slo.test.yml` tests each one with promtool, including the cases that must stay quiet.
   Prometheus loads `slo.yml` beside `alerts.yml` and keeps 35 days of samples, enough for
   the 30-day window.
5. **Incidents.** Severity levels, first-response steps that link every runbook, and how
   users are told.
   - The product already shows retryable, plain-language errors and fails closed rather
     than showing stale content.
   - The owner must name a status channel and contact (M4.6).
   - Notifying anyone about a data incident is the owner's legal decision, not a
     procedure invented here.

## Not decided here

- **The path in front of the API** (DNS, TLS proxy, network) is not seen by the counters.
  An external canary probe is part of R6-06.
- **Changes to the objectives** after real traffic need a dated ADR.
- **Status page and contact** are M4.6, from the owner.

## Verification

- **Unit tests:**
  - the queue-wait gauge, the read counter and status classification, in the exact text;
  - the API counting reads by final status, and not counting other requests, through the
    operator listener;
  - consistency between the SLO rules, recorded series, dashboard, objectives and anchors.
- **PostgreSQL** (pinned image, throwaway container): the wait is measured to the first
  claim, a still-queued job is excluded, and a crash retry keeps the first claim's wait.
- **promtool 3.15.0:** `check rules` finds 11 rules in `slo.yml`, and `test rules` passes
  7 groups. Four deliberate mutations all make the tests fail: the success threshold,
  the burn factor, an excluded code, and counting ended reads as good.
- **Production rehearsal,** against the real API:
  - promtool checks and tests both rule files;
  - an unknown publication read through the proxy is counted as `ended`, in the
    listener's text and in Prometheus;
  - Prometheus loads all 16 rules, healthy.
- Local and CI counts are recorded in the implementation status and the pull request.
