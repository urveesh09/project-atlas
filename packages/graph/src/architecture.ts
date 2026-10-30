import {
  ARCHITECTURE_LIMITS,
  ArchitecturePolicySchema,
  ArchitectureReviewSchema,
  CYCLE_EDGE_KINDS,
  canonicalJson,
  canonicalJsonSha256,
  compareUtf8,
  hashFields,
  utf8ByteLength,
  type ArchitecturePolicy,
  type ArchitectureSelector,
  type ArchitectureFile,
  type ArchitectureEdge,
  type ArchitectureRow,
  type ArchitectureReview,
  type GraphSnapshot,
  type GraphEdge,
} from '@atlas/schema';
import { parseScanJson } from './scan.js';
import { QualityImportError } from './quality.js';
import { GraphIndex } from './graph-index.js';
import { findStaticCycles } from './scc.js';
function fail(message: string): never { throw new QualityImportError(message); }
function unique(values: readonly string[]): boolean { return new Set(values).size === values.length; }
/** JSON.parse accepts duplicate keys. Reject ambiguity, including escaped key aliases. */
function architectureJson(text: string, limit: number): unknown {
  const value = parseScanJson(text, limit);
  const stack: (Set<string> | null)[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{' || c === '[') {
      stack.push(c === '{' ? new Set() : null);
      if (stack.length > ARCHITECTURE_LIMITS.jsonDepth) fail('Architecture JSON exceeds its nesting limit.');
    } else if (c === '}' || c === ']') stack.pop();
    else if (c === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') i++;
        i++;
      }
      let next = i + 1;
      while (/\s/.test(text[next] ?? '') && next < text.length) next++;
      if (text[next] === ':') {
        const keys = stack.at(-1);
        const key: unknown = JSON.parse(text.slice(start, i + 1));
        if (keys && typeof key === 'string') {
          if (keys.has(key)) fail('Architecture JSON repeats an object key.');
          keys.add(key);
        }
      }
    }
  }
  return value;
}
export function parseArchitecturePolicy(text: string): ArchitecturePolicy {
  const parsed = ArchitecturePolicySchema.safeParse(architectureJson(text, ARCHITECTURE_LIMITS.policyBytes));
  if (!parsed.success)
    fail('Invalid or unsupported architecture policy.');
  const policy = parsed.data;
  if (!unique(policy.rules.map(r => r.id)) || policy.rules.filter(r => r.kind === 'cycle').length > 1)
    fail('Policy rule IDs must be unique; use at most one cycle rule.');
  for (const rule of policy.rules)
    if (rule.kind === 'forbidden-dependency') {
      if (!unique(rule.edgeKinds))
        fail('Policy edge kinds must not repeat.');
      rule.edgeKinds.sort(compareUtf8);
      for (const selector of [rule.from, rule.to]) {
        if (!Object.keys(selector).length)
          fail('Every selector must explicitly select paths, roles or packages.');
        for (const values of [selector.paths, selector.roles, selector.packages])
          if (values) {
            if (!unique(values))
              fail('Selector values must not repeat.');
            values.sort(compareUtf8);
          }
      }
    }
  policy.rules.sort((a, b) => compareUtf8(a.id, b.id));
  return policy;
}
function matches(file: ArchitectureFile, selector: ArchitectureSelector): boolean {
  return (!selector.paths || selector.paths.some(p => p === '' || file.path === p || file.path.startsWith(p + '/')))
    && (!selector.roles || selector.roles.includes(file.role))
    && (!selector.packages || selector.packages.includes(file.packagePath));
}
function prepare(graph: GraphSnapshot) {
  const index = new GraphIndex(graph);
  const files = new Map<string, ArchitectureFile>();
  for (const n of graph.nodes)
    if (n.kind === 'file') {
      const owner = index.packageOf(n.id);
      if (!owner)
        fail('Architecture file has no owning package.');
      files.set(n.id, { nodeId: n.id, lineageId: n.lineageId, path: n.path, role: n.role, packagePath: owner.path });
    }
  const edges = graph.edges.filter(e => files.has(e.sourceId) && files.has(e.targetId)).toSorted((a, b) => compareUtf8(a.id, b.id));
  const lineage = (id: string) => files.get(id)!.lineageId ?? id;
  // Rules reuse relation identities: hash each edge once, not once per rule/frame.
  const edgeKeys = new Map(edges.map(e => [e.id, hashFields('atlas.architecture.relation/1', [lineage(e.sourceId), lineage(e.targetId), e.kind, e.confidence])]));
  const edgeEvidence = (e: GraphEdge): ArchitectureEdge => {
    const observations = e.evidenceIds.toSorted(compareUtf8).slice(0, ARCHITECTURE_LIMITS.locations);
    return {
      edgeId: e.id, from: files.get(e.sourceId)!, to: files.get(e.targetId)!, kind: e.kind, confidence: e.confidence,
      observations: e.observationCount, locations: observations.map(id => {
        const observation = index.observations.get(id);
        if (!observation || observation.sourceId !== e.sourceId || observation.targetId !== e.targetId || observation.kind !== e.kind)
          fail('Architecture observation differs from its edge.');
        return { observationId: id, range: observation.range };
      }), evidenceOmitted: e.observationCount - observations.length
    };
  };
  return { graph, files, edges, edgeKeys, edgeEvidence, lineage };
}
type Prepared = ReturnType<typeof prepare>;
/** Only receives already validated artifact frames. Does not execute or discover policies. */
export function reviewArchitecture(analysisId: string, current: GraphSnapshot, policyInput: ArchitecturePolicy, baseline: GraphSnapshot | null = null): ArchitectureReview {
  const policy = parseArchitecturePolicy(canonicalJson(policyInput));
  if (baseline && (baseline.repoId !== current.repoId || baseline.snapshotId === current.snapshotId || baseline.commitOid === current.commitOid))
    fail('Architecture baseline must be a different snapshot in the same repository.');
  const now = prepare(current), old = baseline ? prepare(baseline) : null;
  const reasons = new Set<ArchitectureReview['reasons'][number]>();
  const incomplete = (g: GraphSnapshot) => {
    const c = g.coverage;
    return c.omittedFiles > 0 || c.excludedFiles > 0 || c.parseFailedFiles > 0 || c.unresolved > 0 || c.unsupported > 0 || c.excludedTargets > 0 || c.limitsHit.length > 0 || c.reasons.length > 0 || c.warnings.length > 0;
  };
  if (incomplete(current))
    reasons.add('current-coverage');
  if (baseline && incomplete(baseline))
    reasons.add('baseline-coverage');
  if ([...now.files.values(), ...(old?.files.values() ?? [])].some(f => f.lineageId === null))
    reasons.add('lineage-unavailable');
  const policySha256 = canonicalJsonSha256(policy), rows: ArchitectureRow[] = [], rules: ArchitectureReview['rules'] = [];
  let total = 0;
  const retain = (make: () => ArchitectureRow) => {
    total++;
    if (rows.length < ARCHITECTURE_LIMITS.rows) rows.push(make());
  };
  for (const rule of policy.rules) {
    const id = (fields: string[]) => `ar_${hashFields('atlas.architecture.issue/1', [analysisId, policySha256, rule.id, ...fields])}`;
    const dependencies = (p: Prepared) => {
      if (rule.kind !== 'forbidden-dependency')
        throw new Error('Expected dependency rule');
      const from = new Set([...p.files.values()].filter(f => matches(f, rule.from)).map(f => f.nodeId));
      const to = new Set([...p.files.values()].filter(f => matches(f, rule.to)).map(f => f.nodeId));
      const found = new Map<string, GraphEdge>();
      for (const e of p.edges)
        if ((rule.edgeKinds as readonly string[]).includes(e.kind) && from.has(e.sourceId) && to.has(e.targetId))
          found.set(p.edgeKeys.get(e.id)!, e);
      return { found, from: from.size, to: to.size };
    };
    if (rule.kind === 'forbidden-dependency') {
      const n = dependencies(now), b = old ? dependencies(old) : null;
      if (!n.from || !n.to || (b && (!b.from || !b.to)))
        reasons.add('unmatched-selector');
      let continuing = 0;
      for (const [key, e] of n.found) {
        const present = b?.found.has(key) ?? false;
        if (present)
          continuing++;
        retain(() => ({ id: id(['dependency', key]), ruleId: rule.id, kind: rule.kind, state: b ? present ? 'continuing' : 'newly-observed' : 'uncompared', edge: now.edgeEvidence(e) }));
      }
      rules.push({ ruleId: rule.id, current: n.found.size, baseline: b?.found.size ?? null, newlyObserved: b ? n.found.size - continuing : null, continuing: b ? continuing : null, noLongerObserved: b ? b.found.size - continuing : null, currentFrom: n.from, currentTo: n.to, baselineFrom: b?.from ?? null, baselineTo: b?.to ?? null });
    }
    else {
      const cycles = (p: Prepared) => new Map(findStaticCycles(p.graph).map(c => [id(c.members.map(p.lineage).sort(compareUtf8)), c]));
      const n = cycles(now), b = old ? cycles(old) : null;
      let continuing = 0;
      // A bounded witness from the existing engine can be a truncated path. Never label it a closed cycle.
      const pairs = new Map<string, GraphEdge>();
      for (const e of now.edges)
        if ((CYCLE_EDGE_KINDS as readonly string[]).includes(e.kind)) {
          const key = `${e.sourceId}:${e.targetId}`;
          if (!pairs.has(key))
            pairs.set(key, e);
        }
      for (const [key, c] of n) {
        const present = b?.has(key) ?? false;
        if (present)
          continuing++;
        retain(() => {
          const members = c.members.map(m => now.files.get(m)!).sort((a, b) => compareUtf8(a.path, b.path));
          const closed = c.witness.length >= 2 && c.witness.length <= ARCHITECTURE_LIMITS.witness + 1 && c.witness[0] === c.witness.at(-1);
          const edges = closed ? c.witness.slice(1).map((to, i) => pairs.get(`${c.witness[i]}:${to}`)) : [];
          const witnessUnavailable = !closed || edges.some(e => !e);
          if (witnessUnavailable || members.length > ARCHITECTURE_LIMITS.members)
            reasons.add('evidence-limit');
          return { id: key, ruleId: rule.id, kind: rule.kind, state: b ? present ? 'continuing' : 'newly-observed' : 'uncompared', members: members.slice(0, ARCHITECTURE_LIMITS.members), memberCount: members.length, membersOmitted: Math.max(0, members.length - ARCHITECTURE_LIMITS.members), witness: witnessUnavailable ? [] : edges.map(e => now.edgeEvidence(e!)), witnessUnavailable };
        });
      }
      rules.push({ ruleId: rule.id, current: n.size, baseline: b?.size ?? null, newlyObserved: b ? n.size - continuing : null, continuing: b ? continuing : null, noLongerObserved: b ? b.size - continuing : null, currentFrom: now.files.size, currentTo: now.files.size, baselineFrom: old?.files.size ?? null, baselineTo: old?.files.size ?? null });
    }
  }
  if (total > rows.length)
    reasons.add('evidence-limit');
  const report = ArchitectureReviewSchema.parse({ format: 'atlas.architecture-review/1', analysisId, repoId: current.repoId, policy, policySha256, current: { snapshotId: current.snapshotId, commitOid: current.commitOid, coverage: current.coverage }, baseline: baseline ? { snapshotId: baseline.snapshotId, commitOid: baseline.commitOid, coverage: baseline.coverage } : null, rules, reasons: [...reasons].sort(compareUtf8), rows: rows.sort((a, b) => compareUtf8(a.id, b.id)), rowsOmitted: total - rows.length });
  if (utf8ByteLength(canonicalJson(report)) + 1 > ARCHITECTURE_LIMITS.reportBytes)
    fail('Architecture review exceeds its 8 MiB limit. Narrow the policy.');
  return report;
}
export function validateArchitectureReview(text: string, analysisId: string, current: GraphSnapshot, baseline: GraphSnapshot | null = null): ArchitectureReview {
  const parsed = ArchitectureReviewSchema.safeParse(architectureJson(text, ARCHITECTURE_LIMITS.reportBytes));
  if (!parsed.success)
    fail('Invalid or unsupported architecture review.');
  const expected = reviewArchitecture(analysisId, current, parsed.data.policy, baseline);
  if (canonicalJson(parsed.data) !== canonicalJson(expected))
    fail('Architecture review differs from the selected artifact and policy.');
  return expected;
}
export function architectureExit(report: ArchitectureReview, failOn?: 'new' | 'all'): number {
  if (failOn === 'new' && !report.baseline)
    fail('New-violation checks require a baseline.');
  if (failOn && report.rules.some(r => (failOn === 'all' ? r.current : r.newlyObserved ?? 0) > 0))
    return 3;
  return report.reasons.length ? 2 : 0;
}
/** Entity-escape every input character that can become active Markdown/HTML. No links. */
const escaped = (text: string) => [...text].map(c => /[A-Za-z0-9 /-]/.test(c) ? c : `&#${c.codePointAt(0)};`).join('');
const reasonLabels: Record<ArchitectureReview['reasons'][number], string> = {
  'current-coverage': 'Current snapshot has exclusions, missing imports, parse failures or other coverage warnings',
  'baseline-coverage': 'Baseline snapshot has exclusions, missing imports, parse failures or other coverage warnings',
  'unmatched-selector': 'At least one rule selector matches no files in a selected snapshot',
  'lineage-unavailable': 'Some files have no lineage identity for reliable comparison',
  'evidence-limit': 'Some matching evidence could not be retained within the report bounds',
};
export const architectureReasonLabel = (reason: ArchitectureReview['reasons'][number]): string => reasonLabels[reason];
export function architectureMarkdown(report: ArchitectureReview): string {
  const lines = ['# Architecture review', '', `Current commit: ${report.current.commitOid}`, `Baseline: ${report.baseline?.commitOid ?? 'none'}`, `Policy SHA-256: ${report.policySha256}`, '', 'Scope: observed internal file dependencies in this artifact. Artifact provenance is not authenticated. No security, runtime-impact or merge-approval verdict.', '', `Coverage: ${report.reasons.map(architectureReasonLabel).join('; ') || 'No missing evidence reported within the declared graph scope'}.`, `Rows omitted: ${report.rowsOmitted}. No absence is labeled resolved.`, ''];
  for (const [label,frame] of [['Current',report.current],['Baseline',report.baseline]] as const) if (frame) {
    const c = frame.coverage;
    lines.push(`${label} coverage: ${c.includedFiles} included of ${c.discoveredFiles} discovered files; ${c.parsedFiles} parsed of ${c.supportedFiles} supported; ${c.parseFailedFiles} parse failures; ${c.opaqueFiles} opaque; ${c.excludedFiles} excluded; ${c.omittedFiles} omitted.`, `${label} imports: ${c.internalResolved} internal; ${c.externalResolved} external; ${c.builtinResolved} built-in; ${c.unresolved} unresolved; ${c.unsupported} unsupported; ${c.excludedTargets} excluded targets.`, '');
  }
  for (const r of report.rules)
    lines.push(`- ${escaped(r.ruleId)}: ${r.current} current; ${r.baseline ?? 'uncompared'} baseline; ${r.newlyObserved ?? 'uncompared'} newly observed; ${r.continuing ?? 'uncompared'} continuing; ${r.noLongerObserved ?? 'uncompared'} no longer observed. Selected files: ${r.currentFrom} source / ${r.currentTo} target currently; ${r.baselineFrom ?? 'uncompared'} source / ${r.baselineTo ?? 'uncompared'} target at baseline.`);
  lines.push('', '## Retained evidence', '');
  for (const r of report.rows) {
    lines.push(`### ${escaped(r.ruleId)}: ${r.state}`, '', `Evidence ID: ${r.id}`, '');
    const edges = r.kind === 'forbidden-dependency' ? [r.edge] : r.witness;
    if (r.kind === 'cycle')
      lines.push(`Static synchronous value cycle component: ${r.memberCount} members (${r.membersOmitted} not listed).`, ...r.members.map(f => `- ${escaped(f.path)}`), r.witnessUnavailable ? 'Closed witness unavailable within its bound.' : 'Closed witness follows.', '');
    for (const e of edges)
      lines.push(`- ${escaped(e.from.path)} → ${escaped(e.to.path)} (${e.kind}, ${e.confidence}; ${e.observations} statements, ${e.evidenceOmitted} locations not listed).`, ...e.locations.map(l => `  - Source ${escaped(e.from.path)}:${l.range.startLine}:${l.range.startColumn}; observation ${l.observationId}.`));
    lines.push('');
  }
  return lines.join('\n') + '\n';
}
