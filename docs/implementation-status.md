# Implementation status

Maintained per plan §20.1. A task is **done** only when its completion evidence exists and its checks pass.

**Current milestone (2026-10-17):** production-plan M2, Python correctness evidence;
M2.1 documentation alignment landed in PR #25. M2.6 exposed a namespace-precedence
defect, corrected in analyzer `0.1.0-dev.8` (ADR-066); required CI/owner merge follow.
M1.1 landed in [PR #20](https://github.com/urveesh09/project-atlas/pull/20);
M1.2/M1.3 landed together in [PR #22](https://github.com/urveesh09/project-atlas/pull/22),
with separate implementation commits. M1.4 landed in
[PR #23](https://github.com/urveesh09/project-atlas/pull/23); M1.5 landed in
[PR #24](https://github.com/urveesh09/project-atlas/pull/24) (analyzer `0.1.0-dev.7`,
ADR-062). Python (`.py`, `.pyi`) is implemented alongside TS/JS, including mixed
repositories. Cython, notebooks and other unsupported languages remain opaque when
included. M2 still needs Python/mixed capacity, the complete hosted Python journey,
broader corpus and testing evidence. The public demo
(<https://urveesh09.github.io/project-atlas/>) is a static viewer on a bundled vuejs/core
analysis. The packages are `0.1.0-beta.1`. `main` requires a pull request and nine named
checks (ADR-046). Beta 2 work is recorded at the end of Phase 6 below (ADR-046, ADR-047).

Unchanged since 2026-10-11:
- The four product pillars and the Phase 6 candidate tooling are implemented.
- Evidence includes the real corpus and the portable CLI. The 20-sample near-limit
  large-history gate passed under 4 CPU/2 GiB (p95 202.37 s, [ADR-037](adr/ADR-037-export-hashing-and-structural-proofs.md)).
- G6 remains open for the exact dense/temporal capacity-fixture matrix, human,
  reference-hardware and deployment acceptance items R6-01…R6-07 in the
  [release audit](release/release-audit.md).
- Runtime instrumentation remains deferred.

Agents: read [AGENTS.md](../AGENTS.md).

## Phase 0: prove constraints and lock contracts

| Task | Status | Evidence | Checks |
|---|---|---|---|
| P0.1 Toolchain/skeleton | Done | 13 workspace packages matching plan §5.3; strict TS (`tsconfig.base.json`); exact pins in [toolchain.md](toolchain.md); [ADR-013](adr/ADR-013-pin-typescript-6-compiler-api.md), [ADR-014](adr/ADR-014-toolchain-and-library-pins.md); CI on Ubuntu and Windows (`.github/workflows/ci.yml`) | `pnpm typecheck`, `pnpm check:deps` (declared deps, source imports, runtime-instrumentation ban; negative case verified) |
| P0.2 TS resolver spike | Done | `packages/analyzer-ts`: syntax facts, require shadowing, virtual FS host, config discovery with bounded `extends`, workspace map, precedence rules 1–7. Decisions in [ADR-015](adr/ADR-015-resolver-context-policy.md) | `analyzer-ts/test/extract.test.ts` (9), `resolve.test.ts` (39 hand-written expectations) |
| P0.3 Safe Git/object spike | Done | `packages/ingest`: generated metadata dir, scrubbed environment, ref resolution without revision syntax, tree/blob/commit/diff readers, process-tree kill, GitHub URL admission, filtered acquisition, explicit blob broker. Results in [ADR-016](adr/ADR-016-safe-git-acquisition-spike-results.md) | `ingest/test/local-git.test.ts` (27: traps, worktrees, alternates, SHA-256, adversarial trees, timeouts); `github.test.ts` (39 offline + 2 live, run with `ATLAS_NETWORK_TESTS=1`) |
| P0.4 Instancing/layout spike | Done | `packages/layout`: square-shelf packer v1, heights, xorshift32 seeds. `apps/web` spike: one InstancedMesh per batch, ID picking, HTML fallback. Report in [benchmarks/phase0-render-spike.md](benchmarks/phase0-render-spike.md) | `layout/test/pack.test.ts` (hand-computed reference, 150 randomized trees, order independence, 20k plots ≈ 30 ms); `pnpm spike:render` |
| P0.5 Contracts/fixtures | Done | `packages/schema` runtime contracts and semantic validators; generated JSON Schema (`packages/schema/generated/`) and OpenAPI (`docs/api/openapi.json`); handcrafted artifact; Harbor demo repository (12 real commits) with independent expectations; [contracts docs](contracts/) | `schema/test` (34), `test-fixtures/test/handcrafted.test.ts` (23), `analyzer-core/test/first-session.test.ts` (6); `pnpm contracts:check` |

### Gate G0 assessment

| Fundamental question | Answer and evidence |
|---|---|
| Can source be read safely? | Yes. Committed objects only, via an ATLAS-owned Git dir. Armed hooks, filters, textconv, external diff, helpers, aliases and an `ext::` promisor remote never execute, and a control run proves the traps were live. Missing objects are reported, never fetched. |
| Can supported imports be classified correctly? | Yes, for the declared matrix: 39 resolver expectations plus the full Harbor demo match hand-written outcomes, including Node-vs-bundler differences and workspace/alias cases. Non-compiler inferences are labeled. |
| Can the supported size be rendered? | Yes, on the recorded device. 10k and 20k buildings render in 2 draw calls; p95 frame time 17.8 ms (vsync-bound); 271/271 picks correct; heap 22–29 MiB; WebGL-absent and context-loss fallbacks show HTML. |

Open items carried forward (none block G0):

- External egress, DNS and container caps for hosted acquisition: Phase 5, P5.3 (ADR-016 interim limits).
- Render budgets on the plan's reference device class, plus Firefox: P3.6/P6.2.
- ~~Cross-checking generated JSON Schema with an independent validator: P1.1.~~ Done in P1.1 (Ajv 2020).

## Phase 1: reliable ingestion and structural artifacts

| Task | Status | Evidence | Checks |
|---|---|---|---|
| P1.1 Canonical schema package | Done | ID re-derivation for nodes, edges and observations (`verifyIds`); coverage arithmetic (included + excluded + omitted = discovered; supported + opaque = included); `validateArtifactBundle` cross-checks manifest ↔ graphs ↔ history ↔ layout; cumulative byte caps in the loader | `test-fixtures/test/contracts.test.ts` (19): golden canonical hashes, Ajv 2020 validating the generated JSON Schemas, ID tampering, bundle cross-reference corruptions |
| P1.2 Safe committed inventory | Done | `analyzer-core/src/inventory.ts`: canonical UTF-8 byte order, lazily batched blob reads, built-in/repository/CLI exclusions, roles, LFS/binary/encoding/Flow/oversize/source-budget accounting, file limit. Rules in [ADR-017](adr/ADR-017-inventory-scope-and-hierarchy-rules.md) | `analyzer-core/test/inventory.test.ts` (79): 35 adversarial entries with hand-written outcomes, limits, determinism, glob semantics, role classification, config validation |
| P1.3 Package/config discovery | Done | `analyzer-core/src/hierarchy.ts`: root and synthetic packages, pnpm/npm workspace globs with negation, exact folder chains, `declares-package` and `project-reference` edges, config and workspace warnings; ambiguous names never guessed | `analyzer-core/test/hierarchy.test.ts` (7), `analyze.test.ts` (6: Harbor hierarchy, reproducibility, cross-platform golden, partial status) |
| P1.4 Artifact I/O | Done | `packages/artifact`: canonical chunks with fixed-metadata gzip; one bounded loader for Node (`directorySource`) and browsers (`pickedFilesSource` + `DecompressionStream`); atomic staging/backup publication with crash recovery | `artifact/test/artifact.test.ts` (19): round trip, browser path, flipped byte, truncation, missing chunk or manifest, gzip bomb, traversal, foreign major, non-canonical JSON, symlinked chunk, refuse/replace/protect, recovery after a crash at either point |
| P1.5 Minimal CLI | Done | `packages/cli`: `doctor`, `analyze`, `inspect` (terminal city plan from the layout chunk), `verify`; exit codes 0/1/2/64/130; committed-only and sharing notices; `repository-id.json` reuse and `--previous`; `--json` NDJSON | `cli/test/cli.test.ts` (19): no network attempts, `.git` byte-identical before/after, uncommitted file invisible, overwrite/replace/identity, partial exit 2, cancellation 130, usage errors 64, corrupt artifact, Gate G1 fixture through the CLI, real binary |

### Gate G1 assessment

| Requirement | Evidence |
|---|---|
| Correct package/directory/file hierarchy | Hand-written hierarchies for the monorepo fixture (`hierarchy.test.ts`) and Harbor (`analyze.test.ts`, `cli.test.ts`) |
| Explicit omissions for all inventory fixtures | Every one of the 35 fixture entries is included, excluded or omitted with its expected reason, both through the library and through `atlas analyze` + `atlas inspect --json` |
| Artifacts reproducible | Identical chunk hashes across runs and via `--previous`. Golden canonical hashes for the handcrafted artifact and Harbor pass in CI on Windows and Linux |
| Safe to import | The bounded loader rejects every corruption class in plan §16.1 "Artifacts" before any rendering code runs |

The CLI end-to-end suite passes on Windows and Linux in the linked CI run.

![atlas analyze and inspect on the Harbor demo](images/atlas-inspect-harbor.png)

## Phase 2: static analysis, graph and functional viewer

| Task | Status | Evidence | Checks |
|---|---|---|---|
| P2.1 Parser facts | Done | Supported TS/JS imports/declarations/ranges, text and token line counts, per-callable cyclomatic contributions, nested callable isolation, malformed/deep syntax failures | `analyzer-ts/test/extract.test.ts`, `complexity.test.ts`; no partial-AST dependency claims |
| P2.2 Resolver implementation | Done | Compiler host accesses only the indexed virtual tree/config/workspace map; explicit inferred/exact confidence and unresolved reasons | `analyzer-ts/test/resolve.test.ts`; real filesystem/network instrumentation reports zero calls, with an armed filesystem control |
| P2.3 Graph aggregation/queries | Done | Grouped evidence, indexed adjacency, unique degree, package rollups, deterministic iterative SCC/witness, search and bounded reach | `graph/test/graph.test.ts`; 20k-node and 100k-edge internal fixtures (the product's included-file cap remains 10k) |
| P2.4 Metrics/rules | Done | Hand-defined line/complexity/degree metrics; shared rule catalog and authored explanations; source/observation/member evidence | `analyzer-core/test/analyze.test.ts`: Harbor expected imports, degree, one cycle/witness, findings, null history; independent complexity tests |
| P2.5 Parser isolation/cache | Done | Bounded child pool, timeout/process-tree kill, crash/OOM handling, deterministic merge, verified serializable fact caches | `analyzer-core/test/parse-pool.test.ts`; timeout child proven gone; malicious/corrupt cache rejected |
| P2.6 Functional viewer/serve | Done | Tree/search/inspector/dependency/findings/source/deep links; browser-only artifact open; loopback session, Host/Origin and file boundaries | `cli/test/serve.test.ts` (13 security tests), `viewer.e2e.test.ts` (8 browser journeys); browser prerequisites enforced in CI |
| Phase 2 transport gate | Done | Lossless indexed graph format preserving canonical IDs and evidence; legacy imports; separate wire/decoded limits and hashes | [ADR-018](adr/ADR-018-indexed-graph-transport.md); `artifact/test/indexed-graph.test.ts` (15), existing artifact/security fixtures, generated JSON Schema |

### Gate G2 assessment

| Requirement | Evidence |
|---|---|
| Find a file | Keyboard-only search and synchronized tree/inspector browser journey |
| Inspect direct dependencies and limitations | Independent Harbor targets/counts; type/dynamic/external/context labels; keyboard navigation follows real targets |
| Explain a finding | Cycle witness, raw metrics, static edge policy and authored limitations in the findings inspector |
| Functional source/artifact paths | Verified committed source; unattached source remains unavailable; file-picker loading performs no upload |
| Medium analysis and size | [20-run report](benchmarks/phase2-analysis.md), cold fact cache after one warm-up: p50 8.21 s, p95 8.38 s, worst 8.57 s; artifact 2,146,223 bytes (2.05 MiB). Both original targets pass |
| Preserve deterministic/full-ID graph | Exact indexed/plain/browser round trips, canonical hash and semantic validation; no dropped declarations/evidence |
| Complete checks | `pnpm verify` with `ATLAS_REQUIRE_BROWSER_TESTS=1`: 20 test files, 417 tests passed on local Windows and both CI platforms; 2 live-acquisition tests opt out of the main suite and pass in the separate live CI job (41/41). Generated contracts, strict source/test/viewer type checks, build and dependency direction pass |

![Phase 2 browser explorer](images/phase2-overview.png)

Decisions and remaining boundaries: [ADR-019](adr/ADR-019-phase2-static-analysis-and-viewer.md). The production 3D city/accessibility/device budgets remain Phase 3; sampled Git history/churn/hotspots remain Phase 4; hosted egress/container/publication gates remain Phase 5. The functional viewer is not represented as the finished 3D product. Reference-class GPU performance, external 2 GiB hosted enforcement and real-repository coverage remain later measured gates.

Cross-platform verification also corrected two test assumptions: linked-worktree paths are compared after filesystem resolution so Windows short paths and expanded paths identify the same directory; the keyboard-only cycle journey inspects both member files and validates source opening whether the diagnostic subject is selected or another member is selected. Production analysis and viewer behavior are unchanged by these corrections.

## Phase 3: miniature city and synchronized navigation

| Task | Status | Evidence | Checks |
|---|---|---|---|
| P3.1 Production layout | Done | Canonical integer rectangles and seeded styling; layout 1.1 perimeter anchors; stable package colors | Authored gate/routing/metric references, randomized containment/order tests, dense integer anchors and 20k union benchmark |
| P3.2 Instanced renderer | Done | Lazy Three.js owner; shared role geometry, code-line heights, bounded orthographic camera, spatial picking, on-demand frames, explicit disposal | Small/medium/large three-lens and close-up references; actual building pick; context failure; 20 map/3D replacement cycles |
| P3.3 Navigation synchronization | Done | Shared search/tree/city/table/inspector selection; explicit camera focus; validated fragments; retained validation/query worker | Real browser keyboard journeys, rapid search and stale worker results, fragment round trips, disposal/deadline tests |
| P3.4 Lenses and overlays | Done | Structure/complexity/fan-in raw legends; directed typed arcs, package rollups, 200-arc cap/pinning, 50-terminal sampling/promotion and complete HTML lists | Independent incoming/outgoing/type counts, 210-edge hub, external overflow, unknown versus zero, static reach bounds |
| P3.5 Accessibility/responsive | Implementation + automated checks done; manual audit pending | Semantic paged HTML, keyboard controls, 44px targets, 320px reflow, reduced motion, touch pan/pinch, map/context fallback | Zero automated WCAG AA violations; keyboard/canvas-disabled task journeys; native touch events; Firefox functional check; human audit protocol below |
| P3.6 Export/performance | Implementation + local measurements done; device audit pending | Bounded PNG/provenance, LOD, worker-owned queries/indexes, lazy renderer and optimized strict validation | Full 20-run [production report](benchmarks/phase3-city.md), 10 Mbps cold route, joint 10k/100k dense fixture, main + worker heap, disposal; exact reference-device repeat remains pending |

### Gate G3 evidence and unresolved release checks

The [raw report](benchmarks/phase3-city.json) stores individual samples, fixture commits, layout IDs, actual environment, errors and gate flags. It is a full acceptance invocation, rather than a one-run smoke test. Real committed repositories are analyzed and exported, then loaded through the production validation worker and loopback server. No graph mock replaces ingestion. The 10,000-file fixture has 99,975 edges. The medium cold route, post-chunk useful load, search, selection/overlay, camera, draw calls, retained combined JS heap and resource-cycle budgets pass on the recorded GT 730 desktop. The dense interaction/camera traces include one 52ms task. A separate [20-run CPU attribution follow-up](benchmarks/phase3-interaction-profile.json), with fresh imports, recorded no long tasks; no repeated blocking work was identified. The original outlier remains unattributed and is preserved for reference-device review. Startup validation and cloning are included in load times, not that long-task trace.

Heap interpretation is explicit: retained main + owned worker data stays below 300 MiB after collection, while pre-collection allocations can exceed it. This is not a 300 MiB process or startup peak guarantee. [ADR-024](adr/ADR-024-decoded-artifact-capacity.md) documents this capacity tradeoff; native GPU memory/RSS and lower-memory devices need separate measurement. Adjacent historical frames are not loaded in Phase 3 and must be budgeted in Phase 4.

[Phase 3 Windows/Linux CI](https://github.com/urveesh09/project-atlas/actions/runs/38063413034) passes commit `f10edf4`. Local full verification at Phase 3: 24 test files, **450 passing tests**, 2 opted-out live acquisition tests; strict library/test/viewer types, production build, dependency direction and generated contracts all checked. The browser suite includes 18 production journeys; legacy artifact import, cumulative byte limits, independent canonical identity/hash references and worker lifecycle tests remain passing. CI software rendering verifies behavior, not reference-device performance.

![Medium production structure city](images/phase3-3000-structure.png)

![Dense city focused selection and directed relationships](images/phase3-10000-detail.png)

Decisions: [ADR-020](adr/ADR-020-production-city-viewer.md) viewer ownership; [ADR-021](adr/ADR-021-bounded-external-ring.md) perimeter; [ADR-022](adr/ADR-022-canonical-validation-performance.md) byte-preserving optimizations; [ADR-023](adr/ADR-023-retain-validated-query-worker.md) worker handoff; [ADR-024](adr/ADR-024-decoded-artifact-capacity.md) versioned capacity.

### Human/device audit protocol

These checks require human assistive-technology use and hardware not available to the automated suite. Record operator, OS/browser/screen-reader versions, fixture commit and pass/fail evidence; do not mark them done from axe results.

1. With NVDA on Windows/Chromium or VoiceOver/Safari, perform artifact open, search and result selection, tree navigation, file dependency/evidence inspection, finding explanation, source open, lens change, map/table switch, omitted-edge pin and static reach query. Confirm announced names, current selection, loading/limits/errors, focus order and recovery with canvas disabled; check no trap or excessive live announcements.
2. At 200% and 400% zoom/320 CSS pixels, repeat core tasks with keyboard and reduced motion. Tables may scroll inside their own regions; page controls must reflow. Check text, focus, unknown metrics and selected role identification without color.
3. Run `bench-city.mjs --firefox` on the plan's reference integrated-GPU device after a clean build, retaining the complete 20-sample report. Record OS, GPU/driver, browser, DPR, hardware and memory. Inspect startup/pre-collection heap and native GPU/RSS in addition to retained data; profile any >50ms interaction tasks. Keep original latency/frame budgets.
4. Repeat export and context-loss/fallback recovery on that device and inspect all lens/role references. Document findings before G3 release sign-off. History/compare acceptance belongs to Phase 4.

## Phase 4: Git evolution and stable temporal city

| Task | Status | Evidence | Checks |
|---|---|---|---|
| P4.1 Bounded mainline history | Done | Safe batch commit walk/diffs; root, merge, date skew, day/commit and shallow boundaries; explicit unavailable changes | Real Git fixtures plus local security traps; observed/requested window assertions |
| P4.2 Lineage/frame selection | Done | Conservative rename continuity, ambiguous duplicates and delete/recreate; unsampled changes processed; sampled chain indices | Authored history fixtures, rename between frames and clock-skew cases |
| P4.3 Historical graph reuse | Done locally | Shared parser/fact/blob cache; selected graph preserved on historical failures; over-cap frames unavailable; bounded lossless transport | Exact Node/browser frame round trips, hostile deltas/compact runs, per-frame capacity regression; hosted checkpoint recovery remains P5.3 |
| P4.4 Churn/hotspots/co-change | Done | Prior-frame-only churn, fixed HEAD cohort, null/partial metrics, nearest-rank findings and bounded co-change | Independent hand-computed activity, Jaccard, ties/interpolation and no future-churn leakage |
| P4.5 Union layout/compare | Done | Latest-path anchors, identical plots, historical current membership; projected graph/raw metric differences | Coordinate invariance, moved-file memberships, additions/deletions/renames, unavailable metric sides |
| P4.6 History UI | Done locally | Sampled keyboard strip, lazy frames/LRU, tombstones, A/B ghosts/markers, churn/hotspot lenses, history/source/deep links | Nine real-browser history journeys, reduced motion/320px/automated AA; worker replacement and comparison-navigation regressions |

### Gate G4 verification

The independent initial full suite passed 524 tests. Review added worker response isolation, current comparison-B synchronization, request-scoped decoder cache ownership, the three-link delta bound, partial co-change and shared blob-budget regressions, and a regression preventing an over-cap historical frame from being rendered as a shortened snapshot. All 528 local-product tests pass (29 files, two live-acquisition tests opt out); strict types, production build, dependency direction and generated contracts pass. [ADR-028](adr/ADR-028-phase4-review-and-cache-ownership.md) records those corrections and the dev.5 identity/golden update.

Performance evidence: [historical analysis report](benchmarks/phase4-history.md) and [snapshot-change/combined-heap report](benchmarks/phase4-history-viewer.md). The dev.5 artifact is 4,924,526 bytes (4.70 MiB), within the 5 MiB target. Cached snapshot changes pass at 135.5 ms p95 across 20 samples; four retained main/worker sweeps stay at 208.38–208.71 MiB and two non-HEAD frames compared retain 226.41 MiB, below 300 MiB. Cold first visits reach 11.29 seconds; pre-collection combined allocations reach 657.34 MiB. These are explicit costs, not hidden by cached or retained measurements.

The [earlier transport report](benchmarks/phase4-history-precompact.md) failed size. The [contended timing batch](benchmarks/phase4-history-contended.md) passes size but fails latency at 101.75 s p95; full verification overlapped two runs. Both are preserved. The final unloaded 20-run dev.5 repeat passes: p50 **68.82 s**, p95 **69.59 s**, maximum **69.59 s**, against 90 seconds. No local tests or viewer profiling competed with that batch. Reports record actual hardware, fixture identities and individual samples; exact reference-device performance remains a release audit.

[Phase 4 Windows/Linux CI](https://github.com/urveesh09/project-atlas/actions/runs/38076541930) passes implementation commit `995acb3`, including live acquisition and the software-rendering check. The full local verification also exercised the separately committed Phase 5 foundation below.

All four local pillars are implemented. Historical omission/window/anchor semantics are visible; missing history never becomes a measured zero. The selected graph is an in-memory local checkpoint and local output publication is atomic. Durable recovery of a crashed hosted sandbox remains P5.3 and is not claimed by the local implementation.

Decisions: [ADR-025](adr/ADR-025-history-semantics.md), [ADR-026](adr/ADR-026-frame-delta-and-compact-transports.md), [ADR-027](adr/ADR-027-viewer-frames-and-history-ui.md), [ADR-028](adr/ADR-028-phase4-review-and-cache-ownership.md). Human assistive-technology and reference-hardware audits remain release checks; the protocol above extends to timeline, tombstone and A/B comparison tasks. Runtime tracing remains fully deferred.

![History comparison on fixed plots](images/phase4-compare.png)

## Phase 5: hosted public GitHub service

The hosted service is implemented end to end. Analysis uses the same analyzer, contracts and viewer as the local route, and the mandatory hosted security gates pass on a real Linux container engine.

| Task | Status | Evidence | Checks |
|---|---|---|---|
| P5.1 API admission and auth | Done | Exact GitHub-root validation; numeric identity, visibility and commit ancestry through the pinned, budgeted client; sessions and one-time hashed capabilities; idempotency (200 on a completed replay); quotas; queue position; `createdAt` | 21 admission integrations on PostgreSQL; live pinned-client checks |
| P5.2 Queue and worker leases | Done | Database fencing (ADR-029), wired to the coordinator: 1 s cancellation poll, 10 s heartbeats, deadline stop, fenced completion, one retry, scratch sweeper | Queue races; coordinator cancellation at all four stages; crash and retry; cancellation winning over publication |
| P5.3 Isolated acquisition and analysis | Done | Broker, acquisition and analysis containers from one pinned image; DNS-pinned CONNECT broker with byte budget; framed untrusted output with independent verification; durable HEAD checkpoint and PARTIAL fallback; reconciliation | Sentinel, network-isolation, lazy-fetch, live-broker and resource gates (ADR-030/031); 55 egress unit checks |
| P5.4 Publication and storage | Done | Private filesystem and S3 (SigV4) stores; uploads before rows; read-back verification; content-keyed objects; complete-only cache; per-chunk access checks; 5-minute visibility; revocation, expiry, deletion, purge, garbage collection, reconciliation | Lifecycle suite under a simulated clock; real S3 gateway; token isolation; storage outage |
| P5.5 Hosted flow and SSE | Done | Landing with a public-output notice; job page with stage counts, queue, elapsed time, warnings, cancellation and retry; SSE with polling fallback; immutable `/a/<id>`; owner deletion; lifecycle screens; same validating worker | Six Chromium journeys with WCAG 2.2 AA audits; no token or session in any URL |
| P5.6 Deployment and runbooks | Done (development and rehearsal) | API and sandbox images; compose stack; `_FILE` secrets; least-privilege API and worker roles; trusted-proxy client identity; operator metrics endpoint; `atlas-ops`; [operations guide and runbooks](hosted-operations.md) | HTTP journey under least-privilege roles; [operator rehearsal](benchmarks/phase5-rehearsal.md) |

### Gate G5 assessment

**Same analyzer, contracts and viewer on both routes.** Sandboxes run `analyzeCommit` with the release profile. The browser loads hosted chunks through the validating worker used for local artifacts.

**Mandatory hosted security gates (plan §16.3).**

| Gate | Evidence |
|---|---|
| Repository scripts never run | Committed traps and an armed remote; no sentinel appears |
| No outbound connectivity during analysis | Network `none`; probes; missing-blob lazy fetch fails explicitly with no new objects |
| Adversarial URL, redirect, DNS and path inputs | URL corpus; broker host, port, IP-literal and private-DNS refusals; redirects never followed |
| Enforced caps outside the analyzed process | cgroup memory, PID, CPU and scratch limits, OOM and deadline kills (ADR-030); the API stays a separate process |
| No secrets or source traces | Published bytes, logs and job state carry no author identity, absolute or sandbox path, token or repository name |
| Capability isolation | Capability A cannot delete B; a stale lease cannot publish; a private or revoked repository exposes neither manifest nor chunk |
| Cross-origin and upload safety | Cross-origin mutations rejected; browser-only opening never uploads (Phase 2 test) |
| Scratch, expiry and revocation | Checked under a simulated clock and a crash |

No private-repository support and no automatic local upload were added.

**Fixed during review.**

- A missing blob became a zero-byte opaque file; it is now `LOCAL_OBJECT_MISSING`.
- The pinned TLS socket was bypassed through `agent: false`.
- The pinned client's byte accounting did not count TLS bytes.
- Least-privilege admission was missing `UPDATE` on `sessions`.
- The fixture `safe.directory` exception never reached `upload-pack`.
- Files written by uid 10001 in job directories could not be removed by the worker.
- The operator CLI tripped a Windows exit assertion.

**Operator rehearsal.** The [rehearsal](benchmarks/phase5-rehearsal.md) ran in containers, against S3-compatible storage, with the processes under least-privilege roles. All 11 steps passed:

- **Harbor journey:** 8.1 s end to end, all 12 frames verified through the public routes.
- **Cached reuse:** 1.1 s.
- **Medium repository** (3,252 files, 40 commits): READY in **162.2 s** end to end, against the 300 s deadline. The artifact is 4.69 MiB. Within that run, history analysis took 74.3 s and verification 35.2 s.
- **Operator cancellation:** 5.5 s, with no sandbox left.
- **Worker crash:** SIGKILL during HISTORY. The retry recovered from the checkpoint and the job reached READY.
- **Operator purge:** the publication answers 410.
- **Restore:** revocation was preserved.
- **Rollback guard:** an older binary refuses a newer schema.

The machine was the Windows 11 development host: 12 CPUs, Docker Desktop 29.8.1. These figures are not a reference-hardware capacity claim.

**Fresh-environment demonstration.** The `deploy/compose.yaml` stack ran from newly generated secrets: PostgreSQL, the S3 gateway, the migration job with role provisioning, and the API image. Alongside it, the host worker ran in GitHub mode with Docker sandboxes. It analyzed the real public repository `sindresorhus/is-plain-obj` through the egress broker, and the job reached READY in 10.1 s with its manifest served by the containerized API. The stack was then torn down with its volumes.

An earlier attempt in that session failed closed with `UPSTREAM_RATE_LIMITED`, as designed: the anonymous GitHub quota had been spent by the live tests.

**Verification.** Local `pnpm verify` ran with every gate enabled: PostgreSQL, the S3 gateway, Docker containers, live GitHub and Chromium. **672 tests passed across 39 files, with none skipped.** No sandbox container or network remained afterwards. Without services, the integration suites skip explicitly (78 tests in the hosted packages). The `hosted` CI job runs the gated suites on Linux.

**Still release work (P6).** G5's controls all pass in the development and CI environments. Public launch remains open:

- deploying the service on operator infrastructure (domain, TLS, egress firewall);
- reference-hardware capacity runs;
- human assistive-technology audits.

Decisions: [ADR-029](adr/ADR-029-hosted-admission-and-lease-foundation.md), [ADR-030](adr/ADR-030-offline-container-isolation-spike.md), [ADR-031](adr/ADR-031-hosted-acquisition-and-analysis-pipeline.md), [ADR-032](adr/ADR-032-publication-storage-and-lifecycle.md), [ADR-033](adr/ADR-033-hosted-flow-deployment-and-operations.md).

![Hosted landing page with the public-output notice](images/phase5-landing.png)

## Phase 6: release candidate verification

**G6 remains open.** Candidate tooling and documentation are implemented while final
human/reference-device/operator acceptance remains pending. See the [release audit](release/release-audit.md)
for requirement traceability and owners/evidence needed; [ADR-035](adr/ADR-035-release-candidate-evidence-and-distribution.md)
records the distribution and evidence decisions.

| Task | Status | Deliverables and acceptance boundary |
|---|---|---|
| P6.1 Real-repository validation | Done, including independent Windows/Linux CI repeats | Three immutable numeric-ID/commit pins; 16 source-authored role/import checks; five cold offline repeats each with exact graph/history/layout canonical and wire hashes; verified source-free exports; [coverage report](release/real-repositories.md); CI compares both OS reports and each against the original committed payload digests |
| P6.2 Capacity/reliability | Development-host evidence added; reference matrix open | Separate 20-run medium and near-limit large HEAD reports; existing 20-run medium history/combined worker heap; actual disk/OOM/timeout/lease/storage/container fault gates; exact dense/large temporal and reference-device measurements remain open |
| P6.3 Usability/accessibility | Automated journeys pass; human reviews open | Existing keyboard/axe/motion/fallback tests and packaged screenshot; [five-developer and assistive-review protocol](release/manual-review.md), no fabricated participant results |
| P6.4 Documentation/distribution | Candidate implemented; task dependencies open | Portable archive, every-file SHA-256 inventory, third-party notices; [relocated offline CLI/browser smoke](release/distribution-smoke.md), [install/demo/privacy guide](release/README.md), [candidate notes](release/release-notes.md); independent reviewer reproduction follows P6.2/P6.3 |
| P6.5 Release audit | Prepared; sign-off open | [Requirements/evidence matrix and acceptance backlog](release/release-audit.md); runtime fully deferred; final no-P0/P1 and human/operator sign-off pending |

The Phase 5 follow-up review adds exclusive same-database Docker-engine ownership
before destructive reconciliation, connection-loss fencing, route-revision isolation,
correct browser cleanup and a final acquisition disk-budget measurement. Windows cold
historical loads are awaited independently of cached-frame performance. [ADR-034](adr/ADR-034-phase5-review-and-exclusive-engine-ownership.md)
details these defects and regression evidence. The prior agent's reported 672-test run
above is preserved as handoff evidence; this review records its own final measurements
separately rather than treating that report as verification of later edits.

**Final local verification (2026-10-11):** `pnpm verify` passed **675 tests across 40
files, none skipped**, with PostgreSQL, S3-compatible storage, the freshly rebuilt sandbox
image, offline Docker probe, Chromium and live GitHub gates enabled. Types, production
viewer, dependency direction and all generated contracts passed. Duration: 250.71 s.
No ATLAS sandbox container or network remained. File-level test concurrency is bounded
to two; production budgets and functional deadlines remain unchanged. The first
unbounded attempt's overwrite timeout and its successful isolated rerun are preserved
in ADR-035 rather than hidden. Final cross-platform CI follows the pushed candidate.
After the independent-suite bootstrap correction, the filtered historical deep-link
regression also passed (1 selected test; the other 26 deliberately filtered), and strict
types passed again. The full CI run checks the committed final test setup.

The medium HEAD batch measures **6.81 s p95**, 1.85 MiB compressed, across twenty
cold-fact-cache repeats. [Full report](benchmarks/phase6-head-capacity.md) includes every
sample and identity. The separate [near-limit large HEAD batch](benchmarks/phase6-large-head-capacity.md)
uses 9,992 files/98,500 import statements and does not claim exact dense temporal capacity.
It passes at **20.59 s p95**, 6.07 MiB compressed, against 60 seconds/20 MiB.
The host is Windows/i5-10400/16 GiB, not the four-core/2 GiB reference environment.

The real corpus includes complete is-plain-obj and Vue results and a useful partial
Vite result. Unresolved generated outputs, unsupported glob/URL/nonliteral observations
and invalid fixtures are disclosed. Five-repeat equality proves determinism; independent
examples cover their authored cases only. The portable CLI candidate extracts away
from pnpm links and passes doctor/analyze/verify/inspect plus a loopback-only browser
city/history/search/dependency journey. Registry audit currently returns zero production
advisories, with its dated [scope and limits](release/dependency-audit.md).

The baseline local portable candidate was built from clean source commit `cabcef46a9c9aea933646f83b7f12699c3e32049`.
All six relocated distribution stages passed; 1,488 files verified, archive 8,692,103
bytes, SHA-256 `d7cddeb3a240fe6c886f6a9b4de9957a949e7f9d8ff0ebbf207b54f7b84cf271`.
Its manifest records `workingTreeDirty: false`; the subsequent evidence commit changes
reports/screenshot/status only. CI produces separate independently built OS candidates.

[Candidate CI 38112425011](https://github.com/urveesh09/project-atlas/actions/runs/38112425011)
passed all eight jobs on `7395fb8`: Windows/Linux full verification and relocated CLI
distribution, mandatory hosted gates, live acquisition, render behavior and five cold
corpus repeats on each OS. The independent comparison matches all three complete
canonical/wire chunk digests and all sixteen source-authored examples across platforms.

The subsequent large-history diagnostic found a cache-lifetime capacity issue: a
260.41 s warm-up and a 3,475.10 MiB parent working-set observation. This is not a
20-run p95 measurement. [The preserved diagnostic](benchmarks/phase6-large-history-precache.md)
and [ADR-036](adr/ADR-036-export-base-cache-lifetime.md) record the correction: discard
derived adjacent-base export rows after their last use while retaining HEAD reuse.
The combined correction streams exact canonical equality/hash work, matches one base
table against one target row at a time, defers indexed working rows and retains only
small base-key projections. A [bounded-parent diagnostic](benchmarks/phase6-large-history-bounded-completion.md)
now completes all twelve frames. Its contended 283.94 s observation is not a p95 pass;
whole-job resource/timing acceptance remains open. No format, identity or budget changes.

[CI 38115803254](https://github.com/urveesh09/project-atlas/actions/runs/38115803254)
passes all eight jobs on `aa85c71`, including exact comparisons against the original
committed corpus payloads on both OSes. The complete physical-gate local run passes
**679 checks across forty files, none skipped**, in 471.48 s with one test-file worker.
Prior parallel runs observed one native pipeline-worker exit and one kernel-OOM-probe
timeout; isolated reruns pass all 22 pipeline and seven sandbox checks. [ADR-035](adr/ADR-035-release-candidate-evidence-and-distribution.md)
records serial physical-gate execution without changing assertions/deadlines/budgets.
An additional property-read regression for the streamed writer and **112 targeted
checks across five files**, plus strict types, pass after that full run.

The refreshed local portable candidate binds clean source `277f59301b6b3b6ad0f166de38b644720d04f82c`:
**8,700,660 bytes**, 1,488 inventoried files, SHA-256
`233f2f883c7ab04bec6cb596aa835a18a1d7105272d9524fedd4f471700477c5`.
All six relocated stages pass, including ten documentation-link checks, complete Harbor
history, keyboard dependency inspection and zero browser errors/outbound requests.
The previous candidate's identity remains recorded above as baseline evidence.

**Large-history whole-job capacity passes under enforced job limits.** On `277f593` the
constrained one-shot diagnostic took 329.24 s (cgroup peak 99.1%). [ADR-037](adr/ADR-037-export-hashing-and-structural-proofs.md)
replaces portable ID hashing with native SHA-256 in Node, and matches and proves delta
rows structurally instead of rendering canonical text. Exact equality is kept, and the
real-corpus payloads stay byte-identical (CI [38122325539](https://github.com/urveesh09/project-atlas/actions/runs/38122325539)).
The [20-sample report](benchmarks/phase6-large-history-container.md) ran inside four CPUs,
2 GiB and no swap, with each run as a fresh production-shaped process. All runs were
complete with twelve frames: **p95 202.37 s** against 240 s; peak 1,919,053,824 bytes,
zero OOM events; 10.43 MiB. A first batch that reused one process and parser pool across
samples was OOM-killed in its second run; it is recorded in ADR-037, not hidden. The
host is the development i5-10400, not the reference machine.

### Verification review after the agent-guide handoff (2026-10-11)

All eight CI jobs on `7480ad6` were independently checked. Review found that
`canonicalValueEqual` accepted an object with an ill-formed Unicode property key,
including when comparing it with itself, although the canonical writer rejected it.
Both structural paths now check keys; regressions cover lone high/low surrogates,
nested/shared objects and arrays, while retaining valid Unicode keys. This restores
ADR-037's existing invalid-input contract; it changes no valid artifact semantics or
version. The canonical suite passes all **44 checks**.

The final `pnpm verify` run passes **684 checks across forty files, none skipped**, in
**472.31 s**, with real PostgreSQL, S3-compatible storage, freshly rebuilt analysis
sandboxes, offline Docker probes, Chromium and live GitHub gates enabled. Strict
types, production build, dependency direction and generated contracts also pass.
Five fresh offline repeats for each of is-plain-obj, Vue and Vite pass all sixteen
independent examples and reproduce the exact committed canonical/wire payload digests;
`check-repository-baseline.mjs` passes for all three. Vite's documented partial
coverage remains explicit; determinism does not relabel it complete.
No ATLAS job container or network remains. All 77 Markdown files have valid local
file links. The guides now retain the exact dense/temporal capacity-fixture work in
R6-01, describe the runner's recorded dirty state accurately, and explain stopping
the fixture coordinator before switching hosted modes. These corrections do not
claim G6 sign-off or introduce scope beyond V0.1.

### City visual refresh (2026-10-11)

At the owner's request the 3D city gained seeded decorative architecture
([ADR-038](adr/ADR-038-decorative-city-architecture.md)):
- eight building archetypes with neighbourhood style families per district;
- procedural windows that fade to the exact lens colour at distance;
- kerbed, stepped blocks, header-strip lawns and trees;
- contact shadows, a diorama shoreline and harbour depots for external terminals;
- rounded package labels with a structure-lens swatch.

Height, lens colour, role roofs, picking, selection and overlays keep their meaning;
the city note and PNG metadata say styling carries no data.

Evidence:
- `pnpm verify`: 37 files, 608 tests passed, 80 service-gated skips, including 4 new
  architecture tests.
- `check-repository-baseline.mjs`: exact for is-plain-obj, Vue and Vite.
- Draw calls: 22–31 for Vue and 16–18 for the 10,000-file city.
- Frame p95: 16.7 ms at the refresh cap.
- Leak check: GPU geometry stays constant across 10 forced-growth frame-swap cycles.

Captures: [overview](images/city-refresh-overview.png),
[quarter](images/city-refresh-quarter.png), [close-up](images/city-refresh-closeup.png).
The 20-run [phase 3 report](benchmarks/phase3-city.md) and its reference images predate
this change and need a rerun of `apps/web/scripts/bench-city.mjs`; P3.6's pending
reference-device audit is unchanged.

### City styles (2026-10-11)

At the owner's request the 3D city offers three decorative styles
([ADR-039](adr/ADR-039-city-styles.md)):
- *Modern city*;
- *Eastern fantasy*: pagodas with upturned eaves on every storey, palace halls on marble
  platforms, vermilion package walls, lanterns, pines and cherry blossom;
- *Western fantasy*: battlemented keeps and round towers, half-timber houses, wizard
  towers, stone town walls, oaks and cypresses.

The style is a per-viewer preference in the city toolbar. It is kept in browser storage,
never in URLs or artifacts, and recorded as `cityStyle` in PNG metadata. Eaves, bands and
battlements take a darker shade of their building's lens colour, and storeys repeat at a
fixed spacing, so taller files gain storeys. Height, lens colour, role roofs, picking and
overlays keep their meaning.

Evidence:
- `pnpm verify`: 37 files, 622 tests passed, 80 service-gated skips, including 18
  style-by-style architecture checks.
- `check-repository-baseline.mjs`: exact for all three real repositories.
- Draw calls: 26–38 for Vue in every style.
- 10,000-file city: 18–24 draw calls and every orbit window at the 16.7 ms refresh cap,
  after reducing eave subdivision removed 33–66 ms windows in the Eastern style.
- Leak check: GPU geometry stays constant over ten forced-growth frame cycles per style.
- Switching style keeps the camera and leaves the URL fragment empty.

Captures: Eastern [quarter](images/city-eastern-quarter.png) and
[close-up](images/city-eastern-closeup.png); Western
[quarter](images/city-western-quarter.png) and [close-up](images/city-western-closeup.png).

### Cinematic camera (2026-10-11)

At the owner's request the 3D city now opens in a *Cinematic 3D* perspective view
([ADR-040](adr/ADR-040-cinematic-camera-and-atmosphere.md)):
- damped orbiting, zoom to cursor and ground panning;
- eased glides for reset, focus and north, which reduced motion turns into jumps;
- real sun shadows that re-render only when buildings change;
- a sky dome, an ocean with fog to the horizon, and style-specific distant scenery: Modern
  headlands and skyline; Eastern karst pillars, floating islands and mist; Western alps and
  a hilltop castle.

*Isometric* remains as a camera option for exact height comparison.

Evidence:
- GPU timer queries located the fantasy styles' cost, and indexing parts and capping town
  walls cut it from about 11.5 to 7 ms per frame.
- Vite and the 10,000-file city: all ten 120-frame orbits per style at the 16.7 ms
  refresh cap.
- Draw calls: 19–36.
- Snapshot change including the shadow update: p95 ≤ 50 ms.
- Leak check: GPU resources stay constant over frame-swap cycles.
- `pnpm verify`: 626 tests passed, 80 service-gated skips; the corpus baseline is exact.
- Viewer e2e: 27 tests pass with the cinematic default, inside `pnpm verify` and in seven
  standalone runs (one under concurrent test load). One standalone run straight after
  `pnpm verify` failed three consecutive tests in the miniature-city suite: overlays, PNG
  export and context loss. It is followed up in the next section.

Captures: [Modern](images/city-cinematic-modern.png),
[Eastern](images/city-cinematic-eastern.png),
[Eastern establishing shot](images/city-cinematic-eastern-establish.png),
[Western](images/city-cinematic-western.png),
[Western street](images/city-cinematic-western-street.png).

### Living city (2026-10-11)

At the owner's request the 3D city is perspective-only and more lifelike
([ADR-041](adr/ADR-041-living-city.md); supersedes ADR-040's camera choice):
- a noise-octave sea with Fresnel sky reflection, sun glitter, shallows and beach foam;
- drifting clouds and swaying trees with soft clustered canopies;
- Eastern palace halls on marble terraces, lotus ponds with arched bridges, paifang gates
  and a curved pavilion source roof;
- Western fortresses with turrets, manors with chimneys and shutters, pinnacled chapels and
  gatehouses;
- Modern glass lobbies and rooftop plant.

Ambient motion runs only on hardware GPUs, outside low detail and reduced motion. It runs at
24 fps when idle, pauses when hidden or measured, and yields for 1.5 s to typing and clicking
elsewhere on the page.

Evidence:
- `pnpm verify`: 627 tests passed, 80 service-gated skips; the corpus baseline is exact.
- Vite and the 10,000-file city: all 120-frame orbits per style at the 16.7 ms refresh cap,
  also after 30 s of idle animation.
- Draw calls: 21–42.
- Snapshot change: p95 ≤ 46 ms.
- Search-to-inspector selection: p95 37–38 ms (budget 100 ms).
- Leak check: GPU resources stay constant over frame-swap cycles.

The three-test e2e failure recurred with its log captured. Each time the test's search
selection did not reach the inspector within its 1-second poll, and only in runs during or
straight after `pnpm verify`: three of four such runs, and none of nine other full runs. Three
causes of extra work were removed:
- a selection's overlay re-rendered the whole shadow map;
- ambient frames competed with page input;
- the search box's deferred close could hide results while typing.

Two consecutive `pnpm verify` runs, each followed by a standalone e2e run, then passed in
full. No test, timeout or assertion changed. The evidence supports load-induced latency
rather than a logic fault, but a slow host could still approach the 1-second poll.

CI run 38160443032 then failed `verify (windows-latest)` while its seven other jobs passed:
Harbor's draw calls reached the e2e bound of 30, a history e2e test timed out, and a parallel
analyzer test reported partial coverage. CI renders on the CPU with SwiftShader, and the full
scene starved the parallel tests. Software renderers now get the low-detail scene, and lawns
and markings joined the ground mesh, saving two draw calls on every machine. With those
changes:
- `CI=1 pnpm verify`: 627 tests passed.
- GPU e2e: 27 tests passed.
- SwiftShader draws 23 calls on Vue; the GPU draws 29.

No test bound changed.

The next CI run (38161310296) failed on Ubuntu, and its log located the earlier e2e failures
too. The history test stopped at snapshot 9 after 3 of 7 key presses. The timeline moves focus
synchronously, so lost keys mean focus was taken away. The inspector's deferred focus after
a selection fired late, on a slow frame, and took focus back from wherever the viewer had
moved it. It now applies only if focus has not moved since the selection. The viewer e2e
suite passes 27 of 27 on both the GPU and SwiftShader (`CI=1`).

Captures: Eastern [ponds and pagodas](images/city-living-eastern-ponds.png) and
[establishing shot](images/city-living-eastern-establish.png),
[Western](images/city-living-western.png), [Western castle](images/city-living-western-castle.png),
[Modern](images/city-living-modern.png).

### Grounded city and view controls (2026-10-12)

At the owner's request the city comes closer to realism and is easier to explore on their
GT 730 ([ADR-042](adr/ADR-042-grounded-city-and-view-controls.md)):
- a sky-occlusion field, baked in a worker per frame, darkens street canyons and the foot of
  every wall;
- the paving differs by style: Modern concrete slabs, Eastern flagstones, Western cobbles.
  Streets are asphalt, pitched roofs have tiles, and glass reflects the sky by viewing angle;
- package labels are placed by priority without overlapping, and the selected building is
  named with a leader line;
- a selected building has a ring at its base, and a selection card shows its folder trail;
- Previous and Next camera view, Whole city, Expand (full screen) and Hide tree are added,
  and the stage is taller (54vh).

A frame guard and calibrated resolution keep the frame rate. Timer queries predict a new
stage size's GPU cost; sustained late frames while moving lower the pixel ratio, rarely and
never per frame. Level of detail counts rendered pixels.

Measuring this found that `measureFrames` rendered twice per sample (121 renders for 60
samples). It now renders once, as interaction does. Earlier orbit results, including the
Phase 3 benchmark, were measured the double way and are kept as recorded.

Evidence (GT 730, one render per sample):
- Stage 54vh: every 120-frame orbit is at the 16.7 ms cap in all styles on Vite and on the
  10,000-file city. GPU time is 7.6–10.4 ms default and 9.2–12.4 ms close.
- Expanded 1920 x 1080: every orbit is at the cap. Vite uses pixel ratios 0.59–0.69; the
  10,000-file city runs at full resolution.
- Snapshot change: p95 48–56 ms. Selection: p95 42–43 ms. Draw calls: 18–41.
- `pnpm verify`: 632 passed, 80 service-gated skips.
- Viewer e2e: 27 of 27 on the GPU and with `CI=1` (SwiftShader).

Failures along the way are recorded in the ADR:
- an unmipmapped field gave 20 ms frames;
- a per-frame canvas resize stalled ANGLE;
- one `CI=1` e2e run failed J1: focus reached the inspector a frame too late on SwiftShader.

Inspector focus now moves in the commit that renders it. Two `CI=1` runs and a GPU run
then passed 27 of 27.

CI run [38215086074](https://github.com/urveesh09/project-atlas/actions/runs/38215086074)
failed `verify (windows-latest)` on attempt 1. Its seven other jobs passed. The failing test
was the analyzer's `--no-history` Harbor test, which reported `partial` instead of
`complete`.
- `partial` means a limit was hit or a parse failed. The parse pool's per-file deadline is
  wall-clock time.
- The test ran alongside the 50-second SwiftShader viewer e2e, the same pairing as the load
  failure in run 38160443032.
- Rerunning only the failed job passed, and the run is green.

The evidence points to CPU contention on the shared runner, not a logic fault. It is not
proven, and the analyzer code is untouched. This failure is kept here.

Captures: [labels](images/city-ux-modern-labels.png),
[contact occlusion](images/city-ux-contact-occlusion.png),
[Western cobbles](images/city-ux-western-cobbles.png),
[Eastern flagstones](images/city-ux-eastern-flagstones.png),
[selection card](images/city-ux-selection-card.png), [expanded city](images/city-ux-expanded.png).

### Bake fallback, proportions and materials (2026-10-12)

A review of ADR-042 found that a worker failure after a snapshot change re-baked the first
snapshot, which the stale guard then discarded. Bakes now go through `OcclusionBaker`
([ADR-043](adr/ADR-043-bake-fallback-proportions-and-materials.md)), which always falls back
to the latest pending request. Regression tests drive the reviewer's exact sequence.

The city is also less repetitive:
- square-planned towers may be seeded slabs;
- Modern adds art deco, octagonal and split-slab silhouettes, and Western a bell tower;
- walls between the windows show brick, precast panels, metal fins or ashlar. These change
  brightness only and appear only close up.

Evidence:
- At the stage, every orbit is at the 16.7 ms cap on Vite (all styles) and the
  10,000-file city.
- Expanded to 1080p, 39 of 40 orbits are at the cap. One was at 33 ms on a fifth
  consecutive heavy run; the guard then lowered the ratio.
- Snapshot change: p95 ≤ 65 ms. Selection: p95 ≤ 44 ms.
- `pnpm verify`: 635 passed. Viewer e2e: 27 of 27 on the GPU and with `CI=1`.
- The corpus baseline is exact.

### Release engineering and pilot readiness (2026-10-12)

An external audit judged ATLAS ready for customer discovery and controlled pilots, not yet
for a subscription launch. The owner directed DevOps work on free tooling
([ADR-044](adr/ADR-044-release-engineering-and-pilot-readiness.md),
[release process](release/release-process.md)):
- version-tag releases with a version guard, a draft GitHub release, the CLI archive,
  `SHA256SUMS` and provenance, and GHCR images with SBOM and provenance;
- CodeQL, dependency review, OpenSSF Scorecard and Dependabot proposals;
- a static demo site of the viewer on the verified vuejs/core corpus artifact;
- a security policy, contribution guide, code of conduct, issue forms (including pilot
  feedback), a pull-request checklist and CODEOWNERS.

Evidence:
- `actionlint`: 0 errors.
- The version guard refuses development, malformed and mismatched tags.
- The static demo, served below a sub-path as on Pages, opened vuejs/core in Chromium. A
  first attempt failed with `MANIFEST_MISSING`, because the worker resolved the relative
  base; the base is now resolved against the page.

Owner settings are pending: Pages source, private vulnerability reporting, Dependabot alerts
and a `main` ruleset. No release has been tagged.

### Pointer picks, keyboard driving and dependency strokes (2026-10-12)

From the owner's beta demo ([ADR-045](adr/ADR-045-pointer-picks-keyboard-driving-and-dependency-strokes.md)):
- **Clicking a building no longer jumps the page.** The pick kept moving focus to the
  inspector heading, which scrolled the page. Pointer picks now keep focus on the city, and
  the inspector is sticky beside it. The scroll position stayed at 248 before and after a
  click.
- **Keyboard driving.** Click the city, then use the arrows or W A S D to move, Q and E (or
  Shift with left and right) to turn, Shift with up and down to tilt, and + or − to zoom,
  with eased movement. The first speed overshot the island from far away; it is now
  capped.
- **Dependency lines.** They are now 3.4 px strokes with arrowheads at the targets and
  midway. Rings mark connected buildings, and the nearest 16 are named with
  `→`, `←` or `↔`.

Evidence:
- Orbits stay at the 16.7 ms cap, with or without the overlay.
- `pnpm verify`: 635 passed. Viewer e2e: 27 of 27 on the GPU and with `CI=1`.

### Beta 2: security triage and enforced checks (2026-10-13)

An external Beta 1 assessment of `677a19f` found 15 untriaged CodeQL alerts, 48 Scorecard
findings and a `main` ruleset that required neither CI nor a pull request.
[ADR-046](adr/ADR-046-security-triage-and-enforced-checks.md) records a disposition for
every alert.

- **Fixed:**
  - polynomial matching of repository-controlled workspace globs (a real stall risk
    in analysis);
  - quadratic `.git/config` comment stripping;
  - three check-then-read file races.

  Two oracle suites compare the new code with the replaced expressions on 40,000+ random
  inputs.
- **Dismissed with reasons:** dedicated-worker message handlers, the S3 client's
  intended upload, and test or maintainer tooling.
- **Actions pinned:** every workflow action is pinned to a full commit SHA with its
  version, which fixes 43 Scorecard findings.
- **Rules on `main`:** a pull request and nine named checks are required, with no bypass.
  Approvals stay at zero because there is one maintainer. Secret scanning and push
  protection are on. Branches are deleted after merge.

Checks:
- `pnpm verify`: 640 passed, 80 skipped.
- `actionlint`: clean.
- `check-repository-baseline`: exact bytes for all three repositories.

### Beta 2: activation, workspace and release identity (2026-10-13)

[ADR-047](adr/ADR-047-beta-2-activation-workspace-and-release-identity.md) answers the
Beta 1 assessment's first-use findings:
- a guided start whose three tasks name targets derived from the analysis;
- the city on the first screen, with the stage at y = 408 at 1366×768 (was 572) and
  y = 429 on a 390 px phone (was 1326);
- Expand as a full-screen workspace that keeps search, the controls and an evidence panel;
- counts that name their units, and findings split by subject;
- no horizontal overflow at 320 px on the demo build;
- overlap-free 2D map labels;
- one PNG export with its provenance embedded (`iTXt` `atlas.provenance`);
- exact GitHub source links for public analyses;
- version `0.1.0-beta.1`, shown in the viewer.

A user guide, [Analyze your own repository](guides/analyze-your-repository.md), is
linked from the demo.

Checks:
- `pnpm verify`: 648 passed, 80 skipped.
- Viewer end-to-end tests: 30 of 30 on the GPU and with `CI=1`.
- `pnpm verify:distribution`: passed.
- Orbits on the GT 730: p95 16.7–16.8 ms in every style, normal and expanded.

### Beta 2: editions and free parity (2026-10-13)

[ADR-048](adr/ADR-048-editions-and-free-parity.md) records the edition policy:
everything shipped stays free (MIT), a later Team edition adds hosted continuity, and
billing waits for pilot evidence. A dated, sourced
[comparison with CodeCharta](product/editions-and-comparison.md) marks where ATLAS is
behind and orders the catch-up work. This change closes five gaps:
- `.gitignore`-style path highlighting with exact counts;
- saved views with validated import and export;
- per-band legend counts;
- copy image to the clipboard;
- a Share menu.

Checks:
- `pnpm verify`: 657 passed, 80 skipped.
- Viewer end-to-end tests: 33 of 33 on the GPU and with `CI=1`.
- The demo first screen is unchanged: the stage starts at y = 408 at 1366×768.

### Refined controls and icons (2026-10-14)

[ADR-049](adr/ADR-049-refined-controls-and-icons.md) replaces the default-looking controls.
- One token-based style for buttons, selects and fields, with primary, ghost, quiet, accent
  and danger variants.
- Themed select chevrons; switch-style city toggles; menus with turning chevrons and icon
  rows.
- A drawn icon set in place of text glyphs; glass trays for the stage controls.
- It fixes the history dots, which a higher-specificity `.city button` rule had drawn
  inside button boxes.

Checks:
- First-screen measurements are unchanged: the stage starts at y = 408 at 1366×768 and
  y = 429 at 390 px, and at y = 465 at 320 px (was 469). No horizontal overflow in light or
  dark.
- Viewer end-to-end tests: 33 of 33 on the GPU and with `CI=1`.

### Change colouring in Compare (2026-10-14)

[ADR-050](adr/ADR-050-change-colouring-in-compare.md) closes the first catch-up item of
ADR-048.
- While a comparison is ready, the city can be coloured by the signed change of one of six
  metrics from snapshot A to B. It defaults to code lines.
- The bands come from the worker's existing `metricChanges`.
- New files are purple, and a value unknown on either side stays unknown.
- The cards, the file table and the exports show the signed numbers.

It also fixes a layout defect: wider than 1350 px, an open compare panel covered the city,
because an auto grid row shrank to 30 px.

Checks:
- Unit: three tests, including a 400-pair random agreement check per metric against
  `metricDeltas`.
- Viewer end-to-end tests: 33 of 33 on the GPU and with `CI=1`. The compare scenario now
  checks the change legend, the table column, the return to lens colours and the
  no-overlap layout.
- On the vuejs/core demo, snapshots 11 → 12 in code lines: 514 unchanged, 9 more, 4 much
  more and 175 unknown (not TS/JS), 702 files in all.

### Scope: focus and hide (2026-10-14)

[ADR-051](adr/ADR-051-scope-focus-and-hide.md) closes catch-up item 2.
- Focus on a folder or package, and hide paths by pattern.
- Hidden files leave their plots empty, so the layout never reflows.
- Strokes, ghosts, legends and change colours follow the scope. Analysis, search and
  findings still cover everything.
- Saved views store the scope.

Checks:
- Unit: scope and saved-view tests.
- Viewer end-to-end tests: 34 of 34.
- vuejs/core demo, focused on `@vue/runtime-core`: 116 of 702 buildings drawn.

### Metric lenses, bands and built-in views (2026-10-14)

[ADR-052](adr/ADR-052-metric-lenses-bands-and-presets.md) closes catch-up item 3.
- Ten grouped colour lenses: code lines, functions, total complexity, fan-out and lines
  changed join the existing lenses.
- A *Bands* menu with a distribution chart, editable band starts, an even split and a
  reset.
- Seven built-in views. Saved views keep custom bands.
- Height and area stay fixed by design.

Checks:
- Unit: layout lens, band and saved-view tests.
- Viewer end-to-end tests: 35 of 35.

### Annotations and compact menus (2026-10-14)

[ADR-053](adr/ADR-053-annotations-and-compact-menus.md) closes catch-up item 4.
- Six named marker colours with notes on folders and packages. A mark tints its districts
  in 3D and on the map.
- Marked folders are listed in the legend; the card shows the note.
- Notes are kept locally and shared as validated `atlas.notes/1` files.

Two fixes:
- **First screen.** The new menus had pushed the 1366×768 stage to y = 446. Compact
  icon-and-badge summaries restore y = 408.
- **Contrast.** A primary button inside the city showed text at 2.27:1, caught by axe; the
  global button reset now has no specificity.

Checks:
- Viewer end-to-end tests: 36 of 36 on the GPU and with `CI=1`.
- `pnpm verify`: 676 passed.

### Package dependency view (2026-10-14)

[ADR-054](adr/ADR-054-package-dependency-view.md) closes catch-up item 5.
- A *Package graph* view: packages in layers above their dependencies, with cycles found
  and edges that close a cycle flagged.
- Wide layers wrap onto further rows; selecting a package dims what is unrelated.
- A complete table and keyboard-selectable boxes.

Checks:
- Unit: 150 random graphs checked against the layout invariants.
- Viewer end-to-end tests: 37 of 37.
- vuejs/core demo: 18 packages, 57 dependencies between them, 3 layers, and one 11-package
  cycle.

### 3D-print export (2026-10-14)

[ADR-055](adr/ADR-055-3d-print-export.md) closes catch-up item 7.
- The city exports as a coloured 3MF and as an STL.
- The model holds only data: a base, district plinths, and one box per file at its
  on-screen height.

Checks:
- Unit tests, and viewer end-to-end tests at 38 of 38.
- On the vuejs/core demo, trimesh reads 804 closed shells.
- lib3mf 2.5.0 reads the 3MF in strict mode with no warnings: 10 colours, every triangle
  coloured.

### Python support, part 1: syntax facts (2026-10-14)

[ADR-056](adr/ADR-056-python-support-design-and-facts.md) records the owner's direction:
Python as deep as TS/JS, with no regression. It adds `@atlas/analyzer-py`.
- **Parser.** The tree-sitter Python grammar 0.25.0, vendored as WASM with its hash, run by
  `web-tree-sitter` 0.25.10.
- **Facts.** The same records as TS/JS: imports by kind (type-only, re-export, dynamic,
  guarded), declarations, code lines and per-callable complexity.
- **Not yet wired.** The analyzer pipeline does not use the adapter yet, so artifacts are
  unchanged and the baseline stays exact.

Check: a CPython `ast`/`tokenize` oracle over the 1,848-file standard library of
CPython 3.14.5. Of 1,841 files parsed by both, 0 mismatch in imports, declarations,
complexity or code lines. 3 files (0.16 %) use syntax newer than the grammar and are
reported as parse failures.

Next: resolution (ADR-057), then integration with the contract and version change.
That step was planned as ADR-058 and landed as
[ADR-060](adr/ADR-060-python-integration.md).

### Python support, part 2: resolution (2026-10-14)

[ADR-057](adr/ADR-057-python-resolution.md) adds Python projects and import resolution to
`@atlas/analyzer-py`.
- **Projects.** From `pyproject.toml` (PEP 621, Poetry, uv, PDM, setuptools, Hatch,
  maturin), `setup.cfg`, `setup.py` (literals only), requirements files and Pipfile.
- **Precedence.** Python's `sys.path` order: relative imports, then the standard library
  (unless shadowed by a script directory), import roots, other runtimes, then declared or
  undeclared distributions.
- **Submodules.** Each submodule named in a from-import becomes its own edge.
- **Reasons.** Namespace packages, guarded imports, exclusions, case mismatches and
  beyond-top-level imports each carry a reason.

Wired into the pipeline by ADR-060.

Checks:
- 11 resolution tests on a monorepo fixture.
- CodeQL's three `js/polynomial-redos` findings on manifest parsing (2026-10-15) are fixed
  with single-pass scanning. Before the old patterns were removed, the new scan matched
  them on 400,000 random lines.
- On the installed `pip` (395 files), 1,852 exact internal resolutions. The run found four
  mistakes, now fixed: phantom externals, Python 2 imports, malformed names, and optional
  imports.

### Interface polish (2026-10-15)

[ADR-058](adr/ADR-058-interface-polish.md) is a preserving refresh: same brand, routes, form
fields and legal copy. The city is untouched.
- **Fixed:**
  - the page scrolled on desktop (5,245 px at 1440×900), from 212 hidden tree labels placed
    against the page;
  - the overview silently capped findings at 20 of 132;
  - a wrapped status pill;
  - an unreadable disabled button;
  - a borderless secondary action;
  - a clipped placeholder.
- **Changed:**
  - self-hosted Geist type outside the stage;
  - one radius rule;
  - 12 px help text;
  - one CTA label;
  - no visible dashes;
  - paged finding lists, with explanations one click away in lists.
- **Added:**
  - a real demo-city render on both entry screens;
  - page titles, metadata, a favicon and `<noscript>` text;
  - for the demo, a canonical link, a social card and structured data.

Checks:
- The city stage is byte-identical before and after in 3D and map, dark and light.
- Viewer end-to-end: 39 of 39, also with `CI=1`.
- Two recorded failures, each fixed and retested (both in the ADR):
  - the first attempt failed journey J3;
  - the first push failed the hosted axe audit, because a fade-in was sampled mid-animation;
    motion is now movement only.
- Inspector length: 12,157 → 6,588 px at 1440 px.
- `pnpm verify` (711 tests), the baseline and `verify:distribution` pass.

### Interface second pass (2026-10-15)

[ADR-059](adr/ADR-059-interface-second-pass.md) reviewed the surfaces ADR-058 had not: job
states, the unavailable page, the inspector, compare, map, table, package graph and phone.
- **Fixed:**
  - failed and cancelled jobs ticked all seven stages as done, because the worker clears the
    stage;
  - package nodes overflowed after the font change;
  - inspector tables scrolled sideways;
  - stale "em dash" copy.
- **Changed:**
  - six summary lines read as sentences;
  - a bordered "New analysis" button.

Checks:
- The new hosted assertions fail on the old page (7 done) and pass with the fix: 6 of 6
  hosted journeys, twice.
- Viewer end-to-end: 39 of 39, also with `CI=1`.
- 0 of 18 package nodes overrun.
- The city stage is byte-identical.
- `pnpm verify` (712 tests) and the baseline pass.

### Python support, part 3: integration (2026-10-15)

[ADR-060](adr/ADR-060-python-integration.md) wires the Python adapter into analysis. It is a
deliberate contract change: analyzer `0.1.0-dev.6`, graph `1.1.0`, artifact `1.4.0`.
- **Analysis.** Python files are parsed in the same bounded parser child as TS/JS.
  - Projects become packages with declared PyPI dependencies.
  - Every ADR-057 resolution becomes an import observation.
  - Syntax errors, cycles, complexity, size and fan-in findings apply as for TS/JS.
- **Inventory.** Python roles (pytest names, stubs, manifests, lockfiles). Virtual
  environments, caches and egg metadata are excluded, and `#` generated headers are
  recognized.
- **Identity.** One `nodeIdentityKey` serves the validator and both wire encodings. Before
  it, a PyPI and an npm package of the same name failed validation and delta decoding.
- **Viewer, CLI, service.** Python language chips, ecosystem-aware labels (unchanged for
  TS/JS), PyPI rows, hosted capabilities, and the grammar in the packaged CLI.

Checks:
- `scripts/compare-analysis-paths.mjs` against main's build: Harbor, is-plain-obj,
  vuejs/core and vite have 0 path-level differences. Only the analyzer version and 13 new
  exclusion patterns in the summary change.
- Mixed TS/JS and Python repository: 7 of 7 tests, with expectations written from ADR-057.
- pallets/flask joins the corpus.
  - 12 of 12 authored checks pass.
  - 83 Python files, all parsed. 666 imports, 0 unresolved.
  - 16 undeclared, inferred externals: 10 come from test-time `sys.path` changes, which
    static analysis cannot see.
- The baseline is regenerated for four repositories.
- Remaining Python gaps are documented in the ADRs, for example grammar gaps for 0.16 % of
  CPython 3.14's own files.

### Production M1.1: Node runtime currency (2026-10-16)

Implemented on `prod/m1-node-24.22`, starting from main `e36a873`, following the
[production plan in PR #19](https://github.com/urveesh09/project-atlas/pull/19).
Pending merge and required CI; this is not completion of M1 or P1.
[ADR-061](adr/ADR-061-dependency-currency-october-2026.md) records the decision.

- `.nvmrc`, the workspace engine minimum, both pinned container bases, active setup
  guides and the portable archive's prerequisite text move to Node 24.22.0.
- Doctor reports a non-fatal security-upgrade warning below 24.22.0 within major 24,
  in human and JSON output. Unsupported majors still fail. Eight boundary cases pass,
  and the real CLI was also run on actual 24.15.0 and 24.22.0 installations.
- The dependency lockfile, analyzer/artifact versions and ADR-015 built-in list are
  unchanged. Comparing the new runtime's built-ins (including prefix-only modules)
  found no additions or removals.

Local evidence on Windows 11 / i5-10400 / 16 GiB, checksum-verified Node 24.22.0:

- `pnpm install --frozen-lockfile --offline`: pass with no lockfile change.
- `ATLAS_REQUIRE_BROWSER_TESTS=1 pnpm verify`: 742 passed, 81 service-gated skipped;
  typecheck, viewer build, 15-package dependency direction and six generated contracts
  pass. This includes the 39 normal-mode viewer journeys.
- Four pinned repositories, five offline cold repeats each: deterministic and export
  verified, with all 28 authored facts retained and exact committed canonical/wire
  payloads preserved by `check-repository-baseline.mjs`. The refreshed
  [report](release/real-repositories.md) records Node 24.22.0; only environment, date
  and observed timings change. Vite remains the expected partial result. Image builds
  overlapped some Vite samples; these are correctness repeats, not capacity evidence.
- Both images build: local API image
  `sha256:a460fb2d3ae8fcccc05cd74ee3ead956010fe0d971714456c1e8373e8243bf01`
  and sandbox image
  `sha256:b7e75ebd0669db0c7614ec164fec7b031920b9a1ae43a152e7869b54ae623aba`.
  Both report Node 24.22.0 and uid 10001 with read-only roots, no network, no
  capabilities and no-new-privileges. These are development builds, not release images.
- Viewer journeys with `CI=1` (software rendering): 39/39 pass, in addition to the
  normal run above.
- `pnpm verify:distribution`: all six relocated offline archive stages pass; archive
  11,018,736 bytes, SHA-256
  `f44ea600c5f2de39355dec2ef675ed58b42ca6497344c53963ee0d5759e479b9`.
  This dirty-tree development smoke is evidence for packaging, not a release identity.
  Its generated screenshot/reports are retained locally; the prior release-candidate
  files are not replaced.

G6 and R6-01…R6-07 remain open; hosted faults and cross-OS results require the CI
jobs, and no reference-hardware or human acceptance is inferred.

### Production M1.2: Python manifest parser security (2026-10-16)

`smol-toml` is pinned to 1.9.1, addressing GHSA-r4xh-jqrq-34v2.
[ADR-061](adr/ADR-061-dependency-currency-october-2026.md) records the execution
boundary, release-note review and this batch's owner-approved grouping.

- The admitted 1 MiB, 131,061-key production-path regression fails on 1.8.0 at
  2,504.5356 ms against the authored 1,000 ms limit. On 1.9.1 all four checks pass;
  an identical-input diagnostic measures 148.4486 ms. This is a diagnostic, not a
  capacity percentile ([report](benchmarks/production-toml-security.md)).
- Pyproject and Pipfile inputs beyond the existing bound are rejected; prototype-like
  metadata does not contaminate object prototypes or displace project dependencies.
- Production dependency audit reports zero known advisories on this date. GitHub's
  two existing Dependabot alerts can only close after the fix reaches main.
- Full verification passes: 746 tests, 81 service-gated skips, typecheck, viewer
  build, dependency direction and six unchanged generated contracts. This includes
  39 normal-mode browser journeys.
- Four repositories × five offline cold repeats pass, including Flask's manifests;
  all 28 authored facts and canonical/wire payloads match the committed baseline.
  The report refresh changes only date/timings, without changing graph digests.
- Hosted and cross-OS evidence remains required in the combined PR. Analyzer/artifact
  versions and acceptance limits are unchanged. P1 and G6 remain open.

### Production M1.3a: viewer runtime patches (2026-10-16)

React/React DOM 19.3.1 and React Three Fiber 9.8.2 are pinned exactly. The packager's
missing-license fallback now matches 9.8.2 and its verified upstream tag (ADR-061).

- `pnpm verify`: 746 passed, 81 service-gated skipped; unchanged generated contracts.
- Viewer journeys: 39/39 in normal rendering and 39/39 in CI software rendering.
- Relocated offline CLI smoke: all six stages pass, including license inventory and
  the city dependency screen. Its screenshot was visually inspected; generated
  candidate reports/images were retained locally and restored in the checkout.
- Manual computer-use bootstrap was blocked by the viewer's cross-site guard. No
  policy was weakened and no manual interaction pass is claimed.
- A clean-commit rendering spike and final combined-PR gates follow this checkpoint.

### Production M1.3b: Zod contract validation patch (2026-10-16)

All four workspace Zod declarations move to 4.6.7. `pnpm contracts:check` passes
without regeneration; independent hashes prove all five JSON Schemas and OpenAPI
remain byte-identical. The full verification passes 746 tests (81 service-gated
skips), including the viewer journeys. Four repositories × five offline cold repeats
preserve all 28 authored facts and canonical/wire payloads against the committed
baseline. Final hosted/cross-OS CI remains required.

### Production M1.3c: test and accessibility tooling (2026-10-16)

Vitest 5.0.5, Playwright 1.64.1 and axe 4.14.0 are pinned at every declaration;
Chromium installation was verified through the new Playwright package.

- Full verification: 746 passed, 81 service-gated skips, with the existing WCAG
  audits intact. Typecheck, viewer build, dependency direction and contracts pass.
- Viewer journeys: 39/39 normally and 39/39 under CI software rendering.
- Relocated CLI smoke: all six stages pass; 11,036,676-byte development archive,
  SHA-256 `83e7f1ef4bef71a2d7e9e226c906b6691b51de5d39665961a1907f7d6b2a31d1`.
  Generated candidate reports/images are retained locally and restored in the
  checkout. Fresh dependency/finding screenshots were visually inspected.
- Dependency audit reports zero known advisories on this date.
- Both images build and smoke-test as uid 10001 / Node 24.22.0 with no network,
  read-only roots, no capabilities and no-new-privileges. The sandbox contains
  TOML 1.9.1 and Zod 4.6.7, checked through its deployed dependency resolution.
  Development image IDs (not release identities): API
  `sha256:7beb80debf952f852bc26d46e2d1cf803d0b3e9a0cacb23325dd25b60ae46ed2`;
  sandbox `sha256:5efeaa38bd4c8ca349902ce20e3d04f3b9111fb0190575bd476fdc42e950231f`.
- Final 20-batch rendering spike on clean `071aaab`: 3k/10k/20k each p95 17.8 ms,
  two draw calls, 271/271 picks, both fallbacks and no recorded scenario/picking
  errors ([both clean checkpoint reports](benchmarks/production-viewer-patches.md)).
  This is development-host spike evidence, not reference-device acceptance.
- All four implementation commits pass full verification separately. Required
  combined CI and owner merge remain pending. M1.4/M1.5, P1 and G6 remain open.

### Production M1.2/M1.3 merge and CI closure (2026-10-16)

The owner merged [PR #22](https://github.com/urveesh09/project-atlas/pull/22) as
`42369b5`. All eight CI jobs pass on source head `9983155` in
[run 38847602763, attempt 2](https://github.com/urveesh09/project-atlas/actions/runs/38847602763/attempts/2);
both security jobs pass in
[run 38847602693](https://github.com/urveesh09/project-atlas/actions/runs/38847602693).
The first live acquisition job failed three live cases with `UPSTREAM_RATE_LIMITED`
while its 39 offline cases passed. Its log is retained locally. After waiting, only
that failed job was rerun; no token, test, policy or deadline was changed. The
reported 60-second retry interval is the client's fallback, not proof of GitHub's
actual quota-reset time. This closes the pending CI/merge notes above, not P1/G6.

### Production M1.4: images and CI services (2026-10-16)

- Fresh Debian package indexes include trixie-security; the existing exact sandbox
  Git pin remains the candidate, `1:2.47.3-0+deb13u1`, so no Dockerfile change is needed.
- CI now uses the same official PostgreSQL 17 Alpine multi-arch digest as compose:
  `sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24`.
  Actual PostgreSQL 17.11 starts healthy; 28 database/API checks pass, two
  S3-dependent checks skip. The temporary container is removed after testing.
- All five workflows pass pinned actionlint 1.7.7 offline. The existing sandbox
  image reports the exact Git package and uid 10001 under a read-only root with no
  network, dropped capabilities and no-new-privileges.
- Monthly workflow-image and security-suite Git checks are now documented, including
  what to do when Debian supersedes an exact pin. ADR-061 records the decision.
- Full local verification passes on Node 24.22.0: 746 tests, including all 39 viewer
  journeys; 81 service-gated skips. Typecheck, viewer build, dependency direction
  (15 packages) and contracts (six files) pass. Hosted/cross-OS CI remains pending
  before handoff. M1.5/P1/G6 stay open.

### Production M1.4 merge and CI closure (2026-10-16)

The owner merged [PR #23](https://github.com/urveesh09/project-atlas/pull/23) as
`4a39f66`. All eight [CI jobs, run 38916019567](https://github.com/urveesh09/project-atlas/actions/runs/38916019567)
and both [security jobs, run 38916019530](https://github.com/urveesh09/project-atlas/actions/runs/38916019530)
pass on the first attempt at source `1dea04a`. The hosted image build, physical
isolation/storage/browser gates and Windows/Linux exact corpus equality pass.
This closes the pending M1.4 CI note above; P1 still requires M1.5.

### Production M1.5: Python runtime and provenance (2026-10-16)

Runtime 0.27.1 builds with the unchanged, hash-checked Python 0.25.0 grammar. ABI 15
loads without API changes. Analyzer `0.1.0-dev.7` deliberately changes identities
because parser provenance is part of graph metadata and analysis/cache keys;
artifact schema 1.4.0 remains readable. ADR-062 records this decision.

- Before and after oracle: CPython 3.14.5, 1,848 files; 1,841 parsed by both, three
  only by CPython, zero only by ATLAS, zero fact mismatches. The same known gaps
  remain: `test_annotationlib.py`, `test_compile.py`, `test_type_params.py`.
- The first targeted run passes 48 tests and fails only the expected old Harbor
  hash golden. Its full failure log is retained locally. After comparison against
  a separately built `4a39f66`, only the four version-derived hashes are refreshed;
  the focused golden rerun passes.
- New tests cover installed-runtime provenance, unchanged grammar ABI compatibility
  and UTF-16 ranges around astral text at several lengths and EOF.
- Main-build comparison covers Harbor and all four pinned repositories. Each has
  exactly one reported difference, `summary.analyzerVersion` dev.6 → dev.7; the
  existing comparator exits 1 for that literal metadata difference. A separate
  assertion verifies the entire report contains only these five transitions.
  Graph facts, relationships, findings, metrics, history and layout agree under
  ADR-060's existing normalization; no comparator rule is changed.
- Fresh corpus: four repositories × five offline cold repeats, all 28 authored
  source checks unchanged, every export verified and deterministic. The baseline
  is regenerated deliberately for dev.7; Vite retains expected partial coverage.
- Rebuilt sandbox parser smoke passes offline, read-only, uid 10001, dropped
  capabilities, no-new-privileges, two CPUs and 512 MiB without swap. It reports
  runtime 0.27.1, ABI 15, one authored import and callable complexity 2. This is not
  the full hosted Python journey required by M2.3.
- Full verification: 751 passed, 81 explicitly skipped; the oracle and all 39
  viewer journeys run and pass. Typecheck, viewer build, dependency direction
  (15 packages) and contracts (six files) pass.
- All six relocated CLI stages pass; an additional extracted-archive Python
  analyze/verify/inspect smoke passes with the independently authored import and
  complexity. The dirty-tree development archive is 10,491,077 bytes, SHA-256
  `33914566fc0081776e5dd3280db38eedd39544dc650d565a6a20bcc393f447cf`.
  Historical distribution reports/images are restored; this is not a release selection.
- Dependency audit reports zero known advisories; GitHub has no open Dependabot
  alerts on this date. Required CI follows before handoff.
  [Detailed evidence and initial failures](benchmarks/production-python-runtime.md).
  P1/G6 remain open.

### Production M1.5 merge and CI closure (2026-10-16)

The owner merged [PR #24](https://github.com/urveesh09/project-atlas/pull/24) as
`afbeede`. All eight [CI jobs, run 38919984739](https://github.com/urveesh09/project-atlas/actions/runs/38919984739)
and both [security jobs, run 38919984738](https://github.com/urveesh09/project-atlas/actions/runs/38919984738)
pass on the first attempt at `6f8b1ab`. This closes the pending CI/merge notes above.
Both OSes reproduce the dev.7 baseline and cross-platform comparison passes.
The oracle actually runs on CI: Linux CPython 3.12.3 has 574 files parsed by both,
zero parse disagreements and zero fact mismatches. Windows CPython 3.12.10 has
1,807 files, 1,796 parsed by both, two CPython-only parses, five ATLAS-only parses
and zero fact mismatches. The previous Windows PR #23 log has the exact same counts
and disagreements on the old runtime. The oracle compares facts where both parse;
it does not assert identical acceptance of all syntax fixtures across Python versions.

### Production M2.1: Python documentation alignment (2026-10-16)

- Align the start and repository guides, package description, product comparison,
  capabilities, candidate notes and agent handoff with committed TS/JS and Python
  support, including mixed repositories and `.pyi` declarations. Python analysis
  uses bundled WASM; only development oracle tests require a Python interpreter.
- Name Cython/notebooks as opaque when included and retain static-resolution,
  confidence, exclusion and coverage limitations. Do not claim an installed Python
  environment is examined or repository setup scripts are executed.
- The audit now traces four pinned repositories and 28 authored checks (12 Flask),
  with ADR-056/057/060/062 evidence and explicitly open M2.2/M2.3/M2.6 work.
  Rename only CI's stale acquisition step; required job names stay identical.
- Preserve the master specification, accepted ADRs and past release/benchmark
  records. No analyzer, artifact, dependency pin or generated contract changes.
- Full verification passes on Node 24.22.0: 751 tests, with 81 explicit skips;
  the CPython oracle and 39 viewer journeys run and pass. Typecheck, viewer build,
  dependency direction (15 packages) and contracts (six files) pass.
- All five workflows pass immutable actionlint 1.7.7 offline. The four-repository
  baseline guard passes against the unchanged committed report; this local check
  is not a fresh analysis run. CI repeats the analyses on both OSes.
- All 253 relative links in the ten edited Markdown files resolve, and the
  four-repository/28-check counts agree with committed corpus data.
- All six relocated CLI stages pass, including archive documentation links. The
  dirty-tree development archive is 10,491,192 bytes, SHA-256
  `6bce6fc1c6db920765fb0125a5881cfd995041bfb8a4e5b1a46f59546601e455`.
  Local reports/images are retained separately; historical candidate outputs are
  restored. This is not a selected release. Required CI and owner merge follow;
  M2.2–M2.6 and G6 remain open.

### Production M2.6 prerequisite: correct namespace precedence (2026-10-17)

- The first expanded-corpus run fails its authored `pydantic_graph` import check.
  The raw parser is correct; root lookup prematurely accepts the outer workspace
  directory as a namespace before finding the actual regular package. PEP 420 and
  independent CPython PathFinder checks establish the expected behavior, without
  changing the corpus expectation or executing repository code.
- Search import roots by component: later regular packages/modules supersede
  namespace portions; selected regular parents block discarded children; surviving
  namespace portions compose and preserve imported-name ranges/root provenance.
  In-memory resolution, policy diagnostics and explicit static limitations remain.
- Before the fix, seven of nine new checks fail; the independent CPython oracle
  already passes. Afterward all nine and the existing eleven resolver checks pass.
  A static Pydantic AI diagnostic now resolves the authored package target. It
  parses the same 187 Python files; unresolved observations drop from 64 to one.
  This diagnostic is neither a five-repeat corpus result nor a capacity measurement.
- Deliberately bump analyzer dev.7 → dev.8, invalidating old identities and cache
  keys. Refresh only Harbor's four version-derived golden hashes after proof;
  the original golden mismatch is retained. Artifact/graph formats do not change.
- Fresh existing corpus: four repos × five cold offline repeats, all 28 authored
  checks unchanged, deterministic full payloads and verified exports. Refresh the
  dev.8 baseline deliberately. Main-build comparison against clean `4d0f6ee`
  covers Harbor plus all four repos: exactly five summary-version differences;
  all other normalized facts agree. The comparator's exit 1 is retained, not
  redefined as a byte-preservation pass; its normalization rules are unchanged.
- Full verification passes 760 tests with 81 explicit service-gated skips; the
  CPython oracle and all 39 viewer journeys run. Typecheck, viewer build, dependency
  direction and six generated contracts pass. [ADR-066](adr/ADR-066-python-namespace-precedence.md)
  records the decision. Required CI is tracked in the fix PR. M2.6 corpus expansion
  and M2.2 dev.8 capacity remain separate work; keep the old dev.7 measurements.

### Reproduce verification

```sh
pnpm install --frozen-lockfile
pnpm --filter @atlas/web exec playwright install --with-deps chromium
pnpm verify                                     # typecheck, viewer build, dependencies, contracts, tests
pnpm verify:distribution                        # portable archive + relocated offline CLI/browser check
pnpm fixtures:demo                              # prints a fresh authored Harbor repository path
node scripts/validate-real-repositories.mjs --acquire
node scripts/validate-real-repositories.mjs        # five cold offline repeats per immutable repo
node scripts/bench-analysis.mjs --runs 20 --report-name phase6-head-capacity
node scripts/bench-analysis.mjs --files 9850 --runs 20 --report-name phase6-large-head-capacity
ATLAS_NETWORK_TESTS=1 pnpm exec vitest run packages/ingest/test/github.test.ts
pnpm spike:render                           # writes docs/benchmarks/phase0-render-spike.{md,json}
pnpm build && pnpm atlas analyze <repo> --out ./atlas-output && pnpm atlas inspect ./atlas-output
pnpm atlas serve ./atlas-output --repo <repo>
node scripts/bench-analysis.mjs                  # 20 measured HEAD runs, cold fact cache
pnpm --filter @atlas/web exec playwright install --with-deps firefox
node apps/web/scripts/bench-city.mjs --firefox     # 20 runs each, 20 cold routes; actual recorded GPU
node apps/web/scripts/bench-city.mjs --report-only # regenerate Markdown from retained JSON, no remeasurement
node apps/web/scripts/profile-city.mjs            # 20 CPU attribution runs using the dense exported fixture
node scripts/bench-history.mjs --keep .atlas-tmp/medium-history # 20 complete cold-fact-cache history runs
node apps/web/scripts/bench-history-viewer.mjs --artifact .atlas-tmp/medium-history # cached/first visits and joint heap
# Hosted gates and rehearsal: see docs/hosted-development.md
```

CI sets `ATLAS_REQUIRE_BROWSER_TESTS=1` so missing Chromium/viewer assets are failures rather than skipped journeys. Set `ATLAS_CAPTURE_VIEWER=1` for the browser E2E file to regenerate the three Phase 2 screenshots. PowerShell environment syntax is `$env:ATLAS_REQUIRE_BROWSER_TESTS = '1'`; the inline `VAR=1` examples above use POSIX shell syntax.
