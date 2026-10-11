# Locked toolchain (P0.1)

Recorded 10 October 2026. Rationale lives in [ADR-013](adr/ADR-013-pin-typescript-6-compiler-api.md) and [ADR-014](adr/ADR-014-toolchain-and-library-pins.md). Every version is exact in `package.json` and `pnpm-lock.yaml`.

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 24.15.0 (`.nvmrc`; `engines: >=24.15.0 <25`) | `engine-strict=true` |
| pnpm | 10.34.6 (`packageManager`) | `npm i -g pnpm@10.34.6` or Corepack |
| Git | ≥ 2.38; verified on 2.55.0.windows.3 | Required by the CLI and tests; diagnosed by `atlas doctor` (P1.5) |

## Libraries

| Package | Version | Used by |
|---|---|---|
| typescript | 6.0.3 | analyzer parser/resolver; workspace type checking |
| zod | 4.6.5 | runtime contracts, JSON Schema/OpenAPI generation |
| @noble/hashes | 2.4.0 | SHA-256 for IDs and canonical hashes in the browser; Node uses its identical native SHA-256 ([ADR-037](adr/ADR-037-export-hashing-and-structural-proofs.md)) |
| react / react-dom | 19.3.0 | viewer |
| three | 0.186.1 | viewer 3D layer |
| @react-three/fiber | 9.8.1 | viewer 3D layer |
| vite | 8.3.4 | viewer build; Vitest peer |
| @vitejs/plugin-react | 6.1.2 | viewer build |
| vitest | 5.0.3 | unit/integration tests |
| playwright | 1.64.0 | rendering spike and browser E2E (Chromium) |
| @types/node | 24.19.2 | matches the runtime major |

## Verified environments

| Environment | Result |
|---|---|
| Windows 11 Pro 10.0.26200, 12 logical CPUs, 16 GiB, Node 24.15.0, Git 2.55.0 | Full local CI green; live acquisition tests green; render spike on NVIDIA GeForce GT 730 (ANGLE D3D11) |
| GitHub Actions `ubuntu-latest` and `windows-latest` | Configured in `.github/workflows/ci.yml` |
