# ADR-022: Bound canonical serialization allocations and preserve validation

Date: 2026-10-10. Status: accepted.

Profiling the real 3,000-file browser import found approximately 3.8 seconds in indexed decoding/canonical hashing and 2.2 seconds in bundle validation. These gates must remain mandatory: canonical wire/decoded hashes, expansion limits, derived IDs and semantic references are not relaxed.

Reduce allocation costs without changing bytes. Frame hash fields into one well-formed UTF-8 string and encode once instead of allocating separate typed arrays for every field/tag. Canonical JSON joins complete child values instead of retaining millions of tiny punctuation tokens, uses one mutable path stack for error reporting, and bounds quoted-key caching to 512 entries. Numeric formatting and lexicographic numeric-key order stay exact. UTF-8 counting uses native scans across ASCII spans and explicitly counts surrogate pairs. Use platform SHA-256 for large asynchronous artifact hashes where Web Crypto is available, with the existing portable synchronous implementation as fallback. Identity derivation remains synchronous and portable.

Existing immutable graph/history golden hashes, adversarial import tests, independently calculated field hashes and Unicode/numeric-key canonical references must pass. Record production measurements after these changes; targets remain unchanged.

Indexed expansion computes the actual serialized length of the strictly validated wire object with native JSON; key ordering changes no byte count. Arbitrary extensions still receive canonical value/Unicode validation. No artifact-supplied size can bypass this calculation. Indexed decoding derives every node/edge/observation ID; bundle validation does not repeat that same derivation a second time. Plain imports still re-derive IDs, and both paths still check full shape, semantics, decoded length/hash and bundle references. These are internal loader optimizations, never options supplied by artifacts. Public bundle validation defaults to ID verification and indexed decoding always calculates its own wire length.
