# ADR-090: Architecture evidence in the city

Date: 2026-10-29. Status: accepted for Q3.1. Extends ADR-089 and the retained-worker
ownership of ADR-027. The owner requested parallel follow-up development after PR #55.

## Evidence and cause

Offline architecture reports can identify a forbidden relation or changed cycle
component, but users must manually locate its files in the city. Importing the report
without recomputing it would trust copied counts and locations. Recomputing two full
graphs on the UI thread would harm interaction and duplicate the worker's graph memory.

## Decision

- Add a separate Architecture review panel, reachable by keyboard, for an explicitly
  picked local `atlas.architecture-review/1` JSON file, at most 8 MiB. No upload or
  persistence is introduced; opening another artifact or reloading clears the report.
- The retained dataset worker reads the native File, binds analysis/repository,
  full commit and snapshot IDs to its own manifest, checks ordered baseline/current
  frames, then calls `validateArchitectureReview` against those validated graphs.
  Policy, counts, rows, confidence and locations are recomputed, not trusted.
- Reject foreign/window-shaped, synthetic, non-File and oversized messages before
  reading bytes. All worker failures return a fixed message, never input text.
  Keep the existing 20-second graph-query deadline. A stalled worker follows the
  existing dataset-worker failure behavior; no new budget or assertion is loosened.
- Dedicated import state preserves a prior valid report after a rejected import.
  Latest request wins; clear/unmount/dataset changes cannot accept a stale result.
  Only one report request may be pending in this panel.
- Show per-rule counts, selector match counts, coverage, limits and bounded current
  evidence, with 20 rows at a time and rule/state filters. Baseline/current links
  select the matching lineage and dependencies inspector through existing navigation.
  Baseline links are offered only when that lineage exists there. Missing old paths
  are not invented and no disappearance is labeled resolved.
- Imported integrity is not producer authentication. The panel says the report was
  recomputed against this artifact, while artifact provenance remains unauthenticated.
  No clean/security/runtime-impact/merge approval follows. Cycle semantics stay SCC
  membership, not enumeration of every new cycle route.
- Use ordinary HTML evidence and existing city selection/navigation; do not add GPU
  overlays, alter layout/rendering, change analyzer/artifact contracts, add dependencies,
  enable signing, deploy a service or add private hosting/billing.

## Verification

Worker tests cover native-shaped File acceptance, wrong channel rejection before
reads, tampered rows/counts/policy, wrong analysis/commit/frame order, byte/UTF-8 errors
and absent retained metadata. Real browser journeys cover import, current/baseline
navigation, filtering/progressive reveal, preserving prior state on error, clear,
reload and artifact replacement, keyboard use, 320 px reflow and accessibility.
Full suite and all engines run in a coordinated test slot. Exact analyzer corpus
bytes and all existing CI/security gates remain required and unchanged. Human/device/
deployment G6/R6 acceptance remains open.
