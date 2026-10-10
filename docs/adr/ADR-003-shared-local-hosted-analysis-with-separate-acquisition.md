# ADR-003: Shared local/hosted analysis with separate acquisition

**Status:** Accepted (baseline from the V0.1 master plan, 10 October 2026)

**Context:** private local analysis and public hosted convenience need different trust boundaries.

**Decision:** identical canonical analyzer/artifact/viewer, separate local and GitHub acquisition adapters; no automatic local upload.

**Alternatives rejected:** cloud-only service, divergent analyzers, arbitrary hosted repository URLs.

**Consequences:** offline route works; host has explicit public/expiry semantics.

**Review trigger:** authenticated/private hosted repositories, requiring a new ownership/access model.
