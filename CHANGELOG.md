# Changelog

All notable changes to ATLAS. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [semantic versioning](https://semver.org/). Detailed evidence for every
change is in [docs/implementation-status.md](docs/implementation-status.md) and the ADRs.

## [Unreleased]

### Security
- Upgrade `smol-toml` to 1.9.1 to fix quadratic work on untrusted Python manifests
  (GHSA-r4xh-jqrq-34v2). A regression exercises the complete 1 MiB admitted document
  through project discovery, alongside boundary and prototype-like metadata checks.
- Upgrade the supported Node.js runtime and both container bases to 24.22.0
  ([ADR-061](docs/adr/ADR-061-dependency-currency-october-2026.md)). `atlas doctor`
  warns on older 24.x releases without preventing diagnosis. Analysis semantics and
  the pinned built-in module list remain unchanged.

### Added
- Python analysis ([ADR-060](docs/adr/ADR-060-python-integration.md)):
  - `.py` and `.pyi` files are parsed, resolved, measured and checked like TS/JS;
  - Python projects become packages, with their declared PyPI dependencies;
  - mixed TS/JS and Python repositories work, and npm and PyPI packages of the same name
    stay distinct;
  - virtual environments, Python caches and egg metadata are excluded;
  - pallets/flask joins the pinned validation corpus.
- Entry screens and sharing ([ADR-058](docs/adr/ADR-058-interface-polish.md)):
  - the start screen and the hosted landing show a real render of the demo city;
  - page titles name the repository;
  - a description, a favicon, link-preview tags and no-JavaScript text;
  - the demo adds a canonical link, a social card and structured data.
- Python support, part 1 ([ADR-056](docs/adr/ADR-056-python-support-design-and-facts.md)):
  - a Python adapter that extracts imports, declarations, code lines and complexity;
  - checked against CPython's own `ast` on the full standard library, with 0
    mismatches.

  Used by analysis since ADR-060.
- Python support, part 2 ([ADR-057](docs/adr/ADR-057-python-resolution.md)):
  - projects and dependencies from every common Python manifest;
  - import resolution with Python's own precedence.

  Used by analysis since ADR-060.
- 3D-print export ([ADR-055](docs/adr/ADR-055-3d-print-export.md)): coloured 3MF and STL of
  the city shown.
- Package graph view ([ADR-054](docs/adr/ADR-054-package-dependency-view.md)):
  - layered package dependencies, with cycles named and edges that close them flagged;
  - a complete table.
- Annotations ([ADR-053](docs/adr/ADR-053-annotations-and-compact-menus.md)):
  - colour and note on folders and packages;
  - listed in the legend, kept locally, shared as `atlas.notes/1`.
- Metric lenses and bands ([ADR-052](docs/adr/ADR-052-metric-lenses-bands-and-presets.md)):
  - ten colour lenses, including code lines, functions, total complexity, fan-out and lines
    changed;
  - editable band starts with a distribution chart and an even split;
  - seven built-in views.
- Scope ([ADR-051](docs/adr/ADR-051-scope-focus-and-hide.md)): focus on a folder or package
  and hide paths by pattern. Plots stay fixed, every count names what is hidden, and saved
  views keep the scope.
- Change colouring in Compare ([ADR-050](docs/adr/ADR-050-change-colouring-in-compare.md)):
  - colour snapshot B by the signed change of code lines, complexity, fan-in, fan-out or
    hotspot score since A;
  - signed values in the cards and the file table.

### Fixed
- The overview's History coverage showed the raw code for where the window ends, such
  as "days". It now says it in words, worded the same as the timeline and the CLI.
- Failed and cancelled hosted jobs ticked every stage as done, including publishing; they
  now say the run stopped before a result was published
  ([ADR-059](docs/adr/ADR-059-interface-second-pass.md)).
- Package graph nodes were narrower than their counts line.
- The measurements table scrolled sideways in the inspector column.
- Measurements still described the old em-dash placeholder.
- On desktop the page itself scrolled (5,245 px at 1440×900), so a wheel over the header slid
  the explorer away. Hidden tree labels now stay inside their panel
  ([ADR-058](docs/adr/ADR-058-interface-polish.md)).
- The overview's findings stopped at 20 without saying so; every finding is now reachable,
  with the remaining count shown.
- Status pills broke across lines.
- The disabled "Analyze repository" button was hard to read.
- "Open a local artifact folder…" did not look like a button.
- The repository URL placeholder was clipped on phones.
- Primary buttons inside the city had text at 2.27:1 contrast.
- The new city menus had pushed the laptop first screen down 38 px; compact summaries
  restore it.
- An open compare panel covered the city on screens wider than 1350 px.

### Changed
- Upgrade runtime contract validation to Zod 4.6.7; generated JSON Schema and OpenAPI
  remain byte-identical (ADR-061).
- Upgrade viewer runtime pins to React/React DOM 19.3.1 and React Three Fiber 9.8.2,
  with its exact-tag distribution license reviewed and refreshed (ADR-061).
- Contract versions ([ADR-060](docs/adr/ADR-060-python-integration.md)): analyzer
  `0.1.0-dev.6`, graph schema `atlas.graph/1.1.0`, artifact `atlas.artifact/1.4.0`. Readers
  still accept artifacts 1.0–1.3. TS/JS results are unchanged at path level; IDs change with
  the analyzer version, as for every version change.
- Summary lines read as sentences, with at most one middle dot; data rows keep their
  separators ([ADR-059](docs/adr/ADR-059-interface-second-pass.md)).
- Interface polish ([ADR-058](docs/adr/ADR-058-interface-polish.md)):
  - self-hosted Geist and Geist Mono outside the city stage;
  - one corner-radius rule;
  - 12 px help text;
  - one label, "Analyze your repository";
  - no dashes in visible text, and "n/a" for unavailable numbers;
  - rule explanations behind "Why this is flagged" in long finding lists.

  The city renders byte-identically.
- Refined controls ([ADR-049](docs/adr/ADR-049-refined-controls-and-icons.md)):
  - one style for buttons, selects and fields in light and dark;
  - switch toggles, menus with icons, and a drawn icon set for the stage controls;
  - history dots no longer sit inside button boxes.

## [0.1.0-beta.1] - 2026-10-14

### Security
- Workspace globs from analyzed repositories are matched without backtracking. A crafted
  glob could stall analysis
  ([ADR-046](docs/adr/ADR-046-security-triage-and-enforced-checks.md)).
- `.git/config` parsing is linear; metadata and static assets are read through one file
  handle.
- Workflow actions are pinned to commit SHAs. `main` requires a pull request and CI;
  secret scanning and push protection are on.

### Added
- Beta 2 first use ([ADR-047](docs/adr/ADR-047-beta-2-activation-workspace-and-release-identity.md)):
  - a guided start with three tasks that name real targets;
  - Expand as a full-screen workspace with search, controls and an evidence panel;
  - *Open on GitHub* links to the exact commit and line for public analyses;
  - PNG exports that carry their provenance inside the file, plus *Export metadata*;
  - a guide, [Analyze your own repository](docs/guides/analyze-your-repository.md).
- Free parity with CodeCharta ([ADR-048](docs/adr/ADR-048-editions-and-free-parity.md),
  [comparison](docs/product/editions-and-comparison.md)):
  - `.gitignore`-style path highlighting with exact counts;
  - saved views with import and export;
  - per-band legend counts;
  - copy image;
  - a Share menu.
- City: keyboard driving (arrows or W A S D, Q/E turn, Shift+arrows tilt, +/− zoom), and
  dependency strokes with arrowheads, rings and direction-marked names on connected files
  ([ADR-045](docs/adr/ADR-045-pointer-picks-keyboard-driving-and-dependency-strokes.md)).
- Release engineering:
  - version-tag releases with the portable CLI archive, checksums and build provenance;
  - API and sandbox images on GHCR;
  - CodeQL, dependency review, OpenSSF Scorecard and Dependabot proposals
    ([ADR-044](docs/adr/ADR-044-release-engineering-and-pilot-readiness.md)).
- A static demo site of the viewer on a verified vuejs/core analysis.
- Security policy, contribution guide, code of conduct, issue forms (including pilot
  feedback) and a pull-request checklist.
- City: wall materials, seeded slab plans and new Modern and Western silhouettes
  ([ADR-043](docs/adr/ADR-043-bake-fallback-proportions-and-materials.md)).
- City: a baked sky-occlusion field, shader paving and glass, priority labels, a selection
  card with a folder trail, Previous/Next view, Expand, Hide tree, and a frame guard with
  calibrated resolution
  ([ADR-042](docs/adr/ADR-042-grounded-city-and-view-controls.md)).
- City: Modern, Eastern-fantasy and Western-fantasy styles, a perspective camera and a
  living sea ([ADR-038](docs/adr/ADR-038-decorative-city-architecture.md) to
  [ADR-041](docs/adr/ADR-041-living-city.md)).

### Changed
- The city takes the first screen. History is a compact strip under it, the long notes
  sit behind *How to read*, and camera buttons are on the stage. On phones the city comes
  before the tree.
- Counts name their units and policies, and a file's findings are split from findings
  about other files.
- Packages are versioned `0.1.0-beta.1`; the viewer shows its version.

### Fixed
- The demo page was 337 px wide on a 320 px screen and clipped a header action.
- 2D map package labels overlapped.
- Clicking a building scrolled the page to the inspector heading (ADR-045).
- After a snapshot change, a failing occlusion worker re-baked the first snapshot
  (ADR-043).
- A selection's deferred focus could take focus back from where the viewer had moved it
  (ADR-041, ADR-042).

## 0.1.0 candidate

The V0.1 release candidate (Phases 1–6) is described in
[docs/release/release-notes.md](docs/release/release-notes.md). It has not been tagged.
