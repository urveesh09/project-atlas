import type { JobStatus } from '@atlas/schema';

/** ATLAS-authored explanations; service and repository text is never rendered as markup. */
export const STAGES: { stage: NonNullable<JobStatus['stage']>; label: string }[] = [
  { stage: 'validate', label: 'Validate the repository' },
  { stage: 'acquire', label: 'Acquire the commit' },
  { stage: 'index', label: 'Index files' },
  { stage: 'analyze', label: 'Analyze imports and metrics' },
  { stage: 'history', label: 'Walk mainline history' },
  { stage: 'layout', label: 'Lay out the city' },
  { stage: 'publish', label: 'Verify and publish' },
];

export const STATE_TEXT: Record<JobStatus['state'], string> = {
  QUEUED: 'Waiting in the queue',
  ACQUIRING: 'Acquiring',
  ANALYZING: 'Analyzing the selected commit',
  HISTORY: 'Analyzing history',
  LAYOUT: 'Laying out the city',
  VALIDATING: 'Verifying the result',
  READY: 'Ready',
  PARTIAL: 'Ready with partial coverage',
  CANCEL_REQUESTED: 'Cancelling',
  CANCELLED: 'Cancelled',
  FAILED: 'Failed',
};

/**
 * Counts in a fixed reading order. Pairs read as "n of N" while a stage runs; a count is
 * shown only when the service reported it, and never as a percentage.
 */
export function describeCounts(counts: Record<string, number>): { value: string; label: string }[] {
  const n = (key: string) => counts[key];
  const fmt = (value: number) => value.toLocaleString('en');
  const out: { value: string; label: string }[] = [];
  const pair = (done: string, total: string, label: string) => {
    if (n(done) === undefined) return;
    out.push({ value: n(total) !== undefined ? `${fmt(n(done)!)} of ${fmt(n(total)!)}` : fmt(n(done)!), label });
  };
  if (n('cached') !== undefined) out.push({ value: 'Reused', label: 'identical completed analysis' });
  if (n('filesDiscovered') !== undefined) out.push({ value: fmt(n('filesDiscovered')!), label: 'files discovered' });
  if (n('filesIncluded') !== undefined) out.push({ value: fmt(n('filesIncluded')!), label: 'files included' });
  pair('filesParsed', 'filesToParse', 'files parsed');
  if (n('importsObserved') !== undefined) out.push({ value: fmt(n('importsObserved')!), label: 'import statements' });
  if (n('commitsTraversed') !== undefined) out.push({ value: fmt(n('commitsTraversed')!), label: 'mainline commits in the window' });
  if (n('framesDone') !== undefined) pair('framesDone', 'framesTotal', 'history snapshots analyzed');
  else pair('framesCompleted', 'framesRequested', 'snapshots in the city');
  if (n('acquiredKiB') !== undefined) out.push({ value: `${fmt(n('acquiredKiB')!)} KiB`, label: 'repository data acquired' });
  if (n('artifactKiB') !== undefined) out.push({ value: `${fmt(n('artifactKiB')!)} KiB`, label: 'published result' });
  return out;
}

export const WARNING_TEXT: Record<string, string> = {
  HISTORY_NOT_ACQUIRED: 'History is unavailable: the latest commit was published on its own.',
  ACQUISITION_NETWORK_LIMIT: 'Fetching history would exceed the 256 MiB transfer limit.',
  HISTORY_DEADLINE: 'History could not finish within the 300-second limit.',
  HISTORY_ACQUISITION_FAILED: 'History could not be fetched from GitHub.',
  HISTORY_ANALYSIS_FAILED: 'History analysis stopped at a resource limit.',
  HISTORY_ARTIFACT_INVALID: 'The history result failed verification and was not published.',
  HISTORY_PARTIAL: 'Some history is partial; the timeline explains the boundary.',
  CHECKPOINT_RECOVERED: 'A worker restarted; the verified latest-commit checkpoint was reused.',
  PROCESS_ISOLATION_ONLY: 'Development service: analysis ran without container isolation.',
  FILE_LIMIT: 'More than 10,000 files: the rest are listed as omitted.',
  PARSE_FAILED: 'Some files could not be parsed and are shown as opaque.',
};

export const ERROR_TEXT: Record<string, { title: string; guidance: string }> = {
  INVALID_REPOSITORY_URL: { title: 'That is not a repository root URL', guidance: 'Use the form https://github.com/owner/repository, without a branch, path or query.' },
  REPOSITORY_NOT_FOUND: { title: 'Repository not found or not public', guidance: 'Only public GitHub repositories can be analyzed here. Use the CLI for private code.' },
  REPOSITORY_NOT_PUBLIC: { title: 'Repository not found or not public', guidance: 'Only public GitHub repositories can be analyzed here. Use the CLI for private code.' },
  REPOSITORY_MOVED: { title: 'The repository moved', guidance: 'It was renamed or transferred. Submit its current URL.' },
  EMPTY_REPOSITORY: { title: 'The repository is empty', guidance: 'Its default branch has no commit to analyze.' },
  COMMIT_NOT_ACCESSIBLE: { title: 'The commit is not accessible', guidance: 'It could not be fetched from the default branch of this repository.' },
  UPSTREAM_RATE_LIMITED: { title: 'GitHub is rate limiting requests', guidance: 'Try again in a few minutes.' },
  UPSTREAM_UNAVAILABLE: { title: 'GitHub is unavailable', guidance: 'Try again later. Nothing was published.' },
  REPOSITORY_TOO_LARGE: { title: 'The repository is too large', guidance: 'Acquisition exceeded the 256 MiB transfer limit. The CLI can analyze it locally.' },
  ANALYSIS_RESOURCE_LIMIT: { title: 'The analysis hit a resource limit', guidance: 'The repository exceeded a V0.1 time or memory limit. The CLI can analyze it locally with lower limits.' },
  ARTIFACT_INVALID: { title: 'The result failed verification', guidance: 'Nothing was published. This is an ATLAS fault; try again later.' },
  JOB_CANCELLED: { title: 'Cancelled', guidance: 'Nothing new was published.' },
  QUOTA_EXCEEDED: { title: 'Too many analyses right now', guidance: 'One analysis runs per visitor at a time, five per hour. Try again later.' },
  IDEMPOTENCY_CONFLICT: { title: 'That request was already used', guidance: 'Reload the page and submit again.' },
  FORBIDDEN: { title: 'This analysis belongs to another browser session', guidance: 'Progress and cancellation are available only to the browser that submitted it.' },
  ARTIFACT_NOT_FOUND: { title: 'This analysis does not exist', guidance: 'Check the link, or start a new analysis.' },
  ARTIFACT_EXPIRED: { title: 'This analysis has expired', guidance: 'Hosted results are kept for seven days. Start a new analysis to see the repository again.' },
  ARTIFACT_DELETED: { title: 'This analysis was deleted', guidance: 'Its owner removed it. Start a new analysis if the repository is still public.' },
  ARTIFACT_REVOKED: { title: 'This analysis is no longer available', guidance: 'The repository is not public any more, so its results were withdrawn.' },
  UNSUPPORTED_SCHEMA: { title: 'This analysis needs a different ATLAS version', guidance: 'Start a new analysis.' },
  VALIDATION_FAILED: { title: 'The request was not accepted', guidance: 'Reload the page and try again.' },
  INTERNAL_ERROR: { title: 'The service is temporarily unavailable', guidance: 'Try again later. Nothing was published.' },
};

export const errorText = (code: string) => ERROR_TEXT[code] ?? ERROR_TEXT['INTERNAL_ERROR']!;

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}
