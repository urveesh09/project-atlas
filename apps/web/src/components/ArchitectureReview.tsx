import { useEffect, useMemo, useRef, useState } from 'react';
import { architectureReasonLabel } from '@atlas/graph';
import { compareUtf8, type ArchitectureFile, type ArchitectureRow, type EdgeKind, type WorkspaceDecisionState, type WorkspaceOwner } from '@atlas/schema';
import { useArchitectureReview } from '../app/architecture';
import { useViewer } from '../app/context';
import { shortOid } from '../app/model';
import type { ArchitectureInput } from '../data/query.worker';
import { Paged } from './ui';

const STATE_LABEL: Record<ArchitectureRow['state'], string> = {
  uncompared: 'Uncompared', 'newly-observed': 'Newly observed', continuing: 'Continuing',
};
const DECISION_LABEL: Record<WorkspaceDecisionState | 'unrecorded', string> = {
  unrecorded: 'No saved decision', 'needs-review': 'Needs review', acknowledged: 'Acknowledged', deferred: 'Deferred',
};
const QUEUE_LABEL: Record<WorkspaceOwner, string> = {
  unassigned: 'Unassigned', maintainers: 'Maintainers', 'architecture-review': 'Architecture review', 'security-review': 'Security review',
};
const EDGE_LABEL: Record<EdgeKind, string> = {
  'imports-value': 'value import', 'imports-type': 'type import', 'reexports-value': 'value re-export',
  'reexports-type': 'type re-export', 'imports-dynamic-literal': 'literal dynamic import',
  'requires-literal': 'literal require', 'imports-resource': 'resource import',
  'declares-package': 'package declaration', 'project-reference': 'project reference',
};

