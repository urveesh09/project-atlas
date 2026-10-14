import { Component, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { LENS_STOPS, METRIC_PALETTE, UNKNOWN_COLOR, bandIndex, facadeColor, lensValue, type CityBuilding, type CityLens, type MetricLens } from '@atlas/layout';
import type { ReachResult } from '@atlas/graph';
import { POLICIES } from '@atlas/graph';
import { compareAscii, compareUtf8 } from '@atlas/schema';
import { useViewer } from '../app/context';
import { useWorkspace } from '../app/workspace';
import { Timeline } from './Timeline';
import { ROLE_LABEL, formatNumber, shortOid } from '../app/model';
import { MapCity } from '../city/MapCity';
import type { CityHandle } from '../city/types';
import type { CityGhost, ViewHistory } from '../city/renderer';
import { overlayKey, type OverlayResult } from '../city/overlay';
import { addProvenance, downloadBlob, embedPngText, exportMetadata, PROVENANCE_KEYWORD } from '../city/export';
import { CITY_THEMES, CITY_THEME_LABEL, type CityTheme } from '../city/themes';
import { compilePathPattern } from '../app/path-pattern';
import type { SavedView } from '../app/saved-views';
import { SavedViews, type ViewPreset } from './SavedViews';
import { ScopeMenu } from './ScopeMenu';
import { BandsMenu } from './BandsMenu';
import { NotesMenu } from './NotesMenu';
import { PackageGraphView } from './PackageGraphView';
import { buildPrintModel, to3mf, toStl } from '../city/print3d';
import { MARK_COLOURS, loadNotes, storeNotes, type Annotation } from '../app/annotations';
import { distribution } from '../app/bands';
import type { CityPaint } from '../city/types';
import { NO_SCOPE, compileScope, type Scope } from '../app/scope';
import { Icon } from './Icon';
import { CHANGE_BANDS, CHANGE_COLORS, CHANGE_LABEL, CHANGE_METRICS, changeBandLabel, changePaint, formatChange, type ChangeMetric } from '../city/change';
import '../styles/city.css';
import { MenuSummary } from './MenuSummary';

const ThreeCity = lazy(() => import('../city/ThreeCity'));
const EMPTY: OverlayResult = {
  key: '',
  selectionId: null,
  arcs: [],
  total: 0,
  omitted: 0,
  unplaced: 0,
  promotedTerminal: null,
  policy: 'Value, dynamic and resource observations; type-only excluded',
};
export const LENS_LABEL: Record<CityLens, string> = {
  structure: 'Package structure',
  'code-lines': 'Code lines',
  complexity: 'Max callable complexity',
  'total-complexity': 'Total complexity (sum over callables)',
  functions: 'Functions and methods',
  'fan-in': 'Fan-in (unique consumers)',
  'fan-out': 'Fan-out (unique dependencies)',
  churn: 'Changed commits (up to this snapshot)',
  'lines-changed': 'Lines changed (added + deleted, up to this snapshot)',
  hotspot: 'Hotspot score (0–100, HEAD cohort)',
  attention: 'Structure attention (no history; 0–100)',
};
/** Lens picker groups (ADR-052); height stays code lines in every lens (plan §11.5). */
const LENS_GROUPS: { label: string; lenses: CityLens[] }[] = [
  { label: 'Structure', lenses: ['structure'] },
  { label: 'Size', lenses: ['code-lines', 'functions'] },
  { label: 'Complexity', lenses: ['complexity', 'total-complexity'] },
  { label: 'Dependencies', lenses: ['fan-in', 'fan-out'] },
  { label: 'History', lenses: ['churn', 'lines-changed', 'hotspot', 'attention'] },
];
const LENS_NOTE: Partial<Record<CityLens, string>> = {
  'lines-changed': 'Lines added plus lines deleted by mainline commits in the analyzed window, counted only up to the snapshot shown.',
  'total-complexity': 'The sum of cyclomatic complexity over every function and method in the file: large files with many simple functions score high too.',
  churn: 'Mainline commits in the analyzed window that changed each file, counted only up to the snapshot shown.',
  hotspot: '0.40 complexity + 0.25 fan-in + 0.35 changed commits, as percentiles of the selected commit’s source cohort. A candidate for inspection, not a defect.',
  attention: '0.60 complexity + 0.40 fan-in percentiles. Shown instead of the hotspot score because usable history is absent; it is not the same score.',
};

class GraphicsBoundary extends Component<{ children: ReactNode; fail(reason: string): void }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch() {
    this.props.fail('The 3D module could not load. Map and table views remain available.');
  }
  override render() {
    return this.state.failed ? <p>3D could not load.</p> : this.props.children;
  }
}

/** City style is a per-viewer preference; it never enters URLs, artifacts or shared state. */
function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return (allowed as readonly string[]).includes(value ?? '') ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage may be blocked; the choice then lasts for this page only.
  }
}
const THEME_KEY = 'atlas.cityStyle';
const NO_VIEWS: ViewHistory = { back: false, forward: false };
/** Keys typed into a control never drive the city (plan §12.4). */
const typing = (target: EventTarget | null) => target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]') !== null;

