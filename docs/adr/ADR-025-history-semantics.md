# ADR-025: Mainline history, lineage and history metrics as implemented

Date: 2026-10-10. Status: accepted for Phase 4 (Gate G4 local).

Plan §7, §10.3 and §11.3 fix the contracts; this records the implementation decisions they leave open, each tested against hand-written fixtures in `packages/history/test` and `packages/analyzer-core/test/history.test.ts`.

## Window and diffs

- **Walk.** One interactive `git cat-file --batch` session walks first-parent links from the selected commit (always included). A parent is included while fewer than `--history-commits` are included and its committer time is not older than the selected commit's time minus `--history-days`. The walk stops at the first parent failing either test. The day test is checked first, so a window ending at an old commit reports `days`, not `commit-cap`. Timestamps are never reordered. A missing parent object ends the window with boundary `shallow`.
- **Diffs.** First-parent diffs run in batches of 25 commits through one `git diff-tree --stdin --always -r -z --raw --numstat` process with the fixed policy (80% renames, copies off, `-l1000`, no external diff or textconv). The oldest commit is compared to the boundary parent when one was read, to the empty tree at a root, and otherwise its change is `unavailable`.
- **Degradation.** If a batch fails or Git reports skipped rename detection, its commits are retried one by one, so the limitation is attributed exactly; those commits are `partial`. If a commit's full diff fails, a tree-only comparison is used: paths only, no renames or line counts, `partial`. If even that fails for a commit inside the window, the window is truncated just below it, exactly like a shallow boundary. Only the oldest commit may lack its change.

## Lineage (ADR-007)

- **Anchors and identity.** `lineageId = hash(repoId, oldest window commit, anchor commit, original path)`. Files present before the oldest change anchor at the boundary parent, or at the oldest commit itself when its change is unknown. Additions anchor at their commit.
- **Ordering.** Departures (deletes and rename sources) are applied before arrivals, so rename chains inside one commit resolve against the parent state as Git computed it.
- **Ambiguity.** A rename is ambiguous, and becomes delete plus add with the new lineage marked `ambiguous`, when more than one deleted or added file shares its old or new blob. Inexact candidates beyond identical blobs are not second-guessed.
- **Scope.** Lineage applies to the same path scope as the inventory: valid paths, built-in, repository and CLI exclusions, read from the selected commit's `atlas.config.json` for every frame. Symlinks and submodules carry no lineage. A type change into or out of a regular file ends or starts one. A rename across the scope boundary is an add or a delete.
- **Bounds.** A frame file the plan did not track gets a recovery lineage anchored at that frame, recorded as `HISTORY_LINEAGE_RECOVERED`; fixtures never trigger it. Lineages seen only between frames are kept until the 20,000-lineage cap. Beyond it they are dropped, counted in `policy.transientLineagesOmitted`, and history becomes partial.

## Frames and budgets

- **Selection and order.** Frame indices are `floor(i(n−1)/(k−1))` over the chain, oldest to newest (plan §7.2). The selected commit is analyzed first and is the checkpoint. Other frames are analyzed newest to oldest, sharing the parser pool, fact cache and a blob cache. That cache is the 256 MiB distinct-source budget and is enforced only for historical frames.
- **Failures.** A frame failing a limit, objects or the end-to-end deadline (default 300 s, plan §4.2) is listed in `history.frameSelection` with its reason and dropped from rendering. A budget or deadline failure stops older frames too. Union lineages over 20,000 drop the oldest frames (`LINEAGE_LIMIT`). With `transport` given, frames exceeding the export limits are dropped oldest first (`ARTIFACT_SIZE`); if the selected commit alone does not fit, the export fails.
- **Status.** History is `complete` only when the requested window was walked, every diff is complete with renames, and every requested frame was analyzed. Binary content does not make it partial: its line counts do not apply rather than being unknown.

## History metrics and findings

- **Files.**
  - `changedCommits` counts window commits up to the frame that changed the lineage, once per commit.
  - Line totals sum known numstat lines; they are null when no contributing change has text lines.
  - `availability.history` is partial when the oldest change is unknown, any contributing line count is unknown, or rename detection was limited for a contributing commit.
- **Containers.** Distinct commits that changed any current member file, and sums of member lines. The value describes current members.
- **Hotspot.**
  - Eligible files are parsed `source` files with complete dependency data. The baseline is the selected commit's cohort, interpolated per plan §10.3.
  - The full score exists only when every cohort member has usable history; otherwise it is null and the viewer offers Structure attention under its own label.
  - Scores are stored per frame for files; containers never receive one.
- **Change concentration.** At least 10 changed commits and at or above the nearest-rank p95 of the frame's source files with usable history.
- **Co-change.** Pairs need at least 3 shared commits and exclude commits that changed more than 50 lineages. Each lineage keeps its 20 strongest partners (Jaccard, then shared count, then ID), and a pair survives when either endpoint keeps it.

## Layout (ADR-008)

- **Districts and anchors.** Containers are identified by path, so a directory that became a package is one district. Kind and parent come from the newest frame containing the path, which keeps the tree acyclic because a parent path is always a proper prefix.
- **Membership.** Every container of the selected commit keeps a district, as do the anchor chains of files deleted earlier. Each frame maps its containers to districts, or to null when an old container anchors nothing.
- **Identity and placement.** The layout ID covers the ordered frame set and the lineage anchors. Plots never move between frames.

## Consequences

`ANALYZER_VERSION` is now `0.1.0-dev.5`: lineage and metric derivations changed, so snapshot IDs and cache keys change (plan §20.1 rule 9). History is on by default; `--no-history` restores the single-frame artifact with history explicitly unavailable.