export function ArchitectureReviewPanel() {
  const architecture = useArchitectureReview();
  const { dataset, goToFrame } = useViewer();
  const input = useRef<HTMLInputElement>(null), heading = useRef<HTMLHeadingElement>(null);
  const inputKind = useRef<ArchitectureInput>('report');
  const [rule, setRule] = useState(''), [state, setState] = useState('all');
  const [decisionFilter, setDecisionFilter] = useState('all');
  const report = architecture.evidence?.report;
  const workspace = architecture.evidence?.workspace;
  const decisions = useMemo(() => new Map(workspace?.decisions.map(decision => [decision.issueId, decision])), [workspace]);
  useEffect(() => { if (architecture.open) heading.current?.focus(); }, [architecture.open]);
  useEffect(() => { setRule(''); setState('all'); setDecisionFilter('all'); }, [report]);
  const rows = useMemo(() => report?.rows
    .filter(row => (!rule || row.ruleId === rule)
      && (state === 'all' || row.state === state)
      && (!workspace || decisionFilter === 'all' || (decisions.get(row.id)?.state ?? 'unrecorded') === decisionFilter))
    .toSorted((a, b) => compareUtf8(a.ruleId, b.ruleId) || compareUtf8(a.id, b.id)) ?? [],
  [report, rule, state, workspace, decisions, decisionFilter]);
  if (!architecture.open) return null;
  const hide = () => {
    architecture.setOpen(false);
    document.getElementById('architecture-review-toggle')?.focus();
  };
  const pick = (kind: ArchitectureInput) => {
    inputKind.current = kind;
    input.current?.click();
  };

  const fileLinks = (file: ArchitectureFile, location?: string) => {
    if (!report) return null;
    const currentAt = dataset.frameOfSnapshot.get(report.current.snapshotId)!;
    const baselineAt = report.baseline ? dataset.frameOfSnapshot.get(report.baseline.snapshotId)! : null;
    const occurrence = file.lineageId && report.baseline
      ? dataset.lineages.get(file.lineageId)?.occurrences.find(o => o.snapshotId === report.baseline!.snapshotId)
      : null;
    return (
      <div className="architecture-file-links">
        {file.lineageId ? <button className="link" type="button" onClick={() => void goToFrame(currentAt, { lineage: file.lineageId, tab: 'dependencies' })}>Current file: {file.path}{location ?? ''}</button> : <span>{file.path} · lineage unavailable</span>}
        {baselineAt !== null && occurrence && <button className="link" type="button" onClick={() => void goToFrame(baselineAt, { lineage: file.lineageId, tab: 'dependencies' })}>Baseline file: {occurrence.path}</button>}
      </div>
    );
  };
  return (
    <section className="external-quality architecture-review panel" id="architecture-review-panel" aria-labelledby="architecture-review-title" onKeyDown={event => {
      if (event.key === 'Escape' && !(event.target instanceof HTMLSelectElement)) {
        event.stopPropagation();
        hide();
      }
    }}>
      <div className="external-quality-heading">
        <h2 id="architecture-review-title" ref={heading} tabIndex={-1}>Architecture review</h2>
        <button className="button ghost" type="button" onClick={hide}>Hide architecture review</button>
      </div>
      <p>Open a report from <code>atlas review-architecture</code> or a copy from <code>atlas workspace export</code>. The evidence is recomputed against this artifact in the background. Files stay in this browser session.</p>
      <p className="quality-caveat">Recomputation does not authenticate the artifact's producer or establish a clean scan, runtime impact, security or merge approval.</p>
      <div className="external-quality-actions">
        <input ref={input} type="file" accept=".json,application/json" className="sr-only" tabIndex={-1} aria-hidden="true" data-architecture-input onChange={event => {
          const file = event.currentTarget.files?.[0];
          const kind = inputKind.current;
          event.currentTarget.value = '';
          inputKind.current = 'report';
          if (file) void architecture.load(file, kind);
        }} />
        <button type="button" className="button" disabled={architecture.pending || !architecture.available} onClick={() => pick('report')}>Open architecture review JSON…</button>
        <button type="button" className="button" disabled={architecture.pending || !architecture.available} onClick={() => pick('workspace')}>Open workspace export…</button>
        <button type="button" className="button ghost" onClick={architecture.clear} disabled={!report && !architecture.pending}>Clear architecture review</button>
      </div>
      {!architecture.available && <p>Background validation is unavailable. Reopen the artifact to retry.</p>}
      <p role="status" aria-live="polite">{architecture.message}</p>
      {architecture.error && <p className="quality-error" role="alert">{architecture.error}</p>}
      {report && <>
        <h3>Recomputed policy evidence</h3>
        {workspace && <div>
          <h4>Local workspace decisions</h4>
          <p>Workspace revision {workspace.revision}. Saved decisions for {decisions.size} of {report.rows.length} retained rows.</p>
          <p>Queues and decisions come from the export. They carry no authenticated identity and do not change policy results. To edit them, use <code>atlas workspace decide</code> and open a new export.</p>
        </div>}
        <p>Current {shortOid(report.current.commitOid)} · baseline {report.baseline ? shortOid(report.baseline.commitOid) : 'not selected'} · {report.rows.length} retained rows; {report.rowsOmitted} omitted.</p>
        <p className="section-description">Policy SHA-256: <code>{report.policySha256}</code></p>
        {report.reasons.length > 0 ? <ul className="quality-caveat">{report.reasons.map(reason => <li key={reason}>{architectureReasonLabel(reason)}</li>)}</ul> : <p>No missing evidence reported within the observed internal-file graph scope. This is not a repository-wide clean verdict.</p>}
        <p>Cycles compare static synchronous value-dependency components by member lineage. A continuing component can still gain a new internal route; this report does not enumerate every simple cycle.</p>
        {(['current','baseline'] as const).map(slot => {
          const frame = report[slot]; if (!frame) return null;
          const c = frame.coverage;
          return <p key={slot}>{slot === 'current' ? 'Current' : 'Baseline'} coverage: {c.parsedFiles} parsed of {c.supportedFiles} supported files; {c.opaqueFiles} opaque; {c.excludedFiles} excluded; {c.omittedFiles} omitted; {c.parseFailedFiles} parse failures; {c.unresolved} unresolved and {c.unsupported} unsupported imports; {c.excludedTargets} excluded targets.</p>;
        })}
        <ul className="architecture-rule-counts">{report.rules.map(r => <li key={r.ruleId}><strong>{r.ruleId}</strong>: {r.current} current; {r.baseline ?? 'uncompared'} baseline; {r.newlyObserved ?? 'uncompared'} newly observed; {r.continuing ?? 'uncompared'} continuing; {r.noLongerObserved ?? 'uncompared'} no longer observed. Selected current files: {r.currentFrom} source / {r.currentTo} target; baseline: {r.baselineFrom ?? 'uncompared'} source / {r.baselineTo ?? 'uncompared'} target.</li>)}</ul>
        <div className="architecture-filters">
          <div><label htmlFor="architecture-rule-filter">Architecture rule</label><select id="architecture-rule-filter" value={rule} onChange={event => setRule(event.currentTarget.value)}><option value="">All rules</option>{report.rules.map(r => <option key={r.ruleId} value={r.ruleId}>{r.ruleId}</option>)}</select></div>
          <div><label htmlFor="architecture-state-filter">Architecture evidence state</label><select id="architecture-state-filter" value={state} onChange={event => setState(event.currentTarget.value)}><option value="all">All states</option>{(Object.keys(STATE_LABEL) as ArchitectureRow['state'][]).map(s => <option key={s} value={s}>{STATE_LABEL[s]}</option>)}</select></div>
          {workspace && <div>
            <label htmlFor="architecture-decision-filter">Workspace decision</label>
            <select id="architecture-decision-filter" value={decisionFilter} onChange={event => setDecisionFilter(event.currentTarget.value)}>
              <option value="all">All decisions</option>
              {Object.entries(DECISION_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>}
        </div>
        <p>{rows.length} retained rows match these filters. No longer observed does not mean resolved.</p>
        <Paged key={`${architecture.revision}:${rule}:${state}:${decisionFilter}`} items={rows} pageSize={20} empty="No retained evidence matches these filters. Omitted or unobserved evidence does not establish a clean result." render={row => <li key={row.id} data-architecture-kind={row.kind} data-architecture-rule={row.ruleId}>
          <div><strong>{STATE_LABEL[row.state]}</strong> · {row.ruleId} · {row.kind === 'cycle' ? 'Static cycle component' : 'Boundary relation'}</div>
          {workspace && <DecisionLabel decision={decisions.get(row.id)} />}
          <div>Evidence ID: <code>{row.id}</code></div>
          {row.kind === 'forbidden-dependency' ? <>
            <div>{EDGE_LABEL[row.edge.kind]} · {row.edge.confidence} confidence · {row.edge.observations} import statements; {row.edge.evidenceOmitted} statement locations not listed.</div>
            {fileLinks(row.edge.from, row.edge.locations[0] ? `:${row.edge.locations[0].range.startLine}:${row.edge.locations[0].range.startColumn}` : undefined)}
            {fileLinks(row.edge.to)}
            {row.edge.locations.length > 0 && <p>Source statement positions: {row.edge.locations.map(l => `${l.range.startLine}:${l.range.startColumn}`).join(', ')}.</p>}
          </> : <>
            <div>{row.memberCount} component members; {row.membersOmitted} not listed. {row.witnessUnavailable ? 'A closed witness is unavailable within the evidence bound.' : `Closed witness: ${row.witness.length} directed relationships.`}</div>
            {row.members.map(member => <div key={member.nodeId}>{fileLinks(member)}</div>)}
            {row.witness.length > 0 && <details><summary>Closed witness relationships ({row.witness.length})</summary><ol>{row.witness.map(edge => <li key={edge.edgeId}>{edge.from.path} → {edge.to.path} · {EDGE_LABEL[edge.kind]} · {edge.confidence} confidence; {edge.locations.length ? `source positions ${edge.locations.map(l => `${l.range.startLine}:${l.range.startColumn}`).join(', ')}` : 'statement locations unavailable'}; {edge.evidenceOmitted} locations not listed.</li>)}</ol></details>}
          </>}
        </li>} />
      </>}
    </section>
  );
}

function DecisionLabel({ decision }: { decision: { state: WorkspaceDecisionState; owner: WorkspaceOwner } | undefined }) {
  if (!decision) return <div>{DECISION_LABEL.unrecorded}</div>;
  return <div>Saved decision · {DECISION_LABEL[decision.state]} · {QUEUE_LABEL[decision.owner]}</div>;
}
