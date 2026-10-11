# Start here: ATLAS from zero to release

This is the one ordered guide: what ATLAS is, how to run every part of it, and what is
left before V0.1 can be signed off. Each section links to the detailed document it
summarizes. Commands are PowerShell on Windows. On macOS or Linux, set environment
variables with `export NAME=value`.

## 0. What exists today

| Thing | Where | State |
|---|---|---|
| Source code | <https://github.com/urveesh09/project-atlas> (branch `main`) | All plan phases 0–6 implemented; CI green |
| Local CLI + browser city | Runs on your machine | Works now (section 2) |
| Hosted service (public GitHub repos) | Code in `apps/api`, `apps/worker`, `deploy/` | Runs **locally**; **not deployed to the internet** |
| Portable CLI archive | Built by `pnpm verify:distribution` | Candidate; not a signed release |
| Release sign-off (gate G6) | [release audit](release/release-audit.md) | Open: needs the human checks in section 6 |

There is no public website yet. Nothing is live until someone deploys the hosted service
(section 6, R6-06). The GitHub link is the code repository.

## 1. One-time setup (about 15 minutes)

1. Install **Node.js 24.15.0**: <https://nodejs.org/en/download> (choose v24.15.0). Check
   with `node --version`.
2. Install **pnpm 10.34.6**: `npm install -g pnpm@10.34.6`. Check with `pnpm --version`.
3. Install **Git 2.38 or newer**: <https://git-scm.com/download/win>. Check with `git --version`.
4. *(Only for the hosted service, sections 4–5)* Install **Docker Desktop** and start it.
5. Get the code. You already have it at `C:\Users\Urveesh\Desktop\project-atlas`. On another machine:
   ```powershell
   git clone https://github.com/urveesh09/project-atlas.git
   cd project-atlas
   ```
6. Install and build:
   ```powershell
   pnpm install --frozen-lockfile
   pnpm build
   pnpm build:web
   ```

Details: [toolchain](toolchain.md).

## 2. See it working in five minutes (local, offline)

```powershell
pnpm fixtures:demo                                   # creates the Harbor demo repo; prints its path
pnpm atlas doctor                                    # checks Node, Git, isolation, parser and scratch space
pnpm atlas analyze <path printed above> --out .\atlas-output
pnpm atlas serve .\atlas-output --repo <same path>
```

`serve` opens your browser on a one-time **session link** on `127.0.0.1`. That link is
the key to your local viewer, so don't share it. In the city:

- **Search** for `pricing.ts`, select it, and open the **Dependencies** tab.
- Switch between the **3D**, **Map** and **Table** views.
- Drag the **timeline** to scrub twelve snapshots; compare snapshots 5 and 12.
- Open **Findings** to see the cycle and hotspots, each with its evidence.

Stop the server with Ctrl+C. Other commands are `pnpm atlas inspect .\atlas-output`, a
terminal summary, and `pnpm atlas verify .\atlas-output`, which checks the artifact's integrity.

## 3. Analyze your own repository

```powershell
pnpm atlas analyze C:\path\to\your\repo --out C:\path\to\atlas-output
pnpm atlas serve C:\path\to\atlas-output --repo C:\path\to\your\repo
```

- Only **committed** files are read. ATLAS never installs, builds or runs your repository,
  and never uploads anything.
- Exit code 0 means complete; 2 means a useful but partial result (see `inspect` for
  coverage); 1 means failure.
- Useful flags: `--ref <commit>`, `--no-history`, `--history-days 30`, `--snapshots 6`.
- Supports TypeScript/JavaScript. Limits: 10,000 files per frame, 200 commits,
  12 frames. Full contract: [CLI](contracts/cli.md).

## 4. Run the hosted service on your machine

The hosted service takes a public GitHub URL, analyzes it in sandboxes and publishes a
seven-day link. To try it locally:

**4a. Simplest (no sandboxes; demo repository only).**
```powershell
docker run --detach --name atlas-phase5-postgres --publish 127.0.0.1:55432:5432 `
  --env POSTGRES_PASSWORD=atlas-local-test --env POSTGRES_DB=atlas_test postgres:17-alpine
$env:ATLAS_DATABASE_URL = 'postgres://postgres:atlas-local-test@127.0.0.1:55432/atlas_test'
node scripts/hosted-dev.mjs
```
Open <http://127.0.0.1:8080/>, submit `https://github.com/atlas-demo/harbor` (served
locally as a fixture), accept the public-output notice, and watch the stages.

