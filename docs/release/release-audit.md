# ATLAS V0.1 release audit

Updated: 2026-10-11. **G6 OPEN — candidate preparation, not release sign-off.**
The four pillars are implemented; runtime tracing/instrumentation remains wholly deferred.
This audit distinguishes implementation/test evidence from human, reference-device and
public-infrastructure acceptance. The canonical requirements remain the [master plan](../plan/PROJECT_ATLAS_V0.1_MASTER_PLAN.md).

## Phase 5 review closure

Review commits `6113d94` and `944d579` fix shared-engine reconciliation fencing, stale
home-route discovery, browser cleanup and the sub-watchdog-interval acquisition disk
race. [ADR-034](../adr/ADR-034-phase5-review-and-exclusive-engine-ownership.md) records
the engine constraint. The final cold-link test correction also authenticates the history
suite independently and waits for both cold navigations before asserting route state.
Actual PostgreSQL termination, Docker isolation, S3 lifecycle and hosted browser behavior
are tested, rather than inferred from mocks. Final verification results and CI links are
recorded in [implementation status](../implementation-status.md).

## Requirements and evidence

| Requirement / plan section | Implementation and verification | Status / boundary |
|---|---|---|
| Four pillars; runtime excluded (§1/3/18) | CLI/analyzer, graph, findings, layout/history, viewer; ADR-012 | Implemented; no runtime components introduced |
| Committed local acquisition (§5/9/14) | `packages/ingest`; safe Git traps, worktrees, missing objects, acquisition-budget regression; doctor/analyze/serve tests | Implementation tests pass; production Git/image audit remains operator work |
| Public GitHub ingestion (§5/13) | `apps/api`, `apps/worker`, pinned broker; real PostgreSQL/S3/container/HTTP gates; live acquisition CI | Implemented; actual domain/TLS/firewall deployment pending |
| Canonical identity/versions (§7/8) | `packages/schema`, `packages/artifact`; independent hash/identity goldens, version readers, malformed chunk/transport/cap tests; generated schema/OpenAPI check | Automated contracts; registry publication not required for candidate |
| TS/JS static resolution/coverage (§9) | `packages/analyzer-ts/core`; filesystem/network-free resolution test; parser worker timeout/crash/OOM; independent authored Harbor and real corpus | Three pinned repos, 16 independently authored facts; corpus equality does not prove all edges correct |
| Dependencies/diagnostics (§10) | `packages/graph`, shared catalog/metrics; SCC witness, bounded reach, external/package summaries, independent churn/hotspot math | Automated implementation checks; user interpretation reviewed under P6.3 |
| Mainline history/lineage (§11) | Authored roots/merges/rename/duplicates/clock-skew fixtures; no future leakage; union invariance/delta/compact round trips | Local and hosted recovery tests; large temporal performance still pending |
| Deterministic layout (§12) | `packages/layout`, graph/layout invariants, stable plots; cross-OS Harbor golden; real corpus full canonical/wire digests | CI independently compares three-repo Windows/Linux corpus |
| Frontend interactions/equivalents (§3/12/16) | Real browser keyboard, deep-link/tombstone/compare/partial, reduced motion/320px, map/table/fallback, axe tests | Automated journeys; five developers/manual assistive use pending |
| Cancellation/partial/resource recovery (§13/15/16) | Queue claim/fence/retry; heartbeat/deadline cancellation; checkpoint fallback; disk/OOM/timeout/network/storage faults; no-container/network leak checks | Local/CI isolation gates; production-host recovery requires rehearsal |
| Publication privacy/lifecycle (§5/13) | Consent/TTL/private storage, per-chunk visibility, management token, expiry/revocation/purge/reconcile tests; operator restore/rollback rehearsal | Seven-day lifecycle implemented; cannot recall already downloaded copies |
| P6.1 empirical corpus (§17) | [Pins](repository-corpus.json), [report](real-repositories.md), reproducible offline 5-run scripts and source-free exports | Done; five repeats on both OSes, independent comparison and exact original-payload baseline checks pass in CI |
| HEAD capacity (§15.2/P6.2) | [20-run medium](../benchmarks/phase6-head-capacity.md), [20-run near-limit large](../benchmarks/phase6-large-head-capacity.md) | Development host only; exact reference hardware and exact dense large fixture pending |
| Historical capacity (§15.2/P6.2) | [20-run medium history](../benchmarks/phase4-history.md), [viewer history/heap](../benchmarks/phase4-history-viewer.md), [20-run large history under 4 CPU/2 GiB](../benchmarks/phase6-large-history-container.md) | Large 12-frame passes: p95 202.37 s ≤ 240 s, peak 1.79 GiB, no OOM (dev host with enforced limits, [ADR-037](../adr/ADR-037-export-hashing-and-structural-proofs.md)); reference machine and exact 20,000-union fixture pending |
| Render/search/response/heap (§15.2) | Phase 3 city/profile reports; selected-edge/draw-call/heap gates; CI software rendering | Exact integrated-GPU Chromium/Firefox, 10 Mbps/100 ms RTT and first-use acceptance pending |
| P6.3 task/assistive review (§1.5/17) | [Uncoached task cards and manual results template](manual-review.md) | Pending ≥5 developers, ≥4 successes/task, keyboard fallback and two assistive platforms |
| P6.4 distribution/docs (§17) | Portable CLI, every-file inventory/third-party notices; [relocated offline smoke](distribution-smoke.md); [fresh-install/demo/privacy guide](README.md), [notes](release-notes.md) | Tooling/docs prepared; P6.2/P6.3 dependencies and independent reviewer sign-off pending |
| P6.5 release traceability (§17/18) | This table; [status](../implementation-status.md), all ADRs, [operator runbook](../hosted-operations.md) | Audit prepared; final signed acceptance pending |

