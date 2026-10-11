# ADR-037: Native hashing and structural export proofs

Date: 2026-10-11. Status: accepted. Refines [ADR-036](ADR-036-export-base-cache-lifetime.md);
supersedes only its choice of *how* exact equality is proven.

## Evidence and cause

After ADR-036, the large-history fixture (9,992 HEAD files, forty mainline commits,
twelve frames) completed within the 2 GiB job, but not within time. Inside the capacity
container (four CPUs, 2 GiB, no swap, 1536 MiB parent heap) the one-shot diagnostic
on `277f593` took **329.24 s** against the plan's 240 s p95 target, with a cgroup peak
of 2,129,039,360 bytes (99.1% of the limit, zero OOM events).

A stage profile on the development host (272.0 s total) put **183.2 s in assembly and
export**, and the analysis of HEAD plus eleven frames at about 80 s. A CPU profile of
that run attributed:

- 59.6 s self time to the canonical JSON writer, of which about 20 s came from building
  a canonical *form string* for every row of both graphs only to test row equality in
  delta matching, and about 31 s from serializing whole graphs as text in chunks;
- about 38 s to ID hashing through the portable `@noble/hashes` SHA-256, including 12 s
  formatting digests through `Array.from(...).join('')`;
- for each delta frame, three whole-graph serializations: the digest, then the original
  and the decoded graph again to prove the round trip.

## Decision

1. **Native SHA-256 in Node.** `sha256Hex`, incremental digests and therefore every ID
   use `node:crypto` when the runtime provides it, obtained synchronously through
   `process.getBuiltinModule`, so the viewer bundle has no `node:` import. Browsers
   keep the portable implementation. SHA-256 is a fixed standard: tests pin the
   portable path, the native path and an independent `createHash` to one another,
   including multibyte text, binary input and lone surrogates (both encoders substitute
   U+FFFD). Digest hex is built as one flat string from a lookup table.
2. **Structural natural-form matching.** Delta matching keeps a target row when a base
   row has its natural key and an equal natural form. For nodes, observations, edges and
   metrics, the forms are now compared structurally, with reference fields mapped to
   natural keys on each side, instead of being rendered to canonical text first.
   Diagnostics, whose keys *are* their forms, still build form text. Keep/add decisions
   are therefore unchanged.
3. **One serialization proves each frame.** `canonicalValueEqual` decides whether two
   values have identical canonical JSON text without building it: same plain-JSON shape,
   key sets and scalars, with `===` matching canonical number text (−0 is written as 0).
   A value without a canonical form (undefined, NaN, ill-formed strings, functions,
   non-plain objects, holes) is equal to nothing, not even itself. The exporter
   serializes each delta frame once for its manifest digest, then proves that the
   decoded graph equals the original with this exact structural comparison. This
   supersedes ADR-036's text-chunk comparison; it is still exact, and it never
   substitutes a hash check for equality.

No format, identity, analyzer version, natural-matching rule, budget or validation
changes. A codec defect still fails the export.

## Verification

- Targeted suites (schema, artifact, analyzer-core, graph, layout): 270 checks before the
  structural proof, and 225 schema/artifact/analyzer-core checks after it, including
  identity goldens and lossless history round trips. New tests compare structural
  equality with text equality over a value matrix (key order, −0, `Object.create(null)`,
  nested arrays and objects, non-canonical values) and cover the fused digest's
  first-chunk, later-chunk and length mismatches.
- `pnpm verify`: 603 passed; the 80 service-gated tests skip locally and run in CI.
- The offline real corpus (is-plain-obj, Vue, Vite; five cold repeats each) reproduces
  the **exact committed canonical and wire payload digests**
  (`check-repository-baseline.mjs`). CI run [38122325539](https://github.com/urveesh09/project-atlas/actions/runs/38122325539)
  repeats that comparison on Windows and Linux; all jobs pass.
- Development host, same fixture: 272.0 s → 221.9 s (hashing, fused digest) →
  193.5 s (structural matching) → **163.6 s** (structural proof). Assembly fell from
  183.2 s to 95.1 s.
- Capacity container, image built from clean `2a70452`: one-shot diagnostic
  **193.44 s**, twelve frames, complete, cgroup peak 1,965,674,496 bytes, zero OOM events.

## Benchmark process model

The first 20-sample container batch on this image was OOM-killed (exit 137) during its
second run. One benchmark process had kept a live parser pool, and the previous run's
uncollected heap, across samples. Production never has that state: each analysis sandbox
runs one analysis, whose parser pool closes before export. `bench-history.mjs
--isolate-runs` now runs every sample (warm-up included) as a fresh process inside the
same capped cgroup, so the whole-job peak and OOM counters still cover every process. A
failed run is reported and stops the batch. The plan's 2 GiB/240 s targets are unchanged.

The configured heaps can still add up to more than the cgroup (a 1536 MiB parent plus two
parser children at up to 512 MiB each). The kernel limit, not V8, is the real ceiling;
the measured peaks below are the evidence that one analysis stays within it.

## Result

The [process-per-run container report](../benchmarks/phase6-large-history-container.md)
(runtime image `efdc0f78…` from clean `2a70452`; benchmark script `8d14a54`, clean tree)
**passes**. Twenty measured samples after one warm-up, every one complete with twelve frames:
p50 **196.26 s**, p95 **202.37 s**, max 208.00 s against 240 s. Whole-job cgroup peak
**1,919,053,824 bytes** (89.4% of 2 GiB), zero `oom`/`oom_kill` events. Artifact
10.43 MiB against 20 MiB.

The host is a Windows/Docker Desktop i5-10400 with the plan's job limits enforced by the
kernel, not the recorded reference machine. Reference-hardware repetition stays in R6-01.
The exact 10,000-file/100,000-edge/20,000-union fixture also remains open; this fixture
has 9,992 HEAD files, 98,500 imports and 9,999 lineages.
