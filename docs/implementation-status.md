# Implementation status

Maintained per plan §20.1. A task is **done** only when its completion evidence exists and its checks pass.

**Current milestone:** Phase 4 local implementation and measured G4 checks pass, including cross-platform CI and the unloaded 20-run history repeat. Phase 5 admission/queue/isolation foundations are implemented below. Human screen-reader and exact reference-device release audits remain open; runtime instrumentation remains deferred.

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

## Phase 5: hosted service foundation

Phase 5 development has started. This is a loopback development control plane plus an independently tested offline container policy. No hosted analyzer coordinator or public artifact publication is enabled.

| Task | Status | Implemented evidence | Remaining completion boundary |
|---|---|---|---|
| P5.1 API admission/auth | Foundation implemented | Exact GitHub-root validation/normalization, strict request/response contracts, sessions, one-time hashed capabilities, idempotency and transactional quotas; generated session OpenAPI route | Upstream numeric identity/visibility resolution and cache reuse |
| P5.2 Queue/leases | Database implementation complete; coordinator pending | Additive checksummed migration, concurrent SKIP LOCKED claims, DB-time heartbeat/generation fences, cancellation, bounded events/SSE replay, one retry within original deadline; time rechecked before transaction commit | Actual acquisition/analysis orchestration, container termination on lost leases and cancellation |
| P5.3 Isolation | Offline container spike passes | Real non-root/read-only/no-network cgroups, CPU/memory/PID/scratch enforcement, OOM/ENOSPC/PID faults and actual container/child cleanup | DNS-pinned acquisition broker, final analyzer image/object boundary, egress byte limits, repository sentinels, durable HEAD checkpoint and stage orchestration |
| P5.4 Publication/storage | Pending | Private publication/object schema reserved; public routes return 503 | Validated private object storage, lease-fenced publication, cache ownership, visibility/expiry/revocation access gates and purge |
| P5.5 Hosted flow | Pending | Management status/events/cancel API foundation | Landing/submission stages, reconnect/poll/cancel browser flows, immutable result URLs and existing viewer integration |
| P5.6 Deploy/runbooks | Partial development documentation | [Dedicated database/container checks and recovery notes](hosted-development.md); required PostgreSQL/Docker CI job | Compose/deployment definitions, trusted proxy identity boundary, secrets/TLS/roles/backups and operator rehearsals |

Local final full verification passes **566 tests across 32 files**. The 31 admission/queue checks include 29 integrations against actual PostgreSQL 17 and two cryptographic unit checks. The seven sandbox checks include five actual Docker Engine 29.8.1 integrations and two policy checks. The two separately gated live-acquisition tests opt out locally and pass in their separate CI job. Strict source/test/viewer types, production build, generated contracts and dependency direction pass. Dedicated hosted CI requires the real database and containers; ordinary matrix runs explicitly opt out of integration checks when those runtimes are absent. [Final Windows/Linux/database/container/acquisition/render CI](https://github.com/urveesh09/project-atlas/actions/runs/38078215851) passes `34866b2`, including the shared UUID-header contract and all 38 hosted-foundation checks. Subsequent CI-evidence edits are documentation only.

Decisions: [ADR-029](adr/ADR-029-hosted-admission-and-lease-foundation.md) and [ADR-030](adr/ADR-030-offline-container-isolation-spike.md). **G5 remains open.** The runtime fifth pillar remains deferred.

## How to reproduce the evidence

```sh
pnpm install --frozen-lockfile
pnpm --filter @atlas/web exec playwright install --with-deps chromium
pnpm verify                                     # typecheck, viewer build, dependencies, contracts, tests
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
```

CI sets `ATLAS_REQUIRE_BROWSER_TESTS=1` so missing Chromium/viewer assets are failures rather than skipped journeys. Set `ATLAS_CAPTURE_VIEWER=1` for the browser E2E file to regenerate the three Phase 2 screenshots. PowerShell environment syntax is `$env:ATLAS_REQUIRE_BROWSER_TESTS = '1'`; the inline `VAR=1` examples above use POSIX shell syntax.
