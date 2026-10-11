# Phase 5 hosted operator rehearsal

Run 2026-10-11T02:55:07.689Z → 2026-10-11T03:01:24.907Z: **all steps passed**.

Environment: Windows_NT 10.0.26200, 12 CPUs, 16 GiB, Node v24.15.0, git version 2.55.0.windows.3, Docker 29.8.1. Isolation: container. Storage: S3-compatible (Versity gateway).

Fresh database; the real migration job provisions least-privilege API and worker roles; the real API and worker processes run under those roles. Repositories come from authored fixtures served to the acquisition sandbox (no GitHub traffic).

| Step | Result | Time | Evidence |
|---|---|---:|---|
| fresh database, migrations and least-privilege roles | pass | 0.5 s | database: fresh; roles: ["api","worker"] |
| API and worker start under their own roles; ready and metrics answer | pass | 0.6 s | ready: true; queued: 0 |
| public journey: Harbor demo with history, verified through the public routes | pass | 8.1 s | jobId: job_aae9e2ad2a393e3d1c2641d213b6951a; analysisId: analysis_bcfa5fcf735bd8c42dc9c837926ee64032925769f72e51fb6e7e59c486f360b0; seconds: 7.754; frames: 12; files: 26; compressedBytes: 37364 |
| cached reuse: identical submission becomes a new publication without analysis | pass | 1.1 s | seconds: 1.055 |
| medium repository end to end (3,252 files at HEAD, 40 commits, history) | pass | 162.2 s | state: READY; endToEndSeconds: 162.207; warnings: []; frames: 12; files: 3252; compressedBytes: 4919707 |
| operator cancellation during analysis stops the sandbox; nothing is published | pass | 5.5 s | requested: CANCEL_REQUESTED; final: CANCELLED; analysisId: null; sandboxesLeft: 0 |
| worker crash after the HEAD checkpoint: SIGKILL, lease expiry, reap, retry from the checkpoint | pass | 158.7 s | stateAtCrash: HISTORY; final: READY; recoverySeconds: 145.22; warnings: [{"code":"CHECKPOINT_RECOVERED","count":1}]; sandboxesLeft: 0 |
| operator purge revokes one publication and its storage | pass | 0.4 s | purged: true; status: 410; code: ARTIFACT_REVOKED |
| backup and restore preserve publication lifecycle state | pass | 0.5 s | dumpBytes: 30913; publications: 4; revokedPreserved: 1; migrations: 2 |
| rollback guard: a database newer than the binary refuses to serve | pass | 0.6 s | apiExit: 1; migrateExit: 1; reason: {"time":"2026-10-11T03:01:22.811Z","service":"api","event":"api.fatal","error":"Database migrations are not current; run the migration job first"} |
| final operator metrics | pass | 0.3 s | outcomes24h: {"CANCELLED":1,"READY":4}; stageMsP95: {"acquireHead":2620,"acquireHistory":3699,"analyzeHead":7144,"analyzeHistory":74321,"upload":216,"uploadHead":81,"validate":0,"verify":35169,"verifyHead":2189}; publications: {"live":3,"expired":0,"deleted":0,"revoked":1,"awaitingPurge":0}; storage: {"liveObjects":3,"liveBytes":9826086,"pendingUploads":0,"purgingUploads":0}; leases: {"live":0,"expired":0} |

Reproduce: see the header of `scripts/hosted-rehearsal.mjs` and docs/hosted-operations.md.
