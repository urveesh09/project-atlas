import { useEffect, useId, useState } from 'react';
import type { ConsumerPathsResult } from '@atlas/graph';
import { LIMITS, escapeForDisplay, type FileNode } from '@atlas/schema';
import { useViewer } from '../app/context';
import { formatNumber, type ViewerModel } from '../app/model';
import { Paged, Section } from './ui';

type Side = 'A' | 'B';

export function CompareConsumerPaths({ a, b }: { a: number; b: number }) {
  const { model, state, frameModel } = useViewer();
  const selected = model.node(state.selectedId);
  const lineage = selected?.kind === 'file' ? selected.lineageId : state.tombstone?.lineageId;
  const frames = { A: frameModel(a), B: frameModel(b) };
  const before = lineage ? frames.A?.fileByLineage.get(lineage) : undefined;
  const after = lineage ? frames.B?.fileByLineage.get(lineage) : undefined;
  const primary = after ?? before;
  return (
    <Section title="Consumer paths">
      {primary ? (
        <ConsumerPathPicker key={lineage} frames={frames} files={{ A: before, B: after }} initialFile={primary} />
      ) : (
        <p className="empty">Select a file to trace which files import it.</p>
      )}
    </Section>
  );
}

function ConsumerPathPicker({ frames, files, initialFile }: {
  frames: Record<Side, ViewerModel | undefined>;
  files: Record<Side, FileNode | undefined>;
  initialFile: FileNode;
}) {
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<Side>(files.B ? 'B' : 'A');
  const [depth, setDepth] = useState<number>(LIMITS.reachDefaultDepth);
  const region = useId();
  const file = files[side];
  const snapshot = frames[side];
  const label = escapeForDisplay((file ?? initialFile).path);
  return (
    <>
      <div className="controls">
        <button type="button" className="button ghost" aria-expanded={open} aria-controls={region} onClick={() => setOpen(!open)}>
          {open ? 'Hide paths' : 'Show paths'}
        </button>
        <code className="row-main">{label}</code>
      </div>
      <div id={region} hidden={!open}>
        {open && (
          <>
            <div className="controls compare-path-controls">
              <label>
                Trace in snapshot
                <select value={side} onChange={(event) => setSide(event.currentTarget.value === 'A' ? 'A' : 'B')}>
                  <option value="A">A · From</option>
                  <option value="B">B · To</option>
                </select>
              </label>
              <label>
                Maximum hops
                <select value={depth} onChange={(event) => setDepth(Number(event.currentTarget.value))} disabled={!file}>
                  {Array.from({ length: LIMITS.reachMaxDepth }, (_, i) => <option key={i + 1}>{i + 1}</option>)}
                </select>
              </label>
            </div>
            <p className="note">
              Paths follow recorded internal value imports, re-exports and literal requires.
              Use them to review static dependencies. Runtime behavior may differ.
            </p>
            {snapshot && file ? (
              <ConsumerPaths key={`${side}:${snapshot.snapshotId}:${depth}`} snapshot={snapshot} file={file} depth={depth} side={side} />
            ) : (
              <p className="empty" role="status">
                {snapshot ? 'The selected file is absent in' : 'Could not read'} snapshot {side}.
              </p>
            )}
          </>
        )}
      </div>
    </>
  );
}

function ConsumerPaths({ snapshot, file, depth, side }: { snapshot: ViewerModel; file: FileNode; depth: number; side: Side }) {
  const { model, queries, goToFrame, select, dispatch } = useViewer();
  const [response, setResponse] = useState<{ result: ConsumerPathsResult | null } | null>(null);
  const { frame } = snapshot;
  const { id } = file;
  useEffect(() => {
    if (!queries) return;
    let current = true;
    const finish = (result: ConsumerPathsResult | null) => { if (current) setResponse({ result }); };
    void queries.consumerPaths(frame, id, depth).then(finish, () => finish(null));
    return () => { current = false; };
  }, [queries, frame, id, depth]);

  const inspect = (importer: FileNode) => {
    if (model.frame === frame) {
      select(importer.id, { focusInspector: true });
      dispatch({ type: 'tab', tab: 'dependencies' });
    } else if (importer.lineageId) {
      void goToFrame(frame, { lineage: importer.lineageId, tab: 'dependencies', focusInspector: true });
    }
  };

  if (!queries || response?.result === null) return <p className="empty" role="status">Consumer paths are unavailable in snapshot {side}.</p>;
  if (!response) return <p role="status">Finding consumers in snapshot {side}…</p>;
  const { result } = response;
  const coverage = snapshot.graph.coverage;
  const limited = coverage.omittedFiles > 0 || coverage.parsedFiles < coverage.supportedFiles || coverage.limitsHit.length > 0;
  return (
    <>
      <p role="status">
        Snapshot {side} · {result.truncated ? 'at least ' : ''}{formatNumber(result.total)} observed
        {' '}{result.total === 1 ? 'consumer' : 'consumers'} within {result.depth} {result.depth === 1 ? 'hop' : 'hops'}
        {' '}({formatNumber(result.direct)} direct in this search).
        {result.paths.length < result.total && <> The first {result.paths.length} paths are available below.</>}
      </p>
      {limited && <p className="note">Snapshot coverage is partial. Some files or relationships may be missing.</p>}
      {result.truncated && <p className="note">The search reached the {formatNumber(LIMITS.reachMaxVisited)}-file visit limit.</p>}
      {result.beyondDepth && <p className="note">The recorded graph has consumers beyond this depth.</p>}
      <Paged
        items={result.paths}
        pageSize={10}
        empty="No static consumer paths were found within this depth."
        render={(path) => (
          <li key={path[0]} className="row">
            <ol className="compare-path" role="list" aria-label={path.length === 2 ? 'Direct import' : `Import path, ${path.length - 1} hops`}>
              {path.map((id, i) => {
                const node = snapshot.node(id);
                if (node?.kind !== 'file') return null;
                const label = escapeForDisplay(node.path);
                const canInspect = i < path.length - 1 && (model.frame === frame || node.lineageId);
                return (
                  <li key={id}>
                    {i > 0 && <span aria-hidden="true">→</span>}
                    {canInspect ? (
                      <button type="button" className="link row-main" aria-label={`Inspect imports of ${label} in snapshot ${side}`} onClick={() => inspect(node)}>
                        {label}
                      </button>
                    ) : <code className="row-main">{label}</code>}
                  </li>
                );
              })}
            </ol>
          </li>
        )}
      />
    </>
  );
}
