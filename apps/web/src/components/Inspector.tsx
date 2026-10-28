import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { HOTSPOT_WEIGHTS, POLICIES, STRUCTURE_ATTENTION_WEIGHTS, hotspotFactors } from '@atlas/graph';
import { LIMITS, RULE_CATALOG, describeReason, formatDiagnosticMessage, type Diagnostic, type GraphNode, type ImportObservation, type NodeMetrics, type RuleId } from '@atlas/schema';
import { useViewer } from '../app/context';
import { ROLE_LABEL, formatNumber, formatOrdinal, shortOid } from '../app/model';
import { TABS, type InspectorTab } from '../app/state';
import { AvailabilityNote, Chip, Paged, Section, SeverityBadge } from './ui';
import { HistoryTab } from './HistoryPanel';
import { ExternalFileFindings } from './ExternalQuality';

const LANGUAGE_LABEL = { typescript: 'TypeScript', javascript: 'JavaScript', python: 'Python' } as const;

/**
 * What a package or built-in is (ADR-060). Node.js and npm rows read as before; Python rows
 * name their ecosystem, and an inferred built-in says which runtime it belongs to.
 */
function perimeterNote(o: ImportObservation, t: GraphNode | undefined, ranges: string): string {
  if (o.status === 'builtin') {
    if (t?.kind !== 'builtin' || t.runtime !== 'python') return 'Node.js built-in';
    return o.reasonCode ? describeReason(o.reasonCode) : 'Python standard library';
  }
  const declared = ranges ? `declared ${ranges}` : o.reasonCode === 'OPTIONAL_EXTERNAL_IMPORT' ? 'optional, not declared in a manifest' : 'not declared in a manifest';
  return t?.kind === 'external-package' && t.ecosystem === 'pypi' ? `PyPI, ${declared}` : declared;
}

const TAB_LABEL: Record<InspectorTab, string> = { overview: 'Overview', dependencies: 'Dependencies', findings: 'Findings', history: 'History' };

const KIND_LABEL: Record<string, string> = {
  'imports-value': 'import',
  'imports-type': 'type import',
  'reexports-value': 're-export',
  'reexports-type': 'type re-export',
  'imports-dynamic-literal': 'dynamic import',
  'requires-literal': 'require',
  'imports-resource': 'resource',
};

