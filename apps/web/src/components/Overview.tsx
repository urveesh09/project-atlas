import { useMemo } from 'react';
import { useViewer } from '../app/context';
import { formatNumber, shortOid } from '../app/model';
import { FindingCard } from './Inspector';
import { Meter, Section, StackBar } from './ui';

/** Repository overview: what was analyzed, what was not, and where to look first. */
export function Overview() {
  const { model, select } = useViewer();
  const c = model.graph.coverage;
  const files = useMemo(
    () =>
      model.graph.metrics
        .map((m) => ({ metric: m, node: model.node(m.nodeId) }))
        .filter((x): x is { metric: typeof x.metric; node: NonNullable<typeof x.node> } => x.node?.kind === 'file'),
    [model],
  );
  const mostComplex = [...files].filter((f) => (f.metric.maxCyclomatic ?? 0) > 0).sort((a, b) => b.metric.maxCyclomatic! - a.metric.maxCyclomatic!).slice(0, 8);
  const mostUsed = [...files].filter((f) => (f.metric.fanIn ?? 0) > 0).sort((a, b) => b.metric.fanIn! - a.metric.fanIn!).slice(0, 8);
  const packages = model.graph.nodes.filter((n) => n.kind === 'package');
  const repoMetrics = model.index.metrics.get(model.index.root.id);
  const status = model.manifest.frames.at(-1)!.analysisStatus;

  return (
    <article className="overview" aria-labelledby="overview-title">
      <header className="overview-header">
        <h2 id="overview-title" tabIndex={-1}>
          {model.manifest.repo.displayName}
        </h2>
        <p className="lede">
          Commit <code title={model.manifest.selectedCommit.oid}>{shortOid(model.manifest.selectedCommit.oid)}</code> from {model.manifest.selectedCommit.committerTime.slice(0, 10)} ·{' '}
          <span className={`status status-${status}`}>{status === 'complete' ? 'complete analysis' : 'partial analysis'}</span> · {formatNumber(repoMetrics?.codeLines)} lines of code in{' '}
          {formatNumber(c.includedFiles)} files
        </p>
      </header>

      <div className="cards">
        <Section title="Files" count={c.discoveredFiles} description="Every committed entry is included, excluded or omitted — never silently dropped.">
          <StackBar
            label={`${c.parsedFiles} parsed, ${c.parseFailedFiles} failed, ${c.opaqueFiles} other included, ${c.excludedFiles} excluded, ${c.omittedFiles} omitted`}
            segments={[
              { value: c.parsedFiles, className: 'seg-parsed', name: 'parsed' },
              { value: c.parseFailedFiles, className: 'seg-warn', name: 'failed' },
              { value: c.opaqueFiles, className: 'seg-other', name: 'other' },
              { value: c.excludedFiles, className: 'seg-excluded', name: 'excluded' },
              { value: c.omittedFiles, className: 'seg-warn', name: 'omitted' },
            ]}
          />
          <dl className="facts">
            <div><dt>Parsed TS/JS</dt><dd>{formatNumber(c.parsedFiles)}</dd></div>
            <div><dt>Parse failed</dt><dd>{formatNumber(c.parseFailedFiles)}</dd></div>
            <div><dt>Other included</dt><dd>{formatNumber(c.opaqueFiles)}</dd></div>
            <div><dt>Excluded</dt><dd>{formatNumber(c.excludedFiles)}</dd></div>
            <div><dt>Omitted by limits</dt><dd>{formatNumber(c.omittedFiles)}</dd></div>
          </dl>
        </Section>

        <Section title="Imports" count={c.observedImports} description="Static import statements and how each resolved.">
          <StackBar
            label={`${c.internalResolved} internal, ${c.externalResolved + c.builtinResolved} packages and built-ins, ${c.unresolved} unresolved, ${c.unsupported + c.excludedTargets} unsupported or excluded`}
            segments={[
              { value: c.internalResolved, className: 'seg-parsed', name: 'internal' },
              { value: c.externalResolved + c.builtinResolved, className: 'seg-other', name: 'external' },
              { value: c.unresolved, className: 'seg-warn', name: 'unresolved' },
              { value: c.unsupported + c.excludedTargets, className: 'seg-excluded', name: 'unsupported' },
            ]}
          />
          <dl className="facts">
            <div><dt>Internal</dt><dd>{formatNumber(c.internalResolved)}</dd></div>
            <div><dt>npm packages</dt><dd>{formatNumber(c.externalResolved)}</dd></div>
            <div><dt>Node.js built-ins</dt><dd>{formatNumber(c.builtinResolved)}</dd></div>
            <div><dt>Unresolved</dt><dd>{formatNumber(c.unresolved)}</dd></div>
            <div><dt>Unsupported / excluded</dt><dd>{formatNumber(c.unsupported + c.excludedTargets)}</dd></div>
          </dl>
        </Section>
      </div>

      <Section title="Findings" count={model.diagnostics.length} description="Built-in, repository-relative heuristics with evidence. Candidates for inspection, not verdicts.">
        {model.diagnostics.length === 0 ? (
          <p className="empty">No findings under the default rules.</p>
        ) : (
          <ul className="findings">
            {model.diagnostics.slice(0, 20).map((d) => (
              <FindingCard key={d.id} diagnostic={d} focusId={null} />
            ))}
          </ul>
        )}
      </Section>

      <div className="cards">
        <Section title="Most branched" description="Highest single-function cyclomatic complexity.">
          <LeaderTable rows={mostComplex.map((f) => ({ id: f.node.id, path: model.pathOf(f.node.id), value: f.metric.maxCyclomatic! }))} unit="complexity" onSelect={select} />
        </Section>
        <Section title="Most depended on" description="Files with the most direct value consumers.">
          <LeaderTable rows={mostUsed.map((f) => ({ id: f.node.id, path: model.pathOf(f.node.id), value: f.metric.fanIn! }))} unit="consumers" onSelect={select} />
        </Section>
      </div>

      <Section title="Packages" count={packages.length}>
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Package</th>
              <th scope="col">Path</th>
              <th scope="col" className="num">Code lines</th>
            </tr>
          </thead>
          <tbody>
            {packages.map((p) => (
              <tr key={p.id}>
                <td>
                  <button type="button" className="link" onClick={() => select(p.id)}>
                    {model.title(p)}
                  </button>
                </td>
                <td>
                  <code>{p.kind === 'package' ? p.path || '.' : ''}</code>
                </td>
                <td className="num">{formatNumber(model.index.metrics.get(p.id)?.codeLines)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </article>
  );
}

function LeaderTable({ rows, unit, onSelect }: { rows: { id: string; path: string; value: number }[]; unit: string; onSelect: (id: string) => void }) {
  if (rows.length === 0) return <p className="empty">Nothing to show.</p>;
  const max = Math.max(...rows.map((r) => r.value));
  return (
    <table className="table leaders">
      <thead>
        <tr>
          <th scope="col">File</th>
          <th scope="col" className="num">
            {unit}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>
              <button type="button" className="link" onClick={() => onSelect(r.id)}>
                {r.path}
              </button>
              <Meter value={r.value} max={max} label={`${r.value} ${unit}`} />
            </td>
            <td className="num">{r.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
