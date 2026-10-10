# ADR-020: Production city consumes canonical layout and shares HTML selection

Date: 2026-10-10. Status: accepted for Phase 3 implementation.

## Decisions before implementation

Reuse layout v1's integer square-shelf rectangles and frame membership. The spike's packer already has independently calculated coordinates, randomized containment/overlap checks and union-size fixtures. Do not introduce a second layout, force simulation, guessed dependency or ID scheme in the browser. A render transform divides integer units by 100; height remains the stored code-line encoding. Package boundaries, role silhouettes and missing-metric marks have fixed meanings.

Load the Three.js renderer as a separate module. React owns controls and dataset/view state; an imperative Three.js adapter owns bounded instanced meshes, camera, picking and GPU disposal. This extends the existing pinned Three.js stack without one component per building. React Three Fiber remains in the isolated spike, which is not the product entry point. The adapter renders on demand, pauses when hidden, caps DPR, disables animation/damping, and respects reduced motion inherently. Camera focus is explicit; selection never moves the camera.

Use the same immutable layout for 3D and Canvas 2D maps. Semantic HTML tree, paged file table and evidence inspectors remain available when both canvases are unavailable. No thousands of focusable canvas proxies. Tables, toolbars and exports use real controls. A context failure preserves selection, lens and graph state and falls back to the map. HTML labels are bounded to selected/hovered files and package labels; source strings are never HTML.

Structure, maximum callable complexity and default-policy fan-in are the three Phase 3 lenses. Numeric stops and neutral missing values are explicit; the score is never inferred from height. Display filters dim buildings without changing coordinates, metrics or graph evidence. Roof silhouettes identify roles independently of color.

The plan mentioned repository configuration “display overrides” without defining fields, persistence or limits. Keep V0.1 committed configuration limited to its tested exclusion globs; unknown keys warn. Defer styling overrides beyond V0.1 until their bounded data schema is specified. Do not invent arbitrary CSS, scripts, metric rewrites or coordinate changes. The viewer's explicit lens/filter controls cover current display choices, and the normative config paragraph now states this boundary.

Immediate file overlays preserve source→imported-target direction, kind and confidence; deterministic order and a 200-line cap are visible, with an HTML paged list that can pin an omitted edge. Cross-district links use fixed cardinal gates and a root corridor; package rollups use unique file-pair counts. External terminals are capped at 50 visible with a full paged HTML list. Reach is a bounded static graph query, not runtime impact.

Prepare immutable scene records and graph indexes in the artifact validation worker. Search/reach/overlay aggregation run in a persistent query worker. Query responses carry monotonically increasing IDs; obsolete results cannot overwrite new selections or datasets. Transfer-derived indexes are trusted only from our worker after bundle validation, never read as artifact metadata. Worker imports and local artifact bytes stay on the local origin.

PNG exports are capped at 2048×2048 and 4 million pixels, rendered explicitly on demand, with JSON provenance (commit, analysis/layout versions and IDs, lens, selected path, edge limits and camera). Canvas 2D export remains available without WebGL. Revoke download URLs and dispose export resources. A static image does not replace the accessible artifact/table.

## Gates and limits

Measure at least 20 runs for layout, useful load, search and selection; test dense graphs and 10k buildings, record actual CPU/GPU/browser and profile heap/draw calls/long tasks/disposal. CI software GL is a correctness check, not a claim about an integrated GPU reference class. Firefox, keyboard-only, touch, reduced motion, 320px reflow and automated accessibility checks need recorded evidence. A real screen-reader audit must be reported separately if unavailable in this environment. History/compare states remain Phase 4 and are not simulated to satisfy visual references.

References: [Three.js instancing and bounds/disposal](https://threejs.org/docs/pages/InstancedMesh.html), [OrbitControls bounds and touch behavior](https://threejs.org/docs/pages/OrbitControls.html), [WCAG 2.2 quick reference](https://www.w3.org/WAI/WCAG22/quickref/).

Follow-up decisions: [ADR-021](ADR-021-bounded-external-ring.md) versions the corrected perimeter at layout 1.1. [ADR-023](ADR-023-retain-validated-query-worker.md) makes the validating worker the persistent query worker, eliminating a redundant graph transfer/index build. Package colors use layout district IDs to remain stable across snapshot occurrence changes. [ADR-024](ADR-024-decoded-artifact-capacity.md) explicitly records the dense-artifact capacity/memory tradeoff. Evidence and pending manual/device audits are in [implementation status](../implementation-status.md).
