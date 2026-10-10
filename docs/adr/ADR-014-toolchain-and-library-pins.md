# ADR-014: Toolchain and library pins for V0.1

**Status:** Accepted, 10 October 2026 (Phase 0, P0.1). Implements plan §5.2.

**Context:** The plan requires an exact runtime, Git, parser and dependencies, with no floating `latest`. These versions were verified to install and pass the Phase 0 suite on Windows 11 and are the CI baseline on Ubuntu and Windows.

**Decision:** See [`docs/toolchain.md`](../toolchain.md) for the full table. Notable choices:

| Choice | Pin | Reason |
|---|---|---|
| Runtime | Node.js 24.15.0 (LTS line), `engines: >=24.15.0 <25` | Supported LTS at implementation start; ES2024 (`String#isWellFormed`) is used for path and identity validation |
| Package manager | pnpm 10.34.6 (`packageManager`) | Single lockfile and workspace. pnpm 10 blocks dependency lifecycle scripts by default, and `onlyBuiltDependencies` stays empty |
| Runtime contracts | zod 4.6.5 | One schema definition. Zod 4's native `toJSONSchema` generates JSON Schema 2020-12 and OpenAPI 3.1 without a second library |
| Hashing | @noble/hashes 2.4.0 | Synchronous, audited, pure-JS SHA-256 with identical behavior in Node and browsers. Needed because browser `SubtleCrypto` is async-only and IDs are derived in hot paths |
| Viewer | React 19.3.0, Vite 8.3.4, @react-three/fiber 9.8.1, three 0.186.1 | The plan's stack. R3F 9.8 supports React `>=19 <19.4` |
| Tests | Vitest 5.0.3, Playwright 1.64.0 (Chromium) | The plan's stack. Playwright drives the rendering spike and later E2E runs |
| Git | ≥ 2.38 required; developed on 2.55.0 | SHA-256 repositories, `--filter=blob:none`, `GIT_NO_LAZY_FETCH` and `diff-tree --find-renames` are all used |

All dependency versions are exact (`save-exact=true`), and `strict-peer-dependencies` is on.

**Consequences:** Upgrades are deliberate and reviewed. A newer major of any analysis-affecting dependency (TypeScript, Git behavior) needs its own ADR because it can change graph semantics.

**Review trigger:** A security advisory affects a pinned package, or a pinned package leaves its support window.
