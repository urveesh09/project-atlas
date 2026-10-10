# ATLAS: your codebase as a city

ATLAS turns the committed contents of a TypeScript/JavaScript repository into a navigable, explainable miniature city:

- packages become districts, folders become blocks and files become buildings;
- static imports are an overlay you can inspect;
- diagnostics and hotspots carry their evidence;
- a bounded Git history lets you scrub and compare snapshots without the city reshuffling.

Every visual encoding has a legend, every finding has evidence, and every gap in the analysis is shown as coverage.

> **Status:** Phase 0 complete (milestone M0). The contracts, safe Git reading, the TypeScript resolver and the rendering approach are proven with tests and recorded evidence. There is no end-user CLI or viewer yet; see [implementation status](docs/implementation-status.md).

## What V0.1 will do

| Pillar | Capability |
|---|---|
| Structure & navigation | Packages and directories as nested districts; search, tree, breadcrumbs, inspector, source links |
| Dependencies | Directed static file imports/re-exports with evidence ranges and confidence; external package perimeter; static cycles |
| Diagnostics & hotspots | Parse errors, unresolved imports, cycles, complexity, size, fan-in and change-concentration findings, each explainable from raw metrics |
| Git evolution | Bounded first-parent history, renames and lineage, sampled snapshots, A/B compare on fixed plots |

It runs two ways: a local CLI (`atlas analyze`, then `atlas serve`) that never uploads anything, and a hosted service for public GitHub repositories. Runtime tracing is explicitly out of scope ([ADR-012](docs/adr/ADR-012-runtime-pillar-deferred-in-full.md)).

## Safety model in one paragraph

Repository contents are data, never instructions. ATLAS reads committed Git objects through an ATLAS-generated Git directory with a scrubbed environment. It never checks out, installs, builds or runs hooks, filters, helpers or repository configuration, and analysis has no network access. These properties are tested: the trap suite arms every Git execution hook and proves none fire ([ADR-016](docs/adr/ADR-016-safe-git-acquisition-spike-results.md)).

## Developing

Prerequisites: Node.js 24.15.0, pnpm 10.34.6 and Git ≥ 2.38 ([toolchain](docs/toolchain.md)).

```sh
pnpm install
pnpm verify              # typecheck + dependency direction + contract drift + tests
pnpm test:watch
pnpm --filter @atlas/web dev   # viewer shell and the instancing spike at /spike.html
```

| Command | Purpose |
|---|---|
| `pnpm build` | Compile all library packages (`tsc -b`) |
| `pnpm typecheck` | Build, then type-check tests and the viewer |
| `pnpm check:deps` | Enforce the package dependency direction and runtime-deferral ban |
| `pnpm contracts:generate` / `contracts:check` | Regenerate or verify JSON Schema and OpenAPI from the runtime schemas |
| `pnpm spike:render` | Measure the WebGL instancing spike in Chromium |
| `ATLAS_NETWORK_TESTS=1 pnpm exec vitest run packages/ingest/test/github.test.ts` | Live GitHub acquisition spike |

## Repository layout

```text
apps/web/                 shared local/hosted viewer (React, Vite, React Three Fiber)
apps/api/                 hosted HTTP surface (Phase 5)
apps/worker/              sandbox coordinator and publication (Phase 5)
packages/schema/          canonical contracts, IDs, canonical JSON, validators, generated JSON Schema
packages/ingest/          sanitized local Git reader, GitHub admission and filtered acquisition
packages/analyzer-ts/     TS/JS syntax facts and virtual-filesystem module resolution
packages/analyzer-core/   analysis pipeline (Phase 1–2)
packages/graph/           aggregation, SCCs, queries (Phase 2)
packages/history/         first-parent history and lineage (Phase 4)
packages/layout/          deterministic integer city layout
packages/artifact/        artifact serialization and import (Phase 1)
packages/cli/             the atlas command (Phase 1–2)
packages/test-fixtures/   handcrafted artifact, Git fixture builder, Harbor demo repository
docs/                     master plan, ADRs, contracts, benchmarks, status
```

The dependency direction is enforced in CI: schema is foundational, analyzers never depend on the viewer or API, and the viewer never imports analyzer or ingestion code.

## Documentation

- [V0.1 master plan](docs/plan/PROJECT_ATLAS_V0.1_MASTER_PLAN.md): the specification
- [Implementation status](docs/implementation-status.md): tasks, evidence and the next step
- [Architecture decision records](docs/adr/)
- Contracts: [identity](docs/contracts/identity.md), [metrics](docs/contracts/metrics.md), [capabilities](docs/contracts/capabilities.md), [CLI](docs/contracts/cli.md), [OpenAPI](docs/api/openapi.json), [JSON Schemas](packages/schema/generated/)
- [Phase 0 rendering benchmark](docs/benchmarks/phase0-render-spike.md)

## License

[MIT](LICENSE)
