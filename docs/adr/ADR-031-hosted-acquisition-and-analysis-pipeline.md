# ADR-031: Hosted acquisition and analysis pipeline

Date: 2026-10-11. Status: accepted (P5.3). Builds on ADR-016 (safe Git), ADR-029 (leases) and ADR-030 (offline container policy).

## Problem

The hosted service must analyze untrusted public repositories with the same analyzer as the CLI. The plan sets these boundaries (§5.1, §8.3, §8.6):

- acquisition reaches only GitHub;
- analysis reaches no network at all;
- the API never touches repository data;
- every limit is enforced outside the analyzed process;
- a complete HEAD result survives a failure during history.

## Decision

### Three sandbox roles, one immutable image

`deploy/sandbox.Dockerfile` builds one image: Node 24.15.0 on Debian 13 (pinned by digest), Git 2.47.3 pinned by package version, and the compiled worker closure. Workers reference it only by image ID (`sha256:…`) and run it with `--pull=never`. Every container:

- runs as uid 10001 on a read-only root, with all capabilities dropped and `no-new-privileges`;
- has its CPU, memory (swap disabled), PID and file-descriptor caps set;
- has noexec tmpfs scratch and logging disabled;
- is labelled for reconciliation and force-removed after use, including on abort and deadline.

Limits may only be lowered.

| Role | Network | Mounts | Caps |
|---|---|---|---|
| `broker` | Default bridge (egress) and the job's internal network | None | 128 MiB, 1 CPU, 16 PIDs |
| `acquisition` | Per-job `--internal` network only (no route out) | Job directory (read-write); a trusted fixture (read-only) in development | 512 MiB, 2 CPUs, 32 PIDs |
| `analysis` | `none` | Acquired object store, read-only | 2 GiB, 4 CPUs, 64 PIDs, 1 GiB scratch |

### Egress broker

The broker (`@atlas/ingest` `startEgressBroker`) is an HTTP CONNECT proxy. It:

- accepts only `github.com:443` and `api.github.com:443`, refusing IP literals, other ports and plain HTTP;
- resolves the name itself and refuses the whole answer if any address is not public unicast. The policy covers private, loopback, link-local, metadata, multicast, documentation, NAT64, 6to4 and Teredo ranges, and refuses IPv4-mapped IPv6 outright;
- dials the validated address (pinned), so a second resolution can never redirect the connection;
- keeps TLS end to end, so Git still verifies `github.com` itself;
- counts bytes in both directions against one budget (256 MiB per attempt). Exceeding it closes every tunnel; the job then publishes the HEAD checkpoint, or fails before it exists.

GitHub metadata calls in trusted processes use `pinnedFetch` with the same policy:

- byte accounting by wire counters, because a TLS-wrapped socket emits no `data` events of its own;
- redirects are never followed;
- an optional minimum-scope token is sent only to `api.github.com`.

A PostgreSQL-shared `UpstreamGate` honours quota headers and `Retry-After` for every process, so one throttled answer stops a retry storm.

### Acquisition

Git runs inside the acquisition container through the broker (`http.proxy`). It fetches into an ATLAS-generated bare repository using the ADR-016 hardening, with packs kept packed (`fetch.unpackLimit=1`). The stages are:

1. HEAD: depth 1, unfiltered.
2. History: the same repository deepened to 201 in a fresh container. Configuration, hooks and alternates are regenerated on reuse.

Blobs are fetched with the window, not by later broker requests. Sizes, binary detection, rename similarity and line counts all need blob content, so per-object requests would need the analysis to run twice. Plan §8.3 allows a bounded unfiltered window when the filtered workflow does not fit, as long as the same caps apply. The broker's network budget is authoritative, and a host-side directory watchdog is the second counter. `blob:none` plus explicit broker requests stays implemented for tools that need only trees.

### Analysis and output

The analysis container runs `analyzeCommit` offline over the read-only store. It writes nothing outside its tmpfs and reports on stdout in a framed protocol:

- progress, files and one result;
- capped at 28 MiB in total, with artifact file names checked against the manifest grammar.

