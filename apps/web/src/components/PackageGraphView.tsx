import { useMemo, useState, type KeyboardEvent } from 'react';
import { POLICIES } from '@atlas/graph';
import { useViewer } from '../app/context';
import { PACKAGE_GRAPH, buildPackageGraph, packageMeta, type PackageGraphEdge, type PackageGraphNode } from '../app/package-graph';

const TABLE_ROWS = 200;
const visiblePackageLabel = (label: string) => label.length > 30 ? `${label.slice(0, 29)}…` : label;
const KIND_LABEL: Record<string, string> = {
  'imports-value': 'value',
  'imports-type': 'type',
  'reexports-value': 're-export',
  'reexports-type': 'type re-export',
  'imports-dynamic-literal': 'dynamic',
  'requires-literal': 'require',
  'imports-resource': 'resource',
};

/**
 * Package dependency view (ADR-054): each package sits above the packages it depends on;
 * dashed red edges close a cycle. The table carries the same edges for keyboard and
 * screen-reader use, and for repositories too large to draw.
 */
export function PackageGraphView() {
  const { model, state, dispatch, select } = useViewer();
  const policy = useMemo(() => (state.includeTypes ? POLICIES.all : POLICIES.all.filter((k) => !k.includes('type'))), [state.includeTypes]);
  const graph = useMemo(() => {
    const files = new Map<string, number>();
    for (const b of model.city.buildings) if (b.packageId) files.set(b.packageId, (files.get(b.packageId) ?? 0) + 1);
    const packages = [...model.index.nodes.values()]
      .filter((n) => n.kind === 'package')
      .map((n) => ({ id: n.id, label: model.title(n), path: 'path' in n ? n.path : '', files: files.get(n.id) ?? 0 }));
    return buildPackageGraph(packages, model.index.packageRollups(policy), (label) => label.length * 6.6);
  }, [model, policy]);
  const nodes = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const selectedPackage = state.selectedId ? (model.index.packageOf(state.selectedId)?.id ?? null) : null;
  const [hover, setHover] = useState<string | null>(null);
  const focus = hover ?? selectedPackage;
  const touches = (e: PackageGraphEdge) => !focus || e.source === focus || e.target === focus;
  const near = useMemo(() => {
    const set = new Set<string>();
    if (focus) for (const e of graph.edges) if (e.source === focus || e.target === focus) set.add(e.source).add(e.target);
    return set;
  }, [graph, focus]);
  const cyclicPackages = graph.nodes.filter((n) => n.cyclic).length;
  const outCount = (id: string) => graph.edges.filter((e) => e.source === id).length;
  const inCount = (id: string) => graph.edges.filter((e) => e.target === id).length;
  const drawable = graph.nodes.length <= PACKAGE_GRAPH.maxNodes;
  const ports = useMemo(() => {
    // Spread each node's edge ends along its bottom (out) and top (in), ordered by the far end.
    const at = new Map<PackageGraphEdge, { sx: number; tx: number }>();
    const spread = (node: PackageGraphNode, list: PackageGraphEdge[], end: 'source' | 'target') => {
      const sorted = [...list].sort((a, b) => nodes.get(end === 'source' ? a.target : a.source)!.x - nodes.get(end === 'source' ? b.target : b.source)!.x);
      sorted.forEach((e, i) => {
        const x = node.x + (node.width * (i + 1)) / (sorted.length + 1);
        const prev = at.get(e) ?? { sx: 0, tx: 0 };
        at.set(e, end === 'source' ? { ...prev, sx: x } : { ...prev, tx: x });
      });
    };
    for (const n of graph.nodes) {
      spread(n, graph.edges.filter((e) => e.source === n.id), 'source');
      spread(n, graph.edges.filter((e) => e.target === n.id), 'target');
    }
    return at;
  }, [graph, nodes]);
  const h = PACKAGE_GRAPH.nodeHeight;
  const path = (e: PackageGraphEdge) => {
    const s = nodes.get(e.source)!,
      t = nodes.get(e.target)!,
      p = ports.get(e)!;
    if (s.y === t.y) {
      // Same row (only inside a cycle): a loop below both boxes, so the cycle reads as going round.
      const y = s.y + h,
        dip = 26 + Math.abs(p.tx - p.sx) * 0.1;
      return `M${p.sx},${y} C${p.sx},${y + dip} ${p.tx},${y + dip} ${p.tx},${y + 7}`;
    }
    // Downward edges leave the bottom of the dependent; the rare upward ones (inside a
    // cycle that wraps onto several rows) leave its top.
    const down = s.y < t.y;
    const y1 = down ? s.y + h : s.y,
      y2 = down ? t.y - 7 : t.y + h + 7,
      mid = (y1 + y2) / 2;
    return `M${p.sx},${y1} C${p.sx},${mid} ${p.tx},${mid} ${p.tx},${y2}`;
  };
  const onNodeKey = (event: KeyboardEvent, id: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      select(id);
    }
  };
  return (
    <div className="pkg-view">
      <p className="city-note pkg-summary" role="status">
        {graph.nodes.length.toLocaleString('en-US')} packages, {graph.edges.length.toLocaleString('en-US')} dependencies between packages,{' '}
        {graph.layers} layers, {cyclicPackages ? `${cyclicPackages} packages in ${graph.cycles.length} cycle${graph.cycles.length === 1 ? '' : 's'}` : 'no package cycles'}. Each
        package sits above the packages it depends on; a dashed red edge closes a cycle. {state.includeTypes ? 'Type-only imports included.' : 'Type-only imports excluded.'}
      </p>
      <label className="city-check">
        <input type="checkbox" checked={state.includeTypes} onChange={(e) => dispatch({ type: 'edges', includeTypes: e.target.checked })} />
        Include type-only imports
      </label>
      {drawable ? (
        <div className="pkg-scroll" tabIndex={0} role="group" aria-label="Package dependency diagram; the table below lists the same dependencies">
          <svg className="pkg-svg" width={graph.width} height={graph.height + 24} viewBox={`0 0 ${graph.width} ${graph.height + 24}`}>
            <defs>
              <marker id="pkg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" className="pkg-arrow" />
              </marker>
              <marker id="pkg-arrow-cycle" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" className="pkg-arrow-cycle" />
              </marker>
            </defs>
            <g aria-hidden="true">
              {graph.edges.map((e) => (
                <path
                  key={`${e.source}>${e.target}`}
                  d={path(e)}
                  className={`pkg-edge${e.cyclic ? ' is-cycle' : ''}${touches(e) ? '' : ' is-dim'}${focus && touches(e) ? ' is-near' : ''}`}
                  strokeWidth={Math.min(4.5, 1 + 0.7 * Math.log2(1 + e.pairs))}
                  markerEnd={`url(#${e.cyclic ? 'pkg-arrow-cycle' : 'pkg-arrow'})`}
                >
                  <title>{`${nodes.get(e.source)!.label} → ${nodes.get(e.target)!.label}: ${e.pairs} file pairs`}</title>
                </path>
              ))}
            </g>
            {graph.nodes.map((n) => (
              <g
                key={n.id}
                role="button"
                tabIndex={0}
                aria-pressed={selectedPackage === n.id}
                aria-label={`${visiblePackageLabel(n.label)}: ${packageMeta(n.files, n.internalPairs)}${n.label.length > 30 ? `, full name ${n.label}` : ''}, depends on ${outCount(n.id)} packages, used by ${inCount(n.id)}${n.cyclic ? ', in a cycle' : ''}`}
                className={`pkg-node${n.cyclic ? ' is-cycle' : ''}${selectedPackage === n.id ? ' is-selected' : ''}${focus && focus !== n.id && !near.has(n.id) ? ' is-dim' : ''}`}
                transform={`translate(${n.x},${n.y})`}
                onClick={() => select(n.id)}
                onKeyDown={(e) => onNodeKey(e, n.id)}
                onPointerEnter={() => setHover(n.id)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(n.id)}
                onBlur={() => setHover(null)}
              >
                <rect width={n.width} height={h} rx={8} />
                <text x={n.width / 2} y={15} textAnchor="middle" className="pkg-label">
                  {visiblePackageLabel(n.label)}
                </text>
                {/* SVG line positioning alone leaves the two words joined in the DOM. */}
                {' '}
                <text x={n.width / 2} y={29} textAnchor="middle" className="pkg-meta">
                  {packageMeta(n.files, n.internalPairs)}
                </text>
              </g>
            ))}
          </svg>
        </div>
      ) : (
        <p className="city-note">
          {graph.nodes.length.toLocaleString('en-US')} packages are more than the diagram draws ({PACKAGE_GRAPH.maxNodes}); the table lists every dependency.
        </p>
      )}
      {graph.cycles.length > 0 && (
        <div className="pkg-cycles">
          <strong>Package cycles</strong>
          <ul>
            {graph.cycles.map((c) => (
              <li key={c.join('|')}>{c.join(' ⇄ ')}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="city-table-wrap">
        <table className="city-table pkg-table">
          <caption>
            Package dependencies · {Math.min(TABLE_ROWS, graph.edges.length)} of {graph.edges.length} shown, most file pairs first. A file pair is one file importing another;
            import statements count every statement.
          </caption>
          <thead>
            <tr>
              <th scope="col">From</th>
              <th scope="col">To</th>
              <th scope="col">File pairs</th>
              <th scope="col">Import statements</th>
              <th scope="col">Kinds</th>
              <th scope="col">Cycle</th>
            </tr>
          </thead>
          <tbody>
            {graph.edges.slice(0, TABLE_ROWS).map((e) => (
              <tr key={`${e.source}>${e.target}`} aria-selected={focus === e.source || focus === e.target}>
                <th scope="row">
                  <button type="button" className="link" onClick={() => select(e.source)}>
                    {nodes.get(e.source)!.label}
                  </button>
                </th>
                <td>
                  <button type="button" className="link" onClick={() => select(e.target)}>
                    {nodes.get(e.target)!.label}
                  </button>
                </td>
                <td className="num">{e.pairs.toLocaleString('en-US')}</td>
                <td className="num">{e.observations.toLocaleString('en-US')}</td>
                <td>{e.kinds.map((k) => KIND_LABEL[k] ?? k).join(', ')}</td>
                <td>{e.cyclic ? 'closes a cycle' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
