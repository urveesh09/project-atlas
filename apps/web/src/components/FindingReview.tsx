import { useMemo, useState } from 'react';
import { findingReviewBasisLabel, findingReviewReasonLabel, findingReviewStateLabel } from '@atlas/graph';
import { compareUtf8, type FindingReview as Review, type ReviewIssue } from '@atlas/schema';
import { useViewer } from '../app/context';
import { Paged } from './ui';

export function FindingReviewPanel({ review }: { review: Review }) {
  const { dataset, goToFrame } = useViewer();
  const [filter, setFilter] = useState('all');
  const { current, baseline } = useMemo(
    () => ({
      current: new Map(review.current.report.findings.map((f) => [f.id, f])),
      baseline: new Map(review.baseline.report.findings.map((f) => [f.id, f])),
    }),
    [review],
  );
  const counts = useMemo(() => {
    const count: Record<ReviewIssue['state'], number> = {
      continuing: 0,
      'newly-reported': 0,
      'no-longer-reported': 0,
      'unmatched-current': 0,
      'unmatched-baseline': 0,
    };
    for (const row of review.issues) count[row.state]++;
    return count;
  }, [review]);
  const visible = useMemo(
    () =>
      review.issues
        .filter((r) => filter === 'all' || r.state === filter)
        .toSorted((a, b) => {
          const af = (a.currentFindingId ? current.get(a.currentFindingId) : baseline.get(a.baselineFindingId!))!;
          const bf = (b.currentFindingId ? current.get(b.currentFindingId) : baseline.get(b.baselineFindingId!))!;
          return compareUtf8(af.path, bf.path) || af.line - bf.line || compareUtf8(a.id, b.id);
        }),
    [review, filter, current, baseline],
  );
  return (
    <section className="finding-review" aria-label="Contextual finding review">
      <h3>Contextual finding review</h3>
      <p>
        {counts.continuing} continuing; {counts['newly-reported']} newly reported; {counts['no-longer-reported']} no
        longer reported; {counts['unmatched-current'] + counts['unmatched-baseline']} unmatched.
      </p>
      <p className="quality-caveat">
        This review is not authenticated in this browser. Copied verification claims do not establish trust. Tracking
        follows bounded file lineage and exact code context; changed or repeated contexts stay uncertain. No longer
        reported does not mean resolved or safe.
      </p>
      {review.reasons.length > 0 && (
        <ul>
          {review.reasons.map((reason) => (
            <li key={reason}>{findingReviewReasonLabel(reason)}</li>
          ))}
        </ul>
      )}
      <p className="section-description">
        Context and scope were declared by the review producer. Recreate this review with independently selected proof
        policies to check signatures locally; this file is not a reusable trust receipt.
      </p>
      <label htmlFor="finding-review-filter">Review evidence</label>{' '}
      <select id="finding-review-filter" value={filter} onChange={(event) => setFilter(event.currentTarget.value)}>
        <option value="all">All evidence ({review.issues.length})</option>
        {(Object.keys(counts) as ReviewIssue['state'][]).map((state) => (
          <option key={state} value={state}>
            {findingReviewStateLabel(state)} ({counts[state]})
          </option>
        ))}
      </select>
      <Paged
        key={filter}
        items={visible}
        pageSize={20}
        empty="No review evidence in this category. This does not establish a clean scan."
        render={(row) => (
          <li key={row.id}>
            <div>
              <strong>{findingReviewStateLabel(row.state)}</strong> · {findingReviewBasisLabel(row.basis)}
            </div>
            <div>
              Tracking ID <code>{row.id}</code>
            </div>
            {(['baseline', 'current'] as const).map((slot) => {
              const id = slot === 'current' ? row.currentFindingId : row.baselineFindingId;
              const f = id ? (slot === 'current' ? current : baseline).get(id) : null;
              if (!f) return null;
              const frame = dataset.frames.findIndex((frame) => frame.snapshotId === review[slot].report.snapshotId);
              return (
                <div key={slot}>
                  <button
                    type="button"
                    className="link"
                    onClick={() => void goToFrame(frame, { lineage: f.lineageId, tab: 'findings' })}
                  >
                    {slot === 'current' ? 'Current' : 'Baseline'}: {f.path}:{f.line}
                    {f.column === null ? '' : `:${f.column}`} · {f.ruleId}
                  </button>
                </div>
              );
            })}
          </li>
        )}
      />
    </section>
  );
}
