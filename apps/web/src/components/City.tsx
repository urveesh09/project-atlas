import { Component, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { LENS_STOPS, METRIC_PALETTE, lensValue, type CityBuilding, type CityLens, type MetricLens } from '@atlas/layout';
import type { ReachResult } from '@atlas/graph';
import { POLICIES } from '@atlas/graph';
import { compareAscii, compareUtf8 } from '@atlas/schema';
import { useViewer } from '../app/context';
import { ROLE_LABEL, formatNumber, shortOid } from '../app/model';
import { MapCity } from '../city/MapCity';
import type { CityHandle } from '../city/types';
import type { CityGhost } from '../city/renderer';
import { overlayKey, type OverlayResult } from '../city/overlay';
import { addProvenance, downloadBlob, exportMetadata } from '../city/export';
import { CITY_THEMES, CITY_THEME_LABEL, type CityTheme } from '../city/themes';
import '../styles/city.css';

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
  complexity: 'Max callable complexity',
  'fan-in': 'Fan-in (unique consumers)',
  churn: 'Changed commits (up to this snapshot)',
  hotspot: 'Hotspot score (0–100, HEAD cohort)',
  attention: 'Structure attention (no history; 0–100)',
};
const LENS_NOTE: Partial<Record<CityLens, string>> = {
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
const THEME_KEY = 'atlas.cityStyle';
function storedTheme(): CityTheme {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return (CITY_THEMES as readonly string[]).includes(value ?? '') ? (value as CityTheme) : 'modern';
  } catch {
    return 'modern';
  }
}
function storeTheme(theme: CityTheme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage may be blocked; the choice then lasts for this page only.
  }
}

