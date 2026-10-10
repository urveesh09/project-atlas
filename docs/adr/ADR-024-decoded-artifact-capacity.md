# ADR-024: Version the decoded artifact capacity at 128 MiB

Date: 2026-10-10. Status: accepted for the bounded artifact profile; G3 device/manual release audits remain pending.

The advertised joint 10,000-file / 100,000-edge fixture cannot be exported under the old 100 MiB total decoded profile. A real committed fixture with 99,975 relationships produced approximately 106 million graph bytes before adding required history/lineage/layout chunks. Shortening declarations did not fix the mismatch: approximately 91 million bytes are mandatory edge/observation evidence alone. Deleting evidence, shortening canonical IDs, or testing fewer relationships would conceal this constraint.

Introduce artifact 1.2 with a **128 MiB cumulative decoded cap**, keeping the 20 MiB compressed transport limit and every source/file/edge/expansion/decompression bound. Readers accept 1.0 plain, 1.1 indexed and 1.2 indexed artifacts. New writers emit 1.2. Older readers may reject 1.2 or over-100-MiB exports; do not represent their capacity as upgraded.

The new profile is accepted only after the real 10k/100k artifact passes validation, browser import, main + dedicated-worker JS heap under 300 MiB, selected overlays, camera and resource disposal. Re-run adversarial import, cumulative-cap and independent hash/identity tests. Keep the original cold-route and interaction budgets. Capacity remains joint and byte-bounded: richer artifacts above 128 MiB still fail with limit details; history reduction is Phase 4. Source is never included in exported chunks.

The master plan's profile table and generated contracts must name the new limit/version, with this ADR preserving the original 100 MiB decision and evidence for changing it.

## Measured acceptance and tradeoff

The full [20-run production report](../benchmarks/phase3-city.md) exercises 10,000 committed files and 99,975 relationships with all data retained. The exported artifact fits the new decoded and unchanged compressed limits. Import/validation, selected overlays, close-up and overview cameras and 20 disposal/replacement cycles pass the measured local gates. The cumulative 128 MiB rejection test and legacy 1.1 import remain covered alongside independent canonical/hash golden checks.

The 300 MiB active-data interpretation measures retained JS heap after collection in **both main and owned dedicated worker**, not just the renderer realm. Pre-collection allocations are recorded separately and are substantially higher on the dense fixture. This is a capacity tradeoff, not a guarantee of 300 MiB startup peak/RSS. The worker retains its graph/indexes rather than a second query worker duplicating them; temporary canonical strings, validation and transfer allocations are collectible. Lower-memory browsers may still struggle during import; the exact reference device, native GPU/RSS and human accessibility audits remain release gates. Phase 4 must account for adjacent-frame caches within retained data capacity and measure startup again.

Do not drop evidence to make a benchmark smaller or present forced-GC measurements as an allocation peak. Raw before/after realm measurements and fixture provenance are retained in the report. If real-repository artifacts exceed 128 MiB, reject with explicit limits; widening again requires a new versioned decision and measurements.
