import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useViewer } from '../app/context';
import { formatDate, shortOid } from '../app/model';

/**
 * The sampled snapshot strip (plan §3.3, §12.2, P4.6). Only analyzed frames are
 * selectable — there are no arbitrary slider positions — and the window, the sampling and
 * the fixed-plot anchoring are stated in words next to the control (Gate G4). Frames are
 * evenly spaced so every target stays 44px and distinct; the window commits that were not
 * sampled appear as ticks inside each gap, so sampling density stays visible.
 */
const BOUNDARY: Record<string, string> = {
  root: 'reaches the repository’s first commit',
  days: 'bounded by the day window',
  'commit-cap': 'bounded by the commit cap',
  shallow: 'stops where a shallow clone ends: the oldest change is unknown',
  'resource-cap': 'stopped by a resource limit',
  none: 'not analyzed',
};

export function Timeline() {
  const { dataset, model, state, goToFrame, frameLoading, frameError, setCompare } = useViewer();
  const frames = dataset.frames;
  const coverage = dataset.manifest.coverage.history;
  const refs = useRef(new Map<number, HTMLButtonElement>());
  const [playing, setPlaying] = useState(false);
  const reducedMotion = useMemo(() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  const unavailable = dataset.history.frameSelection?.commits.filter((c) => c.status === 'unavailable') ?? [];

  const windowStart = dataset.history.commits.at(-1)?.committerTime;
  const position = (i: number) => (frames.length === 1 ? 0.5 : i / (frames.length - 1));
  // Unsampled window commits: before the first frame, then inside each gap between frames.
  const ticks = useMemo(() => {
    const out: { key: string; at: number }[] = [];
    const chain = frames.map((f) => dataset.chainIndex.get(f.commit.oid) ?? 0);
    for (let i = 0; i + 1 < frames.length; i++) {
      const between = chain[i + 1]! - chain[i]! - 1;
      for (let j = 1; j <= between; j++) out.push({ key: `${i}:${j}`, at: position(i) + (j / (between + 1)) * (position(i + 1) - position(i)) });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset, frames]);

  // Optional stepping, never automatic (plan §12.4); off entirely under reduced motion.
  useEffect(() => {
    if (!playing) return;
    if (state.frame >= frames.length - 1) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => void goToFrame(state.frame + 1, { quiet: true }), 1400);
    return () => clearTimeout(timer);
  }, [playing, state.frame, frames.length, goToFrame]);
  if (coverage.status === 'unavailable' || frames.length < 1) {
    return (
      <section className="timeline timeline-off" aria-labelledby="timeline-title">
        <h2 id="timeline-title" className="timeline-title">
          History
        </h2>
        <p className="timeline-summary">
          {coverage.boundary === 'none' && coverage.requestedCommitCap === 0
            ? 'Not requested for this analysis (history disabled). Churn and hotspot scores are absent, never zero.'
            : `Requested but unavailable: ${BOUNDARY[coverage.boundary] ?? 'not analyzed'}. Only the selected commit is shown; churn and hotspot scores are absent, never zero.`}
        </p>
      </section>
    );
  }

  const go = (frame: number) => {
    setPlaying(false);
    void goToFrame(frame);
  };
  const onKey = (event: KeyboardEvent<HTMLOListElement>) => {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    // Relative to the focused snapshot, so quick presses accumulate while a frame loads.
    const focused = [...refs.current].find(([, el]) => el === event.target)?.[0] ?? state.frame;
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? frames.length - 1 : delta ? focused + delta : -1;
    if (target < 0 || target >= frames.length) return;
    event.preventDefault();
    refs.current.get(target)?.focus();
    go(target);
  };
  const active = frames[state.frame]!;
  const commitsUpTo = (dataset.chainIndex.get(active.commit.oid) ?? 0) + 1;

  return (
    <section className="timeline" aria-labelledby="timeline-title">
      <div className="timeline-head">
        <h2 id="timeline-title" className="timeline-title">
          History
        </h2>
        <p className="timeline-summary">
          <strong>{coverage.commitsTraversed.toLocaleString('en-US')}</strong> mainline commits ·{' '}
          {windowStart ? `${formatDate(windowStart)} → ${formatDate(frames.at(-1)!.commit.committerTime)}` : formatDate(active.commit.committerTime)} ·{' '}
          <strong>{frames.length}</strong> analyzed snapshot{frames.length === 1 ? '' : 's'}
          {coverage.framesRequested > frames.length ? ` of ${coverage.framesRequested} requested` : ''} · {BOUNDARY[coverage.boundary] ?? coverage.boundary}
          {coverage.status === 'partial' && <span className="chip chip-warn timeline-chip">partial history</span>}
        </p>
        <details className="timeline-help">
          <summary>How to read history</summary>
          <ul>
            <li>
              Snapshots are <strong>sampled</strong> commits on the first-parent (mainline) chain, not every commit. Churn and the change counts still use every commit in
              the window, counted only up to the snapshot shown.
            </li>
            <li>A merge contributes the change it brought to the mainline, which can bundle several people’s work.</li>
            <li>
              Buildings keep <strong>one fixed plot</strong> in every snapshot, anchored to the file’s latest path. A file that moved still stands on that plot; the tree and
              inspector show where it really was at the time.
            </li>
            <li>A file absent from a snapshot shows its last and next appearance instead of a substitute; deleted and added files are marked in comparisons.</li>
          </ul>
        </details>
      </div>
      <div className="timeline-scroll">
      <div className="timeline-track" style={{ minWidth: frames.length * 48 }}>
        <div className="timeline-axis" aria-hidden="true">
          {ticks.map((t) => (
            <span key={t.key} className="timeline-tick" style={{ left: `${t.at * 100}%` }} />
          ))}
        </div>
        <ol className="timeline-strip" aria-label="Analyzed snapshots, oldest to newest" onKeyDown={onKey}>
          {frames.map((f, i) => {
            const selected = i === state.frame;
            const inCompare = state.compare && (state.compare.a === i || state.compare.b === i);
            return (
              <li key={f.snapshotId} style={{ left: `${position(i) * 100}%` }}>
                <button
                  ref={(el) => {
                    if (el) refs.current.set(i, el);
                  }}
                  type="button"
                  className={`timeline-frame${selected ? ' is-active' : ''}${inCompare ? ' is-compare' : ''}${frameLoading === i ? ' is-loading' : ''}`}
                  aria-current={selected ? 'step' : undefined}
                  tabIndex={selected ? 0 : -1}
                  aria-label={`Snapshot ${i + 1} of ${frames.length}: ${formatDate(f.commit.committerTime)}, commit ${shortOid(f.commit.oid)}, ${f.coverage.includedFiles.toLocaleString('en-US')} files${i === dataset.headIndex ? ', selected commit' : ''}${f.analysisStatus !== 'complete' ? `, ${f.analysisStatus} analysis` : ''}${state.compare?.a === i ? ', comparison A' : state.compare?.b === i ? ', comparison B' : ''}`}
                  onClick={() => go(i)}
                >
                  <span className="timeline-dot" aria-hidden="true">
                    {state.compare?.a === i ? 'A' : state.compare?.b === i ? 'B' : ''}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
      </div>
      <div className="timeline-controls">
        <button type="button" className="button" disabled={state.frame === 0} onClick={() => go(state.frame - 1)}>
          ‹ Earlier
        </button>
        <p className="timeline-current" aria-hidden="true">
          <strong>
            Snapshot {state.frame + 1} of {frames.length}
          </strong>{' '}
          · {formatDate(active.commit.committerTime)} · <code>{shortOid(active.commit.oid)}</code> · {active.coverage.includedFiles.toLocaleString('en-US')} files ·{' '}
          {commitsUpTo} of {coverage.commitsTraversed} window commits up to here
          {state.frame === dataset.headIndex && ' · selected commit'}
        </p>
        <button type="button" className="button" disabled={state.frame >= frames.length - 1} onClick={() => go(state.frame + 1)}>
          Later ›
        </button>
        {!reducedMotion && frames.length > 1 && (
          <button
            type="button"
            className="button ghost"
            aria-pressed={playing}
            onClick={() => {
              if (!playing && state.frame >= frames.length - 1) void goToFrame(0, { quiet: true });
              setPlaying(!playing);
            }}
          >
            {playing ? 'Pause' : 'Step through'}
          </button>
        )}
        {frames.length > 1 && (
          <button
            type="button"
            className="button ghost"
            aria-pressed={state.compare !== null}
            onClick={() => void setCompare(state.compare ? null : { a: state.frame === 0 ? 0 : state.frame - 1, b: state.frame === 0 ? 1 : state.frame })}
          >
            {state.compare ? 'Close comparison' : 'Compare snapshots…'}
          </button>
        )}
        {state.frame !== dataset.headIndex && (
          <button type="button" className="link" onClick={() => go(dataset.headIndex)}>
            Back to the selected commit
          </button>
        )}
      </div>
      {frameLoading !== null && (
        <p className="timeline-status" role="status">
          Loading snapshot {frameLoading + 1}… the current snapshot stays usable.
        </p>
      )}
      {frameError && (
        <p className="timeline-status timeline-error" role="alert">
          {frameError}
        </p>
      )}
      {unavailable.length > 0 && (
        <p className="timeline-status">
          {unavailable.length} requested snapshot{unavailable.length === 1 ? ' was' : 's were'} not analyzed:{' '}
          {unavailable.map((u) => `${shortOid(u.commitOid)} (${(u.reason ?? '').toLowerCase().replaceAll('_', ' ')})`).join(', ')}. They are listed here and in coverage, never
          filled in.
        </p>
      )}
      {!model.isHead && (
        <p className="timeline-status timeline-past">
          Viewing the past: metrics, findings and dependencies below are those of {formatDate(model.commit.committerTime)}. Hotspot scores use the selected commit’s cohort
          as a fixed baseline.
        </p>
      )}
    </section>
  );
}
