import { useId, useMemo, useState } from 'react';
import { comparedDependencyEvidence, type ComparedEdge, type FrameComparison } from '@atlas/graph';
import { escapeForDisplay } from '@atlas/schema';
import { useViewer } from '../app/context';
import { Paged, Section } from './ui';

type Change = { edge: ComparedEdge; side: 'A' | 'B' };

export function CompareDependencies({ result, a, b }: { result: FrameComparison; a: number; b: number }) {
  const { dataset, model, state } = useViewer();
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const selected = model.node(state.selectedId);
  const lineage = selected?.kind === 'file' ? selected.lineageId : (state.tombstone?.lineageId ?? null);
  const scope = selectedOnly ? lineage : null;
  const scopedPath = scope && (selected?.kind === 'file' ? selected.path : dataset.lineagePath(scope));
  const rows = useMemo<Change[]>(() => [
    ...result.edgesAdded.map((edge) => ({ edge, side: 'B' as const })),
    ...result.edgesRemoved.map((edge) => ({ edge, side: 'A' as const })),
  ], [result]);
  const visible = useMemo(() => scope
    ? rows.filter(({ edge }) => edge.sourceLineageId === scope || edge.target === scope)
    : rows, [rows, scope]);

  return (
    <Section
      title="Dependency changes"
      count={rows.length}
      description="Open a relationship to see the import evidence in its snapshot. Changes describe observed static relationships and can reflect changes in resolution or coverage."
    >
      <label className="compare-dependency-scope">
        <input
          type="checkbox"
          checked={scope !== null}
          disabled={lineage === null}
          onChange={(event) => {
            setSelectedOnly(event.currentTarget.checked);
            setOpen(null);
          }}
        />
        Selected file only
      </label>
      {scope && (
        <p role="status">
          Showing {visible.length} of {rows.length} changes involving {scopedPath ? <code className="row-main">{scopedPath}</code> : 'the selected file'}.
        </p>
      )}
      <Paged
        key={scope ?? 'all'}
        items={visible}
        pageSize={20}
        empty={scope ? 'No dependency differences for the selected file.' : 'No dependency differences.'}
        render={(change) => {
          const { edge, side } = change;
          const key = JSON.stringify([side, edge.sourceLineageId, edge.target, edge.kind]);
          return (
            <DependencyChangeRow
              key={key}
              change={change}
              frame={side === 'A' ? a : b}
              open={open === key}
              toggle={() => setOpen(open === key ? null : key)}
            />
          );
        }}
      />
    </Section>
  );
}

function DependencyChangeRow({ change, frame, open, toggle }: {
  change: Change;
  frame: number;
  open: boolean;
  toggle: () => void;
}) {
  const id = useId();
  const { edge, side } = change;
  const added = side === 'B';
  return (
    <li>
      <div className="row">
        <button
          type="button"
          className="link row-main compare-dependency-toggle"
          aria-expanded={open}
          aria-controls={id}
          onClick={toggle}
        >
          <span className={added ? 'delta-up' : 'delta-down'}>{added ? 'Added' : 'Removed'}</span>{' '}
          {edge.sourcePath} → {edge.targetLabel} <span className="row-meta">({edge.kind})</span>
        </button>
      </div>
      <div id={id} hidden={!open} className="compare-dependency-evidence">
        {open && <DependencyEvidence change={change} frame={frame} />}
      </div>
    </li>
  );
}

function DependencyEvidence({ change, frame }: { change: Change; frame: number }) {
  const { frameModel, model, select, dispatch, goToFrame } = useViewer();
  const snapshot = frameModel(frame);
  const evidence = useMemo(() => snapshot && comparedDependencyEvidence(snapshot.index, change.edge), [snapshot, change.edge]);
  if (!evidence) return <p className="empty">Import evidence is unavailable for this relationship.</p>;
  const { locations, statements, omittedByArtifact, sourceId } = evidence;
  const retained = statements - omittedByArtifact;
  const inspect = () => {
    if (model.frame === frame) {
      select(sourceId, { focusInspector: true });
      dispatch({ type: 'tab', tab: 'dependencies' });
    } else {
      void goToFrame(frame, { lineage: change.edge.sourceLineageId, tab: 'dependencies', focusInspector: true });
    }
  };
  return (
    <>
      <p>
        <strong>Evidence in snapshot {change.side}</strong> · {statements} observed {statements === 1 ? 'statement' : 'statements'}.
        {' '}Showing {locations.length} of {retained} retained positions.
        {omittedByArtifact > 0 && <> The artifact omitted {omittedByArtifact} {omittedByArtifact === 1 ? 'position' : 'positions'}.</>}
      </p>
      {locations.length > 0 && (
        <ul className="rows">
          {locations.map((observation) => (
            <li key={observation.id} className="row">
              <code className="row-main">{escapeForDisplay(observation.specifier ?? '(computed)')}</code>
              <span className="row-meta">
                line {observation.range.startLine}:{observation.range.startColumn} · {observation.confidence}
              </span>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="button ghost" onClick={inspect}>
        {change.side === 'A' ? 'Open A and inspect dependencies' : 'Inspect dependencies in B'}
      </button>
    </>
  );
}
