# Changelog

All notable changes to ATLAS. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [semantic versioning](https://semver.org/). Detailed evidence for every
change is in [docs/implementation-status.md](docs/implementation-status.md) and the ADRs.

## [Unreleased]

### Added
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
- Primary buttons inside the city had text at 2.27:1 contrast.
- The new city menus had pushed the laptop first screen down 38 px; compact summaries
  restore it.
- An open compare panel covered the city on screens wider than 1350 px.

### Changed
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
