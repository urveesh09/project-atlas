# ADR-011: Expiring public artifacts, source-free persistence

**Status:** Accepted (baseline from the V0.1 master plan, 10 October 2026)

**Context:** public repositories can change visibility; metadata and source have different retention needs.

**Decision:** no source text/author emails/messages in stored artifacts; seven-day public publication; access-time visibility check and purge.

**Alternatives rejected:** permanent anonymous publication; raw source archive; opaque signed URL as sole privacy control.

**Consequences:** share links expire, local copies cannot be recalled, upstream outages may block reads.

**Review trigger:** persistent user-owned publishing needs authentication, explicit retention, and deletion ownership.
