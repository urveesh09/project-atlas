import { useMemo, useState } from 'react';
import { useViewer } from '../app/context';
import { shortOid } from '../app/model';
import { Icon } from './Icon';

const KEY = 'atlas.startHidden';
export const DEMO = Boolean(import.meta.env.VITE_ATLAS_DEMO_BASE);
/** Where a demo visitor learns to analyze their own repository (ADR-047). */
export const OWN_REPOSITORY_GUIDE = 'https://github.com/urveesh09/project-atlas/blob/main/docs/guides/analyze-your-repository.md';

function readHidden(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * A short, dismissible start (ADR-047): what this analysis is, and three tasks that each
 * name their concrete target, so a first visit begins with a question the city answers.
 * The targets are derived from the analysis, never hard-coded.
 */
export function StartPanel() {
  const { model, dataset, dispatch, select, setCompare } = useViewer();
  const [hidden, setHidden] = useState(readHidden);
  const targets = useMemo(() => {
    const files = new Map<string, number>();
    let traced: { id: string; path: string; fanIn: number } | null = null;
    for (const b of model.city.buildings) {
      const pkg = model.index.packageOf(b.nodeId);
      if (pkg) files.set(pkg.id, (files.get(pkg.id) ?? 0) + 1);
      const fanIn = b.metric?.fanIn ?? null;
      if (b.role === 'source' && fanIn !== null && (!traced || fanIn > traced.fanIn || (fanIn === traced.fanIn && b.path < traced.path))) traced = { id: b.nodeId, path: b.path, fanIn };
    }
    let largest: { id: string; files: number } | null = null;
    for (const [id, count] of files) if (!largest || count > largest.files || (count === largest.files && id < largest.id)) largest = { id, files: count };
    return { largest, traced };
  }, [model]);
  const hide = (value: boolean) => {
    setHidden(value);
    try {
      localStorage.setItem(KEY, value ? '1' : '0');
    } catch {
      // Storage may be blocked; the choice then lasts for this page only.
    }
  };
  if (hidden) {
    return (
      <p className="start-reopen">
        <button type="button" className="link" onClick={() => hide(false)}>
          Show guided start
        </button>
      </p>
    );
  }
  const largest = targets.largest ? model.node(targets.largest.id) : undefined;
  const traced = targets.traced;
  const frames = dataset.frames.length;
  const remote = model.manifest.repo.remote;
  return (
    <section className="start" aria-labelledby="start-title">
      <div className="start-text">
        <h2 id="start-title">{DEMO ? 'Live demo' : 'Start here'}</h2>
        <p>
          {DEMO ? (
            <>
              Static analysis of{' '}
              {remote ? (
                <a href={`https://github.com/${remote.owner}/${remote.name}/tree/${model.manifest.selectedCommit.oid}`} target="_blank" rel="noopener noreferrer">
                  {model.manifest.repo.displayName}
                </a>
              ) : (
                model.manifest.repo.displayName
              )}{' '}
              at <code>{shortOid(model.manifest.selectedCommit.oid)}</code>: one building per TS/JS file. Nothing from the repository runs.
            </>
          ) : (
            <>One building per file. Every number links to its evidence.</>
          )}
        </p>
        {DEMO && (
          <a className="start-own" href={OWN_REPOSITORY_GUIDE} target="_blank" rel="noopener noreferrer">
            Analyze your own repository →
          </a>
        )}
      </div>
      <ul className="start-tasks" aria-label="Suggested tasks">
        {largest && (
          <li>
            <button
              type="button"
              onClick={() => {
                select(largest.id);
                dispatch({ type: 'tab', tab: 'overview' });
                dispatch({ type: 'focus' });
              }}
            >
              <span className="start-task-icon">
                <Icon name="package" size={18} />
              </span>
              <span className="start-task-text">
                <strong>Explore a package</strong>
                <span>
                  {model.title(largest)}, the largest ({targets.largest!.files.toLocaleString('en-US')} files)
                </span>
              </span>
            </button>
          </li>
        )}
        {traced && (
          <li>
            <button
              type="button"
              onClick={() => {
                select(traced.id);
                dispatch({ type: 'edges', direction: 'both' });
                dispatch({ type: 'tab', tab: 'dependencies' });
                dispatch({ type: 'focus' });
              }}
            >
              <span className="start-task-icon">
                <Icon name="link" size={18} />
              </span>
              <span className="start-task-text">
                <strong>Trace a file’s dependencies</strong>
                <span>
                  {traced.path.split('/').at(-1)}, imported by {traced.fanIn.toLocaleString('en-US')} files
                </span>
              </span>
            </button>
          </li>
        )}
        {frames > 1 && (
          <li>
            <button type="button" onClick={() => void setCompare({ a: frames - 2, b: frames - 1 })}>
              <span className="start-task-icon">
                <Icon name="compare" size={18} />
              </span>
              <span className="start-task-text">
                <strong>Compare two snapshots</strong>
                <span>What changed between the last two of {frames}</span>
              </span>
            </button>
          </li>
        )}
      </ul>
      <button type="button" className="start-hide" aria-label="Hide" title="Hide the guided start" onClick={() => hide(true)}>
        <Icon name="close" />
      </button>
    </section>
  );
}
