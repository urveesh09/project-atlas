import { useEffect, useRef, useState } from 'react';
import { useViewer } from '../app/context';
import { fetchSource, type SourceText } from '../data/load';

/**
 * Read-only source (plan §14.3): fetched by snapshot ID + file occurrence ID from the
 * local server, rendered strictly as text. Nothing here interprets the content.
 */
export function SourcePanel() {
  const { model, state, dispatch } = useViewer();
  const request = state.source!;
  const [result, setResult] = useState<SourceText | { error: string } | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const targetRef = useRef<HTMLLIElement>(null);
  const opener = useRef<Element | null>(document.activeElement);
  const node = model.node(request.nodeId);

  useEffect(() => {
    let current = true;
    setResult(null);
    fetchSource(model.sourceSnapshotId, request.nodeId).then(
      (r) => current && setResult(r),
      () => current && setResult({ error: 'NETWORK' }),
    );
    return () => {
      current = false;
    };
  }, [model, request.nodeId]);

  useEffect(() => {
    closeRef.current?.focus();
    return () => {
      // Return focus to whatever opened the panel.
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, []);

  useEffect(() => {
    if (result && 'text' in result) targetRef.current?.scrollIntoView({ block: 'center' });
  }, [result]);

  const close = () => dispatch({ type: 'close-source' });
  return (
    <aside className="source-panel" role="dialog" aria-modal="false" aria-labelledby="source-title" onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), close())}>
      <header className="source-header">
        <h2 id="source-title">{node?.kind === 'file' ? node.path : 'Source'}</h2>
        <span className="source-meta">read-only · committed version</span>
        <button ref={closeRef} type="button" className="button" onClick={close} aria-label="Close source">
          Close
        </button>
      </header>
      {!result && <p className="empty" role="status">Loading source…</p>}
      {result && 'error' in result && (
        <p className="empty" role="status">
          Source unavailable ({result.error.toLowerCase().replaceAll('_', ' ')}).
        </p>
      )}
      {result && 'text' in result && (
        <ol className="code" aria-label={`${result.lineCount} lines`}>
          {result.text.split('\n').map((line, i) => (
            <li key={i} ref={i + 1 === request.line ? targetRef : undefined} className={i + 1 === request.line ? 'target' : undefined}>
              <code>{line || ' '}</code>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