export function Inspector({ node }: { node: GraphNode }) {
  const { model, state, dispatch, select } = useViewer();
  const tabRefs = useRef(new Map<InspectorTab, HTMLButtonElement>());
  // A file's tab counts its own findings; findings that only mention it are listed below them.
  const findings = model.index.diagnosticsFor(node.id).filter((d) => node.kind !== 'file' || isAbout(d, node.id)).length;

  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = TABS.indexOf(state.tab);
    const next = event.key === 'ArrowRight' ? (index + 1) % TABS.length : event.key === 'ArrowLeft' ? (index - 1 + TABS.length) % TABS.length : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    dispatch({ type: 'tab', tab: TABS[next]! });
    tabRefs.current.get(TABS[next]!)?.focus();
  };

  const pkg = model.index.packageOf(node.id);
  return (
    <article className="inspector" aria-labelledby="inspector-title">
      <nav className="breadcrumbs" aria-label="Location">
        <ol>
          <li>
            <button type="button" className="crumb" onClick={() => select(null)}>
              {model.manifest.repo.displayName}
            </button>
          </li>
          {model.index.ancestors(node.id).filter((a) => a.kind !== 'repository').map((a) => (
            <li key={a.id}>
              <button type="button" className="crumb" onClick={() => select(a.id)}>
                {a.kind === 'package' ? (a.path === '' ? `${model.title(a)} (root)` : model.title(a)) : a.label}
              </button>
            </li>
          ))}
        </ol>
      </nav>
      <header className="inspector-header">
        <h2 id="inspector-title" tabIndex={-1}>
          {node.kind === 'file' ? node.label : model.title(node)}
        </h2>
        <p className="inspector-path">{node.kind === 'file' || node.kind === 'directory' ? node.path : node.kind === 'package' ? node.path || '(repository root)' : ''}</p>
        <div className="chips">
          <Chip tone="accent">{node.kind === 'file' ? ROLE_LABEL[node.role] : node.kind}</Chip>
          {pkg && node.kind !== 'package' && <Chip>{model.title(pkg)}</Chip>}
          {node.kind === 'file' && node.language && <Chip>{LANGUAGE_LABEL[node.language]}</Chip>}
          {node.kind === 'file' && <ParseChip status={node.parseStatus} />}
          <Chip tone="muted" title={model.commit.oid}>
            @ {shortOid(model.commit.oid)}
            {model.isHead ? '' : ` · ${model.commit.committerTime.slice(0, 10)}`}
          </Chip>
        </div>
      </header>
      <div className="tabs" role="tablist" aria-label="Inspector sections" onKeyDown={onTabKey}>
        {TABS.map((tab) => (
          <button
            key={tab}
            ref={(el) => {
              if (el) tabRefs.current.set(tab, el);
            }}
            type="button"
            role="tab"
            id={`tab-${tab}`}
            aria-selected={state.tab === tab}
            aria-controls={`panel-${tab}`}
            tabIndex={state.tab === tab ? 0 : -1}
            className="tab"
            onClick={() => dispatch({ type: 'tab', tab })}
          >
            {TAB_LABEL[tab]}
            {tab === 'findings' && findings > 0 && <span className="tab-count">{findings}</span>}
          </button>
        ))}
      </div>
      <div className="tabpanel" role="tabpanel" id={`panel-${state.tab}`} aria-labelledby={`tab-${state.tab}`} tabIndex={0}>
        {state.tab === 'overview' && <OverviewTab node={node} />}
        {state.tab === 'dependencies' && <DependenciesTab node={node} />}
        {state.tab === 'findings' && <><ExternalFileFindings node={node} /><FindingsTab node={node} /></>}
        {state.tab === 'history' && <HistoryTab node={node} />}
      </div>
    </article>
  );
}

function ParseChip({ status }: { status: string }) {
  const text = status === 'parsed' ? 'parsed' : status === 'failed' ? 'parse failed' : status === 'skipped' ? 'not parsed' : 'not analyzable';
  return <Chip tone={status === 'parsed' ? 'neutral' : status === 'failed' ? 'warn' : 'muted'}>{text}</Chip>;
}

const METRICS: { key: keyof NodeMetrics; label: string; definition: string; container?: string }[] = [
  { key: 'physicalLines', label: 'Physical lines', definition: 'LF-delimited lines; a trailing newline adds none.', container: 'Sum over files.' },
  { key: 'codeLines', label: 'Code lines', definition: 'Lines touching a code token; comment and blank lines excluded.', container: 'Sum over parsed files.' },
  { key: 'declarationCount', label: 'Declarations', definition: 'Top-level named declarations.', container: 'Sum over parsed files.' },
  { key: 'maxCyclomatic', label: 'Max complexity', definition: 'Highest cyclomatic complexity of any function (1 + decisions).', container: 'Maximum over files.' },
  { key: 'sumCyclomatic', label: 'Total complexity', definition: 'Sum over functions; grows with size.', container: 'Sum over files.' },
  { key: 'callableCount', label: 'Functions', definition: 'Functions, methods, constructors, accessors and arrows with a body.', container: 'Sum over files.' },
  { key: 'fanIn', label: 'Direct value consumers', definition: 'Unique files that import this one by value, re-export, require or dynamic import. Type-only imports are not counted.' },
  { key: 'fanOut', label: 'Direct value dependencies', definition: 'Unique files this one imports under the same policy. Counts files, not import statements; type-only and resources excluded.' },
  { key: 'changedCommits', label: 'Changed commits', definition: 'Mainline commits in the window that changed this file, up to this snapshot.', container: 'Distinct commits changing any file here.' },
  { key: 'linesAdded', label: 'Lines added', definition: 'Text lines added by those changes (numstat); binary content has none.', container: 'Sum over files.' },
  { key: 'linesDeleted', label: 'Lines deleted', definition: 'Text lines deleted by those changes.', container: 'Sum over files.' },
];