export function City() {
  const { dataset, model, state, dispatch, select, queries, comparison } = useViewer();
  const lenses: CityLens[] = ['structure', 'complexity', 'fan-in', 'churn', dataset.hotspotAvailable ? 'hotspot' : 'attention'];
  const handle = useRef<CityHandle | null>(null);
  const [readyMode, setReadyMode] = useState<'3d' | 'map' | null>(null),
    [message, setMessage] = useState(''),
    [hoverId, setHoverId] = useState<string | null>(null),
    [exporting, setExporting] = useState(false),
    [overlayReady, setOverlayReady] = useState(false);
  const ready = readyMode === state.mode;
  const [storedOverlay, setOverlay] = useState<OverlayResult>(EMPTY),
    [lowQuality, setLowQuality] = useState(model.city.buildings.length >= 10_000),
    [theme, setTheme] = useState<CityTheme>(storedTheme);
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
  const filter = useMemo(
    () => (b: CityBuilding) =>
      state.filter === 'all' ||
      (state.filter === 'findings' ? model.diagnosticCount(b.nodeId) > 0 : b.role === state.filter),
    [model, state.filter],
  );
  const files = useMemo(
    () => model.city.buildings.filter(filter).sort((a, b) => compareUtf8(a.path, b.path)),
    [model, filter],
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
      const plot = dataset.plotOf.get(f.lineageId);
      if (plot) marks.push({ rect: plot.rect, kind: 'deleted', height: dataset.heightIn(state.compare.a, f.lineageId) ?? 0.8 });
    }
    for (const f of result.added) {
      const plot = dataset.plotOf.get(f.lineageId);
      if (plot) marks.push({ rect: plot.rect, kind: 'added', height: dataset.heightIn(state.compare.b, f.lineageId) ?? 0.8 });
    }
    return marks;
  }, [comparison, dataset, model.frame, state.compare]);
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
  const exportImage = async () => {
    if (exporting) return;
    if (!handle.current) {
      setMessage('The view is still preparing. Try export again when it is ready.');
      return;
    }
    setExporting(true);
    setMessage('Preparing the bounded PNG export…');
    try {
      const metadata = exportMetadata(model, state, overlay, handle.current.cameraState(), state.mode === '3d' ? theme : null);
      const blob = await addProvenance(
        await handle.current.exportPng(),
        `ATLAS · ${model.manifest.repo.displayName} · ${shortOid(model.graph.commitOid)} ${model.commit.committerTime.slice(0, 10)}${model.isHead ? '' : ` (snapshot ${model.frame + 1}/${dataset.frames.length})`}${state.compare ? ` · compare ${state.compare.a + 1}→${state.compare.b + 1}` : ''} · ${LENS_LABEL[state.lens]}${model.manifest.coverage.history.status === 'partial' || model.graph.coverage.limitsHit.length ? ' · PARTIAL COVERAGE' : ''} · ${model.manifest.analyzer.version} · static analysis`,
      );
      downloadBlob(blob, 'atlas-city.png');
      downloadBlob(
        new Blob([JSON.stringify(metadata, null, 2)], { type: 'application/json' }),
        'atlas-city.metadata.json',
      );
      setMessage('Exported PNG and provenance metadata. The file table and artifact retain accessible evidence.');
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
  return (
    <section className="city" aria-labelledby="city-title">
      <div className="city-heading">
        <div>
          <p className="eyebrow">ONE FILE · ONE BUILDING{model.isHead ? '' : ` · SNAPSHOT ${model.frame + 1} OF ${dataset.frames.length}`}</p>
          <h1 id="city-title">{model.isHead ? 'Your code, in perspective' : `As it stood on ${model.commit.committerTime.slice(0, 10)}`}</h1>
        </div>
        <span>
          {model.city.buildings.length.toLocaleString()} plots ·{' '}
          {model.city.districts.filter((d) => d.kind === 'package').length} packages
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
          </select>
        </label>
        <label>
          Lens
          <select
            aria-label="Lens"
            value={state.lens}
            onChange={(e) => dispatch({ type: 'lens', lens: e.target.value as typeof state.lens })}
          >
            {lenses.map((lens) => (
              <option key={lens} value={lens}>
                {LENS_LABEL[lens]}
              </option>
            ))}
          </select>
        </label>
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
        {state.mode !== 'table' && (
          <>
            <button type="button" onClick={() => handle.current?.reset()}>
              Reset city
            </button>
            <button type="button" aria-label="Zoom in" onClick={() => handle.current?.zoom(1.3)}>
              ＋
            </button>
            <button type="button" aria-label="Zoom out" onClick={() => handle.current?.zoom(1 / 1.3)}>
              −
            </button>
            <button type="button" onClick={() => handle.current?.north()}>
              North
            </button>
            <button
              type="button"
              disabled={!selectedIds.size || !ready}
              onClick={() => {
                handle.current?.focus(selectedIds);
              }}
            >
              Focus selection
            </button>
            <button type="button" disabled={!ready || exporting} onClick={() => void exportImage()}>
              Export PNG
            </button>
          </>
        )}
        {state.mode === '3d' && (
          <label>
            City style
            <select
              aria-label="City style"
              value={theme}
              onChange={(e) => {
                const next = e.target.value as CityTheme;
                setTheme(next);
                storeTheme(next);
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
      </div>
      <p className="city-note">
        Height = code lines, on a logarithmic scale. △ source · ⬡ test · ▱ declaration · □ kiosk. × marks unavailable
        analysis. Roads separate folders; they are spacing. City style, building shapes, storeys, windows, walls,
        trees and the harbour are decorative and seeded per file; they carry no data. Roofs, eaves and battlements
        share their building's lens colour.
      </p>
      <div className="city-legend" aria-label="City lens legend">
        <strong>{LENS_LABEL[state.lens]}</strong>
        {state.lens === 'structure' ? (
          <span>Stable package colors; inspect package names below and in the tree.</span>
        ) : (
          <>
            {LENS_STOPS[state.lens as MetricLens].map((n, i) => (
              <span key={n}>
                <i style={{ background: METRIC_PALETTE[i] }} aria-hidden="true" />
                {n}
                {i === 4 ? '+' : LENS_STOPS[state.lens as MetricLens][i + 1]! - 1 === n ? '' : `–${LENS_STOPS[state.lens as MetricLens][i + 1]! - 1}`}
              </span>
            ))}
            <span>× unknown</span>
          </>
        )}
        {LENS_NOTE[state.lens] && <span className="legend-note">{LENS_NOTE[state.lens]}</span>}
        {ghosts.length > 0 && (
          <span className="legend-note">
            Compare marks: <span aria-hidden="true">▢</span> outlined ghost = deleted since A · <span aria-hidden="true">◆</span> raised diamond = added in B.
          </span>
        )}
      </div>
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
      {state.mode !== 'table' && (
        <div className="city-stage">
          {state.mode === 'map' ? (
            <MapCity
              city={model.city}
              ghosts={ghosts}
              lens={state.lens}
              selected={selectedIds}
              filter={filter}
              overlay={overlay}
              focusNonce={state.focusNonce}
              select={(id) => select(id, { focusInspector: true })}
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
                  city={model.city}
                  lens={state.lens}
                  selected={selectedIds}
                  filter={filter}
                  overlay={overlay}
                  focusNonce={state.focusNonce}
                  lowQuality={lowQuality}
                  theme={theme}
                  select={(id) => select(id, { focusInspector: true })}
                  hover={setHoverId}
                  fail={fail}
                  register={register3d}
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
              </span>
            </div>
          )}
          <span className="city-attribution">ATLAS · STATIC REPOSITORY CITY</span>
        </div>
      )}
      <div className="city-overlay-controls">
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
        Overlay: {overlay.arcs.length} of {overlay.total} relationships; {overlay.omitted} omitted ({overlay.unplaced}{' '}
        without visible plots/terminals). Arrows point to imported targets. Value = blue solid · type = purple · dynamic
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
      {state.mode === 'table' && (
        <div className="city-table-wrap">
          <table className="city-table">
            <caption>
              Included files · {files.length} displayed of {model.city.buildings.length}. Values retain their analysis
              policy.
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
