# Implementation status

Maintained per plan §20.1. A task is **done** only when its completion evidence exists and its checks pass.

**Current milestone:** M1 complete (Gate G1 passed locally on Windows, 10 October 2026; Linux confirmation pending the first CI run). **Next task:** P2.1 Parser facts.

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
| Artifacts reproducible | Identical chunk hashes across runs and via `--previous`. Golden canonical hashes for the handcrafted artifact and Harbor are asserted in CI on Windows and Linux; Linux confirmation needs the first CI run, which is pending until the repository is pushed |
| Safe to import | The bounded loader rejects every corruption class in plan §16.1 "Artifacts" before any rendering code runs |

Carried forward: the CLI end-to-end suite has run on Windows; the Linux run arrives with CI.

![atlas analyze and inspect on the Harbor demo](images/atlas-inspect-harbor.png)

## How to reproduce the evidence

```sh
pnpm install --frozen-lockfile
pnpm verify                                     # typecheck, dependency direction, contracts, tests
ATLAS_NETWORK_TESTS=1 pnpm exec vitest run packages/ingest/test/github.test.ts
pnpm spike:render                           # writes docs/benchmarks/phase0-render-spike.{md,json}
pnpm build && pnpm atlas analyze <repo> --out ./atlas-output && pnpm atlas inspect ./atlas-output
```
