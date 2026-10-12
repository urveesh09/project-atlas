# Changelog

All notable changes to ATLAS. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [semantic versioning](https://semver.org/). Detailed evidence for every
change is in [docs/implementation-status.md](docs/implementation-status.md) and the ADRs.

## [Unreleased]

### Added
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

### Fixed
- After a snapshot change, a failing occlusion worker re-baked the first snapshot
  (ADR-043).
- A selection's deferred focus could take focus back from where the viewer had moved it
  (ADR-041, ADR-042).

## 0.1.0 candidate

The V0.1 release candidate (Phases 1–6) is described in
[docs/release/release-notes.md](docs/release/release-notes.md). It has not been tagged.
