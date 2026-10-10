# ADR-016: Safe Git reading and acquisition, results of the P0.3 spike

**Status:** Accepted, 10 October 2026 (Phase 0, P0.3). Confirms ADR-004 and records interim limits.

**Context:** ADR-004 requires reading committed objects without executing anything from the repository. Plan §8.3 also requires a filtered, shallow, broker-mediated acquisition from GitHub. Both were spiked against real Git 2.55.0 and github.com.

**Decisions and evidence:**

1. **ATLAS-owned metadata directory.** Every Git invocation uses a freshly generated bare `GIT_DIR` with a generated config. The user's repository is used only as `GIT_OBJECT_DIRECTORY` (local adapter), after alternates are rejected.
   - The environment is built from scratch: no inherited variables except `SystemRoot`/`windir`/`ComSpec` on Windows, plus a PATH restricted to Git/system directories.
   - It sets `GIT_CONFIG_NOSYSTEM`, empty global/system config files, `GIT_NO_REPLACE_OBJECTS`, `GIT_NO_LAZY_FETCH`, `GIT_ALLOW_PROTOCOL` (empty offline, `https` for acquisition) and `GIT_TERMINAL_PROMPT=0`.
   - Defense-in-depth `-c` overrides on every call: empty hooksPath, `fsmonitor=false`, empty `diff.external`, empty `credential.helper`, `protocol.allow=never`, and others.
2. **No revision expressions.** Refs are resolved by bounded reads of `HEAD`, loose refs and `packed-refs`, linked-worktree `commondir` included. Results are peeled through tag objects with `cat-file`. Git only ever receives validated full object IDs. Reftable repositories need `--ref <full-sha>` (`LOCAL_OBJECT_STORE_UNSUPPORTED`/`REFTABLE`).
3. **Execution traps never fire.** The trap fixture arms hooks, `core.fsmonitor`, `core.pager`, `core.sshCommand`, `diff.external`, textconv and diff drivers, clean/smudge/process filters, credential helpers, aliases shadowing `cat-file`/`diff-tree`, and an `ext::` promisor remote. With all of these armed, tree listing, blob reads, rename-detecting diffs and missing-object probes leave no sentinel. As a control, ordinary Git honoring the same configuration does create a sentinel, so the assertion is not vacuous. See `packages/ingest/test/local-git.test.ts`.
4. **Filtered acquisition works on GitHub.** A fresh bare repository with a generated promisor config runs `fetch --depth=201 --filter=blob:none --no-tags origin <sha>`. Against `octocat/Hello-World` this fetched 2,388 bytes with no blobs. An offline reader over those objects reports blobs as `missing` and does not lazily fetch them. The explicit broker call `fetch --filter=blob:none --stdin origin` with blob IDs then supplies exactly the requested blobs.
5. **Byte budget containment.** A watchdog polls the scratch directory and kills the Git process tree (`taskkill /T` on Windows, process-group `SIGKILL` on POSIX) when the budget is exceeded. A `microsoft/TypeScript` fetch with a 256 KiB budget failed with `REPOSITORY_TOO_LARGE` in about 1.2 s.

**Interim limits (must close before hosted launch, plan §16.3):**

- The watchdog counts bytes on disk, not network bytes, and runs in-process. Phase 5 must add the external egress proxy/firewall, per-stage network policy and container memory/PID/disk limits. This spike does not substitute for them.
- DNS pinning and private-address blocking are not yet implemented: acquisition only ever connects to the hard-coded `api.github.com` and `github.com` hosts. Phase 5 adds the network-layer controls.
- The live tests are opt-in (`ATLAS_NETWORK_TESTS=1`) locally. They run in a separate CI job.

**Consequences:** No archive download path is needed, so the plan's archive ADR condition does not trigger. Missing objects in partial or local clones surface as `LOCAL_OBJECT_MISSING`, never as a fetch.

**Review trigger:** GitHub stops honoring filtered fetch or blob wants by ID, or a Git upgrade changes any hardened behavior. The trap test must then be re-run before the upgrade lands.
