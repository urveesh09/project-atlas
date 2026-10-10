# ADR-018 — Indexed graph transport without changing canonical identity

**Status:** accepted for implementation; acceptance requires exact round trips, hostile-input checks and the 20-run medium benchmark.
**Date:** 2026-10-10
**Supersedes:** the assumption in plan §6.5 that every graph chunk must store full canonical graph JSON directly. Canonical graph/identity/metric contracts remain unchanged.

## Problem

The existing medium fixture (3,142 files, 30,000 imports) produces 9,711,215 compressed bytes, exceeding the 5 MiB medium target. Unique cryptographic IDs have high entropy; gzip cannot eliminate their repeated storage across observations, edges and evidence. Removing declarations or evidence would reduce developer utility and still not reliably meet the budget.

## Decision

Publish artifact format `atlas.artifact/1.1.0`, retaining readers for 1.0.0. Its graph chunks may use `atlas.graph.indexed/1`: omit node/observation/edge IDs that can be derived exactly from their existing documented inputs, and encode node and observation references as zero-based indices into the canonical ordered arrays. Retain all declarations, evidence, diagnostics, metrics, lineage IDs, confidence and coverage. History/layout remain canonical JSON.

The decoded graph is still `atlas.graph/1.0.0` with the original full SHA-256 IDs. No shortened IDs, collision assumptions, lossy sampling or metric changes are introduced. The canonical order is retained so decoding does not sort away invalid or duplicate rows.

For an indexed chunk, `uncompressedBytes` describes the wire JSON; `encodedSha256` verifies that JSON before decoding. `decodedBytes` bounds reconstructed canonical JSON and `sha256` continues to verify the full canonical graph. Both wire and decoded cumulative sizes obey the existing 100 MiB cap. Existing plain chunks need none of these additional fields. Unknown codecs, incomplete codec metadata, non-graph encoded chunks, invalid indices, excess rows/strings, and inconsistent duplicate manifest references are rejected.

The codec is browser-safe and uses the same runtime definitions as the graph. Decode validates shape and reference indices before reconstructing IDs; the normal graph/bundle invariant validators still run after decoding. Validate full input graphs before encoding so a tampered canonical ID cannot be silently repaired by serialization.

## Alternatives

- Raise the medium budget: rejected before measuring a lossless transport improvement.
- Shorten hashes or replace canonical IDs globally: rejected; identity is a separate concern from serialization.
- Drop evidence/declarations/findings: rejected; changes the product's explainability.
- General dictionary containing every full ID: insufficient for unique observation/edge IDs and more generic decoder complexity than necessary.
- Brotli-only transport: browser compatibility and random-ID entropy remain; does not resolve the structural duplication.

## Acceptance and consequences

Handcrafted and Harbor graphs must round-trip exactly through both the Node and browser decompressors. Legacy artifacts remain readable. Negative cases must retain bounded failures before rendering. The benchmark must report time **and** size separately, with overall pass requiring both; keep the original benchmark for comparison. The new codec adds bounded decoding work, measured in the same benchmark and browser journeys. The master plan's canonical IDs and size limits remain authoritative; this ADR records the transport amendment.