function OverviewTab({ node }: { node: GraphNode }) {
  const { model, dispatch } = useViewer();
  const metrics = model.index.metrics.get(node.id);
  const container = node.kind !== 'file';
  const cycle = metrics?.sccId ? model.graph.diagnostics.find((d) => d.ruleId === 'ATLAS_STATIC_CYCLE' && d.subjectIds.includes(node.id)) : undefined;
  return (
    <>
      {metrics ? (
        <Section title="Measurements" description={container ? 'Aggregated over the files inside, as noted per row.' : 'Raw values; n/a means not available, never zero.'}>
          <table className="metrics">
            <thead>
              <tr>
                <th scope="col">Metric</th>
                <th scope="col" className="num">
                  Value
                </th>
                <th scope="col">Definition</th>
              </tr>
            </thead>
            <tbody>
              {METRICS.filter((m) => !container || m.container).map((m) => (
                <tr key={m.key}>
                  <th scope="row">{m.label}</th>
                  <td className="num">{formatNumber(metrics[m.key] as number | null)}</td>
                  <td className="definition">{container ? m.container : m.definition}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="availability">
            Syntax <AvailabilityNote value={metrics.availability.syntax} /> {metrics.availability.syntax === 'complete' && 'complete'}; dependencies{' '}
            <AvailabilityNote value={metrics.availability.dependencies} /> {metrics.availability.dependencies === 'complete' && 'complete'}; history{' '}
            <AvailabilityNote value={metrics.availability.history} /> {metrics.availability.history === 'complete' && 'complete'}.
          </p>
        </Section>
      ) : (
        <p className="empty">No measurements for this {node.kind}.</p>
      )}
      {node.kind === 'file' && <HotspotExplanation node={node} />}
      {cycle && (
        <Section title="Static cycle">
          <p>
            Part of a static value dependency cycle of {cycle.subjectIds.length} files.{' '}
            <button type="button" className="link" onClick={() => dispatch({ type: 'tab', tab: 'findings' })}>
              See Findings
            </button>
          </p>
        </Section>
      )}
      {node.kind === 'file' && node.declarations.length > 0 && (
        <Section title="Declarations" count={node.declarations.length + node.declarationsOmitted}>
          <Paged
            items={node.declarations}
            pageSize={25}
            empty="None"
            render={(d) => (
              <li key={`${d.name}-${d.range.startOffset}`} className="row">
                <code className="row-main">{d.name}</code>
                <span className="row-meta">
                  {d.kind}
                  {d.exported ? ' · exported' : ''} · line {d.range.startLine}
                </span>
              </li>
            )}
          />
          {node.declarationsOmitted > 0 && <p className="note">{node.declarationsOmitted} more not recorded (limit {LIMITS.declarationsPerFile} per file).</p>}
        </Section>
      )}
      {container && <ChildrenSummary node={node} />}
      {node.kind === 'file' && <SourceAction nodeId={node.id} line={null} label="View source" />}
    </>
  );
}

function ChildrenSummary({ node }: { node: GraphNode }) {
  const { model, select } = useViewer();
  const children = model.index.children.get(node.id) ?? [];
  return (
    <Section title="Contents" count={children.length}>
      <Paged
        items={children}
        pageSize={40}
        empty="Empty"
        render={(child) => (
          <li key={child.id} className="row">
            <button type="button" className="link row-main" onClick={() => select(child.id)}>
              {child.kind === 'package' ? model.title(child) : child.label}
              {child.kind !== 'file' ? '/' : ''}
            </button>
            <span className="row-meta">{child.kind === 'file' ? ROLE_LABEL[child.role] : child.kind}</span>
          </li>
        )}
      />
    </Section>
  );
}

/**
 * The exact committed file on GitHub (ADR-047), only for public-GitHub analyses: the
 * analyzed commit, the file's path in that snapshot and, when known, the line. Every path
 * segment is encoded, and nothing is fetched; the visitor follows the link deliberately.
 */
export function githubBlobUrl(remote: { owner: string; name: string } | null, commitOid: string, path: string, line: number | null): string | null {
  if (!remote || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commitOid)) return null;
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${encodeURIComponent(remote.owner)}/${encodeURIComponent(remote.name)}/blob/${commitOid}/${encoded}${line ? `#L${line}` : ''}`;
}

function SourceAction({ nodeId, line, label }: { nodeId: string; line: number | null; label: string }) {
  const { source, dispatch, model } = useViewer();
  const node = model.node(nodeId);
  if (node?.kind !== 'file') return null;
  const github = model.manifest.repo.sourceKind === 'public-github' ? githubBlobUrl(model.manifest.repo.remote, model.commit.oid, node.path, line) : null;
  const githubLink = github && (
    <a className="button" href={github} target="_blank" rel="noopener noreferrer">
      {line ? `Open line ${line} on GitHub` : 'Open on GitHub'}
    </a>
  );
  if (!source || !source.attached) {
    return (
      <div className="source-links">
        {githubLink}
        {source && !source.attached && !github && (
          <p className="note">Source is not attached{source.reason === 'NOT_REQUESTED' ? '. Start with atlas serve --repo <dir> to read it here.' : ` (${source.reason.toLowerCase().replaceAll('_', ' ')}).`}</p>
        )}
      </div>
    );
  }
  if (node.language === null) return <div className="source-links">{githubLink}<p className="note">Source is shown only for TypeScript, JavaScript and Python files.</p></div>;
  return (
    <div className="source-links">
      <button type="button" className="button" onClick={() => dispatch({ type: 'source', nodeId, line })}>
        {label}
      </button>
      {githubLink}
    </div>
  );
}

function Location({ obs }: { obs: ImportObservation }) {
  return (
    <span className="loc">
      line {obs.range.startLine}:{obs.range.startColumn}
    </span>
  );
}

function DependenciesTab({ node }: { node: GraphNode }) {
  const { model, select } = useViewer();
  if (node.kind !== 'file') return <PackageDependencies node={node} />;
  const observations = model.index.observationsFrom(node.id);
  const internal = observations.filter((o) => o.status === 'resolved-internal' && o.kind !== 'imports-type' && o.kind !== 'reexports-type');
  const typeOnly = observations.filter((o) => o.status === 'resolved-internal' && (o.kind === 'imports-type' || o.kind === 'reexports-type'));
  const perimeter = observations.filter((o) => o.status === 'resolved-external' || o.status === 'builtin');
  const unresolved = observations.filter((o) => o.status === 'unresolved' || o.status === 'unsupported' || o.status === 'excluded-target');
  const consumers = useMemo(() => {
    const bySource = new Map<string, { kinds: Set<string>; lines: number[] }>();
    for (const edge of model.index.incoming(node.id, POLICIES.all)) {
      if (model.node(edge.sourceId)?.kind !== 'file') continue;
      const entry = bySource.get(edge.sourceId) ?? { kinds: new Set(), lines: [] };
      entry.kinds.add(KIND_LABEL[edge.kind] ?? edge.kind);
      for (const id of edge.evidenceIds) {
        const obs = model.index.observations.get(id);
        if (obs) entry.lines.push(obs.range.startLine);
      }
      bySource.set(edge.sourceId, entry);
    }
    return [...bySource].sort(([a], [b]) => (model.pathOf(a) < model.pathOf(b) ? -1 : 1));
  }, [model, node.id]);

  const target = (obs: ImportObservation) => {
    const t = model.node(obs.targetId);
    return t ? (
      <button type="button" className="link row-main" onClick={() => select(t.id)}>
        {model.title(t)}
      </button>
    ) : null;
  };
  if (node.parseStatus !== 'parsed') {
    return (
      <>
        <p className="empty">This file was not parsed, so its own imports are unknown. Consumers below are still exact.</p>
        <ConsumerList consumers={consumers} />
      </>
    );
  }
  const metric = model.index.metrics.get(node.id);
  const targets = new Set(internal.map((o) => o.targetId)).size;
  const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
  return (
    <>
      {/* Several counts describe one file's relationships; each names its unit and policy (ADR-047). */}
      <p className="count-note">
        <strong>Reading the counts:</strong> {plural(internal.length, 'internal import statement')} reach {plural(targets, 'file')}
        {metric?.fanOut !== null && metric?.fanOut !== undefined ? ` (${plural(metric.fanOut, 'direct value dependency', 'direct value dependencies')} in Overview, which excludes resources)` : ''}.{' '}
        {plural(consumers.length, 'file')} import this one in any way, type-only included
        {metric?.fanIn !== null && metric?.fanIn !== undefined ? `; ${plural(metric.fanIn, 'is a direct value consumer', 'are direct value consumers')}` : ''}.
      </p>
      <Section title="Imports" count={internal.length} description="Internal import statements, one row each; several can reach the same file. Click a target to inspect it.">
        <Paged
          items={internal}
          empty="No internal imports."
          render={(o) => (
            <li key={o.id} className="row">
              {target(o)}
              <span className="row-meta">
                {KIND_LABEL[o.kind]} · <code>{o.specifier}</code> · <Location obs={o} />
                {o.confidence !== 'exact' && <Chip tone="muted" title={o.reasonCode ? describeReason(o.reasonCode) : 'Resolved with documented assumptions'}>{o.confidence}</Chip>}
              </span>
            </li>
          )}
        />
      </Section>
      <ConsumerList consumers={consumers} />
      <Section title="Packages and built-ins" count={perimeter.length}>
        <Paged
          items={perimeter}
          empty="None."
          render={(o) => {
            const t = model.node(o.targetId);
            const ranges = t?.kind === 'external-package' ? [...new Set(t.declaredRanges.map((r) => r.range))].join(', ') : '';
            return (
              <li key={o.id} className="row">
                <span className="row-main">
                  <code>{t ? model.title(t) : o.specifier}</code>
                </span>
                <span className="row-meta">
                  {perimeterNote(o, t, ranges)} · <Location obs={o} />
                </span>
              </li>
            );
          }}
        />
      </Section>
      <Section title="Type-only" count={typeOnly.length} description="Type imports are separate: they do not count toward consumers, dependencies or cycles.">
        <Paged
          items={typeOnly}
          empty="None."
          render={(o) => (
            <li key={o.id} className="row">
              {target(o)}
              <span className="row-meta">
                {KIND_LABEL[o.kind]} · <Location obs={o} />
              </span>
            </li>
          )}
        />
      </Section>
      <Section title="Unresolved and unsupported" count={unresolved.length}>
        <Paged
          items={unresolved}
          empty="Every import resolved."
          render={(o) => (
            <li key={o.id} className="row">
              <code className="row-main">{o.specifier ?? '(computed specifier)'}</code>
              <span className="row-meta">
                {describeReason(o.reasonCode ?? 'UNRESOLVED')} · <Location obs={o} />
              </span>
            </li>
          )}
        />
      </Section>
      <Reach nodeId={node.id} />
    </>
  );
}

function ConsumerList({ consumers }: { consumers: [string, { kinds: Set<string>; lines: number[] }][] }) {
  const { model, select } = useViewer();
  return (
    <Section title="Consumers" count={consumers.length} description="Unique files that import this file in any way, type-only included, with their importing lines.">
      <Paged
        items={consumers}
        empty="No file imports this one."
        render={([id, entry]) => (
          <li key={id} className="row">
            <button type="button" className="link row-main" onClick={() => select(id)}>
              {model.pathOf(id)}
            </button>
            <span className="row-meta">
              {[...entry.kinds].join(', ')} · line {entry.lines.sort((a, b) => a - b).join(', ')}
            </span>
          </li>
        )}
      />
    </Section>
  );
}

function Reach({ nodeId }: { nodeId: string }) {
  const { model, select } = useViewer();
  const [direction, setDirection] = useState<'outgoing' | 'incoming'>('outgoing');
  const [depth, setDepth] = useState<number>(LIMITS.reachDefaultDepth);
  const [shown, setShown] = useState(false);
  const result = useMemo(() => (shown ? model.index.reach(nodeId, { direction, depth }) : null), [model, nodeId, direction, depth, shown]);
  return (
    <Section title="Reachable files" description="Bounded breadth-first search over the static value-edge policy. This is static structure, not runtime impact.">
      <div className="controls">
        <label>
          Direction{' '}
          <select value={direction} onChange={(e) => setDirection(e.target.value as 'outgoing' | 'incoming')}>
            <option value="outgoing">what this file depends on</option>
            <option value="incoming">what depends on this file</option>
          </select>
        </label>
        <label>
          Depth{' '}
          <select value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
            {[1, 2, 3, 4, 5].map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="button" onClick={() => setShown(true)}>
          Show reachable
        </button>
      </div>
      {result && (
        <>
          <p className="note" role="status">
            {result.nodes.length} file{result.nodes.length === 1 ? '' : 's'} within depth {result.depth}
            {result.truncated ? `; stopped at the ${LIMITS.reachMaxVisited.toLocaleString('en-US')}-file limit` : ''}
            {result.beyondDepth ? '; more lie beyond this depth' : ''}.
          </p>
          <Paged
            items={result.nodes}
            empty="Nothing reachable."
            render={(n) => (
              <li key={n.id} className="row">
                <button type="button" className="link row-main" onClick={() => select(n.id)}>
                  {model.pathOf(n.id)}
                </button>
                <span className="row-meta">depth {n.depth}</span>
              </li>
            )}
          />
        </>
      )}
    </Section>
  );
}

function PackageDependencies({ node }: { node: GraphNode }) {
  const { model, select } = useViewer();
  const declared = model.index.outgoing(node.id, ['declares-package', 'project-reference']);
  const rollups = node.kind === 'package' ? model.index.packageRollups().filter((r) => r.sourcePackageId === node.id && r.targetPackageId !== node.id) : [];
  return (
    <>
      {node.kind === 'package' && (
        <Section title="Imports into other packages" count={rollups.length} description="Observed file imports, rolled up by package. Unique file pairs and statements are both shown.">
          <Paged
            items={rollups}
            empty="No imports into other packages."
            render={(r) => (
              <li key={r.targetPackageId} className="row">
                <button type="button" className="link row-main" onClick={() => select(r.targetPackageId)}>
                  {model.title(model.node(r.targetPackageId)!)}
                </button>
                <span className="row-meta">
                  {r.uniqueFilePairs} file pair{r.uniqueFilePairs === 1 ? '' : 's'} · {r.observations} statement{r.observations === 1 ? '' : 's'}
                </span>
              </li>
            )}
          />
        </Section>
      )}
      <Section title="Declared in the manifest" count={declared.length} description="What package.json declares or tsconfig references. Declarations are not observed imports.">
        <Paged
          items={declared}
          empty={node.kind === 'package' ? 'No declared dependencies.' : 'Folders do not declare dependencies; select a file or package.'}
          render={(e) => {
            const target = model.node(e.targetId)!;
            return (
              <li key={e.id} className="row">
                {target.kind === 'package' ? (
                  <button type="button" className="link row-main" onClick={() => select(target.id)}>
                    {model.title(target)}
                  </button>
                ) : (
                  <code className="row-main">{model.title(target)}</code>
                )}
                <span className="row-meta">
                  {e.kind === 'project-reference' ? 'project reference' : target.kind === 'external-package' ? target.declaredRanges.filter((r) => r.packageNodeId === node.id).map((r) => `${r.field} ${r.range}`).join(', ') : 'workspace package'}
                </span>
              </li>
            );
          }}
        />
      </Section>
    </>
  );
}

function FindingsTab({ node }: { node: GraphNode }) {
  const { model } = useViewer();
  const list = useMemo(() => {
    if (node.kind === 'file') return model.index.diagnosticsFor(node.id);
    // Containers show the findings of everything inside them.
    const inside = new Set<string>();
    const stack = [node.id];
    while (stack.length > 0) {
      const id = stack.pop()!;
      inside.add(id);
      for (const child of model.index.children.get(id) ?? []) stack.push(child.id);
    }
    return model.diagnostics.filter((d) => d.subjectIds.some((s) => inside.has(s)));
  }, [model, node]);
  if (list.length === 0) return <p className="empty">No findings under the default rules. Thresholds are repository-relative product defaults, not quality grades.</p>;
  if (node.kind !== 'file')
    return <Paged items={list} pageSize={10} step={20} listClassName="findings" empty="" render={(d) => <FindingCard key={d.id} diagnostic={d} focusId={node.id} compact />} />;
  // A file's own findings first; then findings about other files that list this one (ADR-047).
  const own = list.filter((d) => isAbout(d, node.id));
  const mentions = list.filter((d) => !isAbout(d, node.id));
  return (
    <>
      <Section title="About this file" count={own.length}>
        {own.length ? (
          <ul className="findings">
            {own.map((d) => (
              <FindingCard key={d.id} diagnostic={d} focusId={node.id} />
            ))}
          </ul>
        ) : (
          <p className="empty">None under the default rules.</p>
        )}
      </Section>
      {mentions.length > 0 && (
        <Section title="Findings about other files" count={mentions.length} description="This file appears in them, for example as one of a heavily imported file’s consumers. Each names its own subject.">
          <Paged items={mentions} pageSize={10} step={20} listClassName="findings" empty="" render={(d) => <FindingCard key={d.id} diagnostic={d} focusId={node.id} compact />} />
        </Section>
      )}
    </>
  );
}

/** A finding is about a file when the file is its subject, or a member of its cycle. */
export function isAbout(d: Diagnostic, id: string): boolean {
  return d.subjectIds[0] === id || (d.ruleId === 'ATLAS_STATIC_CYCLE' && d.subjectIds.includes(id));
}

/**
 * One finding. `compact` is for long lists (a folder, the overview, mentions): the rule's
 * general explanation, the same on every card of a rule, is one click away there (ADR-058).
 * A file's own findings always show it.
 */
export function FindingCard({ diagnostic: d, focusId, compact = false }: { diagnostic: Diagnostic; focusId: string | null; compact?: boolean }) {
  const { model, select } = useViewer();
  const rule = RULE_CATALOG[d.ruleId as RuleId];
  const subject = model.node(d.subjectIds[0]);
  const others = d.ruleId === 'ATLAS_STATIC_CYCLE' ? d.subjectIds : d.ruleId === 'ATLAS_HIGH_FAN_IN' ? d.subjectIds.slice(1) : [];
  const evidence = d.evidenceIds.map((id) => model.index.observations.get(id)).filter((o): o is ImportObservation => o !== undefined);
  return (
    <li className={`finding finding-${d.severity}`}>
      <div className="finding-head">
        <SeverityBadge severity={d.severity} />
        <h3 className="finding-title">{rule?.title ?? d.ruleId}</h3>
      </div>
      <p className="finding-message">{formatDiagnosticMessage(d)}</p>
      {subject && subject.id !== focusId && (
        <p className="finding-subject">
          {d.ruleId === 'ATLAS_STATIC_CYCLE' ? 'Reported on' : 'About'}{' '}
          <button type="button" className="link" onClick={() => select(subject.id)}>
            {model.title(subject)}
          </button>
          {d.range && ` at line ${d.range.startLine}`}
        </p>
      )}
      {subject?.id === focusId && d.range && <p className="finding-subject">At line {d.range.startLine}, column {d.range.startColumn}.</p>}
      {others.length > 0 && (
        <details className="finding-detail">
          <summary>
            {d.ruleId === 'ATLAS_STATIC_CYCLE' ? 'Files in the cycle' : 'Direct consumers'} ({others.length})
          </summary>
          <ul className="rows">
            {others.map((id) => (
              <li key={id} className="row">
                <button type="button" className="link row-main" onClick={() => select(id)}>
                  {model.pathOf(id)}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      {evidence.length > 0 && d.ruleId !== 'ATLAS_HIGH_FAN_IN' && (
        <details className="finding-detail">
          <summary>Evidence ({evidence.length} statement{evidence.length === 1 ? '' : 's'})</summary>
          <ul className="rows">
            {evidence.slice(0, 50).map((o) => (
              <li key={o.id} className="row">
                <code className="row-main">{o.specifier ?? '(computed)'}</code>
                <span className="row-meta">
                  {model.pathOf(o.sourceId)} · line {o.range.startLine}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {rule &&
        (compact ? (
          <details className="finding-detail">
            <summary>Why this is flagged</summary>
            <p className="finding-explain">{rule.explanation}</p>
          </details>
        ) : (
          <p className="finding-explain">{rule.explanation}</p>
        ))}
      {subject?.kind === 'file' && <SourceAction nodeId={subject.id} line={d.range?.startLine ?? null} label="View source at this line" />}
    </li>
  );
}

const pct = (p: number) => `${formatOrdinal(Math.round(p * 100))} percentile`;

/**
 * Hotspot explainability (plan §10.3): raw values, percentiles against the fixed HEAD
 * cohort, weights and window. Without usable history, the separately named Structure
 * attention score is shown instead; the full score is never renormalized.
 */
function HotspotExplanation({ node }: { node: Extract<GraphNode, { kind: 'file' }> }) {
  const { model, dataset } = useViewer();
  const metric = model.index.metrics.get(node.id);
  const factors = hotspotFactors(dataset.baseline, node, metric);
  if (!factors || !metric)
    return (
      <Section title="Hotspot">
        <p className="note">
          Not scored: only parsed production-source files with complete dependency data are ranked. Tests, configuration, declarations and opaque files form separate cohorts.
        </p>
      </Section>
    );
  const W = HOTSPOT_WEIGHTS;
  const S = STRUCTURE_ATTENTION_WEIGHTS;
  const full = factors.score !== null;
  return (
    <Section
      title={full ? 'Hotspot score' : 'Structure attention'}
      description={`A candidate for inspection under documented heuristics, ranked against the ${dataset.baseline.cohortSize} production-source files of the selected commit. It is not a defect, risk or quality grade.`}
    >
      <p className="hotspot-score">
        <strong>{full ? factors.score : factors.structureAttention}</strong> / 100
        {!full && <span className="note"> (no usable history, so the full hotspot score is unavailable rather than recomputed without it)</span>}
      </p>
      <table className="metrics">
        <thead>
          <tr>
            <th scope="col">Factor</th>
            <th scope="col" className="num">
              Raw
            </th>
            <th scope="col">Percentile</th>
            <th scope="col" className="num">
              Weight
            </th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Max complexity</th>
            <td className="num">{formatNumber(metric.maxCyclomatic)}</td>
            <td>{pct(factors.pComplexity)}</td>
            <td className="num">{full ? W.complexity : S.complexity}</td>
          </tr>
          <tr>
            <th scope="row">Direct consumers</th>
            <td className="num">{formatNumber(metric.fanIn)}</td>
            <td>{pct(factors.pFanIn)}</td>
            <td className="num">{full ? W.fanIn : S.fanIn}</td>
          </tr>
          {full && (
            <tr>
              <th scope="row">Changed commits</th>
              <td className="num">{formatNumber(metric.changedCommits)}</td>
              <td>{pct(factors.pChangedCommits!)}</td>
              <td className="num">{W.changedCommits}</td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="note">
        Score = round(100 × Σ weight × percentile). Percentiles use midranks of the selected commit's cohort{model.isHead ? '' : ', so this earlier snapshot is graded on the same scale'}.
        {dataset.baseline.complexity?.allIdentical || dataset.baseline.fanIn?.allIdentical ? ' Some factors are identical across the cohort and cannot discriminate.' : ''}
      </p>
    </Section>
  );
}
