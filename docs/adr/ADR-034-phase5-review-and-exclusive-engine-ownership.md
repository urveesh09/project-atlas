# ADR-034: Phase 5 review and exclusive Docker-engine ownership

Date: 2026-10-11. Status: accepted. Clarifies ADR-031/033.

Startup reconciliation removes every ATLAS sandbox on an engine. ADR-031 assumes one coordinator service owns that engine, but the initial implementation did not enforce this. A second service starting during live analysis could remove the first service's containers.

Before reconciliation or claiming jobs, the worker now obtains a PostgreSQL session advisory lock keyed by the Docker engine's own immutable identity. The dedicated session remains held until graceful shutdown has drained running jobs. Another coordinator using the same engine and service database fails configuration before destructive reconciliation. Different engines can run against the same queue. Losing the lock's database connection terminates the process; a subsequent startup reconciles abandoned containers and normal job leases fence recovery.

Operators must dedicate each engine to one ATLAS service/database. This lock cannot coordinate independent databases. Slot concurrency within the owning service remains supported. Horizontal capacity uses separate engines; a rolling restart on one engine first drains/stops its existing worker.

The review also fixes two browser lifecycle issues:

- Close the isolated browser context in `finally`, and close the test HTTP listener and its keep-alive connections together. CI run [38109040490](https://github.com/urveesh09/project-atlas/actions/runs/38109040490) had 594 passing tests but failed this cleanup hook; increasing its timeout would conceal the leak.
- Fence asynchronous home-route discovery by a route revision. A delayed capabilities response cannot replace a newer analysis route. Preserve the existing explicit-navigation versus fragment-history distinction, including reloading a deleted publication at its current URL.

Evidence: the PostgreSQL queue suite proves concurrent engine exclusion, independent engines, restart after unlock, and actual backend termination releasing the lock and notifying the owner. The hosted Chromium success journey delays a capabilities probe, opens an analysis, releases the probe, and asserts the city survives. Local targeted verification: **45 passing checks across three suites**. The pre-review full suite passed **594 checks**, with 78 hosted integrations explicitly disabled; full hosted and final CI evidence are recorded in implementation status after verification.

This review does not substitute for the Phase 6 human accessibility, developer usability, reference-device or public infrastructure audits.
