import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import type { FrameComparison } from '@atlas/graph';
import { QueryClient } from '../data/query';
import type { SourceStatus } from '../data/load';
import { ViewerModel, formatDate, shortOid, type ViewerDataset } from './model';
import { formatFragment, parseFragment, viewReducer, type InspectorTab, type ViewAction, type ViewState } from './state';

interface ViewerContextValue {
  dataset: ViewerDataset;
  /** The active frame. Its graph is authoritative for all evidence shown. */
  model: ViewerModel;
  queries: QueryClient | null;
  state: ViewState;
  dispatch: (action: ViewAction) => void;
  /** Select a node of the active frame, expanding its ancestors and announcing the change. */
  select: (id: string | null, options?: { focusInspector?: boolean }) => void;
  /** Show another analyzed frame; the selected lineage is preserved or tombstoned. */
  goToFrame: (frame: number, options?: { lineage?: string | null; tab?: InspectorTab; quiet?: boolean; compare?: { a: number; b: number } }) => Promise<void>;
  /** The frame being decoded, if any (controls stay responsive meanwhile). */
  frameLoading: number | null;
  frameError: string | null;
  /** Start or end an explicit A -> B comparison (B is displayed). */
  setCompare: (compare: { a: number; b: number } | null) => Promise<void>;
  /** Decoded frame models for a comparison (A and B), when loaded. */
  frameModel: (frame: number) => ViewerModel | undefined;
  /** The active comparison's result, computed in the worker for exactly state.compare. */
  comparison: { a: number; b: number; result: FrameComparison | null; error: string | null } | null;
  source: SourceStatus | null;
}

const ViewerContext = createContext<ViewerContextValue | null>(null);

export function useViewer(): ViewerContextValue {
  const value = useContext(ViewerContext);
  if (!value) throw new Error('useViewer outside ViewerProvider');
  return value;
}

/** Frames kept decoded on the main thread besides HEAD (plan §15.3: at most two). */
const HISTORICAL_FRAMES_CACHED = 2;
const INVALID_LINK = 'The link contained unsupported or invalid view settings; showing the repository overview.';

