import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react';
import type { SourceStatus } from '../data/load';
import { ViewerModel } from './model';
import { formatFragment, parseFragment, viewReducer, type InspectorTab, type ViewAction, type ViewState } from './state';

interface ViewerContextValue {
  model: ViewerModel;
  state: ViewState;
  dispatch: (action: ViewAction) => void;
  /** Select a node, expanding its ancestors and announcing the change. */
  select: (id: string | null, options?: { focusInspector?: boolean }) => void;
  source: SourceStatus | null;
}

const ViewerContext = createContext<ViewerContextValue | null>(null);

export function useViewer(): ViewerContextValue {
  const value = useContext(ViewerContext);
  if (!value) throw new Error('useViewer outside ViewerProvider');
  return value;
}

export function ViewerProvider({ model, source, children }: { model: ViewerModel; source: SourceStatus | null; children: ReactNode }) {
  const [state, dispatch] = useReducer(viewReducer, undefined, (): ViewState => {
    const fragment = parseFragment(location.hash);
    const file = fragment.file ? model.fileByLineage.get(fragment.file) : undefined;
    const roots = model.index.children.get(model.index.root.id) ?? [];
    return {
      selectedId: file?.id ?? null,
      tab: (file && fragment.tab) || 'overview',
      expanded: new Set([...roots.map((n) => n.id), ...(file ? model.index.ancestors(file.id).map((n) => n.id) : [])]),
      source: null,
      announcement: fragment.rejected ? 'The link contained unsupported or invalid view settings; showing the repository overview.' : fragment.file && !file ? 'The linked file is not in this artifact.' : '',
    };
  });

  const select = useCallback(
    (id: string | null, options: { focusInspector?: boolean } = {}) => {
      const node = model.node(id);
      dispatch({
        type: 'select',
        id: node ? node.id : null,
        ancestors: node ? model.index.ancestors(node.id).map((n) => n.id) : [],
        announce: node ? `Selected ${model.title(node)}` : 'Showing repository overview',
      });
      if (options.focusInspector) requestAnimationFrame(() => document.getElementById('inspector-title')?.focus());
    },
    [model],
  );

  // Follow fragment changes made outside the app (pasted links, back/forward).
  useEffect(() => {
    const onHash = () => {
      const fragment = parseFragment(location.hash);
      const file = fragment.file ? model.fileByLineage.get(fragment.file) : undefined;
      if (fragment.rejected || (fragment.file && !file)) {
        dispatch({ type: 'announce', message: fragment.rejected ? 'The link contained unsupported or invalid view settings; showing the repository overview.' : 'The linked file is not in this artifact.' });
        return;
      }
      if (file) {
        select(file.id);
        if (fragment.tab) dispatch({ type: 'tab', tab: fragment.tab });
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [model, select]);

  // Mirror the file selection and tab into the URL fragment (no history spam).
  useEffect(() => {
    const node = model.node(state.selectedId);
    const fragment = formatFragment(node?.kind === 'file' ? node.lineageId : null, state.tab as InspectorTab);
    if (fragment !== location.hash && !(fragment === '' && location.hash === '')) history.replaceState(null, '', fragment || location.pathname + location.search);
  }, [model, state.selectedId, state.tab]);

  const value = useMemo(() => ({ model, state, dispatch, select, source }), [model, state, select, source]);
  return <ViewerContext.Provider value={value}>{children}</ViewerContext.Provider>;
}