## Outstanding acceptance work

| ID | Owner needed | Required evidence / acceptance | Gate impact |
|---|---|---|---|
| R6-01 | Performance reviewer/operator | Recorded four-core/2 GiB job host + SSD; 20-run medium/large HEAD and 12-frame history incl. exact dense/union fixtures; unchanged 15/60/90/240 s targets; sizes/omissions/peaks/leaks | P6.2 open |
| R6-02 | Device reviewer | Recorded integrated-GPU/8 GiB/1920×1080/DPR≤1.5 Chromium and Firefox; 20 interaction samples, camera/search/first-use/network/draw/combined heap and long-task profiles | P6.2 open; prior cold-load costs require investigation |
| R6-03 | Product reviewer + five developers | Complete [manual task protocol](manual-review.md), retain initial/follow-up failures and ≥4/5 successes each; coverage interpretation | P6.3 open |
| R6-04 | Accessibility reviewers | NVDA/Windows plus second assistive platform, no-canvas equivalents, focus/zoom/motion/announcement/recovery evidence | P6.3 open |
| R6-05 | Independent install reviewer | Fresh supported machine reproduces candidate hash/doctor/local offline demo and operator-controlled hosted demo; exact environment and outcome | P6.4 open, after P6.2/P6.3 |
| R6-06 | Deployment operator | Domain/TLS, network firewall and least-privilege roles, dated image/Git/OS audit, backup/restore/revocation/rollback, live canaries, leak/metrics/alert checks | Public launch blocked until verified |
| R6-07 | Release owner | Review CI/reports, triage every known defect, no unresolved P0/P1, lock final code/archive identities and sign off §18 definition of done | G6 open |

The large-history [diagnostic](../benchmarks/phase6-large-history-precache.md) subsequently
observed excessive export working data; [ADR-036](../adr/ADR-036-export-base-cache-lifetime.md)
records cache lifetime, streamed exact canonical text, one-table matching and deferred
indexed working rows. The [bounded-parent diagnostic](../benchmarks/phase6-large-history-bounded-completion.md)
completes all twelve frames. After [ADR-037](../adr/ADR-037-export-hashing-and-structural-proofs.md),
the [20-sample whole-job report](../benchmarks/phase6-large-history-container.md) passes
inside four CPUs, 2 GiB and no swap: p95 202.37 s, peak 1,919,053,824 bytes, zero OOM events.
R6-01 includes verifying this observed issue
as well as the missing reference measurements. A warm-up is not a 20-run p95 result.
Other open rows are acceptance gaps, not invented measured failures. Automated checks cannot
replace participants, screen readers or hardware that has not been used. There is no
authorization or infrastructure configuration here for creating an actual public service.

## Measurement caveats and resolved defects

Medium HEAD passes locally at **6.81 s p95**, 1.85 MiB compressed; cold parser facts,
one warm-up plus twenty measurements. Light packaging/maintainer I/O overlapped early
samples; no other analyzer/browser benchmark batch overlapped. The near-limit large
batch runs separately. Both reports name the actual Windows/i5-10400/16 GiB host,
not the required reference environment. No memory cap or four-core affinity is claimed.
The large HEAD batch passes at **20.59 s p95**, 6.07 MiB compressed. Its fixture has
9,992 included files and 98,500 import statements; it is close
to the cap, not the exact 10,000-file/100,000-edge temporal acceptance fixture.

Medium history's final 20-run dev.5 batch passes at **69.59 s p95** and 4.70 MiB.
Cached snapshot changes pass at **135.5 ms p95**, with four retained main/worker sweeps
at 208.38–208.71 MiB and comparison at 226.41 MiB. Cold first visits reach **11.29 s**;
pre-collection combined allocations reach **657.34 MiB**. These explicit costs must
be revisited on the reference device; retained-heap success is not a startup guarantee.
Original failed-size and contended history reports remain available. No budget has been
relaxed to make a gate appear successful.

The Phase 5 review defects above are fixed with regression coverage. The compiler's
`.js` declaration substitution is a documented resolution contract, not a defect patched
to match a guessed example. Vite's partial status and role heuristics are disclosed.
[Registry audit](dependency-audit.md) returned zero advisories on its recorded date;
that does not sign off deployed images or all runtime dependencies forever.

The 2026-10-11 handoff review corrects structural equality's rejection of ill-formed
Unicode property keys, matching the serializer's existing contract. Its regression
and complete physical-gate verification pass (684 checks, none skipped); exact
verification evidence is recorded in [implementation status](../implementation-status.md).
Valid artifact identities and versions are preserved. The agent/start guides now
explicitly retain the exact capacity-fixture matrix in R6-01 rather than describing
all remaining work as human or infrastructure acceptance.

## Release identity and approval record

Candidate internal package version: `0.1.0-dev`; analyzer: `0.1.0-dev.6`; artifact:
`atlas.artifact/1.4.0`; layout: 1.1. Distribution manifests record exact source HEAD,
working-tree state, lockfile hash and per-file digest; smoke reports bind archive bytes.
Do not turn a dirty-tree candidate into a signed release by changing a document label.

Final source commit / archive SHA-256: **pending release owner selection**.
Human/device/operator review reports: **pending**.
No-P0/P1 review and sign-off owner/date: **pending**.
Decision: **keep G6 open until all required evidence exists**.
