# ADR-030: Offline analysis-container isolation spike

Date: 2026-10-10. Status: accepted as partial P5.3 evidence; hosted launch remains blocked.

## Decision

Test the actual Linux container boundary before wiring repository acquisition or publication. The trusted coordinator generates a sandbox name and uses an immutable operator-owned image ID. Docker receives argument arrays with `shell:false`; repository input cannot choose executables, images, environment or flags. The current entrypoint is explicitly a trusted probe, not a repository-analysis endpoint.

Offline analysis policy: network `none`, user 10001, read-only root filesystem, no capabilities, `no-new-privileges`, no host sockets/mounts, four CPU cap, 64 PID cap, 2 GiB memory with swap disabled, and a combined 1 GiB tmpfs budget for `/tmp` and `/scratch`. Scratch is noexec/nosuid/nodev. Limits may be lowered for fixtures, never raised. Logging is disabled in Docker; attached output is byte-capped and never persisted by default.

Cancellation/deadline must remove the **container**, not just kill the Docker CLI. Cleanup always runs with its own bounded control deadline, independent of the aborted request. Interrupted creation also triggers removal; only a confirmed absent container is tolerated. Cleanup failure fails the coordinator and requires operator reconciliation rather than being silently accepted.

## Actual evidence

Seven checks pass locally against Docker Engine 29.8.1 with a Linux Node 24.15.0 image, resolved to immutable ID `sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d`:

- Two policy checks pin every profile cap and reject mutable/injected/raised configuration.
- Kernel/runtime probe proves non-root, read-only root, no host Docker socket, blocked metadata/private/public TCP probes and actual cgroup memory/PID/CPU values.
- An 8 MiB scratch profile hits kernel `ENOSPC`.
- A 64 MiB memory profile kills an allocation-heavy child with SIGKILL. A trusted surviving supervisor proves positive kernel `memory.events` `oom` and `oom_kill` counters, disabled swap and exit 137; the API process remains outside the sandbox.
- A 16-PID profile actually rejects excess child-process creation.
- A stalled program with a child process exceeds its coordinator deadline; the sandbox is force-removed and no labeled probe container remains.

The dedicated Linux CI job repeats PostgreSQL races and these container gates. Ordinary cross-platform verification explicitly skips opt-in container/database checks when their runtime is absent, never substitutes mocks for the isolation evidence.

The first hosted CI run (`a91b16e`, run 38077015611) returned exit 137 but Docker's `.State.OOMKilled` was false behind `--init`. Treating that daemon flag as the sole kernel witness was an unportable test assumption. The revised probe requires the actual cgroup's OOM/allocation counters plus the child signal, rather than accepting an exit code or dropping the memory gate. `oomKilled` in the probe result remains raw Docker metadata, not an authoritative resource diagnosis. Kernel counter meaning: [cgroup v2 memory.events](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory).

## Remaining P5.3 and G5 gates

This spike does **not** prove GitHub acquisition DNS pinning, egress byte accounting, repository-script sentinels inside the final image, parser/lazy-fetch isolation on real repository objects, a durable HEAD checkpoint, per-stage container cancellation, storage cleanup or public publishing. The final analyzer image, input-object mounts, acquisition broker and coordinator must reuse this policy and pass those tests. No public result is served before that work and visibility/storage lifecycle gates pass.

References: [Docker resource constraints](https://docs.docker.com/engine/containers/resource_constraints/), [container runtime options](https://docs.docker.com/engine/containers/run/), plan §8.6 and §16.3.
