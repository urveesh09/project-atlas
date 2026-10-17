# Locked toolchain (P0.1)

Recorded 10 October 2026. Rationale lives in [ADR-013](adr/ADR-013-pin-typescript-6-compiler-api.md) and [ADR-014](adr/ADR-014-toolchain-and-library-pins.md). Every version is exact in `package.json` and `pnpm-lock.yaml`.

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 24.22.0 (`.nvmrc`; `engines: >=24.22.0 <25`) | `engine-strict=true` |
| pnpm | 10.34.6 (`packageManager`) | `npm i -g pnpm@10.34.6` or Corepack |
| Git | ≥ 2.38; verified on 2.55.0.windows.3 | Required by the CLI and tests; diagnosed by `atlas doctor` (P1.5) |

## Libraries

| Package | Version | Used by |
|---|---|---|
| typescript | 6.0.3 | analyzer parser/resolver; workspace type checking |
| smol-toml | 1.9.1 | Python project/Pipfile manifests; BSD-3-Clause, no runtime dependencies |
| web-tree-sitter | 0.27.1 | WASM Python parser runtime; MIT; unchanged grammar pinned separately (ADR-056/062) |
| zod | 4.6.7 | runtime contracts, JSON Schema/OpenAPI generation |
| @noble/hashes | 2.4.0 | SHA-256 for IDs and canonical hashes in the browser; Node uses its identical native SHA-256 ([ADR-037](adr/ADR-037-export-hashing-and-structural-proofs.md)) |
| react / react-dom | 19.3.1 | viewer |
| three | 0.186.1 | viewer 3D layer |
| @react-three/fiber | 9.8.2 | viewer 3D layer |
| vite | 8.3.4 | viewer build; Vitest peer |
| @vitejs/plugin-react | 6.1.2 | viewer build |
| vitest | 5.0.5 | unit/integration tests |
| fast-check | 4.10.2 | development-only bounded property tests with fixed replay seeds (ADR-061) |
| @vitest/coverage-v8 | 5.0.5 | development-only informational coverage, matched to Vitest; no percentage gate |
| playwright | 1.64.1 | rendering spike and browser E2E (Chromium) |
| @axe-core/playwright | 4.14.0 | browser accessibility audits; no rule exclusions added for upgrades |
| @types/node | 24.19.2 | matches the runtime major |

## Verified environments

| Environment | Result |
|---|---|
| Windows 11 Pro 10.0.26200, 12 logical CPUs, 16 GiB, Node 24.15.0, Git 2.55.0 | Full local CI green; live acquisition tests green; render spike on NVIDIA GeForce GT 730 (ANGLE D3D11) |
| Same Windows development host, Node 24.22.0 / pnpm 10.34.6, 2026-10-16 | 742 tests pass (81 service-gated skips), viewer 39/39 in normal and CI modes, four-repository exact-byte corpus, six-stage portable archive smoke; both Linux images build ([ADR-061](adr/ADR-061-dependency-currency-october-2026.md)) |
| GitHub Actions `ubuntu-latest` and `windows-latest` | Configured in `.github/workflows/ci.yml` |
| Same Windows host, Node 24.22.0 / pnpm 10.34.6, Python 3.14.5, 2026-10-16 (M1.5) | 751 tests pass, 81 explicit skips; CPython oracle runs with zero mismatches; five-repo main-build comparison has only declared summary-version changes; new five-repeat dev.7 baseline and relocated CLI/Python smoke pass ([ADR-062](adr/ADR-062-python-parser-runtime-and-analysis-identity.md)) |
