import { useEffect, useRef, useState, type RefObject } from 'react';
import { WorkspaceProvider, useWorkspace } from '../app/workspace';
import { useViewer } from '../app/context';
import { shortOid } from '../app/model';
import { Inspector } from './Inspector';
import { Overview } from './Overview';
import { Search } from './Search';
import { SourcePanel } from './SourcePanel';
import { Tree } from './Tree';
import { City } from './City';
import { ComparePanel } from './ComparePanel';
import { Tombstone } from './HistoryPanel';
import { DEMO, OWN_REPOSITORY_GUIDE, StartPanel } from './StartPanel';
import { ResultActions } from '../hosted/ResultActions';

/**
 * The functional explorer: tree, search, inspector and overview, all plain HTML. A hosted
 * publication adds its expiry, a new-analysis route and owner deletion; it never offers
 * to upload anything.
 */
type ExplorerProps = { onOpenOther: () => void; hosted?: { analysisId: string; expiresAt: string | null } | null };
export const ATLAS_VERSION = typeof __ATLAS_VERSION__ === 'string' ? __ATLAS_VERSION__ : 'dev';

export function Explorer(props: ExplorerProps) {
  const root = useRef<HTMLDivElement>(null);
  return (
    <WorkspaceProvider target={root}>
      <ExplorerShell {...props} root={root} />
    </WorkspaceProvider>
  );
}

function ExplorerShell({ onOpenOther, hosted = null, root }: ExplorerProps & { root: RefObject<HTMLDivElement | null> }) {
  const { model, state, select, dispatch } = useViewer();
  const workspace = useWorkspace();
  const searchRef = useRef<HTMLInputElement>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  // Hiding the tree is a per-viewer layout preference, like the city style.
  const [treeHidden, setTreeHidden] = useState(() => {
    try {
      return localStorage.getItem('atlas.treeHidden') === '1';
    } catch {
      return false;
    }
  });
  const toggleTree = () => {
    setTreeHidden((hidden) => {
      try {
        localStorage.setItem('atlas.treeHidden', hidden ? '0' : '1');
      } catch {
        // Storage may be blocked; the choice then lasts for this page only.
      }
      return !hidden;
    });
  };
  const selected = model.node(state.selectedId);
  const status = model.manifest.frames[model.frame]!.analysisStatus;

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
        else if (state.selectedId || state.tombstone) select(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch, helpOpen, select, state.selectedId, state.tombstone, state.source]);

  return (
    <div
      ref={root}
      className={`app${state.source ? ' with-source' : ''}${treeHidden ? ' tree-hidden' : ''}${workspace.mode !== 'no' ? ` is-workspace${workspace.drawer ? '' : ' drawer-closed'}` : ''}`}
    >
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
        <span className="app-version" title={`ATLAS viewer ${ATLAS_VERSION}`}>
          {ATLAS_VERSION}
        </span>
        <div className="repo">
          <span className="repo-name">{model.manifest.repo.displayName}</span>
          <code className="repo-commit" title={model.commit.oid}>
            {shortOid(model.commit.oid)}
          </code>
          {!model.isHead && <span className="status status-past">snapshot {model.frame + 1}</span>}
          <span className={`status status-${status}`}>{status}</span>
        </div>
        <Search ref={searchRef} />
        <div className="topbar-actions">
          <button type="button" className="button ghost" aria-expanded={!treeHidden} aria-controls="repository-tree" onClick={toggleTree}>
            {treeHidden ? 'Show tree' : 'Hide tree'}
          </button>
          <button type="button" className="button ghost" aria-expanded={helpOpen} aria-controls="shortcuts" onClick={() => setHelpOpen((o) => !o)}>
            Keys
          </button>
          {DEMO && (
            // Static demo builds (ADR-044, ADR-047) point visitors at running ATLAS on their own code.
            <a className="button ghost" href={OWN_REPOSITORY_GUIDE} target="_blank" rel="noopener noreferrer">
              Your repository
            </a>
          )}
          {hosted ? (
            <ResultActions analysisId={hosted.analysisId} expiresAt={hosted.expiresAt} />
          ) : (
            <button type="button" className="button ghost" onClick={onOpenOther}>
              Open artifact…
            </button>
          )}
        </div>
      </header>
      {helpOpen && (
        <section id="shortcuts" className="shortcuts" aria-label="Keyboard shortcuts">
          <dl>
            <div><dt><kbd>/</kbd></dt><dd>Search</dd></div>
            <div><dt><kbd>↑</kbd> <kbd>↓</kbd></dt><dd>Move in the tree or results</dd></div>
            <div><dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>Collapse, expand; switch inspector tabs</dd></div>
            <div><dt><kbd>Enter</kbd></dt><dd>Select</dd></div>
            <div><dt><kbd>←</kbd> <kbd>→</kbd> in History</dt><dd>Earlier or later snapshot</dd></div>
            <div><dt><kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> or arrows in the city</dt><dd>Move forward, left, back, right (click the city first)</dd></div>
            <div><dt><kbd>Q</kbd> <kbd>E</kbd>, <kbd>Shift</kbd>+arrows</dt><dd>Turn; tilt the view up or down</dd></div>
            <div><dt><kbd>+</kbd> <kbd>−</kbd></dt><dd>Zoom the city in or out</dd></div>
            <div><dt><kbd>F</kbd></dt><dd>Expand the city, or leave it</dd></div>
            <div><dt><kbd>[</kbd> <kbd>]</kbd></dt><dd>Previous or next camera view (3D)</dd></div>
            <div><dt><kbd>Esc</kbd></dt><dd>Close panel, then clear selection</dd></div>
            <div><dt><kbd>?</kbd></dt><dd>Show or hide this help</dd></div>
          </dl>
          <p className="shortcuts-about">
            ATLAS viewer {ATLAS_VERSION} · analysis by {model.manifest.analyzer.version} · artifact {model.manifest.artifactVersion.replace('atlas.artifact/', '')}
          </p>
        </section>
      )}
      <div className="layout">
        <nav id="repository-tree" className="sidebar" aria-label="Repository">
          <Tree />
        </nav>
        <main id="main-content" className="content city-content" tabIndex={-1}>
          <StartPanel />
          <City />
          <div className="city-inspector">
            {state.tombstone ? (
              <Tombstone key={`${state.tombstone.lineageId}:${state.frame}`} lineageId={state.tombstone.lineageId} />
            ) : selected && selected.kind !== 'repository' ? (
              <Inspector key={selected.id} node={selected} />
            ) : (
              <Overview />
            )}
          </div>
          <ComparePanel />
        </main>
        {state.source && <SourcePanel key={`${state.source.nodeId}:${state.source.line}`} />}
      </div>
      <div className="sr-only" role="status" aria-live="polite">
        {state.announcement}
      </div>
    </div>
  );
}
