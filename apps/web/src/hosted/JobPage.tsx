import { useEffect, useRef, useState } from 'react';
import type { JobStatus } from '@atlas/schema';
import { cancelJob, followJob, HostedApiError, TERMINAL } from './api';
import { STAGES, STATE_TEXT, WARNING_TEXT, describeCounts, errorText, formatElapsed } from './messages';
import { navigate } from './route';

const STAGE_INDEX = new Map(STAGES.map((s, i) => [s.stage, i]));

/**
 * Job progress (plan §3.1, §3.3): stage list with counts rather than an invented overall
 * percentage, queue position, warnings, cancellation, and a failure code with guidance.
 * Updates arrive by SSE with polling fallback; completion offers the immutable result URL.
 */
export function JobPage({ jobId }: { jobId: string }) {
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [error, setError] = useState<HostedApiError | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => followJob(jobId, setStatus, setError), [jobId]);
  useEffect(() => heading.current?.focus(), []);
  const active = status !== null && !TERMINAL.has(status.state);
  useEffect(() => {
    if (!active) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [active]);

  const cancel = async () => {
    setCancelling(true);
    try {
      setStatus(await cancelJob(jobId));
    } catch (failure) {
      if (failure instanceof HostedApiError) setError(failure);
    } finally {
      setCancelling(false);
    }
  };

  const current = status?.stage ? (STAGE_INDEX.get(status.stage) ?? -1) : status && TERMINAL.has(status.state) ? STAGES.length : -1;
  const done = status?.state === 'READY' || status?.state === 'PARTIAL';
  const elapsed = status ? (TERMINAL.has(status.state) ? Date.parse(status.updatedAt) : now) - Date.parse(status.createdAt) : 0;
  const failure = status?.error ? errorText(status.error.code) : null;
  // The service clears the stage when a job fails or is cancelled, so the page cannot know
  // where it stopped. It then claims no stage at all rather than ticking every one (ADR-059).
  const stoppedAtUnknown = status !== null && (status.state === 'FAILED' || status.state === 'CANCELLED') && status.stage === null;

  return (
    <main className="gate">
      <div className="gate-card hosted-card">
        <p className="gate-brand">
          <a href="/" onClick={(e) => { e.preventDefault(); navigate('/'); }} className="brand-link">
            <span className="brand-mark" aria-hidden="true">◆</span> ATLAS
          </a>
        </p>
        <h1 ref={heading} tabIndex={-1}>
          {status ? STATE_TEXT[status.state] : error ? errorText(error.detail.code).title : 'Loading the analysis…'}
        </h1>
        {error && (
          <div className="hosted-error" role="alert">
            {errorText(error.detail.code).guidance}{' '}
            <a href="/" onClick={(e) => { e.preventDefault(); navigate('/'); }}>Start a new analysis</a>
          </div>
        )}
        {status && (
          <>
            <p className="gate-note" role="status" aria-live="polite">
              {status.state === 'QUEUED' && status.queuePosition !== null ? `Position ${status.queuePosition} in the queue. ` : ''}
              Elapsed {formatElapsed(elapsed)}, including time in the queue.
            </p>
            {stoppedAtUnknown ? (
              <p className="gate-note stage-unknown">
                {status.state === 'CANCELLED' ? 'It was cancelled' : 'It stopped'} before a result was published.
              </p>
            ) : (
            <ol className="stage-list" aria-label="Stages">
              {STAGES.map((s, i) => {
                const state = status.state === 'FAILED' || status.state === 'CANCELLED' ? (i < current ? 'done' : i === current ? 'stopped' : 'todo') : i < current || done ? 'done' : i === current ? 'active' : 'todo';
                return (
                  <li key={s.stage} className={`stage stage-${state}`} aria-current={state === 'active' ? 'step' : undefined}>
                    <span className="stage-mark" aria-hidden="true">{state === 'done' ? '✓' : state === 'active' ? '●' : state === 'stopped' ? '■' : '○'}</span>
                    {s.label}
                    <span className="sr-only">: {state === 'done' ? 'done' : state === 'active' ? 'in progress' : state === 'stopped' ? 'stopped' : 'waiting'}</span>
                  </li>
                );
              })}
            </ol>
            )}
            {describeCounts(status.counts).length > 0 && (
              <dl className="count-list" aria-label="Counts">
                {describeCounts(status.counts).map((count) => (
                  <div key={count.label}>
                    <dt>{count.value}</dt>
                    <dd>{count.label}</dd>
                  </div>
                ))}
              </dl>
            )}
            {status.warnings.length > 0 && (
              <ul className="warning-list" aria-label="Warnings">
                {status.warnings.map((w) => (
                  <li key={w.code}>
                    <code>{w.code}</code> {WARNING_TEXT[w.code] ?? 'See the coverage report in the result.'}
                    {w.count > 1 ? ` (${w.count})` : ''}
                  </li>
                ))}
              </ul>
            )}
            {failure && status.error && (
              <div className="hosted-error" role="alert">
                <strong>{failure.title}.</strong> {failure.guidance} <code>{status.error.code}</code>
              </div>
            )}
            <div className="hosted-actions">
              {done && status.analysisId && (
                <a className="button primary" href={`/a/${status.analysisId}`} onClick={(e) => { e.preventDefault(); navigate(`/a/${status.analysisId}`); }}>
                  Open the city
                </a>
              )}
              {active && (
                <button type="button" className="button" onClick={() => void cancel()} disabled={cancelling || status.state === 'CANCEL_REQUESTED'}>
                  {cancelling || status.state === 'CANCEL_REQUESTED' ? 'Cancelling…' : 'Cancel analysis'}
                </button>
              )}
              {TERMINAL.has(status.state) && (
                <a className="button" href="/" onClick={(e) => { e.preventDefault(); navigate('/'); }}>
                  {status.state === 'FAILED' && status.error?.retryable ? 'Try again' : 'New analysis'}
                </a>
              )}
            </div>
            {done && <p className="gate-small">The result link is permanent until it expires; it does not follow later commits.</p>}
          </>
        )}
      </div>
    </main>
  );
}
