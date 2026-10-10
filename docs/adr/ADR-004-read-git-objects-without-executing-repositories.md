# ADR-004: Read Git objects without executing repositories

**Status:** Accepted (baseline from the V0.1 master plan, 10 October 2026)

**Context:** checkout/install/build can trigger untrusted tools, links, or heavy content.

**Decision:** bare object acquisition, virtual files, no hooks/filter/submodule/LFS/config execution; offline parser stage.

**Alternatives rejected:** checkout plus npm install; generic unrestricted cloning.

**Consequences:** generated outputs and external types may be absent; advanced local object layouts are unsupported.

**Review trigger:** Git filter/transport constraints fail spike; an alternate acquisition needs the same caps and safety gates.