export function ViewerProvider({ head, source, children }: { head: ViewerModel; source: SourceStatus | null; children: ReactNode }) {
  const dataset = head.dataset;
  const [queries, setQueries] = useState<QueryClient | null>(null);
  const models = useRef(new Map<number, ViewerModel>([[head.frame, head]]));
  const [, setModelVersion] = useState(0);
  const [frameLoading, setFrameLoading] = useState<number | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  const frameTicket = useRef(0);
  const compareTicket = useRef(0);

  const [state, dispatch] = useReducer(viewReducer, undefined, (): ViewState => {
    const fragment = parseFragment(location.hash);
    const frame = fragment.frame ? dataset.frameOfSnapshot.get(fragment.frame) : head.frame;
    const invalid = fragment.rejected || frame === undefined;
    const atHead = !invalid && frame === head.frame;
    const file = atHead && fragment.file ? head.fileByLineage.get(fragment.file) : undefined;
    const roots = head.index.children.get(head.index.root.id) ?? [];
    const absent = atHead && fragment.file && !file;
    return {
      lens: invalid ? 'structure' : normalizeLens(fragment.lens ?? 'structure', dataset),
      mode: invalid ? '3d' : (fragment.mode ?? '3d'),
      filter: 'all',
      direction: 'outgoing',
      includeTypes: false,
      pinnedEdgeId: null,
      packages: false,
      focusNonce: 0,
      selectedId: file?.id ?? null,
      tab: (file && fragment.tab) || (absent && dataset.lineages.has(fragment.file!) ? 'history' : 'overview'),
      expanded: new Set([...roots.map((n) => n.id), ...(file ? head.index.ancestors(file.id).map((n) => n.id) : [])]),
      source: null,
      frame: head.frame,
      compare: null,
      tombstone: absent && dataset.lineages.has(fragment.file!) ? { lineageId: fragment.file! } : null,
      announcement: invalid ? INVALID_LINK : absent && !dataset.lineages.has(fragment.file!) ? 'The linked file is not in this artifact.' : '',
    };
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const model = models.current.get(state.frame) ?? head;
  const modelRef = useRef(model);
  modelRef.current = model;

  useEffect(() => {
    try {
      const client = new QueryClient({ graph: head.graph, city: head.city, frame: head.frame }, dataset.sessionWorker);
      setQueries(client);
      return () => client.dispose();
    } catch {
      setQueries(null);
      dispatch({ type: 'announce', message: 'Background queries are unavailable. Use the tree, file table and inspector.' });
    }
  }, [dataset, head]);

  const select = useCallback((id: string | null, options: { focusInspector?: boolean } = {}) => {
    const current = modelRef.current;
    const node = current.node(id);
    dispatch({
      type: 'select',
      id: node ? node.id : null,
      ancestors: node ? current.index.ancestors(node.id).map((n) => n.id) : [],
      announce: node ? `Selected ${current.title(node)}` : 'Showing repository overview',
    });
    if (options.focusInspector) requestAnimationFrame(() => document.getElementById('inspector-title')?.focus());
  }, []);

  const loadFrame = useCallback(
    async (frame: number): Promise<ViewerModel> => {
      const cached = models.current.get(frame);
      if (cached) return cached;
      if (!queries) throw new Error('Historical frames need the background query worker');
      const prepared = await queries.frame(frame);
      return new ViewerModel(dataset, frame, prepared.graph, prepared.prepared, prepared.city);
    },
    [dataset, queries],
  );

  const remember = useCallback(
    (target: ViewerModel, keep: readonly number[] = []) => {
      const cache = models.current;
      cache.delete(target.frame);
      cache.set(target.frame, target);
      // Evict the least recently shown historical frames, never HEAD or a frame in use.
      const evictable = [...cache.keys()].filter((f) => f !== head.frame && f !== target.frame && !keep.includes(f));
      while (cache.size > HISTORICAL_FRAMES_CACHED + 1 && evictable.length > 0) cache.delete(evictable.shift()!);
    },
    [head.frame],
  );

  const goToFrame = useCallback(
    async (frame: number, options: { lineage?: string | null; tab?: InspectorTab; quiet?: boolean; compare?: { a: number; b: number } } = {}) => {
      if (frame < 0 || frame >= dataset.frames.length) return;
      if (!options.compare) compareTicket.current++;
      const ticket = ++frameTicket.current;
      setFrameError(null);
      setFrameLoading(frame);
      let target: ViewerModel;
      try {
        target = await loadFrame(frame);
      } catch (error) {
        if (ticket !== frameTicket.current) return;
        setFrameLoading(null);
        const message = `Snapshot ${frame + 1} could not be loaded (${error instanceof Error ? error.message : 'unknown error'}). The current snapshot is unchanged.`;
        setFrameError(message);
        dispatch({ type: 'announce', message });
        return;
      }
      // Latest requested frame wins: a slower, older request never overwrites it.
      if (ticket !== frameTicket.current) return;
      const current = modelRef.current;
      const view = stateRef.current;
      prefetchTicket.current++;
      // Explicit snapshot navigation updates comparison B; it must not leave the
      // legend describing a different graph or pin an unused third historical frame.
      const pair = options.compare ?? (view.compare && view.compare.a !== frame ? { a: view.compare.a, b: frame } : null);
      remember(target, pair ? [pair.a] : []);
      const selected = current.node(view.selectedId);
      const lineage = options.lineage !== undefined ? options.lineage : selected?.kind === 'file' ? selected.lineageId : (view.tombstone?.lineageId ?? null);
      let selectedId: string | null = null;
      let tombstone: ViewState['tombstone'] = null;
      let note = '';
      if (lineage) {
        const file = target.fileByLineage.get(lineage);
        if (file) selectedId = file.id;
        else {
          tombstone = { lineageId: lineage };
          note = ` ${dataset.lineagePath(lineage) ?? 'The selected file'} is not present in this snapshot.`;
        }
      } else if (selected && selected.kind !== 'repository') {
        const counterpart = target.counterpart(selected);
        if (counterpart) selectedId = counterpart.id;
        else note = ` ${current.title(selected)} does not exist in this snapshot; showing the overview.`;
      }
      // Expansion is stored by occurrence ID: carry it over through counterparts.
      const expanded = new Set<string>((target.index.children.get(target.index.root.id) ?? []).map((n) => n.id));
      for (const id of view.expanded) {
        const node = current.node(id);
        const counterpart = node ? target.counterpart(node) : null;
        if (counterpart) expanded.add(counterpart.id);
      }
      if (selectedId) for (const ancestor of target.index.ancestors(selectedId)) expanded.add(ancestor.id);
      const f = dataset.frames[frame]!;
      if (view.compare || options.compare) dispatch({ type: 'compare', compare: pair });
      dispatch({
        type: 'frame',
        frame,
        selectedId,
        tombstone,
        expanded,
        announce: options.quiet
          ? view.announcement
          : `Snapshot ${frame + 1} of ${dataset.frames.length}: ${formatDate(f.commit.committerTime)}, commit ${shortOid(f.commit.oid)}, ${f.coverage.includedFiles.toLocaleString('en-US')} files.${note}`,
      });
      if (options.tab) dispatch({ type: 'tab', tab: options.tab });
      else if (tombstone) dispatch({ type: 'tab', tab: 'history' });
      setFrameLoading(null);
      setModelVersion((v) => v + 1);
    },
    [dataset, loadFrame, remember],
  );

  // Idle prefetch of the next older snapshot (the usual stepping direction): a later visit
  // is then a cached change. It never evicts the active frame, HEAD or a compare pair.
  const prefetchTicket = useRef(0);
  const prefetch = useCallback(
    (frame: number) => {
      if (frame < 0 || models.current.has(frame) || !queries || stateRef.current.compare) return;
      const ticket = ++prefetchTicket.current;
      setTimeout(() => {
        if (ticket !== prefetchTicket.current) return;
        loadFrame(frame).then(
          (target) => {
            if (ticket !== prefetchTicket.current) return;
            const view = stateRef.current;
            if (view.compare) return;
            remember(target, [view.frame]);
          },
          () => undefined,
        );
      }, 300);
    },
    [loadFrame, queries, remember],
  );
  useEffect(() => {
    if (frameLoading === null) prefetch(state.frame - 1);
  }, [prefetch, state.frame, frameLoading]);

  const setCompare = useCallback(
    async (compare: { a: number; b: number } | null) => {
      const ticket = ++compareTicket.current;
      prefetchTicket.current++;
      if (!compare) {
        frameTicket.current++;
        setFrameLoading(null);
        dispatch({ type: 'compare', compare: null, announce: 'Comparison closed.' });
        return;
      }
      if (compare.a === compare.b || !dataset.frames[compare.a] || !dataset.frames[compare.b]) return;
      try {
        const a = await loadFrame(compare.a);
        if (ticket !== compareTicket.current) return;
        const b = await loadFrame(compare.b);
        if (ticket !== compareTicket.current) return;
        remember(a, [b.frame]);
        remember(b, [a.frame]);
      } catch {
        if (ticket !== compareTicket.current) return;
        dispatch({ type: 'announce', message: `Snapshot ${compare.a + 1} could not be loaded for comparison.` });
        return;
      }
      if (stateRef.current.frame !== compare.b) await goToFrame(compare.b, { quiet: true, compare });
      if (ticket !== compareTicket.current) return;
      dispatch({ type: 'compare', compare, announce: `Comparing snapshot ${compare.a + 1} to snapshot ${compare.b + 1}.` });
      setModelVersion((v) => v + 1);
    },
    [dataset, goToFrame, loadFrame, remember],
  );

  // A link may name a historical frame: open it once the query worker is ready.
  const initialFrame = useRef<{ frame: number; lineage: string | null; tab: InspectorTab | null } | null>(
    (() => {
      const fragment = parseFragment(location.hash);
      const frame = fragment.frame && !fragment.rejected ? dataset.frameOfSnapshot.get(fragment.frame) : undefined;
      return frame !== undefined && frame !== head.frame ? { frame, lineage: fragment.file, tab: fragment.tab } : null;
    })(),
  );
  useEffect(() => {
    const pending = initialFrame.current;
    if (!queries || !pending) return;
    initialFrame.current = null;
    void goToFrame(pending.frame, { lineage: pending.lineage, ...(pending.tab ? { tab: pending.tab } : {}) });
  }, [queries, goToFrame]);

  // Follow fragment changes made outside the app (pasted links, back/forward).
  useEffect(() => {
    const onHash = () => {
      const fragment = parseFragment(location.hash);
      const frame = fragment.frame ? dataset.frameOfSnapshot.get(fragment.frame) : head.frame;
      if (fragment.rejected || frame === undefined || (fragment.file && !dataset.lineages.has(fragment.file))) {
        select(null);
        dispatch({ type: 'lens', lens: 'structure' });
        dispatch({ type: 'mode', mode: '3d' });
        dispatch({ type: 'tab', tab: 'overview' });
        dispatch({ type: 'announce', message: fragment.rejected || frame === undefined ? INVALID_LINK : 'The linked file is not in this artifact.' });
        return;
      }
      dispatch({ type: 'lens', lens: normalizeLens(fragment.lens ?? 'structure', dataset) });
      dispatch({ type: 'mode', mode: fragment.mode ?? '3d' });
      if (frame !== stateRef.current.frame) {
        void goToFrame(frame, { lineage: fragment.file ?? null, ...(fragment.tab ? { tab: fragment.tab } : {}) });
        return;
      }
      const file = fragment.file ? modelRef.current.fileByLineage.get(fragment.file) : undefined;
      if (file) {
        select(file.id);
        if (fragment.tab) dispatch({ type: 'tab', tab: fragment.tab });
      } else if (fragment.file) {
        dispatch({ type: 'frame', frame, selectedId: null, tombstone: { lineageId: fragment.file }, announce: `${dataset.lineagePath(fragment.file)} is not present in this snapshot.` });
        dispatch({ type: 'tab', tab: 'history' });
      } else select(null);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [dataset, head.frame, select, goToFrame]);

  // Mirror the frame, file lineage and tab into the URL fragment (no history spam).
  useEffect(() => {
    const node = model.node(state.selectedId);
    const lineage = node?.kind === 'file' ? node.lineageId : (state.tombstone?.lineageId ?? null);
    const fragment = formatFragment(lineage, state.tab, state.lens, state.mode, state.frame === head.frame ? null : model.snapshotId);
    if (fragment !== location.hash && !(fragment === '' && location.hash === '')) history.replaceState(null, '', fragment || location.pathname + location.search);
  }, [model, head.frame, state.selectedId, state.tombstone, state.tab, state.lens, state.mode, state.frame]);

  // Comparison results: computed off the main thread; a stale pair never replaces the current one.
  const [comparison, setComparison] = useState<ViewerContextValue['comparison']>(null);
  useEffect(() => {
    const pair = state.compare;
    if (!pair) {
      setComparison(null);
      return;
    }
    let stale = false;
    setComparison({ ...pair, result: null, error: null });
    if (!queries) {
      setComparison({ ...pair, result: null, error: 'Comparison needs the background query worker.' });
      return;
    }
    queries.compare(pair.a, pair.b).then(
      (result) => {
        if (stale) return;
        setComparison({ ...pair, result, error: null });
        const files = result.added.length + result.deleted.length + result.renamed.length + result.modified.length;
        dispatch({ type: 'announce', message: `Comparison ready: ${result.added.length} added, ${result.deleted.length} deleted, ${result.renamed.length} renamed, ${result.modified.length} changed files${files === 0 ? '; no file differences' : ''}.` });
      },
      (error: Error) => {
        if (!stale) setComparison({ ...pair, result: null, error: error.message });
      },
    );
    return () => {
      stale = true;
    };
  }, [queries, state.compare]);

  const frameModel = useCallback((frame: number) => models.current.get(frame), []);
  const value = useMemo(
    () => ({ dataset, model, state, dispatch, select, goToFrame, frameLoading, frameError, setCompare, frameModel, comparison, source, queries }),
    [dataset, model, state, select, goToFrame, frameLoading, frameError, setCompare, frameModel, comparison, source, queries],
  );
  return <ViewerContext.Provider value={value}>{children}</ViewerContext.Provider>;
}

/** The full hotspot score needs usable history; otherwise the separately named lens applies. */
function normalizeLens(lens: ViewState['lens'], dataset: ViewerDataset): ViewState['lens'] {
  if (lens === 'hotspot' && !dataset.hotspotAvailable) return 'attention';
  return lens;
}