The coordinator treats that output as untrusted. It writes the files and runs the full streaming validator (`verifyArtifactDirectory`). It then checks identity a sandbox could not satisfy by accident:

- repository numeric ID, owner and name, and `repoId`;
- commit;
- analyzer version;
- expected history state.

### HEAD checkpoint

With history requested, the coordinator:

1. Analyzes HEAD with history marked unavailable (`historyUnavailable: HISTORY_NOT_ACQUIRED`, boundary `resource-cap`).
2. Verifies that result, uploads it and records it in `job_checkpoints`.
3. Only then deepens acquisition.

If history acquisition, analysis or verification fails, or the deadline nears (the coordinator stops 8 s early and keeps a publication reserve), the verified checkpoint is published as PARTIAL. Its job warnings say why. A retry after a crash finds the checkpoint, skips the HEAD stage and still falls back to it. Cancellation and lost leases never publish.

### Orchestration and cancellation

A `LeaseMonitor` polls the job every second and heartbeats every 10 s, both on database time. Cancellation, lost leases and the deadline all abort one signal. That signal removes the running containers before the coordinator acknowledges anything (ADR-029: cancel and publication serialize on the job row).

Each attempt gets fresh scratch, removed afterwards. Worker startup removes every labelled sandbox container and network left by a crashed coordinator.

Development uses `ProcessStageRunners`: the same entrypoints and protocol as child processes, with no isolation. These runners are accepted only with `ATLAS_DEVELOPMENT=1` and fixture repositories. Every job they run carries the `PROCESS_ISOLATION_ONLY` warning.

## Evidence

Container gates (`apps/worker/test/sandbox-pipeline.test.ts`), run against Docker Engine 29.8.1 on the development machine:

- The full journey runs in containers; READY with 12 frames, and no sandbox container or network remains.
- **Sentinels:** the committed traps never fire. They include npm lifecycle scripts, Husky and `core.hooksPath` hooks, a TypeScript plugin, Vite and webpack configs, filter/diff/merge attributes and an `ext::` submodule. The remote is also armed with ADR-016's configuration traps. No sentinel appears on the host, in the acquired store or in the output.
- **Lazy fetch:** an analysis over a `blob:none` store fails with `LOCAL_OBJECT_MISSING` and adds no object.
- **Network isolation:** from the acquisition network, direct TCP to a public address and to the metadata address fails. The broker refuses `example.com`, IP literals and port 22.
- **Live:** `octocat/Hello-World` is acquired only through the broker, with network bytes counted. Spoon-Knife with a 2 KiB budget fails with `REPOSITORY_TOO_LARGE`.

Process-mode pipeline tests (`pipeline.test.ts`, real PostgreSQL and storage) cover:

- stage order and verification;
- cache reuse;
- PARTIAL fallback on the transfer limit and on the deadline;
- failure before the checkpoint;
- cancellation while acquiring HEAD, analyzing HEAD, acquiring history and analyzing history;
- killing a running sandbox;
- crash recovery from the checkpoint;
- cancellation winning over publication;
- rejection of forged sandbox identity.

Unit tests cover the broker, the pinned client and the address policy (55 egress checks).

The review found and fixed three defects:

- A missing blob was read as `BAD`/`-` and became an opaque zero-byte file. `listTree` now fails with `LOCAL_OBJECT_MISSING`.
- `https.request` with `agent: false` ignored the pinned socket and dialed the name itself.
- Local-transport `upload-pack` drops `-c` configuration, so the fixture `safe.directory` exception now lives in a generated global file.

## Consequences

- The per-attempt network budget is per attempt. A crash retry may transfer the window again within the original 300 s deadline.
- A real repository whose window exceeds 256 MiB publishes HEAD only.
- The analyzer runs twice on HEAD when history is requested (about 15 s for the medium fixture) in exchange for the durable checkpoint.
- The coordinator needs a Docker engine, and its job directories must be bind-mountable (uid 10001 writes into them). It is deployed on dedicated hosts, never alongside the API.
- Deployments must still add an egress firewall allowing only the broker hosts to reach GitHub (§8.2). The broker is the application allowlist, not a replacement for network policy.
