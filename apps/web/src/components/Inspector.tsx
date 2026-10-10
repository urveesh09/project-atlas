import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { POLICIES } from '@atlas/graph';
import { LIMITS, RULE_CATALOG, describeReason, formatDiagnosticMessage, type Diagnostic, type GraphNode, type ImportObservation, type NodeMetrics, type RuleId } from '@atlas/schema';
import { useViewer } from '../app/context';
import { ROLE_LABEL, formatNumber, shortOid } from '../app/model';
import { TABS, type InspectorTab } from '../app/state';
import { AvailabilityNote, Chip, Paged, Section, SeverityBadge } from './ui';

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
  const findings = model.index.diagnosticsFor(node.id).length;

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
          {node.kind === 'file' && node.language && <Chip>{node.language === 'typescript' ? 'TypeScript' : 'JavaScript'}</Chip>}
          {node.kind === 'file' && <ParseChip status={node.parseStatus} />}
          <Chip tone="muted" title={model.manifest.selectedCommit.oid}>
            @ {shortOid(model.manifest.selectedCommit.oid)}
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
        {state.tab === 'findings' && <FindingsTab node={node} />}
        {state.tab === 'history' && <HistoryTab />}
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
  { key: 'fanIn', label: 'Direct consumers', definition: 'Files that import this one (value, re-export, require or dynamic import).' },
  { key: 'fanOut', label: 'Direct dependencies', definition: 'Files this one imports under the same policy. Type-only and resources excluded.' },
];

function OverviewTab({ node }: { node: GraphNode }) {
  const { model, dispatch } = useViewer();
  const metrics = model.index.metrics.get(node.id);
  const container = node.kind !== 'file';
  const cycle = metrics?.sccId ? model.graph.diagnostics.find((d) => d.ruleId === 'ATLAS_STATIC_CYCLE' && d.subjectIds.includes(node.id)) : undefined;
  return (
    <>
      {metrics ? (
        <Section title="Measurements" description={container ? 'Aggregated over the files inside, as noted per row.' : 'Raw values; an em dash means not available, never zero.'}>
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
            Syntax <AvailabilityNote value={metrics.availability.syntax} /> {metrics.availability.syntax === 'complete' && 'complete'} · Dependencies{' '}
            <AvailabilityNote value={metrics.availability.dependencies} /> {metrics.availability.dependencies === 'complete' && 'complete'} · History <AvailabilityNote value="unavailable" />
          </p>
        </Section>
      ) : (
        <p className="empty">No measurements for this {node.kind}.</p>
      )}
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

function SourceAction({ nodeId, line, label }: { nodeId: string; line: number | null; label: string }) {
  const { source, dispatch, model } = useViewer();
  const node = model.node(nodeId);
  if (!source || node?.kind !== 'file') return null;
  if (!source.attached) {
    return <p className="note">Source is not attached{source.reason === 'NOT_REQUESTED' ? ' — start with atlas serve --repo <dir> to read it here.' : ` (${source.reason.toLowerCase().replaceAll('_', ' ')}).`}</p>;
  }
  if (node.language === null) return <p className="note">Source is shown only for analyzable TS/JS files.</p>;
  return (
    <button type="button" className="button" onClick={() => dispatch({ type: 'source', nodeId, line })}>
      {label}
    </button>
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
  return (
    <>
      <Section title="Imports" count={internal.length} description="Files this file imports. Click a target to inspect it.">
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
                  {o.status === 'builtin' ? 'Node.js built-in' : ranges ? `declared ${ranges}` : 'not declared in a manifest'} · <Location obs={o} />
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
    <Section title="Consumers" count={consumers.length} description="Files that import this file, with the importing statements.">
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
  return (
    <ul className="findings">
      {list.map((d) => (
        <FindingCard key={d.id} diagnostic={d} focusId={node.id} />
      ))}
    </ul>
  );
}

export function FindingCard({ diagnostic: d, focusId }: { diagnostic: Diagnostic; focusId: string | null }) {
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
          In{' '}
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
      {rule && <p className="finding-explain">{rule.explanation}</p>}
      {subject?.kind === 'file' && <SourceAction nodeId={subject.id} line={d.range?.startLine ?? null} label="View source at this line" />}
    </li>
  );
}

function HistoryTab() {
  const { model } = useViewer();
  const h = model.manifest.coverage.history;
  return (
    <div className="empty-state">
      <h3>History is not in this artifact</h3>
      <p>
        Mainline history, renames and snapshot comparison arrive with Phase 4. This artifact describes commit <code>{shortOid(model.manifest.selectedCommit.oid)}</code> only (history status: {h.status}).
      </p>
    </div>
  );
}
