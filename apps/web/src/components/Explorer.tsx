import { useEffect, useRef, useState } from 'react';
import { useViewer } from '../app/context';
import { shortOid } from '../app/model';
import { Inspector } from './Inspector';
import { Overview } from './Overview';
import { Search } from './Search';
import { SourcePanel } from './SourcePanel';
import { Tree } from './Tree';
import { City } from './City';

/** The functional explorer: tree, search, inspector and overview, all plain HTML. */
export function Explorer({ onOpenOther }: { onOpenOther: () => void }) {
  const { model, state, select, dispatch } = useViewer();
  const searchRef = useRef<HTMLInputElement>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const selected = model.node(state.selectedId);
  const status = model.manifest.frames.at(-1)!.analysisStatus;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.closest('input, textarea, select, [contenteditable="true"]') !== null && target !== null;
      // Shortcuts never intercept typing in controls (plan §12.4).
      if (event.key === '/' && !typing && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (event.key === '?' && !typing) {
        setHelpOpen((open) => !open);
      } else if (event.key === 'Escape' && !typing) {
        if (helpOpen) setHelpOpen(false);
        else if (state.source) dispatch({ type: 'close-source' });
        else if (state.selectedId) select(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch, helpOpen, select, state.selectedId, state.source]);

  return (
    <div className={`app${state.source ? ' with-source' : ''}`}>
      <a className="skip" href="#main-content">
        Skip to content
      </a>
      <header className="topbar">
        <button type="button" className="brand" onClick={() => select(null)} aria-label="ATLAS: repository overview">
          <span className="brand-mark" aria-hidden="true">
            ◆
          </span>
          <span className="brand-name">ATLAS</span>
        </button>
        <div className="repo">
          <span className="repo-name">{model.manifest.repo.displayName}</span>
          <code className="repo-commit" title={model.manifest.selectedCommit.oid}>
            {shortOid(model.manifest.selectedCommit.oid)}
          </code>
          <span className={`status status-${status}`}>{status}</span>
        </div>
        <Search ref={searchRef} />
        <div className="topbar-actions">
          <button type="button" className="button ghost" aria-expanded={helpOpen} aria-controls="shortcuts" onClick={() => setHelpOpen((o) => !o)}>
            Keys
          </button>
          <button type="button" className="button ghost" onClick={onOpenOther}>
            Open artifact…
          </button>
        </div>
      </header>
      {helpOpen && (
        <section id="shortcuts" className="shortcuts" aria-label="Keyboard shortcuts">
          <dl>
            <div><dt><kbd>/</kbd></dt><dd>Search</dd></div>
            <div><dt><kbd>↑</kbd> <kbd>↓</kbd></dt><dd>Move in the tree or results</dd></div>
            <div><dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>Collapse, expand; switch inspector tabs</dd></div>
            <div><dt><kbd>Enter</kbd></dt><dd>Select</dd></div>
            <div><dt><kbd>Esc</kbd></dt><dd>Close panel, then clear selection</dd></div>
            <div><dt><kbd>?</kbd></dt><dd>Show or hide this help</dd></div>
          </dl>
        </section>
      )}
      <div className="layout">
        <nav className="sidebar" aria-label="Repository">
          <Tree />
        </nav>
        <main id="main-content" className="content city-content" tabIndex={-1}>
          <City />
          <div className="city-inspector">{selected && selected.kind !== 'repository' ? <Inspector key={selected.id} node={selected} /> : <Overview />}</div>
        </main>
        {state.source && <SourcePanel key={`${state.source.nodeId}:${state.source.line}`} />}
      </div>
      <div className="sr-only" role="status" aria-live="polite">
        {state.announcement}
      </div>
    </div>
  );
}
