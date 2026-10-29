# ATLAS V0.1 release audit

Updated: 2026-10-29 (`v0.1.0-beta.2` tagged 2026-10-19; M4.1–M4.6, record retention and M5.2 part 1 landed; open items in the [backlog](../backlog.md)). **G6 OPEN — candidate preparation, not release sign-off.**
The four pillars are implemented; runtime tracing/instrumentation remains wholly deferred.
This audit distinguishes implementation/test evidence from human, reference-device and
public-infrastructure acceptance. The canonical requirements remain the [master plan](../plan/PROJECT_ATLAS_V0.1_MASTER_PLAN.md).

The supported runtime/security pins now use Node 24.22.1 ([ADR-088](../adr/ADR-088-node-october-security-patch.md)).
The initial Q2.2 image scan correctly blocked vulnerable 24.22.0; fresh checks are
required on the patched candidate. This maintenance does not close G6 or deploy the kit.

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
| Public GitHub ingestion (§5/13) | `apps/api`, `apps/worker`, pinned broker; real PostgreSQL/S3/container/HTTP gates; live acquisition CI | Hosted Python journey implemented (ADR-064); actual domain/TLS/firewall deployment pending |
| Canonical identity/versions (§7/8) | `packages/schema`, `packages/artifact`; independent hash/identity goldens, version readers, malformed chunk/transport/cap tests; generated schema/OpenAPI check | Automated contracts; registry publication not required for candidate |
| TS/JS and Python static resolution/coverage (§9; ADR-056/057/060/065/066/080) | `packages/analyzer-ts`, `analyzer-py`, `analyzer-core`; TS filesystem/network-free resolution test; isolated parser faults; authored Harbor and pinned real corpus; [Python parser/oracle evidence](../benchmarks/production-python-runtime.md), ADR-062 | Six pinned repos, 46 authored checks including Flask, a uv workspace and mixed Python/TS application. New expectations exposed the corrected namespace-precedence bug (ADR-066). Five offline repeats and CLI viewer checks pass; six-repository CI and owner merge have landed (combined PR #33; reconfirmed by PR #35 checks). CPython facts agree where both parse, with disclosed grammar gaps. Python capacity/mixed fixtures (M2.2) and hosted journey (M2.3) have separate evidence; corpus equality does not prove all edges correct |
| Dependencies/diagnostics (§10) | `packages/graph`, shared catalog/metrics; SCC witness, bounded reach, external/package summaries, independent churn/hotspot math | Automated implementation checks; user interpretation reviewed under P6.3 |
| Optional external lint evidence (owner extension, ADR-085) | Separate `atlas.quality/1` sidecars, local Ruff SARIF import, validated snapshot/file references and exact-location comparison; [guide](../guides/external-findings.md), [physical producer check](../benchmarks/external-quality-import.json) | Source messages/host paths excluded; binding is user-declared and scan scope/configuration unverified. This cannot establish resolution, security coverage or a merge gate. Original G6 requirements remain open |
| Optional scan declarations/provenance (Q2.1, ADR-086) | Separate `atlas.scan/1`, isolated profile/path/blob accounting, strict independently selected GitHub workflow/source/root policy; [guide](../guides/scan-provenance.md), [actual offline verifier check](../benchmarks/scan-provenance.md) | Real vendor signatures verify with networking disabled; tampering/wrong policy fail. Execution/scope remain producer assertions; browser declarations remain unauthenticated. The signing recipe is inactive and a live ATLAS scan proof remains owner work. No clean/resolution/merge verdict or G6 closure |
| Optional contextual finding review (Q2.2, ADR-087) | Committed-source anchors, deterministic within-analysis tracking, explicit historical-target/producer pins, browser two-snapshot navigation; [guide](../guides/finding-review.md) | Duplicated/changed context, changed settings and partial/unverified scope remain uncertain. Real Ruff producer and full-size matching/import checks are distinct from signature mocks and vendor crypto proof. Browser verification claims are never authenticated; live ATLAS signed scan pair remains owner activation work. No automatic resolved/clean/merge verdict or G6 closure |
| Mainline history/lineage (§11) | Authored roots/merges/rename/duplicates/clock-skew fixtures; no future leakage; union invariance/delta/compact round trips | Local and hosted recovery tests; large temporal performance still pending |
| Deterministic layout (§12) | `packages/layout`, graph/layout invariants, stable plots; cross-OS Harbor golden; real corpus full canonical/wire digests | Six pinned repositories run on Windows, Linux and macOS, with the three-way comparison passing in PR #35 |
| Frontend interactions/equivalents (§3/12/16) | Real browser keyboard, deep-link/tombstone/compare/partial, reduced motion/320px, map/table/fallback; [named audits of visible screens, menus and source dialog](accessibility-preparation.md), including WCAG 2.1 A rules; null/throwing WebGL fallback checks console/page errors and primary-action transition ratios meet 4.5:1 (ADR-071) | Automated preparation; M3.4 intermittent overflow diagnosis, five developers/manual assistive use pending |
| Cancellation/partial/resource recovery (§13/15/16) | Queue claim/fence/retry; heartbeat/deadline cancellation; checkpoint fallback; disk/OOM/timeout/network/storage faults; no-container/network leak checks | Local/CI isolation gates; production-host recovery requires rehearsal |
| Publication privacy/lifecycle (§5/13) | Consent/TTL/private storage, per-chunk visibility, management token, expiry/revocation/purge/reconcile tests; operator restore/rollback rehearsal | Seven-day lifecycle implemented; cannot recall already downloaded copies |
| P6.1 empirical corpus (§17) | [Pins](repository-corpus.json), [report](real-repositories.md), reproducible offline 5-run scripts and source-free exports; ADR-065 | All six have five-repeat/46-check evidence and cross-OS corpus/comparison CI (PR #35). Existing four baseline bytes remain unchanged from the dev.8 prerequisite |
| HEAD capacity (§15.2/P6.2) | [20-run medium](../benchmarks/phase6-head-capacity.md), [20-run near-limit large](../benchmarks/phase6-large-head-capacity.md); Python [medium](../benchmarks/production-python-head-medium-dev9.md)/[large](../benchmarks/production-python-head-large-dev9.md) and mixed [medium](../benchmarks/production-mixed-head-medium-dev9.md)/[large](../benchmarks/production-mixed-head-large-dev9.md) under 4 CPU/2 GiB ([ADR-081](../adr/ADR-081-python-capacity.md)) | All pass on the development host: TS/JS, and Python/mixed on dev.9 (p95 at most 18.09 s against 60 s). Exact reference hardware and exact dense large fixture pending |
| Historical capacity (§15.2/P6.2) | [20-run medium history](../benchmarks/phase4-history.md), [viewer history/heap](../benchmarks/phase4-history-viewer.md), [20-run large history under 4 CPU/2 GiB](../benchmarks/phase6-large-history-container.md) | Large 12-frame passes: p95 202.37 s ≤ 240 s, peak 1.79 GiB, no OOM (dev host with enforced limits, [ADR-037](../adr/ADR-037-export-hashing-and-structural-proofs.md)). Python [medium](../benchmarks/production-python-history-medium-dev9.md)/[large](../benchmarks/production-python-history-large-dev9.md) and mixed [medium](../benchmarks/production-mixed-history-medium-dev9.md)/[large](../benchmarks/production-mixed-history-large-dev9.md) pass on dev.9 ([ADR-081](../adr/ADR-081-python-capacity.md)); mixed large peaks at 1.85 GiB and mixed medium packs 4.92 of 5 MiB. Reference machine and exact 20,000-union fixture pending |
| Render/search/response/heap (§15.2) | Phase 3 city/profile reports; selected-edge/draw-call/heap gates; CI software rendering | Exact integrated-GPU Chromium/Firefox, 10 Mbps/100 ms RTT and first-use acceptance pending |
| P6.3 task/assistive review (§1.5/17) | [Uncoached task cards and manual results template](manual-review.md) | Pending ≥5 developers, ≥4 successes/task, keyboard fallback and two assistive platforms |
| P6.4 distribution/docs (§17) | Portable CLI, every-file inventory/third-party notices; [relocated offline smoke](distribution-smoke.md); [fresh-install/demo/privacy guide](README.md), [notes](release-notes.md) | Tooling/docs prepared; P6.2/P6.3 dependencies and independent reviewer sign-off pending |
| P6.5 release traceability (§17/18) | This table; [status](../implementation-status.md), all ADRs, [operator runbook](../hosted-operations.md) | Audit prepared; final signed acceptance pending |

## Outstanding acceptance work

Production M4.1 prepares the [reference deployment](../../deploy/production/README.md)
and [ADR-072](../adr/ADR-072-reference-hosted-deployment.md): real production API/TLS
transport rehearsal, configuration validators and isolated packet-policy enforcement,
alongside the existing hosted acquisition/analysis gates. It does not install a host
firewall, run systemd on the deployment machine, verify site credentials/renewal,
or create a public service. Those remain R6-06, with later M4
supply-chain/SLO/legal work still open. See the [dated report](../benchmarks/production-reference-deployment.md).
M4.2 ([ADR-073](../adr/ADR-073-operator-monitoring.md)) adds Prometheus text metrics,
alert rules with unit tests and an optional in-namespace Prometheus, rehearsed against
the real production API. R6-06's live alert checks still need the site's own alert
delivery.

M4.3 ([ADR-074](../adr/ADR-074-private-backups-and-restore-drill.md)) adds daily private
backups and independent expiry pruning, plus a guarded scratch restore that runs actual
sweep/reconciliation against fresh storage. It preserves original lifecycle evidence and
quarantines stale live state, including later-deleted publications and cancelled jobs.
The [physical report](../benchmarks/production-backup-restore.md) records real TLS
PostgreSQL, corruption/failure recovery and untouched live storage. No backup secrets or
archives are CI artifacts. Operator installation, alert delivery, promotion, post-backup
takedown reconciliation and a live-site recovery drill remain R6-06.

M4.4 ([ADR-075](../adr/ADR-075-scanned-immutable-image-publication.md)) adds pinned
scanner/SBOM/publisher tools, exact OCI graph scanning before either image publication,
signed workflow/tag/commit verification and an isolated registry-copy rehearsal. Runtime
package managers are removed after a real scan found vulnerable npm dependencies.
See [image verification](../image-supply-chain.md) and [dated evidence](../benchmarks/production-image-supply-chain.md).
No live signing, release tag, public package or deployment is produced by this task;
actual release and R6-06 acceptance remain owner/operator work.
M4.5 ([ADR-076](../adr/ADR-076-service-levels.md)) defines provisional
[service levels](../hosted-slo.md) and incident handling, measured from `/metrics` with
tested rules. R6-06 must confirm them against 30 days of real traffic and add an
external canary for the path in front of the API.
M4.6 ([ADR-077](../adr/ADR-077-public-service-pages.md)) adds the privacy, terms and
takedown pages and contact link. A production API refuses to start without the owner's
texts or with the shipped placeholders. **Owner work before launch:** the legal wording
itself, and the contact. Under the owner's delegation,
[ADR-078](../adr/ADR-078-record-retention-and-status.md) deletes job records 30 days after
they end and requires a status page, by default the project's GitHub `incident` issues.

Production M2.3 adds full hosted Python evidence (2026-10-16, [ADR-064](../adr/ADR-064-hosted-python-evidence.md)):
145 local PostgreSQL/S3/container/browser checks pass, including two authored Python
frames, rename lineage and exact internal/builtin/PyPI facts. Required CI is tracked
in its PR. This closes the missing local Python journey evidence; it does not close
Python capacity (M2.2), deployment acceptance or G6. The expanded corpus has since landed and passes the cross-OS jobs in PR #35.
M2.2 records all eight Python/mixed capacity rows on the development host (2026-10-20,
[ADR-081](../adr/ADR-081-python-capacity.md)); they pass, and R6-01 still needs the reference machine.

| ID | Owner needed | Required evidence / acceptance | Gate impact |
|---|---|---|---|
| R6-01 | Performance reviewer/operator | Recorded four-core/2 GiB job host + SSD; 20-run medium/large HEAD and 12-frame history incl. exact dense/union fixtures; Python/mixed capacity from M2.2; unchanged 15/60/90/240 s targets; sizes/omissions/peaks/leaks. M2.2's Python/mixed rows pass on the development host (ADR-081). The exact fixtures now exist (`build-history-fixture.mjs --shape exact\|dense`, [ADR-082](../adr/ADR-082-exact-capacity-fixtures.md)); their 20-run development-host rows are pending, and the reference machine is still required | P6.2 open |
| R6-02 | Device reviewer | Recorded integrated-GPU/8 GiB/1920×1080/DPR≤1.5 Chromium and Firefox; 20 interaction samples, camera/search/first-use/network/draw/combined heap and long-task profiles | P6.2 open; prior cold-load costs require investigation |
| R6-03 | Product reviewer + five developers | Complete [manual task protocol](manual-review.md), retain initial/follow-up failures and ≥4/5 successes each; coverage interpretation | P6.3 open |
| R6-04 | Accessibility reviewers | [Numbered NVDA/Firefox/Chrome and VoiceOver/Safari scripts](manual-review.md#screen-reader-rehearsal-scripts-m33), no-canvas equivalents, focus/zoom/motion/announcement/recovery evidence; inspect retained incomplete axe checks | P6.3 open; M3.3 prepares the review, no human results claimed |
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

Current package version: `0.1.0-beta.2`; analyzer: `0.1.0-dev.10` (export fitting,
[ADR-083](../adr/ADR-083-fit-the-export.md), with history memory held by
[ADR-084](../adr/ADR-084-history-memory.md); Python 3.15 grammar,
[ADR-080](../adr/ADR-080-python-3-15-syntax.md), after the namespace precedence correction,
[ADR-066](../adr/ADR-066-python-namespace-precedence.md)); artifact:
`atlas.artifact/1.4.0`; layout: 1.1. Distribution manifests record exact source HEAD,
working-tree state, lockfile hash and per-file digest; smoke reports bind archive bytes.
Do not turn a dirty-tree candidate into a signed release by changing a document label.

Final source commit / archive SHA-256: **pending release owner selection**.
Human/device/operator review reports: **pending**.
No-P0/P1 review and sign-off owner/date: **pending**.
Decision: **keep G6 open until all required evidence exists**.