**4b. Real sandboxes and real GitHub repositories.**
```powershell
docker build -f deploy/sandbox.Dockerfile -t atlas-sandbox:dev .
$img = docker image inspect atlas-sandbox:dev --format '{{.Id}}'
node scripts/hosted-dev.mjs --docker $img --github
```
Submit any small public repository, for example `https://github.com/sindresorhus/is-plain-obj`.
GitHub's anonymous quota is 60 API calls per hour. For more, set `$env:ATLAS_GITHUB_TOKEN`
to a token with public read access only.

**4c. Production-like stack (Docker Compose).** Follow
[hosted development → Compose stack](hosted-development.md#compose-stack).

Details: [hosted development](hosted-development.md), [operations and runbooks](hosted-operations.md).

## 5. Run the checks

```powershell
pnpm verify                  # types, viewer build, dependency rules, contracts, ~600 tests
pnpm verify:distribution     # builds the portable CLI archive and tests it outside the repo
node scripts/validate-real-repositories.mjs --acquire    # once, needs network
node scripts/validate-real-repositories.mjs              # 5 offline repeats × 3 real repos
```

Service-backed tests (PostgreSQL, S3, containers, browser, live GitHub) skip unless
enabled. To run all of them, see [hosted development → Test gates](hosted-development.md#test-gates).
CI runs everything on each push: <https://github.com/urveesh09/project-atlas/actions>.

## 6. What is left before V0.1 release, and how to do each

Code work for every phase is done. These seven items need **people, hardware or
infrastructure**. Each one records its evidence in the file named, and none may be
marked done without real results.

| ID | What | Who | How | Record in |
|---|---|---|---|---|
| R6-01 | Capacity on the **reference machine** (4-core, 2 GiB job, SSD) | You or an operator | On that machine, rerun `node scripts/bench-analysis.mjs --runs 20` and the history container gate: `node scripts/build-history-fixture.mjs`, then `node scripts/bench-history-container.mjs --image <labelled sandbox image> --fixture <printed dir>` | `docs/benchmarks/` (reports are written automatically) |
| R6-02 | Viewer performance on a **reference laptop** (integrated GPU, 8 GiB, 1920×1080), Chromium and Firefox | Device reviewer | `node apps/web/scripts/bench-city.mjs --firefox` on that laptop; also check first load over a throttled 10 Mbps/100 ms network | `docs/benchmarks/` |
| R6-03 | **Five developers** try five tasks without coaching | You recruit; you observe | Follow the [task cards](release/manual-review.md); need ≥ 4 of 5 successes per task | Results table in [manual review](release/manual-review.md) |
| R6-04 | **Screen-reader** audit (NVDA on Windows, plus VoiceOver on Mac) | Accessibility reviewer | Work through the checklist in [manual review](release/manual-review.md#manual-accessibilitydevice-audit) | Same file |
| R6-05 | **Fresh-install** reproduction on a clean machine | Someone other than the author | Section 1 → `pnpm verify:distribution` → extract the archive → follow [candidate guide](release/README.md); compare the archive SHA-256 | [release audit](release/release-audit.md) |
| R6-06 | **Public deployment** (domain, HTTPS, firewall, backups) | Deployment operator | Follow [operations → release procedure](hosted-operations.md#release-procedure); firewall allows only broker → GitHub:443; run the restore/rollback rehearsal (`scripts/hosted-rehearsal.mjs`) on the real infrastructure | [release audit](release/release-audit.md) |
| R6-07 | **Sign-off** | Release owner (you) | Review CI and every report above; no unresolved P0/P1 defects; pick the final commit and archive hash | "Release identity and approval record" in [release audit](release/release-audit.md) |

Suggested order: R6-03 and R6-04 first, because their findings may change the UI. Then
R6-01 and R6-02, then R6-05, R6-06 and R6-07.

## 7. Where everything lives

| Need | Document |
|---|---|
| Rules and pitfalls for coding agents | [AGENTS.md](../AGENTS.md) |
| Product specification | [master plan](plan/PROJECT_ATLAS_V0.1_MASTER_PLAN.md) |
| What is built and its evidence | [implementation status](implementation-status.md) |
| Requirement-by-requirement trace and open items | [release audit](release/release-audit.md) |
| Why things are the way they are | [decision records (ADR-001 … ADR-037)](adr/) |
| Install/demo/privacy for end users | [candidate guide](release/README.md), [release notes](release/release-notes.md) |
| Hosted setup, configuration, runbooks | [hosted development](hosted-development.md), [hosted operations](hosted-operations.md) |
| Contracts | [CLI](contracts/cli.md), [identity](contracts/identity.md), [metrics](contracts/metrics.md), [capabilities and limits](contracts/capabilities.md), [OpenAPI](api/openapi.json) |
| Measurements | [benchmarks](benchmarks/) |
| Real-repository results | [real repositories](release/real-repositories.md) |
