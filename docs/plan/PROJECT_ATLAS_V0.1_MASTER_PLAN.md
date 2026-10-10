# Project ATLAS — Codebase as a City

## Implementation master plan, V0.1

**Status:** implementation baseline; product and architecture decisions below are resolved unless a numbered spike fails its acceptance gate.  
**Prepared:** 10 October 2026.  
**Audience:** the coding agent and the human reviewing its work.  
**Product choices:** stylized miniature city; equal emphasis on visual appeal and developer usefulness; hybrid local CLI and hosted analysis of public GitHub repositories.  
**Immediate scope:** structure/navigation, dependencies, diagnostics/hotspots, and Git evolution/history.  
**Explicitly deferred:** runtime tracing, instrumentation, execution profiling, live traffic, production telemetry, and any inference of observed runtime behavior.

This document is a specification for building the product, not a claim that the product, benchmarks, or tests already exist. Numeric budgets are release requirements to validate. It consolidates the available prior conversation and the current request; the cached prior assistant responses were reference placeholders, so no undisclosed earlier architecture is assumed.

## Contents

1. [Product contract and boundaries](#1-product-contract-and-boundaries)
2. [Decisions that challenge weak assumptions](#2-decisions-that-challenge-weak-assumptions)
3. [V0.1 user journeys and screens](#3-v01-user-journeys-and-screens)
4. [Supported repositories and operating limits](#4-supported-repositories-and-operating-limits)
5. [System architecture and implementation stack](#5-system-architecture-and-implementation-stack)
6. [Canonical graph and artifact contracts](#6-canonical-graph-and-artifact-contracts)
7. [Identity, snapshots, history, and comparisons](#7-identity-snapshots-history-and-comparisons)
8. [Secure repository ingestion](#8-secure-repository-ingestion)
9. [Analyzer implementation](#9-analyzer-implementation)
10. [Metrics, diagnostics, and hotspot semantics](#10-metrics-diagnostics-and-hotspot-semantics)
11. [Deterministic city generation](#11-deterministic-city-generation)
12. [Frontend behavior and accessibility](#12-frontend-behavior-and-accessibility)
13. [HTTP API and job lifecycle](#13-http-api-and-job-lifecycle)
14. [CLI and local viewer](#14-cli-and-local-viewer)
15. [Performance, reliability, and operations](#15-performance-reliability-and-operations)
16. [Testing and release acceptance gates](#16-testing-and-release-acceptance-gates)
17. [Phased implementation backlog](#17-phased-implementation-backlog)
18. [Risks and mitigations](#18-risks-and-mitigations)
19. [Architecture decision records](#19-architecture-decision-records)
20. [Agent execution and handoff requirements](#20-agent-execution-and-handoff-requirements)
21. [Primary technical references](#21-primary-technical-references)

---

## 1. Product contract and boundaries

### 1.1 Product promise

ATLAS turns the committed contents of a TS/JS repository into a navigable, explainable miniature city. The city is another interface to a canonical repository graph. Every visual encoding has a legend, every finding has evidence, and every incomplete analysis has a visible coverage explanation.

A developer should answer these questions without already knowing the repository:

- Where are the packages, folders, source files, and major entry points?
- What does this file import, and which files directly depend on it?
- Which source files have concentrated complexity, dependency cycles, or recent churn?
- How did the structure and these metrics change across the analyzed Git window?
- What evidence supports the apparent hotspot, and what should I inspect next?

A shareable city should also be immediately recognizable as a small city: coherent neighborhoods, miniature buildings, quiet roads, readable lighting, and an attractive camera composition. Visual delight must come from a clear grammar and polished interaction, not fabricated analytics.

### 1.2 Four pillars to ship

| Pillar | V0.1 capability | Evidence and limitations |
|---|---|---|
| Structure/navigation | Packages and directories as nested neighborhoods; files as buildings; search, tree, breadcrumbs, detail panel, source links | Exact tracked tree for included files; excluded and unsupported files remain counted |
| Dependencies | Directed static file imports/re-exports; external package perimeter; immediate inbound/outbound exploration; static cycle inspection | Import relationships, not call graphs or execution frequency; confidence and unresolved reasons visible |
| Diagnostics/hotspots | Parse errors, unresolved imports, static cycles, complexity outliers, file-size and fan-in outliers, change concentration | Built-in deterministic heuristics; no claim of bugs, vulnerabilities, code quality score, or production criticality |
| Git evolution/history | Bounded first-parent history; file changes and renames; sampled structural snapshots; two-snapshot compare; stable city plots | Window and shallow boundaries disclosed; sampled frames are not a complete replay of every commit |

### 1.3 Runtime is a separate future pillar

Do not implement agents, SDKs, OpenTelemetry collectors, browser instrumentation, execution hooks, request traces, profiling, heat from observed calls, coverage collection, or production ingestion in V0.1. Do not animate imports as if they were requests. A static dependency may be drawn with an arrow; its width represents an explicitly defined static count.

Reserve only a future schema extension namespace, `extensions`, and a documented adapter boundary. No runtime database tables, endpoints, controls, dependencies, or placeholder dashboard are required now.

### 1.4 Included and excluded product features

**Must ship:** local committed-repository analysis; public GitHub analysis; offline artifact opening; deterministic city; functional tree/list fallback; structure and dependency evidence; bounded history; diagnostics; deep links; user-initiated PNG export; portable graph artifact; cancellation, partial results, and limit reporting.

**Optional after all required gates pass:** a second decorative palette, camera bookmarks, a polished onboarding tour, or a read-only embeddable public city. These must not delay the four pillars.

**Outside V0.1:** private hosted repositories, GitHub OAuth for repository access, automatic local upload, working-tree/watch mode, arbitrary Git servers, zip uploads to the hosted service, language servers, symbol-level call graphs, full type checking, AI explanations, natural-language agents, vulnerability scanning, test/coverage execution, automated refactoring, branch DAG visualization, author rankings, collaboration, paid billing, million-file cities, and custom executable analyzers.

### 1.5 Product-level acceptance

With the shipped demo and a supported real repository, a new user can:

1. Get a city through both supported ingestion routes.
2. Find a named file in under 15 seconds after the artifact loads.
3. Inspect its immediate inbound and outbound file dependencies and their evidence.
4. Explain a hotspot using raw metrics rather than its color alone.
5. Compare two analyzed commits, see additions/deletions/renames, and preserve orientation.
6. Complete all five tasks using a keyboard and the HTML tree/table with 3D unavailable.
7. Tell which files, imports, and historical periods were not analyzed.

Run a small usability review with at least five developers unfamiliar with the fixture; target at least four successful completions per task without coaching. Record outcomes and fix recurring failures. This is a formative release gate, not a statistically representative study.

## 2. Decisions that challenge weak assumptions

| Tempting assumption | Why it is weak | Resolved V0.1 decision |
|---|---|---|
| Every function should be a building | Huge symbol counts, unstable naming, confusing skyline | Files are buildings; named declarations are inspector/search metadata with a bounded count |
| Import links are runtime traffic | Imports may be type-only, conditional, or unused | Static edges have explicit kinds; no activity or execution claims |
| Tall/red means bad | Size, complexity, centrality, and churn measure different things | Height encodes size; a selected lens encodes one metric or the documented hotspot score |
| Missing `node_modules` means invalid code | No install is allowed; framework aliases and generated outputs may be absent | Distinguish absent context, unsupported resolver, genuine missing local path, and parse failure |
| One global force layout can show architecture | It drifts between revisions and destroys folder familiarity | Hierarchical rectangular districts with deterministic file slots; dependency overlay does not move buildings |
| Historical cities can be laid out independently | Every scrub moves landmarks | One plot plan over the union of selected snapshots, plus explicit lineage matching |
| Stable path IDs solve history | Renames and delete/recreate break path continuity | Snapshot occurrence IDs and bounded-history lineage IDs are different concepts |
| A shallow clone implies a known full history | Parents and blobs may be missing; merges pull many objects | Bounded traversal, acquisition caps, and explicit history coverage; never label truncated history complete |
| Monorepo boundaries follow folders alone | Workspace manifests and TS references contain useful information | Prefer recognized package roots; preserve folder hierarchy inside them; do not claim references are runtime imports |
| Hosting is a serverless request handler | Parsing, Git transfer, and history are long, untrusted workloads | Asynchronous job worker with isolated acquisition and offline analysis stages |
| Public source can be retained forever | Privacy changes, deletion, stale links, and operating cost still matter | Expiring artifacts, revalidation, deletion controls, and no persisted source text |
| An all-language plan should begin with generic parsers | It spreads effort across incompatible resolution semantics | Ship TS/JS adapter first; add languages only through a capability contract |
| A successful parse is equivalent to a correct dependency | Resolution depends on config and ecosystem | Evidence, resolution mode, and confidence accompany each edge; capability matrix constrains promises |

Where accuracy and spectacle conflict, preserve accuracy and use visual polish around it. Where a complete repository exceeds limits, return a deterministic partial analysis with coverage; do not secretly random-sample files.

## 3. V0.1 user journeys and screens

### 3.1 Hosted public repository journey

1. Landing page: one GitHub repository URL field, a clear public-output notice, a demo, and a local CLI route.
2. Accept only a repository-root URL; resolve the default branch to an immutable commit SHA.
3. Show queue position when known and stage progress: validate, acquire, index, analyze, history, layout, publish. Use counts rather than a fabricated overall percentage.
4. Allow cancellation. Preserve the request management token only in the caller's session, never in a share URL.
5. Open the city at an immutable analysis URL. Display repository, abbreviated SHA, analysis scope, elapsed time, and coverage summary.
6. Initial city uses the Structure lens and latest analyzed snapshot. A small legend explains files, packages, height, and static dependency controls.
7. Search/select a file; inspector and tree stay synchronized.
8. Switch to Dependencies, Complexity, Churn, or Hotspots. History controls remain available across lenses.
9. Copy a share link or export a PNG. A share link exposes the analyzed public graph until its expiry; it does not refresh a moving branch automatically.

Initial analysis outputs are public only because the user submitted a public repository and saw this consequence. Do not support uploading local artifacts to this service in V0.1. Local artifact opening in the browser remains browser-only.

### 3.2 Local journey

1. Run `atlas analyze . --out ./atlas-output` in a Git repository.
2. CLI resolves the selected commit and reads tracked Git objects. Working-tree edits and untracked files are not included; print that fact before analysis.
3. CLI writes a validated directory artifact and machine-readable summary, or a useful partial result with exit status 2.
4. Run `atlas serve ./atlas-output`. The bundled viewer opens on loopback using a random session capability.
5. View all four pillars without network access. With `atlas serve ./atlas-output --repo .`, source links open the local viewer's read-only source panel at a file and line; without an attached repository, graph inspection still works and source is unavailable.
6. Export/share the directory artifact manually. Display that graphs reveal paths, package/declaration names, metrics, and commit IDs even though source text is omitted.

### 3.3 Screen inventory

| Screen/state | Required elements |
|---|---|
| Landing | Repository input, demo, CLI instructions, public-output notice, language/limit summary |
| Job | Stage/counts, warning list, cancel, retry guidance, final failure code |
| Explorer | City/map area, tree/search, lens/legend, coverage badge, snapshot strip, inspector, toolbar |
| Inspector | Path/kind, metrics with definitions, dependency tabs, diagnostics with evidence, bounded change list, source action |
| Compare | A/B snapshot selectors, metric delta table, added/deleted/renamed list, ghost plots, clear A-to-B direction |
| Table/map fallback | Same entities, filters, selection, evidence, comparisons, exports; renderer preference remembered locally |
| Expired/deleted | Human explanation, no stale graph, safe new-analysis action |

### 3.4 Demo and sharing requirements

Ship an authored TS/JS demo repository with two workspace packages, a UI folder, a server folder, tests, assets, a barrel, a static import cycle, a changing complex file, and a renamed file. Create actual Git commits for the evolution story. The demo must be generated by the same analyzer as real projects; no special-case graph fabrication.

PNG export includes repository label, commit/range, selected lens legend, ATLAS version, and a partial-coverage mark when relevant. Render on demand at bounded dimensions; do not set permanent `preserveDrawingBuffer` just for export. No default badges implying a repository's quality. Saved views encode validated state, never scripts or arbitrary camera matrices without bounds.

## 4. Supported repositories and operating limits

### 4.1 Language and config capability matrix

| Input | V0.1 treatment |
|---|---|
| `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` | Parse, declarations, imports, complexity, diagnostics, history |
| `.d.ts`, `.d.mts`, `.d.cts` | Declaration role; parse/type relationships; excluded from executable complexity and default hotspot ranking |
| Standard ECMAScript and TS syntax supported by the pinned TypeScript parser | Supported; parser version recorded; unsupported/new syntax yields parse diagnostics |
| Flow syntax, Vue/Svelte single-file components, MDX, CoffeeScript | Opaque file; language unsupported; no fake dependencies |
| JSON, stylesheets, images, Markdown, arbitrary other files | Structural opaque files; resource target when statically imported; byte size and Git changes only |
| `package.json`, npm/pnpm/Yarn workspace declarations | Read JSON plus bounded pnpm YAML workspace patterns; package grouping and declared direct dependencies |
| `tsconfig.json`/`jsconfig.json`, relative `extends`, `paths`, project references | Safe JSONC read through virtual filesystem; supported options and failure reasons recorded |
| Config `extends` from an external package | Not loaded from installed dependencies; mark configuration context incomplete |
| `exports`, `imports`, self-name imports in included workspace packages | Supported subset through TypeScript resolver with virtual workspace mapping; record chosen conditions |
| Webpack/Vite/Babel executable configuration, TS plugins | Never execute; aliases not represented in safe configs remain unresolved/unsupported |
| npm/pnpm/Yarn lockfiles | Structurally represented; lock version/transitive graph parsing deferred |
| npm dependencies outside repository | External package nodes with declared ranges; package subpath preserved in evidence; no source download |
| `node:` and recognized bare Node built-ins | Built-in perimeter nodes using a pinned built-in list, not npm packages |
| Literal dynamic import / `require` | Static candidates; shadowed `require` excluded; dynamic expressions become unresolved observations |
| `require.resolve`, `import.meta.glob`, custom loader macros | Unsupported static constructs; optional warning count, no invented edges |

TypeScript resolution modes have different extension and package behavior; preserve the applicable mode instead of applying a universal extension guess. `paths` helps the compiler resolve a specifier but does not rewrite emitted imports. These distinctions drive the resolver policy. See [TypeScript module reference](https://www.typescriptlang.org/docs/handbook/modules/reference) and [moduleResolution options](https://www.typescriptlang.org/tsconfig/moduleResolution).

### 4.2 Fixed release profile

Use the same defaults locally and hosted. Hosted limits are hard; CLI may lower limits but cannot increase them in V0.1. MiB means 1,048,576 bytes. Cap counters independently; a small compressed download may still be a large expanded object set.

| Resource | Default/hard limit | Behavior on limit |
|---|---|---|
| Ref | Default branch, or explicit full commit SHA | Hosted ref must be accessible from this repository; CLI validates a local commit |
| Enumerated tree entries per snapshot | 100,000 | Abort that snapshot; retain a prior complete snapshot only with explicit partial coverage |
| Included file nodes per snapshot | 10,000 | Include in canonical path-byte order; list/count omitted files with reason |
| Historical union file lineages | 20,000 | Reduce oldest sampled frames before layout, then stop history if still over; never omit HEAD to fit history |
| Source/config blob | 1 MiB each | Opaque oversize node; no parse |
| Total decoded TS/JS/config source at HEAD | 64 MiB | Stop accepting parsable blobs in canonical order; opaque nodes still included |
| Distinct source bytes acquired across all analyzed history | 256 MiB | Stop historical blob expansion; history metadata may survive; coverage records boundary |
| Network bytes during hosted acquisition | 256 MiB total | Kill acquisition, publish HEAD-only if complete; otherwise fail |
| Temporary job filesystem | 1 GiB | Kill process tree and mark resource-limited |
| Worker process memory | 2 GiB total job budget | Isolated child termination; never bring down API |
| Source dependency edges per snapshot | 100,000 aggregate edges | Deterministic truncation with exact omitted observation count |
| Dependency evidence rows | 250,000 per snapshot | Retain aggregate counts; bounded evidence is explicitly marked |
| Exported declarations | 100 per file | Truncation count shown; declaration count metric remains complete if parse completed |
| History lookback | 90 days relative to selected commit's committer timestamp | Disclose requested and observed window |
| First-parent commits | 200, plus one boundary parent where available | Disclose shallow/commit-cap boundary |
| Analyzed structural frames | At most 12, including selected commit | All selected frames listed; no arbitrary slider positions |
| Files changed in one commit for co-change | 50 | Exclude that commit from co-change pairs; still count individual changes |
| Config inheritance | 16 levels; 256 config files; 1 MiB/file | Config warning; default inferred mode if unusable |
| End-to-end worker deadline | 300 seconds | Return complete HEAD with partial history if available; otherwise fail |
| Per-file parsing deadline | 2 seconds | Terminate parser child; opaque failure node |
| Directory nesting | 64 | Flatten display below boundary while retaining canonical paths |
| Export artifact | 128 MiB decoded total (artifact 1.2; revised from 100 MiB by ADR-024), 20 MiB compressed transport | Deterministically reduce history frames; if HEAD still exceeds, fail export with limit details |

Limits may be revised only through a documented ADR and re-run capacity gates. A cap is not a performance promise. Hard timeouts are containment, not analysis completion guarantees. Start with one concurrent job per 2 GiB worker slot and scale slots explicitly.

### 4.3 Coverage is data

For each frame record counts for discovered, included, supported, parsed, parse-failed, oversized, excluded, binary/invalid-encoding, symlink, submodule, and limit-omitted files. Record imports observed/resolved/external/unresolved/unsupported; history commits traversed and frames completed. Never convert absent metrics to zero.

Excluded files remain in coverage and boundary counts, but need not have individual building nodes. Unsupported files within the node budget have opaque buildings. A repository with zero TS/JS files may produce a structure-only city with a prominent language limitation. An empty Git repository has a clear `EMPTY_REPOSITORY` failure.

## 5. System architecture and implementation stack

### 5.1 Components and data flow

```text
Local Git repository -> safe object reader ---------------------+
                                                               |
GitHub root URL -> API -> durable job -> acquisition sandbox ----+-> virtual blob store
                                                                     |
                          offline analyzer -> canonical snapshots/history
                                                                     |
                                      deterministic layout -> artifact validator
                                                                     |
                             local directory OR object storage + manifest
                                                                     |
                                 same browser viewer: 3D / map / tree / table
```

Keep three boundaries real: acquisition can access the permitted GitHub endpoint; analysis cannot access a network; the viewer cannot read arbitrary server or local files.

### 5.2 Chosen implementation stack

- TypeScript for all product packages; strict checks and explicit public contracts.
- Node.js LTS supported at implementation start. Pin the exact runtime, Git, TypeScript parser, and dependencies in the lockfile/toolchain files; do not use floating `latest` in CI or production.
- pnpm workspace, ordinary package scripts, and a single lockfile. No task orchestrator is needed initially.
- TypeScript Compiler API for syntax and compiler-aware resolution through a constrained virtual filesystem. No `tsc --build`, language service, or repository install.
- React + Vite web viewer; Three.js through React Three Fiber for the 3D layer; ordinary semantic HTML for all controls and evidence.
- Zod or equivalent runtime contract library as the single schema definition; generate JSON Schema and OpenAPI from it and verify them in CI.
- Fastify API with REST and server-sent events. No GraphQL or WebSocket requirement.
- PostgreSQL for jobs, ownership/capability hashes, manifests, expiry, and rate-budget coordination. Database-backed queue with `FOR UPDATE SKIP LOCKED`, leases, and transactional state transitions; no Redis dependency in V0.1.
- S3-compatible storage for immutable, compressed artifact chunks. Objects private to origin; short-lived signed retrieval or API streaming after authorization/visibility checks.
- Dedicated container workers, network policy, resource limits, and a narrowly scoped acquisition broker. Do not run arbitrary repository analysis in the API process.
- Vitest for domain contracts/fixtures, Playwright for end-to-end and rendering, axe checks plus manual assistive-technology testing.

Library choices are implementation choices, not claims about the newest available release. Phase 0 locks compatible versions after verification.

### 5.3 Repository package layout

```text
apps/web/                     shared local/hosted viewer
apps/api/                     hosted HTTP surface and job admission
apps/worker/                  sandbox coordinator and artifact publication
packages/schema/              canonical types, validators, migration policy
packages/ingest/               GitHub validation, isolated Git acquisition, local object adapter
packages/analyzer-core/        pipeline, coverage, deterministic merge
packages/analyzer-ts/          parsing, declarations, resolver, complexity
packages/history/              first-parent changes, lineage, frame selection
packages/graph/                aggregation, SCCs, queries, metrics
packages/layout/               integer plots, transforms, overlay routing
packages/artifact/             serialization, content hashes, bounded import/export
packages/cli/                  analyze, inspect, serve, verify
packages/test-fixtures/        authored repositories and adversarial inputs
docs/                         contracts, ADRs, benchmarks, operator/runbook
```

Dependency direction: schema is foundational; analyzer does not depend on web or API; graph consumes schema; layout consumes graph/schema and never parser internals; viewer consumes artifact/schema/layout outputs. Ingestion supplies virtual objects, never a repository-specific browser schema. Avoid a universal services framework; build the TS/JS implementation and extract only genuinely shared interfaces.

### 5.4 Adapter contract

```ts
interface LanguageAdapter {
  id: string; version: string;
  capabilities: readonly ('syntax' | 'imports' | 'declarations' | 'complexity')[];
  supports(path: RepoPath): boolean;
  parse(input: { path: RepoPath; bytes: Uint8Array; parserKey: string }): ParseResult;
  resolve(input: ResolveInput, fs: ReadonlySnapshotFS): ResolveResult;
}
```

`ParseResult` contains plain serializable facts, never live AST objects. A parser child owns ASTs and frees them per file. `ReadonlySnapshotFS` permits only virtual repository reads and virtual workspace mappings; no host fallback, plugin loading, or remote lookup. Future language adapters must pass the same evidence/coverage/identity contract, but may advertise fewer capabilities.

## 6. Canonical graph and artifact contracts

### 6.1 Schema invariants

Use schema version `atlas.graph/1.0.0`, layout version `atlas.layout/1.0.0`, and artifact version `atlas.artifact/1.0.0`. These are contract versions separate from the application version. Unknown major versions are rejected. Optional additive fields may increment minor; consumers ignore unknown optional fields only inside validated extension slots. No implicit migrations of IDs or metric definitions.

All IDs use full lowercase SHA-256 digests with a readable type prefix. Git object IDs retain their native object format and length. JSON uses UTF-8, finite numbers, explicit `null` for unavailable scalar metrics, lexically ordered object keys in canonical hashing, and arrays sorted by documented keys. Runtime validators reject duplicate IDs, dangling references, invalid enums, nonfinite numbers, impossible ranges, and over-limit collections.

### 6.2 Core types

The following is the normative shape; Phase 0 turns it into runtime schemas. Discriminated subtype fields and invariants below must be implemented, not replaced by unrestricted `any` metadata.

```ts
type ID = string;
type RepoPath = string; // relative, '/' separators, validated as section 8 specifies
type Availability = 'complete' | 'partial' | 'unavailable';
type Confidence = 'exact' | 'inferred' | 'heuristic';
type NodeKind = 'repository' | 'package' | 'directory' | 'file'
              | 'external-package' | 'builtin';
type FileRole = 'source' | 'test' | 'declaration' | 'config' | 'asset' | 'opaque';

interface ArtifactManifest {
  artifactVersion: 'atlas.artifact/1.0.0';
  schemaVersion: 'atlas.graph/1.0.0';
  analysisId: ID; analysisKey: ID; repo: RepositoryDescriptor;
  selectedCommit: GitCommitRef;
  analyzer: { version: string; parserVersion: string; gitVersion: string };
  optionsDigest: string; metricDefinitionVersion: 'atlas.metrics/1';
  frames: FrameDescriptor[]; historyChunk: ChunkRef;
  layoutChunk: ChunkRef; chunks: ChunkRef[];
  coverage: AnalysisCoverage;
  createdAt: string; expiresAt: string | null;
  sourceTextIncluded: false;
}
interface RepositoryDescriptor {
  repoId: ID; displayName: string;
  sourceKind: 'local-git' | 'public-github';
  remote: { host: 'github.com'; owner: string; name: string; numericId: string } | null;
  objectFormat: 'sha1' | 'sha256';
}
interface GitCommitRef {
  oid: string; committerTime: string; firstParentOid: string | null;
}
interface FrameDescriptor {
  snapshotId: ID; commit: GitCommitRef; ordinal: number;
  graphChunk: ChunkRef; nodeCount: number; edgeCount: number;
  analysisStatus: Availability; coverage: SnapshotCoverage;
}
interface ChunkRef {
  path: string; sha256: string; uncompressedBytes: number;
  compressedBytes: number; mediaType: 'application/json';
}
interface GraphSnapshot {
  snapshotId: ID; repoId: ID; commitOid: string;
  nodes: GraphNode[]; edges: GraphEdge[];
  importObservations: ImportObservation[];
  diagnostics: Diagnostic[];
  metrics: NodeMetrics[]; coverage: SnapshotCoverage;
}
interface NodeBase {
  id: ID; kind: NodeKind; label: string; parentId: ID | null;
  lineageId: ID | null; // file only; bounded to this history run
}
type GraphNode =
  | (NodeBase & { kind: 'repository' })
  | (NodeBase & { kind: 'package'; path: RepoPath; manifestPath: RepoPath | null;
                 packageName: string | null; workspace: boolean })
  | (NodeBase & { kind: 'directory'; path: RepoPath })
  | (NodeBase & { kind: 'file'; path: RepoPath; blobOid: string; blobSha256: string | null;
                 language: string | null; role: FileRole; byteSize: number;
                 parseStatus: 'parsed' | 'failed' | 'unsupported' | 'skipped';
                 declarations: DeclarationSummary[]; declarationsOmitted: number })
  | (NodeBase & { kind: 'external-package'; ecosystem: 'npm'; packageName: string;
                 declaredRanges: DeclaredRange[] })
  | (NodeBase & { kind: 'builtin'; moduleName: string });
interface DeclaredRange {
  packageNodeId: ID; field: 'dependencies' | 'devDependencies' | 'peerDependencies'
                       | 'optionalDependencies'; range: string;
}
interface SourceRange {
  startOffset: number; endOffset: number; // UTF-16 units, half-open
  startLine: number; startColumn: number; endLine: number; endColumn: number; // 1-based
}
interface DeclarationSummary {
  name: string; kind: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'variable';
  exported: boolean; range: SourceRange;
}
type EdgeKind = 'imports-value' | 'imports-type' | 'reexports-value' | 'reexports-type'
              | 'imports-dynamic-literal' | 'requires-literal' | 'imports-resource'
              | 'declares-package' | 'project-reference';
interface GraphEdge {
  id: ID; sourceId: ID; targetId: ID; kind: EdgeKind;
  confidence: Confidence; observationCount: number;
  evidenceIds: ID[]; evidenceOmitted: number;
}
interface ImportObservation {
  id: ID; sourceId: ID; kind: EdgeKind;
  specifier: string | null; range: SourceRange;
  status: 'resolved-internal' | 'resolved-external' | 'builtin' | 'unresolved'
        | 'unsupported' | 'excluded-target';
  targetId: ID | null;
  reasonCode: string | null; resolverMode: string;
  confidence: Confidence | null;
}
interface Diagnostic {
  id: ID; ruleId: string; ruleVersion: number;
  severity: 'info' | 'warning' | 'error';
  category: 'parse' | 'resolution' | 'structure' | 'complexity' | 'history' | 'coverage';
  subjectIds: ID[]; range: SourceRange | null;
  messageCode: string; parameters: Record<string, string | number>;
  evidenceIds: ID[]; fingerprint: string;
}
interface NodeMetrics {
  nodeId: ID;
  physicalLines: number | null; codeLines: number | null;
  declarationCount: number | null;
  maxCyclomatic: number | null; sumCyclomatic: number | null; callableCount: number | null;
  fanIn: number | null; fanOut: number | null; sccId: ID | null;
  changedCommits: number | null; linesAdded: number | null; linesDeleted: number | null;
  hotspotScore: number | null;
  availability: { syntax: Availability; dependencies: Availability; history: Availability };
}
```

Structure is represented by `parentId`, not duplicated containment edges. Package/project-reference edges do not count toward file dependency fan-in, fan-out, or cycles. All file occurrences have one parent; graph roots/perimeter nodes have null parents. A directory and a package at the same path are represented by the package node as the hierarchy container, avoiding duplicate districts. A synthetic root package handles unclaimed root files.

### 6.3 Edge semantics and aggregation

- Direction is **importer -> imported target**. Incoming means direct consumers of the selected file.
- A graph edge aggregates observations with identical `(sourceId, targetId, kind, confidence)` in one frame; preserve source evidence ranges separately.
- Mixed type/value imports split into their respective observations; one module statement may yield two kinds, but multiple value bindings from that statement count as one value observation.
- Re-export edges keep their kind; `export *` is a direct file dependency, not expanded into edges to every transitive consumer.
- Static unresolved observations have no target edge. Do not create a fictitious missing-file building.
- External package identity is scoped npm package name (`@scope/pkg`, not subpath or range). Distinct importing package manifests retain distinct declared ranges. No claim of installed version or transitive inventory.
- Internal targets excluded from analysis get an `excluded-target` observation with safe path metadata in bounded evidence, not a dangling edge.
- Built-ins are distinct from npm packages. URL imports are unsupported and never fetched.
- Rollups aggregate file edges between packages; show both unique source-target file pair count and observation count. Never confuse a package manifest dependency with an observed import.

### 6.4 Coverage and history contracts

```ts
interface SnapshotCoverage {
  discoveredFiles: number; includedFiles: number; supportedFiles: number; parsedFiles: number;
  parseFailedFiles: number; opaqueFiles: number; excludedFiles: number; omittedFiles: number;
  observedImports: number; internalResolved: number; externalResolved: number;
  builtinResolved: number; unresolved: number; unsupported: number; excludedTargets: number;
  reasons: { code: string; count: number }[];
  limitsHit: string[]; warnings: { code: string; path: RepoPath | null }[];
}
interface AnalysisCoverage {
  head: SnapshotCoverage;
  history: { status: Availability; requestedDays: number; requestedCommitCap: number;
             commitsTraversed: number; framesRequested: number; framesCompleted: number;
             boundary: 'root' | 'days' | 'commit-cap' | 'shallow' | 'resource-cap' | 'none';
             oldestOid: string | null; newestOid: string; renameDetection: Availability;
             lineDiffs: Availability; coChange: Availability };
}
interface HistoryArtifact {
  historyId: ID; frames: { snapshotId: ID; commitOid: string; ordinal: number }[];
  commits: { oid: string; firstParentOid: string | null; committerTime: string;
             changes: FileChange[]; changesAvailability: Availability }[];
  lineages: FileLineage[];
  coChangePairs: CoChangePair[];
}
interface FileChange {
  kind: 'add' | 'modify' | 'delete' | 'rename' | 'type-change';
  oldPath: RepoPath | null; newPath: RepoPath | null;
  oldBlobOid: string | null; newBlobOid: string | null;
  lineageId: ID | null; renameSimilarity: number | null;
  added: number | null; deleted: number | null;
}
interface FileLineage {
  id: ID; anchorCommitOid: string; anchorPath: RepoPath;
  continuity: 'exact-path' | 'git-rename' | 'ambiguous';
  occurrences: { snapshotId: ID; nodeId: ID; path: RepoPath }[];
}
interface CoChangePair {
  aLineageId: ID; bLineageId: ID; togetherCommits: number;
  eligibleUnionCommits: number; jaccard: number;
}
```

Do not export author emails, author ranking, raw commit messages, source snippets, raw configuration content, machine absolute paths, remote credentials, or `.git` content. Exported declaration names and import specifiers are repository metadata and must be covered by the local sharing notice. Bound strings: paths 4,096 UTF-8 bytes, labels/specifiers 1,024, diagnostic parameters 1,024 each, total diagnostic records 50,000 per frame. Validate cumulative bytes as well as counts.

### 6.5 Artifact format and reproducibility

Directory format:

```text
manifest.json
graphs/<snapshot-id>.json.gz
history/history.json.gz
layout/layout.json.gz
summary.json
```

`summary.json` is derived and optional for import. Manifest hashes are over uncompressed canonical JSON; transport lengths/hashes are separately verified where supplied. Gzip uses fixed metadata so canonical exports are reproducible. No HTML or executable code is embedded in the artifact. Browser import selects a directory or the manifest and chunks through file inputs; hosted local-artifact upload is absent.

The reproducible domain payload excludes `analysisId`, wall-clock `createdAt`/`expiresAt`, timings, worker IDs, and management capabilities. `analysisKey` hashes repo identity, immutable commit, normalized options, parser/analyzer/metric versions, and selected history boundary. Snapshot IDs hash repo identity, commit OID, analyzer version, and options digest. Layout hash includes the ordered frame set, lineage map, and layout version. Cache entries with partial history also include the observed acquisition boundary; a partial run must not poison a later complete cache entry.

Browser import validates manifest first, then cumulative compressed/decompressed sizes and chunk hashes in a worker. Reject traversal chunk paths, decompression bombs, foreign schema majors, dangling references, and duplicate chunk names. Keep the import pipeline independent of the renderer.

## 7. Identity, snapshots, history, and comparisons

### 7.1 Identity is deliberately layered

| Identity | Derivation | Guarantee |
|---|---|---|
| Hosted repository | Hash of `github.com` plus GitHub numeric repository ID | Stable across repository rename; forks are distinct |
| Local repository | Generated UUID persisted in the chosen output's `repository-id.json`; explicit `--repo-id` can reuse it | Stable when caller reuses identity; never infer identity from a machine absolute path |
| Snapshot | Hash of repoId, immutable commit OID, analysis options and analyzer version | Same analysis inputs produce same snapshot ID |
| Node occurrence | Hash of snapshotId, kind, and canonical path; perimeter nodes use canonical package/builtin name | Unambiguous inside one snapshot; intentionally changes across snapshots |
| File lineage | Hash of repoId, history boundary commit, birth/anchor commit, original canonical path | Continuity within this bounded history artifact; not a permanent Git truth |
| Import observation | Hash of snapshotId, source occurrence ID, kind, range, specifier | Repeated occurrences remain distinguishable |
| Aggregate edge | Hash of snapshotId, source, target, kind, confidence | Deterministic aggregation |
| Diagnostic fingerprint | Hash of rule/version, lineage when available, stable normalized evidence | Best-effort matching across frames; exact occurrence ID also stored |

Hash inputs use length-prefixed UTF-8 fields or canonical JSON, never ambiguous string concatenation. Sort repository paths by their original validated UTF-8 byte sequence. Preserve case and Unicode code points; do not lowercase or normalize NFC/NFD. Linux case-distinct paths remain distinct on Windows because analysis uses a virtual filesystem, not extracted source paths.

Local determinism is conditional on the same repoId. The first generated UUID is intentionally not reproducible from arbitrary repository contents. `atlas analyze --previous <artifact-dir>` reuses repoId and compatible options, but V0.1 may recompute the artifact fully. Independently generated local cities need not share IDs with the hosted city.

### 7.2 First-parent history contract

Starting at the selected commit, walk first-parent links newest to oldest. Include at most 200 commits whose committer timestamps meet the 90-day window, stopping at the first older commit. Git timestamps need not be monotonic: this is a bounded contiguous mainline window, not a claim to find every commit with a date in range. Preserve parent-chain order, never reorder by timestamp. The selected commit is always included, even if its date is anomalous.

Acquire one additional boundary parent when permitted, so the oldest included commit's change can be computed without extending displayed history. If missing, its changes are unavailable. A root commit is compared to an empty tree. A merge commit is compared only to its first parent; its integrated changes may include work from multiple authors/branches. Label this **mainline changes**, not individual developer work. First-parent and shallow behavior must be explicit; see [Git log documentation](https://git-scm.com/docs/git-log).

For a completed window with `n` commits, select `k=min(requestedSnapshots,n)` structural frames, where requestedSnapshots defaults to 12 and may be lowered by the CLI. For `k>1`, select indices `floor(i*(n-1)/(k-1))`, `i=0..k-1`, in oldest-to-newest chain order; for `k=1`, select HEAD alone. Deduplicate defensively and include HEAD. The requested days/commit caps likewise use normalized CLI values when lowered, within the hard profile ceilings. Use all included commits for change counts where diffs are available; only these selected frames receive full parse/graph/layout state.

If a history frame exceeds limits, record the frame as unavailable and drop it from rendering, retaining its requested commit in coverage. Analyze HEAD first and atomically checkpoint it. Any later resource failure may publish this HEAD-only result plus completed historical frames. Do not publish half a graph frame.

### 7.3 File changes, renames, and lineage

Read NUL-delimited Git tree/diff output. Use trusted Git with external diff and text conversion disabled. Use rename detection at **80% similarity**, copies disabled, a rename candidate limit of 1,000, and a bounded diff timeout. Record the Git version and algorithm options. Binary line counts are unavailable rather than zero. These controls avoid repository-configured diff helpers; see [Git diff documentation](https://git-scm.com/docs/git-diff).

Process all traversed changes oldest to newest, including commits between analyzed frames:

1. For files present at the oldest boundary, allocate anchored lineages using that boundary commit and path.
2. `modify` preserves the active path's lineage.
3. `delete` closes that lineage at that point; `add` creates a new lineage even if the path was used before.
4. An accepted one-to-one Git rename preserves lineage and records old/new path and similarity. A rename+edit is still one lineage.
5. If rename candidates are ambiguous (including multiple identical deleted/added blobs), do not invent continuity: represent add/delete and flag possible rename evidence. Never pick a match only to make the animation prettier.
6. If rename detection times out or is skipped, retain exact-path continuity and record rename coverage partial. No speculative global symbol/content matching is required.
7. A copy creates a new lineage; similarity to another file does not transfer identity.
8. Type changes into a symlink/submodule end the source-file occurrence and are reflected in coverage.

Lineage is bounded to the window. Widening the window or changing rename policy may change IDs. Export this limitation. No Git command can provide an immutable universal file identity.

### 7.4 Comparison contract

Compare any two completed analyzed frames, ordered A -> B even if B is older. Match file occurrences by lineage ID, then exact path only when both artifacts use the same lineage policy and there is no delete/recreate evidence. V0.1 comparisons are inside one artifact; arbitrary cross-artifact comparison is deferred.

Return additions, deletions, renames, modified blob content, file role changes, raw metric deltas, and dependency edge additions/removals projected onto lineages/perimeter identities. Presence changes do not imply parsed changes. A null metric delta remains null, with the unavailable reason. Cycles are recomputed per frame. Parent/group moves and renamed paths are listed even when the building retains its fixed plot.

The compare panel shows interval changes between snapshots and separately the analyzed commit activity within the interval. Activity counts and graph differences answer different questions; a file may change and return to the same content.

### 7.5 Churn and co-change

For each lineage and frame, count available included first-parent changes up to that frame within the fixed artifact window. `changedCommits` counts at most once per commit; pure renames count as structural changes, with line churn zero only when the diff confirms no line changes. `linesAdded`/`linesDeleted` aggregate text numstat data and become partial when a contributing diff is missing. Do not include later commits in an earlier frame's score.

Co-change uses commits with 2..50 changed included source/test lineages that have at least one occurrence in a completed frame. Transient files absent from all sampled frames remain change metadata but do not enter this overlay. Deduplicate lineages per commit, exclude pure rename-only pairs from co-change, and exclude binary/resource-only files. For pair A/B, `jaccard = together / eligibleUnion`; require `together >= 3`. Keep at most 20 partners per file by descending together count, descending Jaccard, then partner lineage ID; merge symmetrically into the union of retained pairs. Exact internal counters may be larger than exported pairs. Describe these as **changed together**, not dependencies or causation.

## 8. Secure repository ingestion

### 8.1 Trust model

Repository contents, filenames, manifests, config, README, Git metadata, and URLs are untrusted data. They must never become agent instructions, shell syntax, build scripts, dynamic modules, HTML, or network destinations. ATLAS itself never asks an LLM to follow repository content. The coding agent must also treat fixtures and downloaded repositories as data.

Attack boundaries include URL parsing/SSRF, Git transport, object parsing, archive/file traversal, config recursion, parser CPU/memory, malformed artifacts, XSS through names, local-server cross-origin requests, and abusive hosted submissions. The hosting API must not be granted source execution or arbitrary outbound access.

### 8.2 Hosted URL admission

Accept `https://github.com/<owner>/<repo>` with an optional trailing slash or `.git` suffix only. Reject userinfo, nonstandard ports, query/fragment, backslashes, encoded separators, control characters, extra path segments, `/tree/...`, alternate domains, IP literals, SSH URLs, `file:`, and other schemes. Owner/repo must be validated simple segments. Do not accept a URL plus a free-form ref; use a separate validated full commit SHA field if requested.

Parse once using the standard URL parser, validate the normalized fields against the raw input policy, then construct fresh GitHub API/Git URLs from the validated owner/name. Resolve repository numeric ID, public visibility, default branch, and full immutable commit SHA. Empty/default-branch-missing repositories receive explicit failure. Cache keys use numeric repository ID and SHA, not user input spelling or a moving branch.

Only permitted GitHub API and HTTPS Git endpoints are reachable by acquisition. Reject repository transfer/redirects initially and ask the caller to use the returned canonical URL; do not silently follow arbitrary redirects. If implementation needs a documented GitHub redirect, allow at most two hops to explicitly allowed hosts, revalidate every destination, never forward credentials to a different host, and test the exact behavior. DNS and connection policy must prevent private, loopback, link-local, multicast, metadata, and IPv4-mapped IPv6 destinations. Preserve TLS hostname checks when pinning a validated destination. Application allowlisting is paired with an egress firewall/proxy; see [OWASP SSRF prevention guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html).

### 8.3 Acquisition implementation

Use a freshly initialized **bare repository** in an isolated temporary directory; no checkout. Fetch only the validated repository/selected commit using HTTPS, shallow depth initially 201, single branch, blob filtering where supported, and no recursive submodules. A shallow merge graph may contain more than 201 commits; network/disk/time caps are authoritative. Traverse the actual first-parent chain to enforce displayed limits.

Prefer filtered acquisition, then fetch only required blob OIDs in bounded batches through the same broker. Acquire HEAD blobs first, run its offline analysis and checkpoint it, then acquire historical blob batches in the separate acquisition sandbox before their corresponding offline analysis. The coordinator may alternate these isolated stages; the parser never gains network access. Do not let analysis-triggered Git lazy fetching bypass the broker. `GIT_NO_LAZY_FETCH=1` where supported and offline network policy enforce this; missing blobs become explicit broker requests, not parser-triggered fetches. If the GitHub server or pinned Git lacks the required filter workflow, Phase 0 may choose a bounded unfiltered bare fetch, still under the same byte/disk caps. Huge repositories can fail gracefully; unlimited full clones are not a fallback.

No repository hooks, submodules, LFS smudge, attribute filters, credential helpers, custom protocols, alternates from untrusted remote data, replace refs, or repository-configured diff drivers may run. LFS pointers are opaque with `LFS_NOT_FETCHED`. Submodules are opaque boundaries with path and bounded target OID, not fetched recursively. Symlinks are not followed.

Launch the trusted Git executable with argument arrays and `shell:false`, no user-controlled executable or option fragments. Set a minimal environment; ignore system/global Git config via explicit empty config files; generate repository config rather than loading downloaded configuration; empty hooks/template directories; disable external diff/textconv, helpers, prompts, proxy inheritance, alternates injection, replace objects, and SSH. Restrict protocols to HTTPS for acquisition and none for offline operations. SHA/path validation is still required; `--` alone is not sufficient for revision arguments. Never print raw stderr containing credentials or authorization headers.

Acquisition broker owns any service credential, uses minimum public-read scope, and never places a token in a Git remote URL or artifact. The analysis container has no service token. Token handling must avoid inherited subprocess environment and process-list leakage. If this boundary cannot be demonstrated, ship the hosted service with anonymous public acquisition and conservative limits until it is corrected.

### 8.4 Local repository adapter

Read the requested committed tree, not the checkout. Git is an explicit CLI prerequisite, diagnosed by `atlas doctor`. Discover normal repositories and linked worktrees through bounded metadata reads. Use an ATLAS-created temporary bare metadata directory with generated config and the validated source object store as a read-only object source; do not run commands using arbitrary local repository config.

Validate source object-store roots and reject object alternates, external object directories, unsupported object formats, or missing promisor objects that would require a remote fetch. Linked worktrees may resolve to their verified common object directory; explicitly test Windows and Unix paths. Repositories requiring alternates/network hydration receive `LOCAL_OBJECT_STORE_UNSUPPORTED` or `LOCAL_OBJECT_MISSING` with remediation to create a normal local clone. Do not secretly fetch, copy huge stores, or mutate `.git`.

Resolve HEAD/ref to a full commit OID before parsing data. CLI permits an existing local ref as a separate validated argument and verifies that it resolves to a commit; hosted accepts only full OIDs/default branch. Never accept arbitrary revision expressions with command-like options. Native object-reading commands must run against the sanitized metadata directory, never an untrusted repository config. Verify Git replacement refs are disabled.

### 8.5 Tree and blob rules

- Enumerate Git trees with NUL framing; preserve original bytes for deterministic sorting.
- Only regular blobs become analyzable content. Never materialize symlinks, device files, hard links, or executable permissions.
- Use virtual paths; deny absolute paths, `..` segments, NUL, backslash ambiguity, unsafe `.git` metadata paths, and invalid UTF-8. Such entries are omitted with a coverage reason; do not reinterpret them as another file.
- Control characters in displayable metadata are escaped; unsupported control-bearing filenames are omitted. Paths remain case-sensitive. Validate that normalization never maps distinct Git paths onto the same identity.
- Decode text as strict UTF-8 with optional BOM. Binary/NUL or invalid encoding is opaque; no silent lossy decoding.
- Built-in exclusions: `.git`, `node_modules`, vendored dependencies, recognized build/output/cache folders, minified bundles, source maps, and generated files indicated by bounded recognized headers. Always report applied patterns. Do not infer arbitrary generated paths only from a filename.
- Apply a V0.1 `atlas.config.json` containing only versioned data: additional exclusion globs. Display overrides were unspecified and are deferred beyond V0.1 until a bounded schema exists (ADR-020); interactive lens/filter controls already cover display choices. Configuration cannot relax security caps, run plugins, redefine metrics, or supply network URLs. Ignore unknown keys with a warning or reject invalid major version.
- `.gitignore` is not the inclusion authority for committed files. The CLI's explicit exclusions and ATLAS defaults define the scope; show this in coverage.

No archive extraction is required by the chosen bare-object design. If a Phase 0 acquisition alternative uses GitHub archives, add an ADR and strict streaming extraction: size/entry caps, path containment, reject links/special entries, no permissions, and no pre-write path escape. Source archive download behavior and redirects are documented by [GitHub repository archive endpoints](https://docs.github.com/en/rest/repos/repos#download-a-repository-archive-tar).

### 8.6 Isolation, retention, and renderer safety

Hosted analysis runs non-root, with read-only runtime filesystem, scratch-only writable mount, no host socket, no cloud metadata route, and network disabled throughout each analysis container's lifetime. The separate acquisition sandbox/broker is the only stage with permitted egress, including bounded historical acquisition after a HEAD checkpoint. Enforce PID, CPU, memory, disk, and deadline limits externally as well as in application counters. Cancellation terminates the complete process group/container and is tested during each stage.

Repository paths, package names, declarations, and specifiers are rendered as escaped text. No raw Markdown/HTML rendering from README or diagnostic messages. Diagnostics use ATLAS-authored message templates and bounded parameters. Source links are constructed from validated host/repository/SHA/path and URL-encoded components; never use repository-supplied URLs. New-window links use appropriate opener isolation.

Destroy temporary source/Git object data after success/failure/cancellation, with a crash-recovery sweeper within one hour. Persist graph artifacts for 7 days after publication. Revalidate public visibility before issuing hosted artifact access and at least daily; revoked/private/deleted repositories cause artifact revocation and purge. GitHub outages fail closed for hosted access after a short bounded visibility cache (at most 5 minutes). Viewer local copies cannot be recalled; the public notice states this consequence.

Management capability permits deletion of the submitted artifact; service administrators have an operational purge path. Deleted/expired API routes return 410 with no graph body. Origin access checks cover every chunk, not only manifest access; storage is private and signed links expire within 5 minutes. CDN/browser headers use `Cache-Control: no-store` for visibility-sensitive API/graph responses. Static app assets may be cached independently.

## 9. Analyzer implementation

### 9.1 Pipeline with deterministic stage boundaries

1. **Validate/acquire:** immutable repository identity, commit, bounded object store, normalized options.
2. **Enumerate:** canonical tracked tree and exclusion coverage; classify files/packages/configs.
3. **Parse HEAD:** bounded parser children produce syntax facts, imports, declarations, complexity, and failures.
4. **Resolve HEAD:** build per-project virtual compiler contexts and resolve observations.
5. **Build graph:** occurrence nodes, parent hierarchy, aggregate edges, diagnostics.
6. **Metrics:** degree sets, SCCs, complexity and size distributions, initial diagnostics.
7. **History:** bounded commit changes, lineage, selected frames; parse/resolve frames using caches.
8. **Temporal metrics:** attach only prior-window change counts to each frame, co-change, compare indexes.
9. **Layout:** union plots and per-frame visual state; no parser data access.
10. **Validate/export:** invariants, deterministic serialization, size checks, atomic publication.

HEAD receives priority so an otherwise useful city survives history limits. Stage outputs are immutable serializable records and coverage. Progress includes total/completed counts when known. Parallel workers may parse files, but final merge always sorts by canonical file/observation keys. Time-dependent behavior cannot affect ordering or metric values except by clearly marked availability boundaries.

### 9.2 TS/JS syntax extraction

Use `createSourceFile` with the appropriate script kind and the pinned TypeScript version. Do not create a full compiler Program or execute emit. Traverse AST once for declarations/imports and once for callable complexity if necessary. Collect:

- ESM import declarations, side-effect imports, named/default imports, type-only imports, mixed imports.
- Re-exports including `export *`, `export { ... } from`, and type re-exports.
- TypeScript import-equals and literal import-type nodes.
- Literal dynamic `import()` and literal CommonJS `require()` only when the lexical scope does not bind a local `require`.
- Resource imports and JSX/TSX syntax without claiming framework-specific module semantics.
- Top-level named declaration summaries; default-export anonymous declarations receive a safe display label and are not treated as stable identities.
- Parse diagnostics with exact bounded ranges. A parse-failed file can retain trustworthy partial facts only if they are tagged partial; default policy is no dependency/complexity claims from malformed AST regions.

Nonliteral dynamic import/require yields unsupported observations at the expression range with no fabricated specifier. Named declarations are not call graph nodes. A statically visible import does not prove the imported file executes.

### 9.3 Config discovery and safe resolution

Discover root `tsconfig.json`/`jsconfig.json` and manifest package roots. Build project contexts from supported configs and explicit `files`/`include`/`exclude`; config excludes affect resolution context, not the overall structural inventory. Assign files to the nearest containing applicable project; when equally applicable, select shortest relative config path then byte order and emit `MULTIPLE_PROJECT_CONTEXTS`. Referenced projects retain their own options.

Read JSONC through TypeScript's parser using the virtual filesystem. Resolve relative `extends` against the declaring config, honoring supported inherited-option origin semantics. Detect cycles, depth/size/count limits, escaping paths, and absent files. Package `extends` is unavailable without in-repository config; no package install. Ignore executable plugins. Inventory safe supported compiler options; unsupported options get informational coverage notes rather than silent changes.

Use `resolveModuleName` with a custom compiler host whose existence/read/directory operations access only indexed virtual data. Respect explicit supported `module`/`moduleResolution` values. If absent/unusable, use a documented inferred `bundler` context for ordinary ESM TS/JS and a Node context for `.mts/.cts/.mjs/.cjs` or recognized package type; mark inferred confidence. Record chosen parser/compiler behavior in artifact options. Do not reinterpret an explicit Node context as bundler just to make a missing extension resolve.

Build a **virtual workspace package map**, not physical `node_modules`: package names -> included manifest roots, safe exports/imports targets, conventional declared entry points. Validate targets stay inside the repository and apply supported import/require/type conditions. Reuse compiler resolution where possible, but record virtual workspace resolution as inferred when no emitted package output exists. Missing referenced-project declaration outputs may map to included source only through a documented project-reference fallback; preserve its provenance. Project references are structural build relationships, not static import edges; see [TypeScript project references](https://www.typescriptlang.org/docs/handbook/project-references).

Resolution outcome precedence:

1. A valid compiler/config-aware internal target wins, including an alias matching a bare-looking name.
2. A recognized built-in specifier becomes a builtin.
3. An in-repository workspace package target uses the safe workspace map.
4. A bare npm specifier with a manifest declaration becomes an external package, retaining range and field.
5. A plausible undeclared bare npm specifier becomes an inferred external package with `UNDECLARED_EXTERNAL_IMPORT` info; do not invent a version.
6. Relative/root/alias candidates that cannot resolve get a reason: `LOCAL_TARGET_MISSING`, `TARGET_EXCLUDED`, `CONFIG_CONTEXT_MISSING`, `ALIAS_UNSUPPORTED`, `GENERATED_TARGET_MISSING`, `PACKAGE_EXPORT_UNSUPPORTED`, or `CASE_MISMATCH` when detectable without conflating paths.
7. URL/nonliteral/framework macro cases are unsupported, never fetched.

Record exact vs inferred vs heuristic confidence based on the branch used. Display coverage ratios separately for supported resolvable observations and all observations; external classification is not proof of an installed package. Resolver unit fixtures are more important than a blanket claim that all Node/Bundler semantics are supported.

### 9.4 Caches and invalidation

Content cache key: SHA-256 bytes + language/script kind + parser version + extraction/metric version. AST cache contains no project assumptions. Resolution cache key adds source path, effective config digest, workspace manifest/map digest, and snapshot tree digest; a changed target file or manifest invalidates it even if the importing blob is unchanged. History diff key includes both tree OIDs, Git version, and rename options.

Caches store serializable facts only, with verified lengths/hashes. Local cache remains inside the chosen output/cache area, not a hidden upload. Hosted raw-content/parse caches are ephemeral within a job in V0.1; only source-free validated artifacts may persist across jobs. A poisoned partial cache cannot overwrite a complete entry.

### 9.5 Incrementality and language expansion

V0.1 reuses unchanged blob facts across sampled history; it need not watch the working tree or maintain a daemon. Full graph rebuilding after changed config/tree is acceptable within performance gates. Future adapters for Python, Go, Rust, and Java need separate ADRs covering package/resolution semantics and capabilities; do not claim them now or ship generic guessed import edges.

## 10. Metrics, diagnostics, and hotspot semantics

### 10.1 Raw definitions

| Metric | Exact V0.1 definition |
|---|---|
| Physical lines | Count LF-delimited lines; empty file = 0; trailing LF does not add an extra empty line |
| Code lines | Distinct physical lines intersecting a nontrivia token; comments/blank-only lines excluded; multiline tokens count all intersected lines |
| Cyclomatic per callable | Start at 1; add 1 per `if`, loop (`for`, `for-in`, `for-of`, `while`, `do`), `catch`, conditional expression, non-default `case`, and short-circuit `&&`, `||`, `??`; optional chaining is not counted |
| Callable boundaries | Function/method/constructor/getter/setter/arrow; nested callables computed separately and excluded from parent's traversal; top-level statements are not a callable |
| Max/sum complexity | Max/sum of callable values; parsed file with no callables = max 0, sum 0; failed/unsupported parse = null |
| Fan-out | Unique included file targets across static value imports/re-exports, literal require and literal dynamic import; type-only and resource targets excluded by default |
| Fan-in | Unique included source files pointing to this file under the same value-edge policy |
| Static cycle | SCC of more than one file, or a self-edge, under a declared edge policy; default uses static synchronous value/re-export/require, excluding type-only/dynamic/resource |
| Churn | Available text additions/deletions and changed commit count in the bounded prior history window; not activity across the whole repository lifetime |
| Dependency reach | Optional bounded transitive reach from a selection; show limit if truncated; never name this actual impact or blast radius |

The metric panel names the policy. A UI toggle may include type edges in dependency exploration, but does not silently redefine stored default metrics. `sumCyclomatic` is raw size-dependent context; `maxCyclomatic` is the primary complexity lens. Directory/package metrics are explicit sums/counts or maxima, not unlabelled averages.

### 10.2 SCCs and findings

Use deterministic Tarjan or Kosaraju, O(V+E); sort traversal by node/edge ID. SCC identity is a hash of sorted member lineage IDs for a frame where available. Display one finding per cycle component with members, policy, and a bounded witness cycle. Finding text: “Static value dependency cycle detected”; never “runtime deadlock.” Type cycles may be explored separately with an explanatory label.

Built-in rule set:

| Rule | Severity | Trigger and evidence |
|---|---|---|
| `ATLAS_PARSE_ERROR` | error | Parser syntax error and source range; error describes analysis/input syntax, not a failing build |
| `ATLAS_LOCAL_IMPORT_UNRESOLVED` | warning | Supported local candidate missing after config-aware resolution; statement evidence and reason |
| `ATLAS_RESOLUTION_CONTEXT_INCOMPLETE` | info | Unsupported alias/generated/external config; do not count as a confirmed missing module |
| `ATLAS_STATIC_CYCLE` | warning | SCC/witness under the stated value-edge policy |
| `ATLAS_COMPLEX_CALLABLE` | warning | Max callable complexity >= 20; range and counted decision contributions |
| `ATLAS_LARGE_SOURCE_FILE` | info | Code lines >= 500; exact value and scope |
| `ATLAS_HIGH_FAN_IN` | info | Fan-in >= 20 and at or above source-file 95th percentile; direct consumers list |
| `ATLAS_CHANGE_CONCENTRATION` | info | Changed commits >= 10 and at or above source-file 95th percentile with usable history |
| `ATLAS_ANALYSIS_LIMIT` | info | Any omission/resource cap; count and affected stage |

Thresholds are versioned product defaults, not universal quality standards. Tests/config/declaration files remain visible but are separated from production-source cohorts. No ESLint invocation or dependency-provided rules. No TODO-count or lint score masquerading as diagnostics. Do not import SARIF until a later contract is specified.

For percentile-threshold rules, use the nearest-rank 95th percentile: sort the eligible nonnull source values ascending and select index `ceil(0.95*n)-1` for `n>0`; an empty cohort has no percentile finding. The absolute minimum in the rule table still applies, so a small uniform repository does not receive an outlier finding merely by occupying its own upper percentile.

### 10.3 Hotspot score, explainability, and comparability

For included parsed source-role files with comparable dependency/history availability, derive empirical percentile ranks for `maxCyclomatic`, `fanIn`, and `changedCommits`. Percentile `p=(midrank-1)/(n-1)` for `n>1`, `p=0` for `n=1`; tied/all-identical values therefore share a midpoint rank. Sort by numeric value; use ties, not node IDs, to compute rank.

Full hotspot score:

```text
score = round(100 * (0.40*pComplexity + 0.25*pFanIn + 0.35*pChangedCommits))
```

Use one fixed eligible cohort and percentile distribution derived from the latest complete HEAD metrics for all frames in this artifact, so a slider does not regrade the city at each step. For a historical value between two distinct HEAD values, interpolate linearly between their midrank percentiles; clamp values outside the baseline range to the endpoint percentiles. An all-identical baseline uses its single shared percentile for every value; expose this limited discriminatory power. The metric inspector exposes the baseline cohort, raw values, percentiles, weights, window, and availability. The HEAD distribution is an explicit retrospective comparison baseline, while an earlier frame's raw churn includes only commits up to that frame.

If usable history is absent, the full hotspot score is **null**; offer a separate **Structure attention** score using `0.60*pComplexity + 0.40*pFanIn` and a distinct label. Do not silently renormalize a missing factor and keep calling it the same score. Partial history supports a visibly partial score only when all scored frames share the same observed window and diff coverage policy; otherwise leave score null and use raw lenses.

Hotspot means “candidate for inspection under these heuristics.” Rankings are repository-relative and cannot compare project quality. A high fan-in file may be a well-designed shared utility. Keep generated/test/declaration cohorts separate. If the eligible cohort is empty, explain why and keep the other lenses functional.

## 11. Deterministic city generation

### 11.1 Visual grammar

| Repository concept | City representation | Fixed meaning |
|---|---|---|
| Repository | Entire island/city base | Analysis scope |
| Workspace/package | Large bordered district | Manifest/workspace boundary |
| Directories | Nested blocks/plazas | Hierarchical structure |
| Included file lineage | Building on a fixed plot | One source or opaque file across analyzed frames |
| File role | Roof silhouette/icon | Source, test, declaration, config, asset/opaque |
| Code lines | Building height | Size, logarithmic and clamped |
| Opaque file | Low kiosk | Unsupported/skipped metrics, not zero-size code |
| Selected lens | Facade color plus legend | Exactly one metric; missing values patterned/neutral |
| Folder roads | Quiet separation gutters | Navigation space, not imports |
| Static dependency | Optional directional overlay | Declared static relation |
| External dependency | Perimeter terminal | Package/builtin outside repository source |
| Deleted file in compare | Translucent/outlined plot | Present in A, absent in B |
| Added file in compare | Outline plus “added” marker | Present in B, absent in A |

No traffic, smoke, fires, animated crowds, or danger sirens imply runtime behavior or defective code. Decorative trees, lamps, and shorelines are permitted if seeded and cheap; they never obscure selection/evidence.

### 11.2 Pure layout contract

Input: validated frame graphs, file lineages, normalized display options, and layout version. Output: integer district rectangles, file plot rectangles, membership per frame, external anchors, and a deterministic render transform. Layout is computed server/CLI-side as a pure function; frontend does not rerun force simulation.

Layout district IDs are hashes of repoId, anchor container kind, and anchor path; they are separate from snapshot graph container IDs. For each frame export an explicit graph-container-to-layout-district map, nullable when a historical container has no anchored district. Historical folder selection always highlights member file plots from that frame, including files anchored elsewhere; it does not depend on graph and layout container IDs being equal.

```ts
interface LayoutArtifact {
  layoutVersion: 'atlas.layout/1.0.0'; layoutId: ID;
  unitsPerCell: 100; root: Rect;
  districts: { id: ID; parentId: ID | null; rect: Rect; anchorPath: RepoPath }[];
  plots: { lineageId: ID; districtId: ID; rect: Rect; seed: number }[];
  externalAnchors: { canonicalName: string; x: number; z: number }[];
  frameState: { snapshotId: ID;
               containers: { graphNodeId: ID; layoutDistrictId: ID | null }[];
               files: { nodeId: ID; lineageId: ID;
                 currentParentId: ID; height: number; present: true }[] }[];
}
interface Rect { x: number; z: number; width: number; depth: number }
```

Integer layout guarantees do not depend on GPU floating-point behavior. Quantize derived height to thousandths before export. Browser rendering may vary slightly by GPU; canonical plot geometry must be identical.

### 11.3 Hierarchy and temporal placement

Choose each lineage's **layout anchor** from its latest present frame, preferring HEAD. Its latest path determines its district and plot across every frame. For deleted-before-HEAD files, use their latest historical path. Directory/package district hierarchy is the union of these anchored paths and required container ancestors. Empty historical containers can retain a boundary at district-level detail if they host anchored plots.

Renaming/moving a file does not move its building within the artifact. Historical inspection shows the actual path, current membership, and a “plot anchored to latest path” note; selecting an old directory highlights its historical members even if some lie outside that anchored rectangle. This resolves the tradeoff explicitly: plots preserve orientation while tree/inspector preserve exact historical structure. Directory boundaries represent the layout anchor hierarchy, not a false claim that an old file already lived there.

Layout remains stable while scrubbing, filtering, selecting lenses, and comparing inside an artifact. A new analysis with new files or a different history window may change district sizes/plots; V0.1 does not promise stability across arbitrary reanalyses. Show layout version/id in exports. `--previous` does not promise incremental plot insertion in this release.

### 11.4 Exact recursive packing algorithm

Use a **hierarchical square-shelf packer**, selected for simple invariants and readable city blocks. It is intentionally not a semantic clustering/treemap algorithm.

Constants in layout version 1: plot interior `1x1` cell; file pitch `2` cells; child district gutter `2` cells; district border `1` cell; district header strip `2` cells. Footprints are constant so temporal LOC changes do not repack the city.

Bottom-up, for each district:

1. Lay out its directly anchored file lineages in ascending lineage ID. `columns = ceil(sqrt(count))`, `rows = ceil(count/columns)`; count zero produces no direct-file item. Each slot is pitch-spaced; a file rectangle has `1x1` interior.
2. Treat that direct-file grid, if any, as one child item. Obtain each child directory/package's already computed bounding rectangle.
3. Sort child items by descending area, descending max side, then stable district ID (direct-grid ID is a hash of district ID plus `direct`). Do not rotate items.
4. Set target shelf width to `max(maxChildWidth, ceil(sqrt(sum((w+gutter)*(d+gutter)))))`.
5. Pack in sorted order left-to-right. Start a new shelf when next item's width would exceed target and shelf is nonempty. Advance shelf depth by max placed depth plus gutter. Use integer arithmetic only.
6. Add border and header strip; translate all descendants by the resulting origin. An empty district uses a minimal `4x4` cell marker only when required for navigation.
7. At repository root, apply the same algorithm to packages and any synthetic root district. Add a fixed perimeter road and external ring outside root bounds.

Assert all child bounds contained, all plots nonoverlapping, no rotations/reflections, and unique plot per lineage. Complexity is O(N log N) due to sorting; geometry computation is O(N). Package districts expose their actual paths; decorative names never replace them.

### 11.5 Building encoding and seeded style

File height for parsed nondeclaration source/test files:

```text
height = quantize_0.001(clamp(1 + 1.5 * log2(1 + codeLines / 25), 1, 14))
```

Opaque/config/asset kiosks use fixed height 0.8; declaration files use a fixed distinct low form and inspector size metrics. Display the role rule in the legend. Height reflects code lines, not bytes or complexity. District bases remain fixed. Rooftop variants come from a specified seeded PRNG (e.g. versioned xorshift32 with nonzero seed derived from SHA-256 lineage bytes); never `Math.random()`.

Structure lens assigns a fixed accessible district palette by stable package/district ID. Complexity/churn/fan-in/hotspot lenses use a sequential color scale with explicit numeric stops and textual legend; color need not encode every subtle variation. Unknown metrics use a neutral hatch/roof mark. Selection uses outline, marker, and HTML selection state; color alone never signals selection or change.

### 11.6 Dependency overlay routing and budgets

Default overview has no individual import spaghetti. At package overview, optionally show package aggregates with width `1 + log2(1 + uniqueFilePairs)` clamped to 6 screen pixels. Selecting a file shows immediate outgoing/incoming edges, capped at 200 by kind, source/target ID; inspector retains all queryable edges with pagination. User can select a particular omitted edge to render it.

Route same-district links as raised quadratic arcs between plot centers; cross-district links pass through fixed district gate points and a root-level corridor. Gate choice is deterministic from relative centers with fixed tie-break order north/east/south/west. Arrowhead points toward the imported target. Link color/style distinguishes type/value/dynamic/resource and always has a legend.

Aggregate dependency lines at far zoom; show file arcs only on selection or close zoom. External terminals are sorted canonical names around four sides of the perimeter; render at most 50 terminals simultaneously, aggregate the rest into an accessible external-package list. No overlay can silently delete underlying graph evidence.

### 11.7 Level of detail and large cities

- Far: package/directory bases, simplified skyline batches, no per-file text.
- Medium: instanced buildings, hovered/selected labels, aggregated edges.
- Near: role roofs, selected evidence lines, capped neighborhood labels.
- Fallback: 2D map from the same rectangles plus fully functional tree/table.

Use instanced meshes per limited role/material batch, not one React component and DOM label per file. Store immutable nodeId/lineageId -> instance maps per frame. Update instance matrices/colors in batches; recalculate instance bounds after transforms. Dispose GPU resources on unmount/frame dataset replacement; see [Three.js InstancedMesh documentation](https://threejs.org/docs/pages/InstancedMesh.html).

History interpolation changes only height/color/presence on fixed plots. Reduced motion changes snapshots immediately. Do not load all historical source graphs into the main thread just to animate: manifest/layout first, HEAD graph, then selected adjacent frames on demand.

## 12. Frontend behavior and accessibility

### 12.1 Application state

Separate immutable dataset state from view state. Dataset state includes artifact/version, completed frames, graphs, layout, and coverage. View state includes active snapshot, optional comparison A/B, selected lineage/node, focused district, lens, edge policy, filters, renderer mode, and bounded camera pose. The active graph is authoritative for all evidence; stale graph selections must be reconciled on frame change.

Preserve a selected lineage across frames. If absent, show a tombstone inspector with last/next known occurrence and let the user select another file; never silently select a similarly named file. Use occurrence IDs for graph queries and lineage IDs for temporal selection. Reset compare only on an explicit user action or invalid dataset state.

Share state example:

```text
/a/<analysisId>#v=1&frame=<snapshotId>&file=<lineageId>&lens=complexity&mode=3d
```

Only a small allowlisted set of fragment keys is accepted; cap total fragment length at 4 KiB. Invalid IDs fall back to a valid state with a message. Optional camera values are clamped finite values, never arbitrary transforms. Fragments do not carry local paths, management tokens, source text, or executable state. A local artifact has no hosted share URL; copy view state/export manually.

### 12.2 Controls and interactions

| Interaction | Required result |
|---|---|
| Hover building | Bounded tooltip: name, role, selected metric, parse/coverage status; no expensive full graph traversal |
| Single click | Select file; outline building; synchronize tree; inspector opens; keep camera stable |
| Double click / Focus button | Fit selected building/neighborhood with bounded camera movement |
| Directory/tree selection | Highlight current-frame descendants; breadcrumb and fit action |
| Search | Case-insensitive human search over path, package, bounded declaration names; exact path first, prefix next, substring next, stable path tie-break |
| Dependency tab | Separate imports/consumers/external/type-only/unresolved lists; range and resolution provenance |
| “Show reachable” | Bounded BFS; direction/depth shown; default depth 2, max 5, cap 2,000 visited nodes |
| Lens switch | Change colors/legend only; fixed plots and selection preserved |
| Snapshot change | Latest requested frame wins; prevent stale async response overwrites; retain selected lineage |
| Compare A/B | Explicit interval, fixed plots, additions/deletions/renames list, raw deltas and availability |
| Filter | Dim/hide display objects; indicate active filters; graph metrics do not silently recompute |
| Clear selection / Escape | Clear transient overlay and restore inspector navigation context |
| Source action | Hosted GitHub immutable permalink; local read-only source only with explicitly attached repository |
| Context loss / 3D unavailable | Offer map/table immediately; preserve state and task capability |

Camera: orthographic default with stylized isometric angle; bounded orbit/pan/zoom, no first-person WASD mode. Toolbar exposes reset, zoom in/out, fit, north/orientation, and 2D/3D/table choice. Touch supports tap and two-finger navigation; no hover-only essential actions. Pointer hit testing is throttled and uses spatial district bounds/instance lookup.

### 12.3 Detail panel contents

Header: current path, package, file role, commit, parse status, and a lineage continuity note when renamed. Tabs:

1. **Overview:** raw size/complexity/degree/churn, definitions, availability, hotspot factors.
2. **Dependencies:** direct inbound/outbound sorted lists, statement ranges, kinds/confidence, external ranges, unresolved reasons; pagination for large lists.
3. **Findings:** rule title, severity, evidence, source location/action, limitations; no invented remediation promise.
4. **History:** included mainline changes affecting this lineage, rename chain, sampled frames, additions/deletions, interval compare action.

Clicking an import's target selects the actual target occurrence. A missing/excluded target has an explanation rather than a broken navigation link. Diagnostic severity is distinct from metric heat. Tables and inspectors expose numbers so the city is not the only way to understand results.

### 12.4 Accessibility acceptance

Target applicable **WCAG 2.2 AA** for the web interface and equivalent access to repository information through semantic HTML. A canvas alone is not accessible; every important action and result has an HTML path. Use the [W3C WCAG quick reference](https://www.w3.org/WAI/WCAG22/quickref/) for implementation checks.

- Real buttons/inputs/tables and a keyboard-operable tree; avoid thousands of hidden focusable canvas surrogates.
- Roving tree focus, appropriate expanded/selected state, predictable tab order, visible focus, and no focus trap in the canvas.
- Enter selects; arrow keys navigate tree; Escape closes transient panels; shortcut help is visible. Shortcuts do not intercept typing in controls.
- A status region announces completed selection/frame changes concisely; no continuous narration during hover or animation.
- Inspector focus changes are deliberate. Frame loading preserves focus and announces unavailable selection without losing context.
- Text contrast at least 4.5:1 for normal text, 3:1 for large text; UI component/focus contrast at least 3:1 where applicable. Do not rely on pastel 3D surfaces for readable text.
- Never rely solely on color, position, hover, motion, or 3D depth for meaning.
- Respect `prefers-reduced-motion`; disable camera flights, autoplay, interpolation, and decorative motion. History never autoplays by default.
- Controls meet applicable target-size requirements; choose 44 CSS px for primary touch controls.
- Reflow ordinary controls/inspector at 320 CSS px and support 200% zoom; city viewport may remain a spatial region with equivalent table information.
- Virtualized tree/table preserves programmatic row information and offscreen search selection; verify with a real screen reader, not only automated checks.
- Export/table/download controls work without WebGL. Explain that static PNGs cannot replace the accessible artifact/table.

### 12.5 Visual completion gate

One coherent palette, restrained lighting, readable package labels, smooth intentional camera limits, consistent empty/error states, and stable pick/select behavior are required. Produce visual reference captures at small, medium, and large supported sizes in every lens and compare mode. Cosmetic details are complete when they improve readability and the miniature-city identity without degrading measured budgets.

## 13. HTTP API and job lifecycle

### 13.1 Routes and payloads

Prefix every route `/api/v1`. Use JSON with runtime schemas; request body maximum 16 KiB. All timestamp strings are ISO 8601 UTC. IDs are validated type-prefixed hashes or random opaque IDs as specified. No endpoint accepts an arbitrary outbound URL except the strictly validated initial GitHub repository root field.

| Route | Response | Authorization/behavior |
|---|---|---|
| `POST /analyses` | 202 new/queued job; 200 completed cache reuse | Same-origin admission, quotas, `Idempotency-Key`; capability returned once |
| `GET /jobs/:jobId` | 200 job state/stages/counts/warnings | Management capability; no raw source/logs |
| `GET /jobs/:jobId/events` | SSE state changes | Same-origin session bound to capability; replay with event sequence |
| `POST /jobs/:jobId/cancel` | 202 accepted, or 200 already terminal | Management capability; cancellation idempotent |
| `GET /analyses/:analysisId` | 200 manifest | Public result with visibility/expiry check; local artifacts absent |
| `GET /analyses/:analysisId/chunks/:chunkId` | 200 compressed validated chunk | Same publication and visibility check; resolve opaque ID, never arbitrary storage path |
| `DELETE /analyses/:analysisId` | 204 | Management capability; purges this publication, revokes its access |
| `GET /capabilities` | 200 supported schema/languages/limits | Public static service contract |
| `GET /health/live` | 200 | Minimal process health, no secrets |
| `GET /health/ready` | 200/503 | Internal/operator check for DB/admission readiness |

Graph search, adjacency, diagnostics, and compare use the shared browser/CLI query library over validated chunks. Do not create server-side graph query endpoints unless benchmark evidence demands them. This keeps local/hosted behavior identical and the API small.

Submission:

```json
{
  "repositoryUrl": "https://github.com/example/project",
  "commitSha": null,
  "profile": "v0.1-default",
  "history": { "enabled": true },
  "publication": "public-expiring"
}
```

Only the named profile is supported initially. `history.enabled=false` explicitly produces a HEAD-only analysis with history disabled coverage; the normal/default path includes history. Request cannot raise limits or enable extra languages. `publication` is mandatory in hosted submission so the form's public-output choice is concrete.

Accepted response:

```json
{
  "jobId": "job_<random128>",
  "state": "QUEUED",
  "managementToken": "<random256-returned-once>",
  "statusUrl": "/api/v1/jobs/job_<random128>",
  "eventsUrl": "/api/v1/jobs/job_<random128>/events",
  "analysisId": null
}
```

These angle-bracket values are explanatory placeholders, not accepted literal IDs. Actual management tokens use cryptographically secure random bytes, store only a one-way hash, and are compared in constant time. Never expose them through URL query/fragment, logs, analytics, or copied share state. API clients use an Authorization bearer header; browser uses a secure HttpOnly same-origin session created on admission, with CSRF/origin checks on mutations. If EventSource cannot send an Authorization header, bind SSE to that session instead of query tokens.

Job state contains `revision`, `stage`, `counts`, `warnings`, `analysisId`, `error`, and `updatedAt`. SSE events `state`, `progress`, `warning`, and `terminal` have monotonic numeric event IDs and compact JSON data. Retain a bounded 100-event replay ring or durable progress rows; older reconnections receive one authoritative current state. SSE is convenience; polling every 2 seconds while active, backing off to 10 seconds, is the supported fallback. Close streams on terminal states and remove listeners on navigation.

### 13.2 State machine

```text
QUEUED -> ACQUIRING -> ANALYZING -> HISTORY -> LAYOUT -> VALIDATING -> READY
                                                            \-> PARTIAL
any nonterminal -> CANCEL_REQUESTED -> CANCELLED
any nonterminal -> FAILED
READY/PARTIAL -> EXPIRED or DELETED (publication lifecycle)
```

`READY` means requested supported scope completed within its declared window; normal bounded days/commit policy is not an error. `PARTIAL` means omissions/failures beyond the explicit profile or incomplete requested history affected results. Distinguish routine built-in exclusions from unexpected caps. A structure-only unsupported-language result is partial for the TS/JS product profile. Terminal publication and job status are separate database fields so deleting an artifact cannot resurrect a job.

Only verified complete frames are published. Failed acquisition before HEAD has no result. Cancellation does not publish new partial results; a previously published result from a separate request is unaffected. Worker crash retries once if safe, with fresh scratch space. Invalid input, security policy violations, and deterministic resource exhaustion are not retried endlessly.

### 13.3 Database and queue contract

Minimum tables:

- `repositories`: numeric GitHub ID, canonical name, last visibility result/time, revoked state.
- `jobs`: id, repository request, normalized input hash, profile/options, state/stage, revision, lease owner/expiry, attempt, deadline, capability hash, timestamps, bounded progress/error.
- `publications`: analysisId, jobId, repoId, commit, artifact content key, created/expiry/deleted/revoked timestamps, manifest storage key.
- `artifact_objects`: content key, version/options/boundary digest, byte counts, storage keys, verified status, reference count/expiry.
- `admissions`: salted short-lived client identity, window counters, idempotency key/input hash/job reference.

Enqueue and admit transactionally. Claim jobs with `SKIP LOCKED`; lease heartbeat every 10 seconds, lease expiry 30 seconds. Reaper fences expired leases by revision/attempt generation. Publishing requires current lease ownership and terminal-state compare-and-swap. Object uploads go to a temporary prefix; verify all chunks, commit publication transaction, then mark objects live. Garbage collector removes abandoned prefixes. Multiple workers must never publish two different artifacts under one publication ID.

### 13.4 Idempotency, caching, and quotas

Idempotency key: client-generated UUID, scoped to admission session, retained 24 hours; same key/same input returns same job, different input returns 409. Repeated response to the same session need not return a token again. Content cache deduplicates immutable source-free artifact bodies, but each authorized new submission may get its own publication/capability and expiry. Deleting one publication does not grant or remove management access to another; repository visibility revocation affects all publications for that repository. Purge unreferenced cached objects on TTL.

Initial hosted admission defaults: one active job per session/client bucket, five new uncached jobs per hour per salted client bucket, maximum 20 queued jobs service-wide, and configured worker-slot concurrency. Queue full returns 429/503 with `Retry-After`; cached responses still have read/abuse quotas. A salted IP/session bucket is an abuse mitigation, not personal identity; retain admission data at most 24 hours and avoid logging full IPs by default. Operators may tune quotas with documented capacity measurements; repository content cannot change them.

Respect upstream rate-limit headers, backoff, and `Retry-After`; use conditional metadata requests where supported. Do not assume a fixed upstream quota based on a token's existence. Coordinate GitHub request budgets across worker slots and stop retry storms. See [GitHub REST rate-limit documentation](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).

### 13.5 Errors

```json
{
  "error": {
    "code": "REPOSITORY_TOO_LARGE",
    "message": "Repository acquisition exceeded the V0.1 transfer limit.",
    "retryable": false,
    "details": { "limitMiB": 256, "stage": "ACQUIRING" },
    "requestId": "req_<random128>"
  }
}
```

Required codes: `INVALID_REPOSITORY_URL`, `REPOSITORY_NOT_PUBLIC`, `REPOSITORY_NOT_FOUND`, `EMPTY_REPOSITORY`, `COMMIT_NOT_ACCESSIBLE`, `UPSTREAM_RATE_LIMITED`, `UPSTREAM_UNAVAILABLE`, `REPOSITORY_TOO_LARGE`, `ANALYSIS_RESOURCE_LIMIT`, `UNSUPPORTED_SCHEMA`, `ARTIFACT_INVALID`, `JOB_CANCELLED`, `ARTIFACT_EXPIRED`, `ARTIFACT_REVOKED`, `FORBIDDEN`, and internal `INTERNAL_ERROR` with no stack trace to caller. Distinguish 400 validation, 403 policy, 404 unavailable public identity, 409 idempotency/state conflict, 410 expired/revoked artifact, 413 limits, 429 quotas, and 503 upstream/service availability. Avoid revealing the existence of private repositories in anonymous error details.

## 14. CLI and local viewer

### 14.1 Commands

```sh
atlas doctor
atlas analyze . --out ./atlas-output
atlas analyze . --ref <local-commit-or-simple-ref> --out ./atlas-output
atlas analyze . --history-days 30 --history-commits 100 --snapshots 8 --out ./atlas-output
atlas analyze . --no-history --out ./atlas-output
atlas analyze . --previous ./previous-atlas-output --out ./next-atlas-output
atlas inspect ./atlas-output --json
atlas verify ./atlas-output
atlas serve ./atlas-output --repo .
atlas serve ./atlas-output --no-open
```

`doctor` reports runtime/Git version, supported object formats, and safe adapter availability without exposing credentials/config. `analyze` accepts a directory, uses committed data, and normalizes options. Numeric overrides must be within the profile; `--snapshots` range 1..12, days 1..90, commits 1..200. Explicit `--no-history` skips history, not other pillars. `--repo-id` accepts a validated persistent identifier; `--previous` verifies compatibility and reuses identity. Conflicting options fail clearly.

`--json` on analysis directs machine-readable progress/final result to stdout; human progress goes to stderr. No color/control escapes in JSON. SIGINT requests cancellation, terminates children, removes staging files, and leaves any preexisting valid output intact.

Exit codes: 0 requested supported scope complete; 2 useful partial artifact; 1 analysis/validation failure; 64 command/argument error; 130 cancellation. Parse findings may produce a partial artifact; they do not cause a fake successful full result. `verify` exits nonzero for corruption/schema/invariant failure. Document status handling for CI.

### 14.2 Atomic files and output safety

Analyze into a sibling staging directory, validate it, then atomically rename to the chosen output. Refuse to overwrite a nonempty output unless `--replace` is explicitly supplied. Replacement keeps a temporary backup until commit, validates resolved paths stay inside the specifically chosen output target, and never recursively deletes the source repository or an arbitrary parent. Test interrupted writes and replacement failure on Windows.

No network request, upload, telemetry, auto-update, or package install occurs during local analysis/serve. The viewer assets are bundled. Source text stays in the Git object store, not exported artifact chunks. Relative displayed paths are allowed; absolute machine paths stay out of logs/artifacts. Cache cleanup touches only validated ATLAS staging/cache directories.

### 14.3 Loopback server and source attachment

Bind only `127.0.0.1` on an OS-selected port by default. Do not offer public/LAN binding in V0.1. Generate a random session capability and use it to establish a local HttpOnly session; do not treat loopback alone as authorization. Validate Host/Origin, use no permissive CORS, block cross-origin mutations, and serve only bundled assets plus the selected validated artifact. No arbitrary filesystem endpoint or directory listing.

`--repo .` explicitly attaches a repository for read-only source access. Validate the artifact's selected commit, declared first-parent frame chain, and each requested file path/blob pair against the attached committed trees; mismatches disable source access with a reason. A generated local repoId alone is not proof of repository identity. Source requests use active snapshot ID + file occurrence ID, which the server maps to validated committed blob OIDs. They never accept absolute paths, arbitrary Git revisions, or unrestricted object IDs. Return bounded UTF-8 text with escaped HTML presentation; opaque/oversize sources are unavailable. Default `serve` without `--repo` still supports all graph features and says source is unattached. Do not open a local editor through shell templates in V0.1.

Browser “Open local artifact” uses file APIs and browser workers; it sends no chunks to hosted endpoints. In hosted context it does not offer repository attachment. Verify this with network interception and an offline test.

## 15. Performance, reliability, and operations

### 15.1 Benchmark environments and fixtures

At Phase 0, record exact CPU/OS/browser/runtime versions. Reference analysis environment: 4 modern CPU cores, 2 GiB job memory cap, SSD, controlled local objects. Reference interactive environment: laptop-class integrated GPU, 8 GiB system RAM, current supported Chromium and Firefox, 1920x1080 viewport, device pixel ratio capped at 1.5. Low-quality profile caps DPR at 1 and disables shadows/decorations. These descriptions must become actual recorded hardware in benchmark reports.

Fixtures: small 300 files/3,000 edges; medium 3,000/30,000; large 10,000/100,000; temporal large union 20,000 lineages but at most 10,000 present per frame. Source fixtures stay within 64 MiB HEAD/256 MiB union. A dense dependency fixture exercises degree/edge caps, not just sparse pretty cities.

### 15.2 Required budgets

| Measure | Release target |
|---|---|
| HEAD analysis after acquisition | Medium <= 15 seconds p95; large <= 60 seconds p95 |
| 12-frame historical analysis after acquisition | Medium <= 90 seconds p95; large <= 240 seconds p95 using blob cache |
| End-to-end hosted deadline | 300 seconds hard; network/queue time reported separately; no universal internet latency promise |
| Layout generation | 20,000 union plots <= 2 seconds p95 |
| Medium artifact compressed | <= 5 MiB total; large <= 20 MiB hard transport limit after frame reduction |
| Viewer first useful HEAD view | <= 3 seconds p95 after required chunks available on reference device |
| Web cold route over test 10 Mbps/100 ms RTT | Medium <= 8 seconds to useful explorer; loading controls remain responsive |
| Search | <= 100 ms p95 medium, <= 200 ms p95 large |
| Selection/inspector/overlay response | <= 100 ms p95 excluding chunk download |
| Continuous camera movement | Medium p95 frame time <= 33 ms; large <= 50 ms in low-quality mode |
| Snapshot change after graph cached | <= 250 ms p95; crossfade does not extend response measurement |
| GPU draw calls | <= 150 medium default view; <= 250 large selected-overlay view |
| Viewer retained JS heap | <= 300 MiB across main + owned workers after collection, large active view with bounded adjacent-frame cache; pre-collection allocations reported separately (ADR-024), not a startup/RSS peak guarantee |
| Graph/history worker responsiveness | No unnecessary main-thread task > 50 ms in measured interaction traces |

Collect at least 20 repeated non-network measurements for p95 budgets with warm/cold conditions specified. Use distributions and environment details; do not report a single favorable run. If a synthetic fixture exceeds a cap, the cap behavior is tested separately from normal performance. Memory/GPU limits need profiling, not only inferred object counts.

### 15.3 Performance implementation rules

Parse in bounded child processes (initially two), each with time/memory limits and kill support; do not rely on an event-loop timer to stop synchronous parsing. Keep only plain facts after parsing. Resolver caches share immutable contexts and batched queries. SCC and graph degree computations use indexed adjacency arrays/sets. Do not make a dense NxN dependency matrix.

Browser workers handle validation/decompression, search indexing, and compare/reachability. Store active graph plus at most two nearby historical frames in an LRU; layout/frame transforms are lighter than complete evidence graphs. Abort obsolete downloads, bound parallel requests, and surface failed chunks without silently using a different frame. Reuse typed buffers and shared geometry/materials. Render on demand when camera/selection is idle, pause in hidden tabs, and avoid state updates per file per frame.

Limit shadows to a small fixed system or use baked/simple ground shading; no per-building lights. Label count is bounded to 100 visible DOM labels. Picking is neighborhood-aware and throttled to at most 30 Hz; no O(N) DOM updates on every pointer movement. A WebGL error falls back to map/table without discarding parsed data.

### 15.4 Operations and observability

Record job-stage durations, queue depth, active leases, memory/disk peaks, bytes fetched, parser failures, coverage/limit-hit counts, artifact sizes, upstream throttling, cancellation cleanup, and publication/purge success. Logs use request/job IDs and codes; avoid source, tokens, full paths, commit messages, and author emails. Useful repository identity may be a hashed numeric ID rather than a public name in operational logs.

Runbooks: stalled job/reaper, upstream outage, malicious/resource-heavy input, purge/revocation, storage reconciliation, worker crash, schema rollback, and capacity scaling. Readiness fails when admission cannot queue reliably; do not fail API liveness solely because GitHub is unavailable. Backups protect service metadata, not an indefinite source archive. Restore respects expired/revoked publication states.

Deploy API/web/worker separately with version-compatible schemas. Database migrations are backwards-compatible within a rollout. Existing immutable artifacts retain their versions; new analyzer versions create new content keys. Canary the authored demo and a bounded public fixture before wider traffic. Public hosted launch requires security/resource gates; local preview can precede it.

## 16. Testing and release acceptance gates

### 16.1 Required fixture matrix

| Area | Fixtures and expected assertions |
|---|---|
| Syntax | TS/TSX/JS/JSX/mts/cts/mjs/cjs, declarations, anonymous exports, unsupported Flow/SFC, malformed AST, huge token/deep nesting |
| Imports | ESM value/type/mixed, side effects, barrel/star, import-type, import-equals, literal/nonliteral dynamic import, require shadowing |
| Resolution | Relative extension substitution, Node vs bundler extension differences, paths/base-origin inheritance, exports/imports conditions, workspace self-name, scoped package subpaths |
| Config | JSONC, relative extends, cycle/depth cap, missing external extends, conflicting projects, safe references, generated output absent, ignored plugins |
| Tree | Empty/no-supported-language, ignored/build/vendor files, Unicode/case-distinct names, spaces/newlines, invalid UTF-8, deep paths, symlink, submodule, LFS pointer |
| Metrics | Exact cyclomatic counts with nested callables, comments/multiline tokens, zero-callable file, unique fan-in/out despite duplicate statements, SCC/self-edge/type-only cycles |
| History | Root, normal modify, merge first-parent, shallow missing parent, amended/date-skew chain, pure rename, rename+edit, ambiguous copies, delete/recreate, rename between sampled frames |
| Comparison | Adds/deletes/renames, change-and-revert, null/partial deltas, historical membership vs anchor, selection of absent lineage |
| Security | SSRF URL forms, redirect/DNS bypass, blocked protocols, credential/helper/hooks traps, textconv/extdiff traps, malicious paths/config, source leakage, forged management token |
| Artifacts | Corrupt hash, wrong version, missing chunks, duplicate/dangling IDs, gzip bomb, excessive strings, NaN/infinite/negative dimensions, chunk path traversal |
| Reliability | Kill during every stage, late worker after lease expiry, cancel vs publish race, disk full, crash cleanup, repeated idempotency, storage/DB partial outage |
| Viewer | Keyboard-only, screen reader, touch, reduced motion, zoom/reflow, missing WebGL/context loss, slow/chunk failure, deep links, fixed-plot snapshots |

Fixtures are authored small examples with independent expected facts. Do not generate expected graphs by running the same analyzer under test and then call them correctness goldens. Determinism goldens are useful in addition to independent fact assertions, not as their replacement.

### 16.2 Correctness and coverage gates

1. All declared-supported resolution fixture edges match independent expected targets/kinds; unsupported contexts produce the expected reason, not guessed edges.
2. Strict schema/invariant validation passes for every exported artifact; invalid imported artifacts fail before rendering.
3. Completed runs with the same repoId/commit/options/versions and available object set yield byte-identical canonical graph/history/layout payloads on Windows and Linux across five runs. Envelope time/analysis IDs are excluded as specified. Resource-interrupted partial runs may have different explicit availability boundaries; their content hashes/cache keys must distinguish those outcomes, and they must never replace a complete cache entry.
4. History lineages pass rename, non-sampled rename, ambiguity, and delete/recreate tests. Pure rename does not increase LOC; missing diff is not zero.
5. Fixed plot coordinates are identical in every frame and lens; no overlap or containment failure under randomized small trees plus boundary-sized fixtures.
6. Metric formulas match hand-computed fixtures. Missing history never creates a full hotspot score; partial availability is visible everywhere a score is used.
7. Report empirical resolved/import coverage on at least three pinned real public TS/JS repositories (single package, workspace monorepo, mixed TS/JS). High coverage is desirable but not faked; every unresolved category is inspectable. No arbitrary target percentage substitutes for fixture correctness.

### 16.3 Security gates, mandatory before hosted launch

- Prove repository scripts never run: fixtures contain hooks/config/plugins/filters/helpers that write sentinel files; no sentinel may appear.
- Prove analysis has no outbound connectivity; test network probes and missing-blob lazy-fetch attempts.
- All URL/redirect/DNS/path adversarial fixtures are rejected or safely represented as documented.
- Parser/decompressor/large-graph tests hit externally enforced caps and kill process groups, preserving API responsiveness.
- Tokens/source/author emails/absolute paths never appear in artifacts or captured logs; verify error paths too.
- Management token for job A cannot cancel/delete B; stale lease cannot publish; private/revoked repo cannot expose manifest or chunk.
- Cross-origin local-server reads/mutations and arbitrary blob/path requests fail. Browser-only artifact opening makes no upload/network source request.
- Scratch cleanup/reaper and artifact expiry/revocation are exercised under simulated clock advancement and crash.

Use an external clock abstraction for time-based tests; do not wait seven actual days. A security gate cannot be waived because the demo is attractive. Record any third-party parser/Git vulnerabilities and patch toolchain before release; do not claim that sandboxing makes parsers risk-free.

### 16.4 Interaction and visual gates

Run browser end-to-end tests for both ingestion routes, all four pillars, selection/search/deep link, history/compare, partial analysis, export, and renderer fallback. Verify pixel/layout references on a pinned browser environment with reasonable tolerance; independently assert canonical geometry exactly. Cross-GPU screenshot identity is not a requirement.

Automated accessibility checks pass without serious/critical findings, then manual keyboard and screen-reader tasks pass. Capture at least one Windows screen-reader/browser combination and one additional supported platform/browser combination. Performance targets in section 15 pass with reports. GPU/heap usage stabilizes across ten artifact open/close cycles and repeated frame/lens changes; no monotonic resource leak.

### 16.5 Release definition of done

All mandatory phase gates pass, all four pillars work on local and hosted routes, schema/CLI/API docs match implementation, demo is reproducible, limitations are visible, no P0/P1 known correctness/security/usability defects remain, and the operator can cancel, expire, purge, and recover jobs. Lower-priority defects need explicit release notes and owner. Runtime-related work remains absent.

## 17. Phased implementation backlog

Task IDs are dependency anchors. Each task delivers working code plus the specific evidence stated. Complete serially or in an explicitly authorized team workflow; this plan does not itself authorize subagents. No phase is complete based on screenshots alone. Every phase ends with a usable artifact/behavior and a short handoff record.

### Phase 0 — Prove constraints and lock contracts

**Dependency:** none. **Milestone M0:** a decision-tested, version-pinned skeleton.

| Task | Dependencies | Concrete work and deliverable | Completion evidence |
|---|---|---|---|
| P0.1 Toolchain/skeleton | none | Create workspace/package boundaries, strict TS, lockfile, CI on Windows/Linux, documented runtime/Git prerequisites | Clean install/build and dependency-direction checks |
| P0.2 TS resolver spike | P0.1 | Implement virtual FS prototype for relative imports, paths inheritance, Node/bundler differences, two workspace packages/exports and references | Independent fixture targets and confidence/reason output; ADR if scope differs |
| P0.3 Safe Git/object spike | P0.1 | Bare filtered GitHub acquisition and sanitized local object reader; linked worktree, missing promisor and alternates handling; cancellation caps | No sentinel execution; no arbitrary outbound; bounded bytes/disk; recorded Git capabilities |
| P0.4 Instancing/layout spike | P0.1 | Render 10,000 simple instances and pick by ID; test memory/context fallback; implement basic integer packer | Initial timing/draw-call/heap report; pick correctness and no-overlap assertions |
| P0.5 Contracts/fixtures | P0.2,P0.3 | Runtime schema draft, named metric definitions, authored Git demo, supported capability list, initial OpenAPI/CLI specification | Schema validates handcrafted artifact; fixture expectations reviewed |

**Gate G0:** no unresolved fundamental question about safely reading source, correctly classifying supported imports, or rendering supported size. If a spike fails, narrow the documented support/capability through an ADR before feature work; do not compensate by executing repository installs or enlarging caps.

### Phase 1 — Reliable ingestion and structural artifacts

**Dependency:** G0. **Milestone M1:** local structure-only artifact with complete coverage accounting.

| Task | Dependencies | Concrete work and deliverable | Completion evidence |
|---|---|---|---|
| P1.1 Canonical schema package | P0.5 | Discriminated validators, hash helpers, ID/path rules, JSON Schema, artifact versions, invariants | Good/bad artifact tests and cross-platform canonical hash tests |
| P1.2 Safe committed inventory | P0.3,P1.1 | Object/tree enumeration, file limits/exclusions/roles, symlink/submodule/LFS/encoding accounting | Tree/security fixtures, deterministic accepted-path set |
| P1.3 Package/config discovery | P1.2,P0.2 | Workspace map, JSONC extends/references, precedence, root synthetic package | Monorepo/config fixture hierarchy and warning assertions |
| P1.4 Artifact I/O | P1.1,P1.2 | Canonical gzip chunks/manifest, hashes/size caps, atomic output, browser import validator | Corruption/decompression/path tests; interrupted-write recovery |
| P1.5 Minimal CLI | P1.2,P1.3,P1.4 | doctor/analyze/inspect/verify; options/exit codes; committed-only notice; repoId reuse | CLI end-to-end on Windows/Linux with no network and no source mutation |

**Gate G1:** CLI produces correct package/directory/file hierarchy and explicit omissions for all inventory fixtures; artifacts are reproducible and safe to import. This phase may have no polished city yet.

### Phase 2 — Static analysis, dependency graph, and useful findings

**Dependency:** G1. **Milestone M2:** an inspectable graph supporting the first three pillars.

| Task | Dependencies | Concrete work and deliverable | Completion evidence |
|---|---|---|---|
| P2.1 Parser facts | P1.1,P1.2 | All supported TS/JS forms, import/type/reexport/require scope, declarations, ranges, parse status | Syntax/import fixtures with exact ranges; malformed/huge-file containment |
| P2.2 Resolver implementation | P2.1,P1.3 | Safe compiler host, workspace fallback, builtins/externals/resource outcomes, reason/confidence rules | Full declared resolution matrix and no host/network fallback |
| P2.3 Graph aggregation/queries | P2.2 | Edge grouping, adjacency, unique degrees, package rollups, bounded reach queries | Duplicate-edge/rollup/direction assertions; dense fixture cap behavior |
| P2.4 Metrics/rules | P2.1,P2.3 | Lines, callable complexity, SCC/witness, static rule registry, null semantics | Hand-computed metrics and SCC fixtures; deterministic findings |
| P2.5 Parser isolation/cache | P2.1,P2.2 | Child resource limits, blob-fact and context-aware caches, deterministic parallel merge | Timeout/kill tests; config/target-change cache invalidation tests |
| P2.6 Functional viewer/serve | P1.4,P1.5,P2.3,P2.4 | Shared HTML tree/search/inspector, local loopback session, source attachment, artifact opening | First three pillar journeys keyboard-only, no upload, source access restrictions |

**Gate G2:** a developer can find files, inspect static dependencies and limitations, and explain diagnostics in the functional viewer. Graph fixtures pass; medium HEAD analysis budget passes or has a documented measured optimization task before advancing.

### Phase 3 — Miniature city and polished navigation

**Dependency:** G2; render spike P0.4. **Milestone M3:** visually complete HEAD city with accessible fallback.

| Task | Dependencies | Concrete work and deliverable | Completion evidence |
|---|---|---|---|
| P3.1 Production layout | P2.3,P0.4 | Versioned square-shelf packing, district hierarchy, plots, external anchors, seeded style | Exact determinism, containment/no-overlap tests, large union benchmark |
| P3.2 Instanced renderer | P3.1,P2.6 | Geometry/material batches, role forms, height, camera, picking, bounds/disposal | Small/medium/large visual references, instance selection, stable heap/GPU cycles |
| P3.3 Navigation synchronization | P3.2,P2.6 | Search/tree/building selection, breadcrumbs/focus, safe view fragments, table/map mode | Round-trip deep links; stale async selection prevention |
| P3.4 Lenses and dependency overlays | P3.2,P2.4 | Structure/complexity/fan-in lenses, legends, incoming/outgoing arcs, aggregation/caps | Direction/kind/limit tests and interpretable inspector values |
| P3.5 Accessibility/responsive | P3.3,P3.4 | Keyboard, screen-reader semantics, touch, reduced motion, contrast, reflow/context fallback | Automated and manual task pass with canvas disabled |
| P3.6 Export/performance | P3.2,P3.4,P3.5 | Bounded PNG export/metadata, LOD, worker query/indexing, first-load optimization | Export references and section 15 interactive budgets |

**Gate G3:** city looks deliberately stylized, is readable, matches graph truth, and keeps the first three pillars fully usable through HTML. Performance is proven with dense as well as visually convenient fixtures.

### Phase 4 — Git evolution and stable temporal city

**Dependency:** G2 for data; G3 for temporal UI. **Milestone M4:** complete local four-pillar product.

| Task | Dependencies | Concrete work and deliverable | Completion evidence |
|---|---|---|---|
| P4.1 Bounded mainline history | P1.2,P0.3 | Parent walk/window, root/merge/shallow boundary, safe diff/numstat, change availability | History fixtures; exact requested/observed boundary reports |
| P4.2 Lineage and frame selection | P4.1,P1.1 | Rename continuity/ambiguity/delete-recreate, all-commit processing, 12-frame index selection | Rename-between-frames and date-skew assertions |
| P4.3 Historical graph reuse | P4.2,P2.5 | Parse/resolve selected frames with cache, HEAD checkpoint, history budget degradation | Complete frame invariants; large temporal deadline/bytes tests |
| P4.4 Churn/hotspots/co-change | P4.1,P4.2,P2.4 | Prior-window metrics, HEAD cohort baseline, null/partial score rules, pair caps | Independent change/rank calculations; no later-commit churn leakage |
| P4.5 Union layout/compare | P4.2,P4.3,P3.1 | Latest-path anchors, fixed plots, per-frame heights/presence, graph/metric diff | Coordinate invariance and moved-file historical membership tests |
| P4.6 History UI | P4.4,P4.5,P3.3 | Sampled snapshot strip, async LRU, A/B compare, tombstones, rename list, churn/hotspot lenses | Full four-pillar local journey with reduced motion and absent selection |

**Gate G4:** local V0.1 satisfies all four pillars. History cannot relabel missing data as zero or reshuffle the city. Sampled frames/window and anchor semantics are obvious to the user.

### Phase 5 — Hosted public GitHub service

**Dependency:** G4 and security isolation spike. **Milestone M5:** hybrid product with controlled public preview.

| Task | Dependencies | Concrete work and deliverable | Completion evidence |
|---|---|---|---|
| P5.1 API admission/auth | P1.1,P0.3 | URL validation/identity, capabilities, session/management token, idempotency, quota/error schemas | Malformed URL/authorization/idempotency and privacy tests |
| P5.2 Queue and worker leases | P5.1 | Postgres migrations, transactional enqueue/claim/heartbeat/fencing, cancellation/retry | Crash/reaper/cancel-vs-publish and multiple-worker race tests |
| P5.3 Isolated acquisition/analysis | P5.2,P4.3 | Egress broker, per-stage network policy, external caps, checkpoint recovery and cleanup | Mandatory execution/network/resource security gates |
| P5.4 Publication/storage lifecycle | P5.3,P1.4 | Private object storage, atomic validated publication, cache refs, expiry, visibility revalidation/purge | Token isolation, chunk authorization, private/deleted repo and storage failure tests |
| P5.5 Hosted flow/SSE | P5.1,P5.2,P5.4,P4.6 | Landing public notice, stage/count UI, cancel, reconnect/poll, immutable share URLs | Hosted success/partial/failure/cancel journeys; no token in URLs |
| P5.6 Deploy/runbooks | P5.4,P5.5 | Compose/dev environment, deployment definitions, secrets/config guide, metrics, purge/capacity runbooks | Fresh environment demo; operator cancellation/purge and rollback rehearsal |

**Gate G5:** both routes use the same analyzer/contracts/viewer; public preview passes every mandatory hosted security gate. No private repository support or automatic local upload is added incidentally.

### Phase 6 — Release validation and handoff

**Dependency:** G5. **Milestone M6:** documented V0.1 release candidate.

| Task | Dependencies | Concrete work and deliverable | Completion evidence |
|---|---|---|---|
| P6.1 Real-repository validation | G5 | Three pinned public repo artifacts and limitations/coverage report; compare independent expected examples | Supported edges/roles spot checked with documented cases |
| P6.2 Full capacity/reliability suite | P6.1 | Repeated benchmark matrix, disk/OOM/timeout/upstream/lease faults, resource leak checks | Published reports meeting section 15/16 gates |
| P6.3 Usability/accessibility polish | P6.1 | Five-developer task review, manual assistive tests, fixes, coherent visual captures | Product task success gate and accessible equivalents pass |
| P6.4 Documentation/distribution | P6.2,P6.3 | CLI packaging, API/schema docs, architecture ADRs, limits/privacy, demo recipe, release notes | Fresh install/local offline/hosted demo reproduction by reviewer |
| P6.5 Release audit | P6.4 | Trace all requirements to evidence; list known defects, deferred runtime scope, operator recovery | V0.1 definition of done signed off; no undocumented scope holes |

### Critical path and first implementation session

Critical data path: `P0.2/P0.3 -> P1 inventory/contracts -> P2 parse/resolve/metrics -> P4 history -> P5 isolation/publication`. Visual path: `P0.4 -> P2.6 -> P3 layout/renderer -> P4.6 -> P5.5`. Do not build the hosted UI around a mocked analyzer and postpone the difficult semantics until launch.

The first implementation session must deliver P0.1 plus small P0.2/P0.3 evidence: a tiny repo with TS/JS, an alias, a workspace import, a type import, a hook sentinel, and a rename. Resolve facts and read committed blobs safely. Write the actual locked versions and any changed ADRs. Only then treat the stack and coverage promises as verified.

Effort is intentionally gated by evidence rather than fixed calendar dates. A single agent should complete one task group, run its relevant checks, and hand off the state before expanding scope. Performance/security spike outcomes can change effort substantially; avoid a false promise of a weekend implementation.

## 18. Risks and mitigations

| Risk | Likelihood/impact | Mitigation and trigger for reconsideration |
|---|---|---|
| TS/JS ecosystem aliases exceed safe static context | high/high | Explicit capability/reason matrix; no executable configs; add narrowly tested resolver rules only through ADR |
| Filtered/shallow Git acquisition fetches unexpectedly large history | medium/high | Network/disk/deadline enforcement, HEAD checkpoint, first-parent coverage, bounded fallback; reduce hosted eligibility if containment cannot be proven |
| Compiler parser/resolver version changes graph semantics | medium/high | Pin versions, version caches/metrics, independent fixtures, new immutable artifacts on upgrade |
| File rename inference is wrong | medium/medium | 80% policy, ambiguity handling, bounded lineage guarantee, expose provenance; favor add/delete over false continuity |
| Historical fixed plots misrepresent old folder geography | certain/medium | Latest-path anchor note, actual tree membership, historical highlights; never label anchor boundary as historical truth |
| Size/heat scores are read as quality judgment | high/medium | Named metrics, raw evidence, null semantics, separate cohorts, no repository quality badge |
| Large/dense graphs swamp frontend | high/high | Instancing/LOD/bounded overlays/worker queries and map/table; lower support ceiling if measured gates fail |
| Hosted submissions exhaust budget or quota | medium/high | Admission/byte/time caps, durable queue, worker slots, conditional upstream checks; reduce concurrency before raising limits |
| Public repository becomes private/deleted | medium/high | Visibility revalidation on access, private storage, short access cache, expiry/purge; local downloads disclosed as irrevocable |
| Local Git config or object store escapes safe reader | medium/high | Sanitized generated Git metadata, alternates rejection, no worktree/config execution, sentinel tests; unsupported advanced layouts fail clearly |
| Security containment only exists in documentation | medium/high | Network/process/resource tests are mandatory release gates; block hosted launch until demonstrated |
| Canonical schema grows into an unbounded analytics platform | high/medium | File-level nodes, bounded evidence, named extension boundary, defer call graph/runtime/SARIF/transitive lock graph |
| Markdown plan diverges from implementation | high/medium | Task evidence/ADR updates at each phase, generated API/schema docs, explicit release traceability |

Risk owner roles: analyzer maintainer owns resolution/metrics; graph/history maintainer owns identity/temporal behavior; frontend maintainer owns rendering/accessibility; service operator owns acquisition/isolation/publication. One coding agent may fill all roles, but each risk still needs an explicit check and human-readable result.

## 19. Architecture decision records

These accepted ADRs are the baseline. Copy into `docs/adr/` with implementation evidence; if changing one, supersede it rather than silently rewriting product semantics.

### ADR-001 — File buildings and a canonical graph

**Context:** symbol-level cities inflate scale and have unstable identities.  
**Decision:** one included file lineage per plot; declarations remain bounded metadata; graph schema independent of renderer.  
**Alternatives rejected:** function/class buildings; renderer-specific JSON as the only model.  
**Consequences:** useful structural exploration with predictable size; no symbol/call-graph promise.  
**Review trigger:** a separate, validated symbol navigation feature after V0.1.

### ADR-002 — TS/JS first using a constrained compiler API

**Context:** parser syntax and module resolution are language/ecosystem-specific.  
**Decision:** pinned TypeScript syntax/resolver via virtual FS, safe config subset, explicit confidence.  
**Alternatives rejected:** regex extraction, full dependency install/typecheck, all-language generic import guesses.  
**Consequences:** no execution; incomplete external/framework contexts are visible; fixtures drive fidelity.  
**Review trigger:** a required resolver behavior cannot be represented safely; narrow scope before adopting another parser/resolver.

### ADR-003 — Shared local/hosted analysis with separate acquisition

**Context:** private local analysis and public hosted convenience need different trust boundaries.  
**Decision:** identical canonical analyzer/artifact/viewer, separate local and GitHub acquisition adapters; no automatic local upload.  
**Alternatives rejected:** cloud-only service, divergent analyzers, arbitrary hosted repository URLs.  
**Consequences:** offline route works; host has explicit public/expiry semantics.  
**Review trigger:** authenticated/private hosted repositories, requiring a new ownership/access model.

### ADR-004 — Read Git objects without executing repositories

**Context:** checkout/install/build can trigger untrusted tools, links, or heavy content.  
**Decision:** bare object acquisition, virtual files, no hooks/filter/submodule/LFS/config execution; offline parser stage.  
**Alternatives rejected:** checkout plus npm install; generic unrestricted cloning.  
**Consequences:** generated outputs and external types may be absent; advanced local object layouts are unsupported.  
**Review trigger:** Git filter/transport constraints fail spike; an alternate acquisition needs the same caps and safety gates.

### ADR-005 — Deterministic hierarchical square-shelf city

**Context:** force layout destroys folder orientation and temporal stability.  
**Decision:** integer hierarchical districts, constant plots, seeded building variants, logarithmic height, dependencies as overlays.  
**Alternatives rejected:** force-directed layout, semantic clusters as default districts, size-changing footprints.  
**Consequences:** comprehensible and testable geometry; possible wasted space and less organic roads.  
**Review trigger:** measured usability/layout density problems; a new layout version must preserve explicit temporal semantics.

### ADR-006 — Bounded first-parent history and sampled frames

**Context:** full Git DAG analysis is expensive and the UI cannot explain every branch at once.  
**Decision:** 90-day contiguous first-parent window, 200 commits, at most 12 graph frames; one additional parent for boundary diff when available.  
**Alternatives rejected:** every commit graph snapshot; author/branch league tables; full-lifetime churn.  
**Consequences:** understandable mainline evolution; merge effects and sampling disclosed.  
**Review trigger:** users need branch-specific architecture comparison; design it as new scope.

### ADR-007 — Occurrence identity separate from bounded lineage

**Context:** paths alone lose renames; content hashes conflate copies and identical files.  
**Decision:** snapshot occurrence IDs plus conservative history lineage; delete/recreate is new; copies do not preserve identity.  
**Alternatives rejected:** permanent path IDs, blob hashes as file identity, heuristic global name matching.  
**Consequences:** honest continuity; cross-window IDs may change.  
**Review trigger:** cross-artifact comparisons require an explicit mapping protocol.

### ADR-008 — Latest-path anchors for stable historical plots

**Context:** preserving exact historical geography and perfectly fixed coordinates conflict when files move.  
**Decision:** latest present path anchors layout; historical membership/path stays exact in tree/inspector/highlights.  
**Alternatives rejected:** full relayout at every frame; ghost districts implying false paths.  
**Consequences:** orientation stays stable; historical district geography needs explanation.  
**Review trigger:** usability review shows anchoring is confusing; reconsider a separate historical-geography mode, not silent plot drift.

### ADR-009 — Evidence-based heuristics rather than quality scores

**Context:** static metrics do not prove correctness, risk, or runtime importance.  
**Decision:** named raw lenses; documented repository-relative hotspot score; null when prerequisites absent; exact rule evidence.  
**Alternatives rejected:** health grade, AI-generated certainty, red-fire danger metaphors.  
**Consequences:** developers can inspect evidence; rankings are intentionally limited.  
**Review trigger:** validated usefulness study suggests new metrics; version definitions/cohorts before changing ranking.

### ADR-010 — Durable async hosted jobs with PostgreSQL queue

**Context:** analysis exceeds request lifetimes and needs cancellation/recovery/resource isolation.  
**Decision:** small REST/SSE API, leased DB queue, separate worker/sandbox, private object storage.  
**Alternatives rejected:** parse in API/serverless request; premature Redis/Kafka/distributed graph store.  
**Consequences:** fewer moving parts but explicit lease/reaper implementation.  
**Review trigger:** measured queue contention or scale exceeds Postgres design; migrate with preserved job semantics.

### ADR-011 — Expiring public artifacts, source-free persistence

**Context:** public repositories can change visibility; metadata and source have different retention needs.  
**Decision:** no source text/author emails/messages in stored artifacts; seven-day public publication; access-time visibility check and purge.  
**Alternatives rejected:** permanent anonymous publication; raw source archive; opaque signed URL as sole privacy control.  
**Consequences:** share links expire, local copies cannot be recalled, upstream outages may block reads.  
**Review trigger:** persistent user-owned publishing needs authentication, explicit retention, and deletion ownership.

### ADR-012 — Runtime pillar deferred in full

**Context:** tracing requires instrumentation, execution context, storage, privacy, and a different interpretation of edges.  
**Decision:** no runtime implementation/dependencies/endpoints/UX in V0.1; reserve an extension boundary only.  
**Alternatives rejected:** placeholder live panels, synthetic traffic, premature telemetry SDK.  
**Consequences:** four pillars can reach a coherent release; static evidence stays honest.  
**Review trigger:** an explicit post-V0.1 runtime product specification.

## 20. Agent execution and handoff requirements

### 20.1 Working rules

1. Read this plan plus applicable repository instructions; use the user's scope if they conflict. Do not infer permission to execute downloaded repository code.
2. Start with Phase 0. Record locked versions and spike evidence, then update changed ADRs before dependent code.
3. Keep a short `docs/implementation-status.md` with task IDs, done/active/blocked status, checks run, artifact locations, and next task. Do not mark tasks done with missing evidence.
4. Implement a narrow working path per phase. Use real analyzer artifacts throughout; temporary mocks must be isolated and removed from release journeys.
5. Preserve package boundaries and runtime schemas. Do not introduce generic metadata that bypasses graph invariants to finish faster.
6. Run relevant correctness/security checks at each task, then broaden at phase gates. When a check fails, fix the cause or document a scoped decision; do not weaken expected data to match the bug.
7. Keep runtime, private hosting, call graphs, language expansion, AI summaries, and repository execution out of the release. Useful extras wait until required gates pass.
8. Treat caps, omissions, and null metrics as product behavior. Error and partial states require the same attention as a successful demo.
9. Update schemas/OpenAPI/CLI docs/ADRs with contract changes. Changing graph identity or metric definitions changes versions/cache keys.
10. Hand the reviewer a reproducible result: command, immutable fixture commit, artifact, screenshot where useful, and the acceptance report. Do not claim testing you did not run.

### 20.2 Required final deliverables from implementation

- Working workspace source and pinned toolchain/lockfile.
- Installable CLI with offline viewer and documented local object limitations.
- Hosted web/API/worker deployment configuration and minimum operator runbooks.
- Versioned runtime schemas, generated JSON Schema/OpenAPI, sample valid artifacts.
- Authored demo repository/history and reproducible demo artifact.
- Independent syntax/resolution/metrics/history fixtures and adversarial security tests.
- Performance, accessibility, visual, and real-repository coverage reports.
- Accepted/superseded ADRs with spike evidence and any remaining known limitations.
- Release checklist mapping each of the four pillars to passed gates; explicit runtime deferral.

### 20.3 Requirement traceability map

| Requirement | Main spec sections | Implementation milestone | Required gate |
|---|---|---|---|
| Exact V0.1 scope and language support | 1–4 | M0/M2 | G0/G2 + resolution fixtures |
| Canonical graph, identity, artifact | 6–7 | M1/M4 | G1/G4 + cross-platform determinism |
| Safe hybrid ingestion | 5,8,13–14 | M1/M5 | G1/G5 + security gates |
| Structure/navigation | 3,9,11–12 | M2/M3 | G2/G3 + user task success |
| Dependencies | 6,9–12 | M2/M3 | G2/G3 + independent targets |
| Diagnostics/hotspots | 10,12 | M2/M4 | G2/G4 + metric/null semantics |
| Git evolution | 7,11–12 | M4 | G4 + lineage/compare fixtures |
| Performance/accessibility | 12,15–16 | M3/M6 | G3/M6 reports |
| HTTP API/CLI/reliability | 13–16 | M1/M5/M6 | CLI/API/race/offline checks |
| Runtime deferral | 1,19 ADR-012 | Every milestone | Release dependency/route/UX audit |

### 20.4 First prompt to the implementing agent

> Build Project ATLAS V0.1 according to this master plan. Begin with Phase 0 and prove the virtual TS resolver, safe Git object ingestion, and large instanced rendering constraints. Implement the four required pillars through the phased gates: repository structure/navigation, static dependencies, diagnostics/hotspots, and bounded Git history/evolution. Use a stylized miniature city and the shared hybrid local/hosted architecture. Do not implement runtime tracing or execute repository code. Maintain task status, evidence, schemas, and ADRs. Resolve routine implementation choices within this specification, document any failed assumptions, and deliver a reproducible working artifact at each milestone before expanding scope.

## 21. Primary technical references

These references justify platform behavior and constraints; ATLAS-specific formulas, limits, data contracts, and product choices are defined by this plan. Verify pinned APIs during Phase 0; source documentation may evolve after this document's date.

- [TypeScript module reference](https://www.typescriptlang.org/docs/handbook/modules/reference) — compiler resolution and package/path semantics.
- [TypeScript moduleResolution options](https://www.typescriptlang.org/tsconfig/moduleResolution) — differences between supported resolver modes.
- [TypeScript project references](https://www.typescriptlang.org/docs/handbook/project-references) — build/reference boundaries and declaration outputs.
- [Git clone documentation](https://git-scm.com/docs/git-clone) — bare/shallow/filter acquisition options and their limitations.
- [Git diff documentation](https://git-scm.com/docs/git-diff) — rename detection, external diff/text conversion, and machine-readable diff options.
- [Git log documentation](https://git-scm.com/docs/git-log) — parent traversal and history semantics.
- [GitHub REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) — upstream admission/backoff behavior.
- [GitHub archive endpoints](https://docs.github.com/en/rest/repos/repos#download-a-repository-archive-tar) — relevant only if acquisition is explicitly changed to archives.
- [OWASP SSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) — application and network destination controls.
- [Three.js InstancedMesh](https://threejs.org/docs/pages/InstancedMesh.html) — instancing, bounds, and resource lifecycle.
- [W3C WCAG 2.2 quick reference](https://www.w3.org/WAI/WCAG22/quickref/) — applicable accessibility acceptance criteria.

---

**Release boundary:** a useful, beautiful, explainable static repository city with bounded Git evolution. Runtime instrumentation is a future product and must remain outside V0.1.
