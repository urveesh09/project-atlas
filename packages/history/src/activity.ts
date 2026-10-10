import { LIMITS, compareAscii, type Availability, type CoChangePair } from '@atlas/schema';
import type { ProcessedCommit } from './lineage.js';

/**
 * Change activity derived from processed first-parent commits (plan §7.5, §10.1).
 * Churn for a frame counts only commits up to and including that frame's commit, so a
 * later commit can never leak into an earlier frame's value.
 */
export interface LineageChurn {
  /** Commits (counted once each) that changed this lineage. */
  changedCommits: number;
  /** Sums of known numstat lines; see `linesUnknown`. */
  linesAdded: number;
  linesDeleted: number;
  /** Contributing changes with known line counts. */
  linesKnown: number;
  /** Contributing changes whose line counts are unknown (path-only diff, split rename). */
  linesUnknown: number;
  /** Contributing binary changes, where line counts do not apply. */
  linesNotApplicable: number;
  /** Changed by a commit whose rename detection was incomplete. */
  renameUncertain: boolean;
}

export interface FrameChurn {
  /** Lineages changed at least once up to the frame; absent lineages had no change. */
  byLineage: Map<string, LineageChurn>;
  /** Distinct commits up to the frame that changed each lineage (for container counts). */
  commitsByLineage: Map<string, number[]>;
  /** Commits counted for this frame (oldest first chain positions 0..frameIndex). */
  commitsInScope: number;
  /** Some commit up to the frame has unknown changes (an unavailable oldest diff). */
  windowIncomplete: boolean;
}

/**
 * Per-frame cumulative churn. `frameOids` name the frame commits; `commits` are newest
 * first. Returned frames are keyed by commit OID.
 */
export function churnByFrame(commits: readonly ProcessedCommit[], frameOids: ReadonlySet<string>): Map<string, FrameChurn> {
  const out = new Map<string, FrameChurn>();
  const running = new Map<string, LineageChurn>();
  const commitLists = new Map<string, number[]>();
  let windowIncomplete = false;
  for (let index = commits.length - 1, position = 0; index >= 0; index--, position++) {
    const commit = commits[index]!;
    if (commit.changesAvailability === 'unavailable') windowIncomplete = true;
    const touched = new Set<string>();
    for (const change of commit.changes) {
      if (change.lineageId === null) continue;
      const entry = running.get(change.lineageId) ?? { changedCommits: 0, linesAdded: 0, linesDeleted: 0, linesKnown: 0, linesUnknown: 0, linesNotApplicable: 0, renameUncertain: false };
      if (!touched.has(change.lineageId)) {
        entry.changedCommits++;
        touched.add(change.lineageId);
        const list = commitLists.get(change.lineageId) ?? [];
        list.push(position);
        commitLists.set(change.lineageId, list);
      }
      if (change.added === null || change.deleted === null) {
        if (commit.unknownLineChanges.has(change)) entry.linesUnknown++;
        else entry.linesNotApplicable++;
      } else {
        entry.linesKnown++;
        entry.linesAdded += change.added;
        entry.linesDeleted += change.deleted;
      }
      if (!commit.renamesComplete) entry.renameUncertain = true;
      running.set(change.lineageId, entry);
    }
    if (frameOids.has(commit.oid)) {
      out.set(commit.oid, {
        byLineage: new Map([...running].map(([id, c]) => [id, { ...c }])),
        commitsByLineage: new Map([...commitLists].map(([id, list]) => [id, [...list]])),
        commitsInScope: position + 1,
        windowIncomplete,
      });
    }
  }
  return out;
}

/** History availability of one lineage's churn at a frame. */
export function churnAvailability(frame: FrameChurn, churn: LineageChurn | undefined): Availability {
  if (frame.windowIncomplete) return 'partial';
  if (churn && (churn.linesUnknown > 0 || churn.renameUncertain)) return 'partial';
  return 'complete';
}

export interface CoChangeResult {
  pairs: CoChangePair[];
  /** Commits excluded because they changed more than the per-commit file cap. */
  excludedCommits: number;
  availability: Availability;
}

/**
 * Co-change pairs over the whole artifact window (plan §6.4, §4.2). Commits changing more
 * than 50 lineages are excluded from pairs (individual changes still count elsewhere).
 * `eligibleUnionCommits` counts eligible commits changing either lineage; `jaccard` is
 * together / union. Pairs need at least 3 shared commits; each lineage keeps its 20
 * strongest partners (jaccard, then shared count, then partner ID) and a pair survives
 * when either endpoint keeps it.
 */
export function coChangePairs(commits: readonly ProcessedCommit[], keepLineage: (id: string) => boolean): CoChangeResult {
  const commitSets = new Map<string, number>();
  const together = new Map<string, number>();
  let excluded = 0;
  let unavailable = false;
  commits.forEach((commit) => {
    // Unknown rename/path continuity also limits pairing certainty, even when a
    // partial diff still supplies useful paths. Keep the pairs with a partial label.
    if (commit.changesAvailability !== 'complete' || !commit.renamesComplete) unavailable = true;
    if (commit.changesAvailability === 'unavailable') {
      return;
    }
    const ids = [...new Set(commit.changes.map((c) => c.lineageId).filter((id): id is string => id !== null && keepLineage(id)))].sort(compareAscii);
    if (ids.length > LIMITS.coChangeMaxFilesPerCommit) {
      excluded++;
      return;
    }
    for (const id of ids) commitSets.set(id, (commitSets.get(id) ?? 0) + 1);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = `${ids[i]}\u0000${ids[j]}`;
        together.set(key, (together.get(key) ?? 0) + 1);
      }
    }
  });
  const candidates: CoChangePair[] = [];
  for (const [key, count] of together) {
    if (count < LIMITS.coChangeMinTogether) continue;
    const [a, b] = key.split('\u0000') as [string, string];
    const union = commitSets.get(a)! + commitSets.get(b)! - count;
    candidates.push({ aLineageId: a, bLineageId: b, togetherCommits: count, eligibleUnionCommits: union, jaccard: count / union });
  }
  const rank = (x: CoChangePair, y: CoChangePair) => y.jaccard - x.jaccard || y.togetherCommits - x.togetherCommits;
  const partners = new Map<string, CoChangePair[]>();
  for (const pair of candidates) {
    for (const id of [pair.aLineageId, pair.bLineageId]) {
      const list = partners.get(id) ?? [];
      list.push(pair);
      partners.set(id, list);
    }
  }
  const kept = new Set<CoChangePair>();
  for (const [id, list] of partners) {
    const other = (p: CoChangePair) => (p.aLineageId === id ? p.bLineageId : p.aLineageId);
    list.sort((x, y) => rank(x, y) || compareAscii(other(x), other(y)));
    for (const pair of list.slice(0, LIMITS.coChangeMaxPartners)) kept.add(pair);
  }
  const pairs = [...kept].sort((x, y) => compareAscii(x.aLineageId, y.aLineageId) || compareAscii(x.bLineageId, y.bLineageId));
  return { pairs, excludedCommits: excluded, availability: unavailable ? 'partial' : 'complete' };
}