export function City() {
  const { dataset, model, state, dispatch, select, queries, comparison } = useViewer();
  const lenses: CityLens[] = ['structure', 'code-lines', 'functions', 'complexity', 'total-complexity', 'fan-in', 'fan-out', 'churn', 'lines-changed', dataset.hotspotAvailable ? 'hotspot' : 'attention'];
  const handle = useRef<CityHandle | null>(null);
  const [readyMode, setReadyMode] = useState<'3d' | 'map' | null>(null),
    [message, setMessage] = useState(''),
    [hoverId, setHoverId] = useState<string | null>(null),
    [exporting, setExporting] = useState(false),
    [overlayReady, setOverlayReady] = useState(false);
  const ready = readyMode === state.mode;
  const [storedOverlay, setOverlay] = useState<OverlayResult>(EMPTY),
    [lowQuality, setLowQuality] = useState(model.city.buildings.length >= 10_000),
    [theme, setTheme] = useState<CityTheme>(() => stored(THEME_KEY, CITY_THEMES, 'modern'));
  const currentOverlayKey = `${model.frame}|` + overlayKey({
    selectedId: state.selectedId,
    direction: state.direction,
    includeTypes: state.includeTypes,
    pinnedEdgeId: state.pinnedEdgeId,
    packages: state.packages,
  });
  const overlay = storedOverlay.key === currentOverlayKey ? storedOverlay : EMPTY;
  const [page, setPage] = useState(0),
    [edgePage, setEdgePage] = useState(0),
    [reach, setReach] = useState<ReachResult | null>(null),
    [depth, setDepth] = useState(2),
    [reachPage, setReachPage] = useState(0);
  const reachTicket = useRef(0);
  const [views, setViews] = useState<ViewHistory>(NO_VIEWS);
  // Change colouring (ADR-050): on by default for each new comparison, in code lines.
  const [changeMetric, setChangeMetric] = useState<ChangeMetric | 'off'>('codeLines');
  const comparisonOpen = state.compare !== null;
  useEffect(() => {
    if (comparisonOpen) setChangeMetric('codeLines');
  }, [comparisonOpen]);
  // Expanded workspace (ADR-047): the whole explorer, so search and evidence stay at hand.
  const workspace = useWorkspace();
  const expanded = workspace.mode;
  const toggleExpanded = workspace.toggle;
  useEffect(() => {
    if (state.mode === 'table' || state.mode === 'packages') return;
    const onKey = (event: KeyboardEvent) => {
      if (typing(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'f' || event.key === 'F') {
        event.preventDefault();
        toggleExpanded();
      } else if (event.key === '[' || event.key === ']') {
        event.preventDefault();
        handle.current?.travel?.(event.key === '[' ? -1 : 1);
      } else if (event.key === 'Escape' && expanded !== 'no') {
        // Leaving the expanded workspace comes first; the selection stays.
        event.stopImmediatePropagation();
        workspace.leave();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [state.mode, expanded, toggleExpanded, workspace]);
  const owner = useRef<'3d' | 'map' | null>(null);
  const register = useCallback((value: CityHandle | null, mode: '3d' | 'map') => {
    if (value) {
      owner.current = mode;
      handle.current = value;
      setReadyMode(mode);
    } else if (owner.current === mode) {
      owner.current = null;
      handle.current = null;
      setReadyMode(null);
    }
  }, []);
  const register3d = useCallback((value: CityHandle | null) => register(value, '3d'), [register]);
  const registerMap = useCallback((value: CityHandle | null) => register(value, 'map'), [register]);
  const fail = useCallback(
    (reason: string) => {
      setMessage(reason);
      dispatch({ type: 'mode', mode: 'map' });
      dispatch({ type: 'announce', message: reason });
    },
    [dispatch],
  );
  const selectedIds = useMemo(() => {
    const ids = new Set<string>(),
      stack = state.selectedId ? [state.selectedId] : [];
    while (stack.length) {
      const id = stack.pop()!;
      if (model.node(id)?.kind === 'file') ids.add(id);
      else for (const child of model.index.children.get(id) ?? []) stack.push(child.id);
    }
    return ids;
  }, [model, state.selectedId]);
  // Scope (ADR-051): focus on a folder and hide paths. Hidden files leave their plots empty.
  const [scope, setScope] = useState<Scope>(NO_SCOPE);
  const scoped = useMemo(() => compileScope(scope), [scope]);
  const city = useMemo(
    () => (scoped.active ? { ...model.city, buildings: model.city.buildings.filter((b) => scoped.visible(b.path)) } : model.city),
    [model.city, scoped],
  );
  // Dependency strokes to a hidden file are dropped and counted, never drawn to an empty plot.
  const shownOverlay = useMemo(() => {
    if (!scoped.active) return overlay;
    const shown = (id: string) => {
      const n = model.node(id);
      return n?.kind !== 'file' || scoped.visible(n.path);
    };
    const arcs = overlay.arcs.filter((a) => shown(a.sourceId) && shown(a.targetId));
    return arcs.length === overlay.arcs.length ? overlay : { ...overlay, arcs, omitted: overlay.omitted + (overlay.arcs.length - arcs.length) };
  }, [overlay, scoped, model]);
  // Annotations (ADR-053): marks on folders and packages, kept per repository in this browser.
  const [notes, setNotesState] = useState<Annotation[]>(() => loadNotes(model.manifest.repo.repoId));
  const setNotes = (next: Annotation[], message: string) => {
    setNotesState(next);
    const kept = storeNotes(model.manifest.repo.repoId, model.manifest.repo.displayName, next);
    dispatch({ type: 'announce', message: kept ? message : `${message} This browser did not keep it; export the notes to save them.` });
  };
  // A mark covers its folder's nested districts too; the nearest mark wins.
  const districtMarks = useMemo(() => {
    const out = new Map<string, string>();
    if (!notes.length) return out;
    for (const d of city.districts) {
      const node = d.nodeId ? model.node(d.nodeId) : undefined;
      const path = node && 'path' in node ? node.path : d.path;
      let best: Annotation | null = null;
      for (const a of notes) if ((path === a.path || path.startsWith(`${a.path}/`)) && (!best || a.path.length > best.path.length)) best = a;
      if (best) out.set(d.id, MARK_COLOURS[best.colour].hex);
    }
    return out;
  }, [notes, city, model]);
  const selectPath = (path: string) => {
    const node = [...model.index.nodes.values()].find((n) => (n.kind === 'directory' || n.kind === 'package') && n.path === path);
    if (node) select(node.id);
    else setMessage(`${path} is not in this snapshot.`);
  };
  // Highlight by path pattern (ADR-048): matching files stay bright, the rest dim.
  const [pattern, setPattern] = useState('');
  const compiled = useMemo(() => {
    try {
      return { matcher: compilePathPattern(pattern), error: null as string | null };
    } catch (error) {
      return { matcher: null, error: error instanceof Error ? error.message : 'Invalid pattern' };
    }
  }, [pattern]);
  const filter = useMemo(
    () => (b: CityBuilding) =>
      (state.filter === 'all' || (state.filter === 'findings' ? model.diagnosticCount(b.nodeId) > 0 : b.role === state.filter)) &&
      (!compiled.matcher || compiled.matcher.test(b.path)),
    [model, state.filter, compiled],
  );
  // Buildings per legend band, so a colour also reads as a count.
  // Band starts per lens (ADR-052): the defaults, or the user's own until reset.
  const [customStops, setCustomStops] = useState<Partial<Record<MetricLens, number[]>>>({});
  const metricLens = state.lens === 'structure' ? null : (state.lens as MetricLens);
  const stops: readonly number[] | null = metricLens ? (customStops[metricLens] ?? LENS_STOPS[metricLens]) : null;
  const lensValues = useMemo(() => (metricLens ? city.buildings.map((b) => lensValue(b, metricLens)) : []), [city, metricLens]);
  const bands = useMemo(() => (stops ? distribution(lensValues, stops) : null), [lensValues, stops]);
  // Custom bands recolour through the same hook as change colouring.
  const lensPaint = useMemo<CityPaint | null>(() => {
    if (!metricLens || !customStops[metricLens]) return null;
    const own = customStops[metricLens];
    return {
      key: `bands:${metricLens}:${own.join(',')}`,
      color: (b) => {
        const v = lensValue(b, metricLens);
        return v === null ? UNKNOWN_COLOR : METRIC_PALETTE[bandIndex(v, own)]!;
      },
      unknown: (b) => lensValue(b, metricLens) === null,
    };
  }, [metricLens, customStops]);
  // Saved views (ADR-048) restore the camera once the chosen view has drawn.
  const pendingCamera = useRef<SavedView['camera']>(null);
  const currentView = (): Omit<SavedView, 'name' | 'savedAt'> => {
    const camera = handle.current?.cameraState() as SavedView['camera'] | undefined;
    return {
      lens: state.lens,
      mode: state.mode,
      filter: state.filter,
      direction: state.direction,
      includeTypes: state.includeTypes,
      pattern,
      stops: metricLens ? (customStops[metricLens] ?? null) : null,
      focus: scope.focus,
      hide: scope.hide,
      selectedPath: state.selectedId ? model.pathOf(state.selectedId) : null,
      theme,
      camera: camera ?? null,
    };
  };
  const applyView = (view: SavedView) => {
    dispatch({ type: 'mode', mode: view.mode });
    if (lenses.includes(view.lens)) dispatch({ type: 'lens', lens: view.lens });
    dispatch({ type: 'filter', filter: view.filter });
    dispatch({ type: 'edges', direction: view.direction, includeTypes: view.includeTypes });
    setPattern(view.pattern);
    setScope({ focus: view.focus, hide: view.hide });
    if (view.lens !== 'structure') {
      const lens = view.lens as MetricLens;
      setCustomStops((all) => {
        const next = { ...all };
        if (view.stops) next[lens] = view.stops;
        else delete next[lens];
        return next;
      });
    }
    if (view.theme && (CITY_THEMES as readonly string[]).includes(view.theme)) {
      setTheme(view.theme as CityTheme);
      store(THEME_KEY, view.theme);
    }
    const target = view.selectedPath === null ? null : [...model.index.nodes.values()].find((n) => n.kind !== 'repository' && 'path' in n && n.path === view.selectedPath);
    select(target?.id ?? null);
    pendingCamera.current = view.camera;
    setMessage(`Applied the view “${view.name}”.${view.selectedPath && !target ? ` ${view.selectedPath} is not in this snapshot, so nothing is selected.` : ''}`);
  };
  // Built-in views (ADR-052): a lens and a filter, nothing else changes.
  const presets: ViewPreset[] = (
    [
      ['Hotspots', dataset.hotspotAvailable ? 'hotspot' : 'attention', 'source', dataset.hotspotAvailable ? 'Complex, depended-on files that change often' : 'Complex, depended-on files (no history)'],
      ['Largest files', 'code-lines', 'source', 'Source files by code lines'],
      ['Most complex', 'complexity', 'source', 'The most branching function in each file'],
      ['Most depended on', 'fan-in', 'all', 'Files with the most direct consumers'],
      ['Most dependencies', 'fan-out', 'all', 'Files that import the most others'],
      ['Most changed', 'churn', 'all', 'Commits per file in the analyzed window'],
      ['Tests', 'structure', 'test', 'Where the tests are'],
    ] as const
  ).map(([name, lens, filter, description]) => ({
    name,
    description,
    apply: () => {
      dispatch({ type: 'lens', lens });
      dispatch({ type: 'filter', filter });
      setPattern('');
      setMessage(`Applied the built-in view “${name}”: ${LENS_LABEL[lens].toLowerCase()}${filter === 'all' ? '' : `, ${filter} files`}.`);
    },
  }));
  useEffect(() => {
    const camera = pendingCamera.current;
    if (!camera || !ready || !handle.current?.restoreCamera) return;
    // A 3D camera only fits the 3D city, and a map view only the map.
    if (('position' in camera) === (state.mode === '3d')) handle.current.restoreCamera(camera);
    pendingCamera.current = null;
  });
  // 3D print (ADR-055): the city shown (scope applied), in the colours shown.
  const exportPrint = (format: '3mf' | 'stl') => {
    try {
      const shownPaint = paint ?? lensPaint;
      const model3d = buildPrintModel(city, (b) => (shownPaint ? shownPaint.color(b) : facadeColor(b, state.lens)));
      const title = `ATLAS · ${model.manifest.repo.displayName} · ${shortOid(model.graph.commitOid)} · ${paint ? `change in ${CHANGE_LABEL[paint.metric].toLowerCase()}` : LENS_LABEL[state.lens]} · ${model.manifest.analyzer.version} · static analysis`;
      const bytes = format === '3mf' ? to3mf(model3d, title) : toStl(model3d, title);
      downloadBlob(new Blob([bytes as BlobPart], { type: format === '3mf' ? 'model/3mf' : 'model/stl' }), `atlas-city.${format}`);
      setMessage(
        `Exported atlas-city.${format}: ${model3d.buildings.toLocaleString('en-US')} buildings on a ${Math.round(model3d.width)} × ${Math.round(model3d.depth)} mm base, ${Math.round(model3d.height)} mm tall. ${format === '3mf' ? 'Each building keeps its colour on screen.' : 'STL has no colours; 3MF keeps them.'} Decorative parts are left out; heights are code lines on the city's logarithmic scale.`,
      );
    } catch (error) {
      setMessage(`3D print export is unavailable: ${error instanceof Error ? error.message : 'the model could not be built'}.`);
    }
  };
  const copyImage = async () => {
    if (!handle.current) return;
    try {
      const blob = await handle.current.exportPng();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setMessage('Copied the view to the clipboard as an image. Use Export PNG to keep its provenance.');
    } catch {
      setMessage('This browser did not allow copying an image. Export PNG saves it instead.');
    }
  };
  const canCopy = typeof ClipboardItem === 'function' && typeof navigator.clipboard?.write === 'function';
  const files = useMemo(
    () => city.buildings.filter(filter).sort((a, b) => compareUtf8(a.path, b.path)),
    [city, filter],
  );
  const edges = useMemo(() => {
    if (!state.selectedId || model.node(state.selectedId)?.kind !== 'file') return [];
    const policy = state.includeTypes ? POLICIES.all : POLICIES.all.filter((k) => !k.includes('type'));
    const all = [
      ...(state.direction === 'incoming' ? [] : model.index.outgoing(state.selectedId, policy)),
      ...(state.direction === 'outgoing' ? [] : model.index.incoming(state.selectedId, policy)),
    ];
    return [...new Map(all.map((e) => [e.id, e])).values()].sort(
      (a, b) =>
        compareAscii(a.kind, b.kind) || compareAscii(a.sourceId, b.sourceId) || compareAscii(a.targetId, b.targetId),
    );
  }, [model, state.selectedId, state.direction, state.includeTypes]);
  useEffect(() => {
    setPage(0);
  }, [state.filter]);
  useEffect(() => {
    setEdgePage(0);
    setReach(null);
    reachTicket.current++;
  }, [state.selectedId, state.direction, state.includeTypes]);
  useEffect(() => {
    let stale = false;
    setOverlay(EMPTY);
    setOverlayReady(false);
    const frame = model.frame;
    const key = `${frame}|${overlayKey({ selectedId: state.selectedId, direction: state.direction, includeTypes: state.includeTypes, pinnedEdgeId: state.pinnedEdgeId, packages: state.packages })}`;
    if (queries)
      void queries
        .overlay(frame, {
          selectedId: state.selectedId,
          direction: state.direction,
          includeTypes: state.includeTypes,
          pinnedEdgeId: state.pinnedEdgeId,
          packages: state.packages,
        })
        .then((result) => {
          if (!stale) {
            setOverlay({ ...result, key });
            setOverlayReady(true);
          }
        })
        .catch(() => {
          if (!stale) setMessage('City overlays are unavailable. Dependencies remain available in the inspector.');
        });
    return () => {
      stale = true;
    };
  }, [queries, model.frame, state.selectedId, state.direction, state.includeTypes, state.pinnedEdgeId, state.packages]);
  // Compare marks on fixed plots: deleted lineages ghosted at their A height, added ones flagged.
  const ghosts = useMemo<CityGhost[]>(() => {
    const result = comparison?.result;
    if (!state.compare || !result || comparison.a !== state.compare.a || comparison.b !== state.compare.b || model.frame !== state.compare.b) return [];
    const marks: CityGhost[] = [];
    for (const f of result.deleted) {
      if (!scoped.visible(f.path)) continue;
      const plot = dataset.plotOf.get(f.lineageId);
      if (plot) marks.push({ rect: plot.rect, kind: 'deleted', height: dataset.heightIn(state.compare.a, f.lineageId) ?? 0.8 });
    }
    for (const f of result.added) {
      if (!scoped.visible(f.path)) continue;
      const plot = dataset.plotOf.get(f.lineageId);
      if (plot) marks.push({ rect: plot.rect, kind: 'added', height: dataset.heightIn(state.compare.b, f.lineageId) ?? 0.8 });
    }
    return marks;
  }, [comparison, dataset, model.frame, state.compare, scoped]);
  // Only while B of a ready comparison is the frame on screen; otherwise the lens colours.
  const comparisonResult =
    state.compare && comparison?.result && comparison.a === state.compare.a && comparison.b === state.compare.b && model.frame === state.compare.b ? comparison.result : null;
  const paint = useMemo(
    () => (comparisonResult && changeMetric !== 'off' ? changePaint(comparisonResult, city.buildings, changeMetric) : null),
    [comparisonResult, city, changeMetric],
  );
  const showReach = async () => {
    if (!queries || !state.selectedId) return;
    const ticket = ++reachTicket.current;
    try {
      const result = await queries.reach(
        model.frame,
        state.selectedId,
        state.direction === 'incoming' ? 'incoming' : 'outgoing',
        depth,
      );
      if (ticket === reachTicket.current) {
        setReach(result);
        setReachPage(0);
      }
    } catch {
      if (ticket === reachTicket.current)
        setMessage('Reach query is unavailable. Direct dependencies remain in the inspector.');
    }
  };
  const currentMetadata = () =>
    exportMetadata(
      model,
      state,
      shownOverlay,
      handle.current?.cameraState() ?? null,
      state.mode === '3d' ? theme : null,
      paint ? { metric: paint.metric, counts: paint.counts } : null,
      scoped.active ? { focus: scoped.focus, hide: scope.hide, shownFiles: city.buildings.length, hiddenFiles: model.city.buildings.length - city.buildings.length } : null,
      stops ? { stops: [...stops], custom: Boolean(metricLens && customStops[metricLens]) } : null,
      notes.map(({ path, colour }) => ({ path, colour })),
    );
  const exportMetadataFile = () => {
    downloadBlob(new Blob([JSON.stringify(currentMetadata(), null, 2)], { type: 'application/json' }), 'atlas-city.metadata.json');
    setMessage('Started the download of atlas-city.metadata.json: the provenance of the current view.');
  };
  const exportImage = async () => {
    if (exporting) return;
    if (!handle.current) {
      setMessage('The view is still preparing. Try export again when it is ready.');
      return;
    }
    setExporting(true);
    setMessage('Preparing the bounded PNG export…');
    try {
      const metadata = currentMetadata();
      const blob = await addProvenance(
        await handle.current.exportPng(),
        `ATLAS · ${model.manifest.repo.displayName} · ${shortOid(model.graph.commitOid)} ${model.commit.committerTime.slice(0, 10)}${model.isHead ? '' : ` (snapshot ${model.frame + 1}/${dataset.frames.length})`}${state.compare ? ` · compare ${state.compare.a + 1}→${state.compare.b + 1}` : ''} · ${paint ? `change in ${CHANGE_LABEL[paint.metric].toLowerCase()}` : LENS_LABEL[state.lens]}${model.manifest.coverage.history.status === 'partial' || model.graph.coverage.limitsHit.length ? ' · PARTIAL COVERAGE' : ''} · ${model.manifest.analyzer.version} · static analysis`,
      );
      // One download that carries its own provenance (ADR-047): browsers may hold back a
      // second automatic download, so the metadata travels inside the PNG as a text chunk.
      const png = embedPngText(new Uint8Array(await blob.arrayBuffer()), PROVENANCE_KEYWORD, JSON.stringify(metadata));
      downloadBlob(new Blob([png as BlobPart], { type: 'image/png' }), 'atlas-city.png');
      setMessage(
        `Exported PNG: started the download of atlas-city.png, with its provenance inside the file (PNG text "${PROVENANCE_KEYWORD}"). Export metadata saves the same provenance as JSON.`,
      );
    } catch (error) {
      setMessage(
        `Image export is unavailable (${error instanceof Error ? error.message : 'encoding failed'}). The file table remains usable.`,
      );
    } finally {
      setExporting(false);
    }
  };
  const hovered = model.node(hoverId);
  const hoveredBuilding = hovered ? model.city.buildings.find((b) => b.nodeId === hovered.id) : undefined;
  // The selection card: where the selection lives (each folder selectable) and its key numbers.
  const chosen = model.node(state.selectedId);
  const trail = useMemo(() => {
    const out: NonNullable<ReturnType<typeof model.node>>[] = [];
    for (let n = chosen; n?.parentId; ) {
      const parent = model.node(n.parentId);
      if (!parent || parent.kind === 'repository') break;
      out.unshift(parent);
      n = parent;
    }
    return out;
  }, [model, chosen]);
  const chosenBuilding = chosen?.kind === 'file' ? model.city.buildings.find((b) => b.nodeId === chosen.id) : undefined;
  const crumb = (n: NonNullable<typeof chosen>) => ('path' in n && n.kind === 'directory' ? (n.path.split('/').at(-1) ?? n.path) : model.title(n));
  return (
    <section className="city" aria-labelledby="city-title">
      <div className="city-heading">
        <h1 id="city-title">
          {model.manifest.repo.displayName}
          <span>{model.isHead ? ' as a city' : ` on ${model.commit.committerTime.slice(0, 10)} (snapshot ${model.frame + 1} of ${dataset.frames.length})`}</span>
        </h1>
        <span className="city-counts">
          {model.city.buildings.length.toLocaleString('en-US')} files · {model.city.districts.filter((d) => d.kind === 'package').length} packages · height = code lines
        </span>
      </div>
      <div className="city-toolbar" aria-label="City controls">
        <label>
          View
          <select
            aria-label="View"
            value={state.mode}
            onChange={(e) => dispatch({ type: 'mode', mode: e.target.value as typeof state.mode })}
          >
            <option value="3d">3D city</option>
            <option value="map">2D map</option>
            <option value="table">File table</option>
            <option value="packages">Package graph</option>
          </select>
        </label>
        {state.mode !== 'packages' && (
          <>
        <label>
          Lens
          <select
            aria-label="Lens"
            value={state.lens}
            onChange={(e) => {
              // Picking a lens asks for its colours, so change colouring steps aside.
              if (paint) setChangeMetric('off');
              dispatch({ type: 'lens', lens: e.target.value as typeof state.lens });
            }}
          >
            {LENS_GROUPS.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.lenses
                  .filter((lens) => lenses.includes(lens))
                  .map((lens) => (
                    <option key={lens} value={lens}>
                      {LENS_LABEL[lens]}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
        {metricLens && stops && bands && !paint && (
          <BandsMenu
            label={LENS_LABEL[metricLens]}
            stops={stops}
            defaults={LENS_STOPS[metricLens]}
            custom={Boolean(customStops[metricLens])}
            values={lensValues.filter((v): v is number => v !== null)}
            dist={bands}
            setStops={(next) =>
              setCustomStops((all) => {
                const copy = { ...all };
                if (next) copy[metricLens] = next;
                else delete copy[metricLens];
                return copy;
              })
            }
          />
        )}
        {state.compare && (
          <label>
            Colour
            <select
              aria-label="Colour by change"
              value={changeMetric}
              disabled={!comparisonResult}
              onChange={(e) => setChangeMetric(e.target.value as ChangeMetric | 'off')}
            >
              <option value="off">Lens values</option>
              {CHANGE_METRICS.map((m) => (
                <option key={m} value={m}>
                  Change in {CHANGE_LABEL[m].toLowerCase()}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Display filter
          <select
            aria-label="Display filter"
            value={state.filter}
            onChange={(e) => dispatch({ type: 'filter', filter: e.target.value as typeof state.filter })}
          >
            <option value="all">All files</option>
            <option value="source">Source</option>
            <option value="test">Tests</option>
            <option value="findings">With findings</option>
          </select>
        </label>
        <label>
          Dependencies
          <select
            aria-label="Dependencies"
            value={state.direction}
            onChange={(e) => dispatch({ type: 'edges', direction: e.target.value as typeof state.direction })}
          >
            <option value="outgoing">Imports → targets</option>
            <option value="incoming">Consumers → selected file</option>
            <option value="both">Imports and consumers</option>
          </select>
        </label>

        {state.mode === '3d' && (
          <label>
            City style
            <select
              aria-label="City style"
              value={theme}
              onChange={(e) => {
                const next = e.target.value as CityTheme;
                setTheme(next);
                store(THEME_KEY, next);
              }}
            >
              {CITY_THEMES.map((t) => (
                <option key={t} value={t}>
                  {CITY_THEME_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
        )}
        {state.mode === '3d' && (
          <label className="city-check">
            <input type="checkbox" checked={lowQuality} onChange={(e) => setLowQuality(e.target.checked)} />
            Low detail
          </label>
        )}
        <label className="city-pattern">
          Highlight
          <input
            type="search"
            aria-label="Highlight paths"
            aria-describedby="city-pattern-help"
            aria-invalid={compiled.error ? true : undefined}
            value={pattern}
            spellCheck={false}
            placeholder="*.test.ts, packages/core, !**/dist/**"
            onChange={(e) => setPattern(e.target.value)}
          />
        </label>
        <ScopeMenu scope={scope} compiled={scoped} shown={city.buildings.length} total={model.city.buildings.length} setScope={setScope} />
          </>
        )}
        <SavedViews current={currentView} apply={applyView} presets={presets} />
        {state.mode !== 'packages' && (
        <NotesMenu
          repository={model.manifest.repo.displayName}
          notes={notes}
          setNotes={setNotes}
          target={chosen && chosen.kind !== 'file' && 'path' in chosen && chosen.path !== '' ? chosen.path : null}
          select={selectPath}
        />
        )}
        {(state.mode === '3d' || state.mode === 'map') && (
          <details className="city-views city-share">
            <MenuSummary icon="share" label="Share" />
            <div className="city-views-panel">
              {canCopy && (
                <button type="button" className="menu-item" disabled={!ready} onClick={() => void copyImage()}>
                  <Icon name="copy" />
                  Copy image
                </button>
              )}
              <button type="button" className="menu-item" disabled={!ready || exporting} onClick={() => void exportImage()}>
                <Icon name="download" />
                Export PNG
              </button>
              <button type="button" className="menu-item" disabled={!ready} onClick={exportMetadataFile}>
                <Icon name="file" />
                Export metadata
              </button>
              <button type="button" className="menu-item" onClick={() => exportPrint('3mf')}>
                <Icon name="cube" />
                3D print, coloured (3MF)
              </button>
              <button type="button" className="menu-item" onClick={() => exportPrint('stl')}>
                <Icon name="cube" />
                3D print (STL)
              </button>
              <p className="city-views-empty">The PNG carries its provenance inside the file: repository, commit, lens and analyzer.</p>
            </div>
          </details>
        )}
      </div>
      {state.mode !== 'packages' && (
      <div className="city-legend" aria-label="City lens legend">
        <strong>{paint && state.compare ? `Change ${state.compare.a + 1} → ${state.compare.b + 1}: ${CHANGE_LABEL[paint.metric].toLowerCase()}` : LENS_LABEL[state.lens]}</strong>
        {paint ? (
          <>
            {CHANGE_BANDS.map((band) => (
              <span key={band}>
                <i style={{ background: CHANGE_COLORS[band] }} aria-hidden="true" />
                {band === 'unknown' ? '× unknown' : changeBandLabel(band, paint.metric)}
                <span className="legend-count">{paint.counts[band].toLocaleString('en-US')}</span>
              </span>
            ))}
          </>
        ) : state.lens === 'structure' ? (
          <span>Stable package colors; inspect package names below and in the tree.</span>
        ) : (
          <>
            {stops!.map((n, i) => (
              <span key={n}>
                <i style={{ background: METRIC_PALETTE[i] }} aria-hidden="true" />
                {n}
                {i === 4 ? '+' : stops![i + 1]! - 1 === n ? '' : `–${stops![i + 1]! - 1}`}
                {bands && <span className="legend-count">{bands.counts[i]!.toLocaleString('en-US')}</span>}
              </span>
            ))}
            <span>
              × unknown{bands && <span className="legend-count">{bands.unknown.toLocaleString('en-US')}</span>}
            </span>
          </>
        )}
        {paint ? (
          <span className="legend-note">
            Each building of snapshot {state.compare!.b + 1} is coloured by how its {CHANGE_LABEL[paint.metric].toLowerCase()} changed since snapshot {state.compare!.a + 1}: blue = less, orange = more. A value unknown on either side stays unknown.
          </span>
        ) : (
          LENS_NOTE[state.lens] && <span className="legend-note">{LENS_NOTE[state.lens]}</span>
        )}
        {ghosts.length > 0 && (
          <span className="legend-note">
            Compare marks: <span aria-hidden="true">▢</span> outlined ghost = deleted since A · <span aria-hidden="true">◆</span> raised diamond = added in B.
          </span>
        )}
        {notes.length > 0 && (
          <span className="legend-marks">
            Marked:
            {notes.slice(0, 12).map((n) => (
              <button key={n.path} type="button" className="legend-mark" onClick={() => selectPath(n.path)}>
                <i style={{ background: MARK_COLOURS[n.colour].hex }} aria-hidden="true" />
                {n.path}
                <span className="sr-only">, {MARK_COLOURS[n.colour].label}</span>
              </button>
            ))}
            {notes.length > 12 && <span>and {notes.length - 12} more in Notes</span>}
          </span>
        )}
        <details className="city-about">
          <summary>How to read the city</summary>
          <p className="city-note">
          Height = code lines, on a logarithmic scale. △ source · ⬡ test · ▱ declaration · □ kiosk. × marks unavailable
          analysis. Roads separate folders; they are spacing. City style, building shapes, storeys, windows, walls,
          trees, paving, ground shading and the harbour are decorative and seeded per file; they carry no data. Roofs,
          eaves and battlements share their building's lens colour. A blue ring marks each selected building. Click the
          city to drive it with the keyboard. The 3D
          city is in perspective, so nearer buildings look larger; the 2D map and file table compare sizes exactly.
          </p>
        </details>
      </div>
      )}
      <p id="city-pattern-help" className={`city-note${compiled.error ? ' city-note-error' : ''}`} hidden={!pattern && !compiled.error}>
        {compiled.error
          ? `Highlight: ${compiled.error}.`
          : `Highlight: ${files.length.toLocaleString('en-US')} of ${city.buildings.length.toLocaleString('en-US')} ${scoped.active ? 'shown ' : ''}files match. Separate patterns with commas; * and ? stay in one folder, ** spans folders, a name without / matches anywhere, ! excludes.`}
      </p>
      {state.filter !== 'all' && (
        <p className="city-note">
          Display filter active: {files.length} matching files. Other buildings are dimmed; metrics and coordinates
          remain unchanged.
        </p>
      )}
      {message && (
        <p className="city-message" role="status">
          {message}
        </p>
      )}
      {state.mode === 'packages' && <PackageGraphView />}
      {(state.mode === '3d' || state.mode === 'map') && (
        <div className="city-stage">
          {state.mode === 'map' ? (
            <MapCity
              city={city}
              ghosts={ghosts}
              lens={state.lens}
              paint={paint ?? lensPaint}
              marks={districtMarks}
              selected={selectedIds}
              filter={filter}
              overlay={shownOverlay}
              focusNonce={state.focusNonce}
              select={(id) => select(id)}
              register={registerMap}
            />
          ) : (
            <GraphicsBoundary fail={fail}>
              <Suspense
                fallback={
                  <p className="city-loading" role="status">
                    Preparing the miniature city… The explorer below is ready.
                  </p>
                }
              >
                <ThreeCity
                  layoutKey={dataset.layout.layoutId}
                  ghosts={ghosts}
                  city={city}
                  lens={state.lens}
                  paint={paint ?? lensPaint}
                  marks={districtMarks}
                  selected={selectedIds}
                  filter={filter}
                  overlay={shownOverlay}
                  focusNonce={state.focusNonce}
                  lowQuality={lowQuality}
                  theme={theme}
                  // A pointer pick keeps focus (and the page) where it is; the inspector beside
                  // the city updates and the live region announces the selection.
                  select={(id) => select(id)}
                  hover={setHoverId}
                  fail={fail}
                  register={register3d}
                  views={setViews}
                />
              </Suspense>
            </GraphicsBoundary>
          )}
          {hovered?.kind === 'file' && (
            <div className="city-hover">
              <strong>{hovered.path}</strong>
              <span>
                {ROLE_LABEL[hovered.role]} · {hovered.parseStatus} · {LENS_LABEL[state.lens]}:{' '}
                {state.lens === 'structure'
                  ? (model.index.packageOf(hovered.id)?.packageName ?? 'root package')
                  : formatNumber(hoveredBuilding ? lensValue(hoveredBuilding, state.lens) : null)}
                {paint && hoveredBuilding && ` · ${CHANGE_LABEL[paint.metric]}: ${formatChange(paint.of(hoveredBuilding))}`}
              </span>
            </div>
          )}
          <div className="city-nav" role="toolbar" aria-label="City view">
            {state.mode === '3d' && (
              <>
                <button type="button" aria-label="Previous view" title="Previous view ( [ )" disabled={!views.back || !ready} onClick={() => handle.current?.travel?.(-1)}>
                  <Icon name="back" />
                </button>
                <button type="button" aria-label="Next view" title="Next view ( ] )" disabled={!views.forward || !ready} onClick={() => handle.current?.travel?.(1)}>
                  <Icon name="forward" />
                </button>
              </>
            )}
            <button type="button" aria-label="Reset city" title="Show the whole city" disabled={!ready} onClick={() => handle.current?.reset()}>
              <Icon name="home" />
            </button>
            {expanded !== 'no' && (
              <button
                type="button"
                aria-label={workspace.drawer ? 'Hide the evidence panel' : 'Show the evidence panel'}
                aria-pressed={workspace.drawer}
                title={workspace.drawer ? 'Hide the evidence panel' : 'Show the evidence panel'}
                onClick={() => workspace.setDrawer(!workspace.drawer)}
              >
                <Icon name="panel" />
              </button>
            )}
            <button
              type="button"
              aria-label={expanded === 'no' ? 'Expand city' : 'Leave expanded city'}
              aria-pressed={expanded !== 'no'}
              title={expanded === 'no' ? 'Expand into a full-screen workspace (F)' : 'Leave the workspace (F or Esc)'}
              onClick={toggleExpanded}
            >
              <Icon name={expanded === 'no' ? 'expand' : 'collapse'} />
            </button>
          </div>
          <div className="city-nav city-nav-camera" role="toolbar" aria-label="Camera">
            <button type="button" aria-label="Zoom in" title="Zoom in (+)" disabled={!ready} onClick={() => handle.current?.zoom(1.3)}>
              <Icon name="plus" />
            </button>
            <button type="button" aria-label="Zoom out" title="Zoom out (−)" disabled={!ready} onClick={() => handle.current?.zoom(1 / 1.3)}>
              <Icon name="minus" />
            </button>
            <button type="button" aria-label="North" title="Turn to face north" disabled={!ready} onClick={() => handle.current?.north()}>
              <Icon name="north" />
            </button>
            <button type="button" aria-label="Focus selection" title="Fly to the selection" disabled={!selectedIds.size || !ready} onClick={() => handle.current?.focus(selectedIds)}>
              <Icon name="focus" />
            </button>
          </div>
          {chosen && chosen.kind !== 'repository' && (
            <div className="city-card">
              {trail.length > 0 && (
                <nav aria-label="Selection path">
                  <ol className="city-trail">
                    {trail.map((n) => (
                      <li key={n.id}>
                        <button type="button" className="city-crumb" aria-label={`Select ${n.kind === 'package' ? 'package' : 'folder'} ${model.title(n)}`} onClick={() => select(n.id)}>
                          {crumb(n)}
                        </button>
                      </li>
                    ))}
                  </ol>
                </nav>
              )}
              <strong>{chosen.kind === 'file' ? (chosen.path.split('/').at(-1) ?? chosen.path) : model.title(chosen)}</strong>
              <span>
                {chosen.kind === 'file'
                  ? `${ROLE_LABEL[chosen.role]} · ${formatNumber(chosenBuilding?.metric?.codeLines)} code lines${paint && chosenBuilding ? ` · ${CHANGE_LABEL[paint.metric]}: ${formatChange(paint.of(chosenBuilding))}` : state.lens === 'structure' ? '' : ` · ${LENS_LABEL[state.lens]}: ${formatNumber(chosenBuilding ? lensValue(chosenBuilding, state.lens) : null)}`}`
                  : `${selectedIds.size.toLocaleString('en-US')} file${selectedIds.size === 1 ? '' : 's'} highlighted`}
              </span>
              {chosen.kind !== 'file' &&
                'path' in chosen &&
                (() => {
                  const mark = notes.find((n) => n.path === chosen.path);
                  return mark ? (
                    <p className="city-card-mark">
                      <i style={{ background: MARK_COLOURS[mark.colour].hex }} aria-hidden="true" />
                      <span className="sr-only">Marked {MARK_COLOURS[mark.colour].label.toLowerCase()}. </span>
                      {mark.note || 'Marked, no note.'}
                    </p>
                  ) : null;
                })()}
              {chosen.kind !== 'file' && 'path' in chosen && chosen.path !== '' && (
                <div className="city-card-actions">
                  <button
                    type="button"
                    aria-label={`Focus on ${chosen.path}`}
                    onClick={() => {
                      setScope({ ...scope, focus: chosen.path });
                      dispatch({ type: 'focus' });
                    }}
                  >
                    <Icon name="scope" size={14} />
                    Focus
                  </button>
                  <button type="button" aria-label={`Hide ${chosen.path}`} onClick={() => setScope({ ...scope, hide: scope.hide.trim() ? `${scope.hide.trim()}, /${chosen.path}` : `/${chosen.path}` })}>
                    <Icon name="hide" size={14} />
                    Hide
                  </button>
                </div>
              )}
              {chosen.kind === 'file' && scoped.active && !scoped.visible(chosen.path) && (
                <p className="city-card-note">
                  Hidden by the scope.{' '}
                  <button type="button" className="city-crumb" onClick={() => setScope(NO_SCOPE)}>
                    Show everything
                  </button>
                </p>
              )}
            </div>
          )}
          {state.mode === '3d' && (
            <p className="city-keys" aria-hidden="true">
              <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> or arrows move · <kbd>Q</kbd><kbd>E</kbd> turn · <kbd>Shift</kbd>+<kbd>↑</kbd><kbd>↓</kbd> tilt · <kbd>+</kbd><kbd>−</kbd> zoom
            </p>
          )}
          <span className="city-attribution">ATLAS · STATIC REPOSITORY CITY</span>
        </div>
      )}
      <Timeline />
      {state.mode !== 'packages' && (
        <>
      <div className="city-overlay-controls">
        <label className="city-check">
          <input
            type="checkbox"
            checked={state.includeTypes}
            onChange={(e) => dispatch({ type: 'edges', includeTypes: e.target.checked })}
          />
          Include type-only
        </label>
        <label className="city-check">
          <input
            type="checkbox"
            checked={state.packages}
            onChange={(e) => dispatch({ type: 'edges', packages: e.target.checked })}
          />
          Package aggregates in overview
        </label>
      </div>
      <p
        className="city-note"
        data-overlay-count
        data-overlay-ready={overlayReady && overlay.key === currentOverlayKey}
      >
        Overlay: {overlay.arcs.length} of {overlay.total} relationships drawn (one per connected pair and kind, never one per
        import statement); {overlay.omitted} omitted ({overlay.unplaced}{' '}
        without visible plots/terminals). Arrows point to imported targets; a ring and a name mark each connected file: → it is imported by the
        selection, ← it imports the selection. Value = blue solid · type = purple · dynamic
        = amber · resource = green. {overlay.policy}.
      </p>
      {!!edges.length && (
        <details className="city-details">
          <summary>Overlay relationships ({edges.length}) · pin an omitted edge</summary>
          <ul>
            {edges.slice(edgePage * 25, (edgePage + 1) * 25).map((e) => (
              <li key={e.id}>
                <span>
                  {model.pathOf(e.sourceId)} → {model.pathOf(e.targetId)} · {e.kind} · {e.confidence}
                </span>
                <button
                  type="button"
                  aria-pressed={state.pinnedEdgeId === e.id}
                  onClick={() => dispatch({ type: 'edges', pinnedEdgeId: state.pinnedEdgeId === e.id ? null : e.id })}
                >
                  Show edge
                </button>
              </li>
            ))}
          </ul>
          <Pager page={edgePage} total={edges.length} size={25} setPage={setEdgePage} />
        </details>
      )}
      {model.node(state.selectedId)?.kind === 'file' && (
        <div className="city-reach">
          <label>
            Reach depth
            <select aria-label="Reach depth" value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => void showReach()}>
            Show reachable files
          </button>
          <span>
            Bounded static {state.direction === 'incoming' ? 'incoming' : 'outgoing'} value/dynamic relationships; not
            runtime impact.
          </span>
          {reach && (
            <div className="reach-results">
              <p role="status">
                {reach.nodes.length} reached at depth ≤ {reach.depth};{' '}
                {reach.truncated ? '2,000-node cap reached' : 'visit cap not reached'};{' '}
                {reach.beyondDepth ? 'more files exist beyond this depth' : 'no additional depth boundary detected'}.
              </p>
              <ul>
                {reach.nodes.slice(reachPage * 25, (reachPage + 1) * 25).map((n) => (
                  <li key={n.id}>
                    <button type="button" className="link" onClick={() => select(n.id, { focusInspector: true })}>
                      {model.pathOf(n.id)}
                    </button>{' '}
                    · depth {n.depth}
                  </li>
                ))}
              </ul>
              <Pager page={reachPage} total={reach.nodes.length} size={25} setPage={setReachPage} />
            </div>
          )}
        </div>
      )}
        </>
      )}
      {state.mode === 'table' && (
        <div className="city-table-wrap">
          <table className="city-table">
            <caption>
              Included files · {files.length} displayed of {model.city.buildings.length}
              {scoped.active ? ` · ${(model.city.buildings.length - city.buildings.length).toLocaleString('en-US')} hidden by the scope` : ''}. Values retain their
              analysis policy.
            </caption>
            <thead>
              <tr>
                <th scope="col">File</th>
                <th scope="col">Role</th>
                <th scope="col">Code lines</th>
                <th scope="col">Max complexity</th>
                <th scope="col">Fan-in</th>
                <th scope="col">Changed commits</th>
                <th scope="col">{dataset.hotspotAvailable ? 'Hotspot' : 'Structure attention'}</th>
                <th scope="col">Status</th>
                {paint && state.compare && (
                  <th scope="col">
                    {CHANGE_LABEL[paint.metric]}, snapshot {state.compare.a + 1} → {state.compare.b + 1}
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {files.slice(page * 40, (page + 1) * 40).map((b) => (
                <tr key={b.nodeId} aria-selected={state.selectedId === b.nodeId}>
                  <th scope="row">
                    <button
                      type="button"
                      className="link"
                      aria-pressed={state.selectedId === b.nodeId}
                      onClick={() => select(b.nodeId, { focusInspector: true })}
                    >
                      {b.path}
                    </button>
                  </th>
                  <td>{ROLE_LABEL[b.role]}</td>
                  <td>{formatNumber(b.metric?.codeLines)}</td>
                  <td>{formatNumber(b.metric?.maxCyclomatic)}</td>
                  <td>{formatNumber(b.metric?.fanIn)}</td>
                  <td>{formatNumber(lensValue(b, 'churn'))}</td>
                  <td>{formatNumber(lensValue(b, dataset.hotspotAvailable ? 'hotspot' : 'attention'))}</td>
                  <td>{b.parseStatus}</td>
                  {paint && <td className="change-cell">{formatChange(paint.of(b))}</td>}
                </tr>
              ))}
            </tbody>
          </table>
          <Pager page={page} total={files.length} size={40} setPage={setPage} />
        </div>
      )}
      {!!(model.city.terminals.length + model.city.terminalOmitted) && <ExternalList />}
    </section>
  );
}

function Pager({
  page,
  total,
  size,
  setPage,
}: {
  page: number;
  total: number;
  size: number;
  setPage(n: number): void;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  return pages > 1 ? (
    <div className="city-pager">
      <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>
        Previous page
      </button>
      <span>
        Page {page + 1} of {pages}
      </span>
      <button type="button" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>
        Next page
      </button>
    </div>
  ) : null;
}
function ExternalList() {
  const { model, select } = useViewer();
  const [page, setPage] = useState(0);
  const external = model.graph.nodes.filter((n) => n.kind === 'external-package' || n.kind === 'builtin');
  return (
    <details className="city-details">
      <summary>
        External packages and built-ins ({external.length}); {model.city.terminalOmitted} terminals omitted from the
        city
      </summary>
      <ul>
        {external.slice(page * 25, (page + 1) * 25).map((n) => (
          <li key={n.id}>
            <button type="button" className="link" onClick={() => select(n.id, { focusInspector: true })}>
              {model.title(n)}
            </button>
          </li>
        ))}
      </ul>
      <Pager page={page} total={external.length} size={25} setPage={setPage} />
    </details>
  );
}
