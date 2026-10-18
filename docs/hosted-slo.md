# Hosted service levels and incidents

Applies to the hosted service only; the CLI and local viewer have no service level.
Decision: [ADR-076](adr/ADR-076-service-levels.md). Metrics and runbooks:
[operations](hosted-operations.md#metrics).

**Status: provisional.** No production traffic has been measured yet. Each objective
below states what it is based on. Where nothing has been measured, it says so. Review
every objective against the first 30 days of real traffic (R6-06), and record any
change in a dated ADR.

## Objectives

| Indicator | Objective | Window | Recorded series |
|---|---|---|---|
| [Publication availability](#publication-availability) | 99.5% | 30 days | `atlas:publication_read_availability:ratio_30d` |
| [Job success](#job-success) | 98% | 24 hours | `atlas:job_success:ratio_24h` |
| [Queue wait](#queue-wait) | p95 at most 10 minutes | 24 hours | `atlas_queue_wait_p95_24h_seconds` |

The recording rules and the four objective alerts are in
[`slo.yml`](../deploy/production/slo.yml), with promtool unit tests in
[`slo.test.yml`](../deploy/production/slo.test.yml). The reference Prometheus keeps 35 days
of samples, enough for the 30-day window.

### Publication availability

**Indicator:** the share of publication reads (manifest and chunk) the API answered
without a server failure:
`ok / (ok + unavailable)` from `atlas_publication_reads_total{result}`.
- `ended` reads (404/410: deleted, expired, revoked or unknown) are designed outcomes and
  are not counted.
- `rejected` reads (other 4xx) are not counted either.
- `unavailable` includes failing closed when GitHub visibility cannot be rechecked within
  5 minutes. Users cannot see the publication then, so it counts against the objective.

**What it misses.** The counter lives in the API process.
- Failures before the API are invisible to it: DNS, the TLS proxy, the network.
- If the API process is down, its operator listener is down too, and
  `AtlasOperatorMetricsDown` pages after 5 minutes.
- An external probe of a canary publication covers the path in front of the API. That is
  part of the R6-06 site acceptance.

**Basis: not measured.** The rehearsals check that reads work, not how often they fail
under real traffic. The objective reflects the reference topology:
- one API host, one database and one storage service, none redundant;
- reads that fail closed while GitHub is unreachable.

99.5% allows about 3.6 hours of failed reads in 30 days.

**Alerts:**
- `AtlasPublicationBudgetFastBurn` pages when the error ratio exceeds 14.4 times the budget
  (7.2%) over both 1 hour and 5 minutes. At that rate the 30-day budget lasts about two
  days.
- `AtlasPublicationBudgetSlowBurn` raises a ticket above 6 times the budget (3%) over both
  6 hours and 30 minutes.

### Job success

**Indicator:** of the jobs that ended in the last 24 hours, excluding cancelled ones and
expected outcomes, the share that ended `READY` or `PARTIAL`. Recorded as
`atlas:job_success:ratio_24h` from `atlas_outcomes_24h` and `atlas_failures_24h`.

**Expected outcomes are excluded.** These are input the service rightly refuses and the
V0.1 limits:
- `INVALID_REPOSITORY_URL`, `REPOSITORY_NOT_PUBLIC`, `REPOSITORY_NOT_FOUND`,
  `REPOSITORY_MOVED`;
- `EMPTY_REPOSITORY`, `COMMIT_NOT_ACCESSIBLE`;
- `REPOSITORY_TOO_LARGE`, `ANALYSIS_RESOURCE_LIMIT`.

**GitHub failures count.** `UPSTREAM_RATE_LIMITED` and `UPSTREAM_UNAVAILABLE` count as
failures, because the user's analysis did not happen. The anonymous GitHub quota is 60
requests per hour, so configure `ATLAS_GITHUB_TOKEN` before relying on this objective
([runbook](hosted-operations.md#upstream-github-outage-or-throttling)).

**Known gap: crashes.** A crashed attempt is retried once. If the retry also outlives its
deadline, the job ends `ANALYSIS_RESOURCE_LIMIT`, which this indicator excludes. Crashes
are watched by `AtlasExpiredLeases` instead.

**Basis: measured in rehearsal, not under real load.**
- In the [operator rehearsal](benchmarks/phase5-rehearsal.md), every job that was not
  cancelled ended `READY`, including one recovered from a killed worker.
- The six pinned real repositories analyze and verify deterministically on Linux,
  Windows and macOS.
- The objective leaves 1 job in 50 for GitHub and infrastructure failures that the
  rehearsals did not exercise.

**Alert:** `AtlasJobSuccessBelowObjective` raises a ticket when the ratio stays below 98%
for an hour. It needs at least 20 counted jobs, so a handful of failures on a quiet day
is not an incident.

### Queue wait

**Indicator:** the p95 time from admission to the first claim, over jobs a worker
claimed in the last 24 hours (`atlas_queue_wait_p95_24h_seconds`).
- The first claim sets the job's deadline to claim time plus 300 seconds, once, so the
  wait is exact.
- A retry keeps that first claim.
- Jobs still waiting are not in this indicator. They appear as
  `atlas_queue_oldest_queued_seconds`, and `AtlasQueueStalled` pages above 10 minutes.

**Basis: measured job durations; queue wait under load is not measured.** The 10-minute
objective matches the existing page threshold for a stalled queue. Whether it holds
depends on capacity. Each queued job ahead of a new one adds its duration, divided by
the worker slots. Measured end-to-end durations:
- a small repository: 7.8 s;
- a 3,252-file repository with 40 commits of history: 162 s;
- recovering a killed worker: 145 s;
- every job is capped at 300 s.

With the defaults of 20 queued jobs and one slot, a full queue of medium repositories
waits about 54 minutes. The objective needs no more than about three medium jobs queued
per slot. Add slots, or lower `ATLAS_QUEUED_JOBS`, before raising admission
([capacity scaling](hosted-operations.md#capacity-scaling)).

**Alert:** `AtlasQueueWaitAboveObjective` raises a ticket when the 24-hour p95 stays above
10 minutes for half an hour.

## Severity levels

| Level | Meaning | Examples | Response |
|---|---|---|---|
| SEV1 | Privacy or security | Source text, a private repository's analysis or a withdrawn publication served; a credential or sandbox-isolation breach | At once, at any hour |
| SEV2 | Service down | `page` alerts: publication fast burn, operator metrics down, expired leases, stalled queue | At once, at any hour |
| SEV3 | Degraded | `ticket` alerts: slow burn, job success or queue wait below objective, stuck purge, GitHub back-off | Within one working day |
| SEV4 | No user impact | A single expected failure, a dashboard gap | Normal planning |

**Alerts cannot raise a SEV1.** Privacy and security incidents come from people:
reports, reviews or audits. Treat any credible report as SEV1 until it is ruled out.

## First response

1. **Acknowledge** the alert and note the time. Open the dashboard and the operator
   `/metrics`.
2. **Follow the runbook** for the alert:

   | Alert | Runbook |
   |---|---|
   | `AtlasPublicationBudgetFastBurn`, `AtlasPublicationBudgetSlowBurn` | Check `upstream.blockedSeconds` ([GitHub outage](hosted-operations.md#upstream-github-outage-or-throttling)), storage readiness ([storage reconciliation](hosted-operations.md#storage-reconciliation)) and the API's error codes |
   | `AtlasOperatorMetricsDown` | API process and database: readiness, then [schema rollback](hosted-operations.md#schema-rollback) if a release just ran |
   | `AtlasExpiredLeases`, `AtlasQueueStalled` | [Stalled job, or the reaper](hosted-operations.md#stalled-job-or-the-reaper), [worker crash](hosted-operations.md#worker-crash) |
   | `AtlasJobSuccessBelowObjective` | `atlas_failures_24h` by code: GitHub ([outage](hosted-operations.md#upstream-github-outage-or-throttling)), `ARTIFACT_INVALID` or `INTERNAL_ERROR` (an ATLAS fault: keep the job IDs) |
   | `AtlasQueueWaitAboveObjective` | [Capacity scaling](hosted-operations.md#capacity-scaling) |
   | `AtlasStoragePurgeStuck` | [Storage reconciliation](hosted-operations.md#storage-reconciliation) |
   | `AtlasUpstreamBlocked` | [GitHub outage or throttling](hosted-operations.md#upstream-github-outage-or-throttling) |

3. **SEV1, before anything else:** stop the exposure.
   - Revoke what is exposed with `atlas-ops purge-analysis` or `atlas-ops revoke-repository`
     ([purge and revocation](hosted-operations.md#purge-and-revocation)).
   - If analysis itself is implicated, stop the workers. Queued jobs then wait, and nothing
     new is published.
   - Rotate any exposed credential ([secret rotation](hosted-operations.md#secret-rotation)).
   - Keep logs and job IDs; they hold no source text or addresses.
4. **Never weaken a limit, an isolation setting or an assertion to end an incident.**
   Raising profile limits needs an ADR.
5. **Close** when the indicator is back within its objective. Write a short review for
   every SEV1 and SEV2: timeline, cause, what detected it, what changes. Record changes
   to objectives in a dated ADR.

## Telling users

**What the service already tells users:**
- Every failed request carries a public error code and a `retryable` flag. The viewer
  shows a plain message:
  - "The service is temporarily unavailable. Try again later. Nothing was published."
  - "GitHub is unavailable" or "GitHub is rate limiting requests", with when to retry.
  - "The result failed verification. This is an ATLAS fault."
- A publication whose visibility cannot be rechecked is refused with 503. The service
  never shows stale content, and never revokes it because of an outage.
- Expired, deleted and revoked publications say which of these happened.
- Nothing is published from a failed job.

**What the operator adds.** The service has no status page. Before launch, the owner names
a status channel and a contact address (M4.6). Then:
- **SEV1 and SEV2:** post on the status channel within 1 hour of acknowledging, and
  update at least every 2 hours until resolved. Afterwards, post a summary of the cause
  and the fix.
- **SEV3:** post only if users are noticeably affected, for example a long queue.
- **SEV1 involving data:** whether and how to notify people is the owner's legal
  decision. These procedures do not decide it. Downloaded copies cannot be recalled, as
  the landing page states.
