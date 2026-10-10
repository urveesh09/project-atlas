import { processLineage, selectFrameIndices, type LineageResult, type WindowCommit } from '@atlas/history';
import { diffCommits, isIngestError, listTree, walkFirstParent, type CommitDiffResult, type CommitObject, type SafeGit } from '@atlas/ingest';
import type { HistoryCoverage } from '@atlas/schema';
import { AnalysisError } from './errors.js';

/**
 * The history plan (plan §7.2, §7.3): the bounded first-parent window, every included
 * commit's first-parent change, conservative lineage and the selected structural frames.
 * It reads commits, trees and diffs only; frame graphs are analyzed afterwards.
 */
export interface HistoryPlan {
  window: WindowCommit[];
  boundary: HistoryCoverage['boundary'];
  lineage: LineageResult;
  /** Selected frame commits, oldest first, with their chain index (0 = oldest included). */
  frames: { commitOid: string; chainIndex: number }[];
  diffs: Map<string, CommitDiffResult>;
}

const isoFromEpoch = (seconds: number) => new Date(seconds * 1000).toISOString();

export function toWindowCommit(commit: CommitObject): WindowCommit {
  return { oid: commit.oid, firstParentOid: commit.parents[0] ?? null, committerTime: isoFromEpoch(commit.committerEpochSeconds) };
}

export async function planHistory(input: {
  git: SafeGit;
  repoId: string;
  head: CommitObject;
  days: number;
  commits: number;
  snapshots: number;
  treeEntries: number;
  inScope: (path: string) => boolean;
  signal?: AbortSignal;
}): Promise<HistoryPlan> {
  const { git, head } = input;
  // The window is relative to the selected commit's committer timestamp (plan §7.2).
  const minEpoch = head.committerEpochSeconds - input.days * 86_400;
  const walked = await walkFirstParent(git, head.oid, { maxCommits: input.commits, minCommitterEpochSeconds: minEpoch, ...(input.signal ? { signal: input.signal } : {}) });
  const oldest = walked.commits.at(-1)!;
  const requests = walked.commits.map((commit, i) => {
    const parent = i + 1 < walked.commits.length ? walked.commits[i + 1]!.oid : walked.boundaryParent?.oid ?? null;
    return { commit, parentOid: parent };
  });
  // The oldest commit is comparable only to an available boundary parent or, at a root,
  // to the empty tree; a missing (shallow) parent leaves its change unavailable.
  const comparable = requests.filter((r) => r.parentOid !== null || (r.commit === oldest && walked.boundary === 'root'));
  const diffs = await diffCommits(
    git,
    comparable.map((r) => ({ commitOid: r.commit.oid, parentOid: r.parentOid })),
    input.signal ? { signal: input.signal } : {},
  );

  // A commit whose change cannot be computed even path by path truncates the window
  // just below it, exactly as a shallow boundary would: only the oldest commit may lack
  // its change, and nothing older is claimed.
  let commits = walked.commits;
  let boundary: HistoryCoverage['boundary'] = walked.boundary;
  for (let i = 0; i < commits.length - 1; i++) {
    const diff = diffs.get(commits[i]!.oid);
    if (diff && diff.status === 'unavailable') {
      commits = commits.slice(0, i + 1);
      boundary = 'shallow';
      break;
    }
  }
  const window = commits.map(toWindowCommit);
  const windowOldest = commits.at(-1)!;
  const oldestDiff = diffs.get(windowOldest.oid);
  const oldestComputable = oldestDiff !== undefined && oldestDiff.status !== 'unavailable';

  // Files present before the oldest change anchor at its boundary parent. A root has an
  // empty base. If the oldest change is not computable (shallow or truncated window), the
  // oldest commit's own tree is the base and anchors there. A truncated window always ends
  // at an uncomputable commit, so a computable oldest commit is the walked oldest.
  let base: { anchorCommitOid: string; paths: string[] } | null = null;
  const baseCommit = oldestComputable ? walked.boundaryParent : windowOldest;
  if (baseCommit) {
    const listing = await listTree(git, baseCommit.tree, { maxEntries: input.treeEntries, ...(input.signal ? { signal: input.signal } : {}) });
    if (listing.truncated) throw new AnalysisError('ANALYSIS_RESOURCE_LIMIT', 'The history base tree exceeds the entry limit', { limit: 'TREE_ENTRY_LIMIT' });
    base = {
      anchorCommitOid: baseCommit.oid,
      paths: listing.entries.filter((e) => e.kind === 'blob' && e.path !== null).map((e) => e.path!),
    };
  }

  const n = window.length;
  const frameIndices = selectFrameIndices(n, input.snapshots);
  // Window is newest first; chain index 0 is the oldest included commit.
  const frames = frameIndices.map((chainIndex) => ({ commitOid: window[n - 1 - chainIndex]!.oid, chainIndex }));
  const lineage = processLineage({
    repoId: input.repoId,
    commits: window,
    diffs,
    base,
    inScope: input.inScope,
    retainActiveAt: new Set(frames.map((f) => f.commitOid)),
  });
  return { window, boundary, lineage, frames, diffs };
}

/** Map a history failure to an explicit coverage boundary; cancellation is rethrown. */
export function historyFailureBoundary(error: unknown): { boundary: HistoryCoverage['boundary']; code: string } {
  if (isIngestError(error, 'CANCELLED') || (error instanceof AnalysisError && error.code === 'CANCELLED')) throw error;
  if (isIngestError(error, 'TIMEOUT') || isIngestError(error, 'RESOURCE_LIMIT') || (error instanceof AnalysisError && error.code === 'ANALYSIS_RESOURCE_LIMIT'))
    return { boundary: 'resource-cap', code: 'HISTORY_RESOURCE_LIMIT' };
  return { boundary: 'none', code: isIngestError(error) ? `HISTORY_${error.code}` : 'HISTORY_FAILED' };
}
