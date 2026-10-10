import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
  type ReactNode,
} from 'react';
import { QueryClient } from '../data/query';
import type { SourceStatus } from '../data/load';
import { ViewerModel } from './model';
import {
  formatFragment,
  parseFragment,
  viewReducer,
  type InspectorTab,
  type ViewAction,
  type ViewState,
} from './state';

interface ViewerContextValue {
  queries: QueryClient | null;
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

export function ViewerProvider({
  model,
  source,
  children,
}: {
  model: ViewerModel;
  source: SourceStatus | null;
  children: ReactNode;
}) {
  const [queries, setQueries] = useState<QueryClient | null>(null);
  useEffect(() => {
    try {
      const client = new QueryClient(model.graph, model.city, model.takeQueryWorker());
      setQueries(client);
      return () => client.dispose();
    } catch {
      setQueries(null);
      dispatch({
        type: 'announce',
        message: 'Background queries are unavailable. Use the tree, file table and inspector.',
      });
    }
  }, [model]);
  const [state, dispatch] = useReducer(viewReducer, undefined, (): ViewState => {
    const parsed = parseFragment(location.hash);
    const invalid = parsed.rejected || (parsed.frame !== null && parsed.frame !== model.sourceSnapshotId);
    const fragment = invalid ? parseFragment('') : parsed;
    const file = fragment.file ? model.fileByLineage.get(fragment.file) : undefined;
    const roots = model.index.children.get(model.index.root.id) ?? [];
    return {
      lens: fragment.lens ?? 'structure',
      mode: fragment.mode ?? '3d',
      filter: 'all',
      direction: 'outgoing',
      includeTypes: false,
      pinnedEdgeId: null,
      packages: false,
      focusNonce: 0,
      selectedId: file?.id ?? null,
      tab: (file && fragment.tab) || 'overview',
      expanded: new Set([...roots.map((n) => n.id), ...(file ? model.index.ancestors(file.id).map((n) => n.id) : [])]),
      source: null,
      announcement: invalid
        ? 'The link contained unsupported or invalid view settings; showing the repository overview.'
        : fragment.file && !file
          ? 'The linked file is not in this artifact.'
          : '',
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
      if (
        fragment.rejected ||
        (fragment.frame && fragment.frame !== model.sourceSnapshotId) ||
        (fragment.file && !file)
      ) {
        select(null);
        dispatch({ type: 'lens', lens: 'structure' });
        dispatch({ type: 'mode', mode: '3d' });
        dispatch({ type: 'tab', tab: 'overview' });
        dispatch({
          type: 'announce',
          message: fragment.rejected
            ? 'The link contained unsupported or invalid view settings; showing the repository overview.'
            : 'The linked file is not in this artifact.',
        });
        return;
      }
      if (file) {
        select(file.id);
        if (fragment.tab) dispatch({ type: 'tab', tab: fragment.tab });
      } else select(null);
      dispatch({ type: 'lens', lens: fragment.lens ?? 'structure' });
      dispatch({ type: 'mode', mode: fragment.mode ?? '3d' });
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [model, select]);

  // Mirror the file selection and tab into the URL fragment (no history spam).
  useEffect(() => {
    const node = model.node(state.selectedId);
    const fragment = formatFragment(
      node?.kind === 'file' ? node.lineageId : null,
      state.tab as InspectorTab,
      state.lens,
      state.mode,
    );
    if (fragment !== location.hash && !(fragment === '' && location.hash === ''))
      history.replaceState(null, '', fragment || location.pathname + location.search);
  }, [model, state.selectedId, state.tab, state.lens, state.mode]);

  const value = useMemo(
    () => ({ model, state, dispatch, select, source, queries }),
    [model, state, select, source, queries],
  );
  return <ViewerContext.Provider value={value}>{children}</ViewerContext.Provider>;
}
