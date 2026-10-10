import type { FileFacts } from '@atlas/analyzer-ts';
import { GraphIndex, POLICIES, nearestRankPercentile, type StaticCycle } from '@atlas/graph';
import {
  LIMITS,
  RULE_CATALOG,
  RULE_THRESHOLDS,
  canonicalJsonSha256,
  compareAscii,
  compareUtf8,
  makeId,
  utf8ByteLength,
  type Diagnostic,
  type FileNode,
  type GraphSnapshot,
  type NodeMetrics,
  type RuleId,
  type SourceRange,
} from '@atlas/schema';

/**
 * Built-in rule evaluation (plan §10.2). Every diagnostic has exact evidence: a source
 * range, observation IDs, or member/consumer lists. Fingerprints use lineage and
 * normalized evidence so the same finding can be matched across frames (plan §7.1).
 */
export interface RuleInput {
  snapshot: GraphSnapshot;
  facts: Map<string, FileFacts>;
  metrics: NodeMetrics[];
  cycles: readonly StaticCycle[];
  limits: { limit: string; count: number; stage: string }[];
}

const LOCAL_MISSING = new Set(['LOCAL_TARGET_MISSING', 'CASE_MISMATCH']);
const CONTEXT_INCOMPLETE = new Set(['ALIAS_UNSUPPORTED', 'CONFIG_CONTEXT_MISSING', 'GENERATED_TARGET_MISSING', 'PACKAGE_EXPORT_UNSUPPORTED', 'AMBIGUOUS_WORKSPACE_PACKAGE']);
const MAX_SUBJECTS = 2_000;

function bounded(text: string, maxBytes = LIMITS.diagnosticParameterBytes): string {
  if (utf8ByteLength(text) <= maxBytes) return text;
  let out = text.slice(0, maxBytes - 1);
  while (utf8ByteLength(out) > maxBytes - 3) out = out.slice(0, -1);
  return `${out}…`;
}

export function evaluateRules(input: RuleInput): { diagnostics: Diagnostic[]; omitted: number } {
  const { snapshot } = input;
  const snap = snapshot.snapshotId;
  const index = new GraphIndex(snapshot);
  const metrics = new Map(input.metrics.map((m) => [m.nodeId, m]));
  const out: Diagnostic[] = [];
  const repositoryId = index.root.id;

  const emit = (ruleId: RuleId, identity: (string | number)[], d: { subjectIds: string[]; range: SourceRange | null; messageCode: string; parameters: Record<string, string | number>; evidenceIds?: string[]; fingerprint: unknown[] }) => {
    const rule = RULE_CATALOG[ruleId];
    const parameters = Object.fromEntries(Object.entries(d.parameters).map(([k, v]) => [k, typeof v === 'string' ? bounded(v) : v]));
    out.push({
      id: makeId('diagnostic', [snap, ruleId, ...identity]),
      ruleId,
      ruleVersion: rule.version,
      severity: rule.severity,
      category: rule.category,
      subjectIds: [...new Set(d.subjectIds)].slice(0, MAX_SUBJECTS),
      range: d.range,
      messageCode: d.messageCode,
      parameters,
      evidenceIds: [...new Set(d.evidenceIds ?? [])].sort(compareAscii).slice(0, MAX_SUBJECTS),
      fingerprint: canonicalJsonSha256([ruleId, rule.version, ...d.fingerprint]),
    });
  };
  const files = snapshot.nodes.filter((n): n is FileNode => n.kind === 'file');
  const lineageKey = (file: FileNode) => file.lineageId ?? file.path;

  for (const file of files) {
    const facts = input.facts.get(file.path);
    if (!facts || facts.parseStatus !== 'failed') continue;
    const first = facts.parseErrors[0];
    emit('ATLAS_PARSE_ERROR', [file.id], {
      subjectIds: [file.id],
      range: first?.range ?? null,
      messageCode: facts.failureReason === 'SYNTAX_ERROR' ? 'PARSE_ERROR' : 'PARSE_FAILED',
      parameters: facts.failureReason === 'SYNTAX_ERROR' ? { tsCode: first?.code ?? 0, errorCount: facts.parseErrors.length } : { reason: facts.failureReason ?? 'UNKNOWN' },
      fingerprint: [lineageKey(file), facts.failureReason, first?.code ?? null],
    });
  }

  // Unresolved local imports: one finding per statement. Context gaps: one per file.
  const contextByFile = new Map<string, { evidence: string[]; reasons: Set<string>; first: SourceRange }>();
  for (const obs of snapshot.importObservations) {
    if (obs.status !== 'unresolved' || obs.reasonCode === null) continue;
    const file = index.nodes.get(obs.sourceId) as FileNode;
    if (LOCAL_MISSING.has(obs.reasonCode)) {
      emit('ATLAS_LOCAL_IMPORT_UNRESOLVED', [obs.id], {
        subjectIds: [file.id],
        range: obs.range,
        messageCode: 'LOCAL_IMPORT_UNRESOLVED',
        parameters: { specifier: obs.specifier ?? '', reason: obs.reasonCode },
        evidenceIds: [obs.id],
        fingerprint: [lineageKey(file), obs.specifier, obs.reasonCode],
      });
    } else if (CONTEXT_INCOMPLETE.has(obs.reasonCode)) {
      const entry = contextByFile.get(file.id) ?? { evidence: [], reasons: new Set<string>(), first: obs.range };
      entry.evidence.push(obs.id);
      entry.reasons.add(obs.reasonCode);
      if (obs.range.startOffset < entry.first.startOffset) entry.first = obs.range;
      contextByFile.set(file.id, entry);
    }
  }
  for (const [fileId, entry] of contextByFile) {
    const file = index.nodes.get(fileId) as FileNode;
    const reasons = [...entry.reasons].sort().join(',');
    emit('ATLAS_RESOLUTION_CONTEXT_INCOMPLETE', [fileId], {
      subjectIds: [fileId],
      range: entry.first,
      messageCode: 'RESOLUTION_CONTEXT_INCOMPLETE',
      parameters: { count: entry.evidence.length, reasons },
      evidenceIds: entry.evidence,
      fingerprint: [lineageKey(file), reasons],
    });
  }

  for (const cycle of input.cycles) {
    const witness = cycle.witness.map((id) => index.pathOf(id)).join(' → ');
    const evidence: string[] = [];
    for (let i = 0; i + 1 < cycle.witness.length; i++) {
      const edge = index.outgoing(cycle.witness[i]!, POLICIES.cycle).find((e) => e.targetId === cycle.witness[i + 1]);
      if (edge?.evidenceIds[0]) evidence.push(edge.evidenceIds[0]);
    }
    emit('ATLAS_STATIC_CYCLE', [cycle.sccId], {
      subjectIds: cycle.members,
      range: null,
      messageCode: 'STATIC_CYCLE',
      parameters: { size: cycle.members.length, policy: 'static-value', witness },
      evidenceIds: evidence,
      fingerprint: [cycle.sccId],
    });
  }

  // Size and complexity apply to parsed, non-declaration code.
  for (const file of files) {
    const facts = input.facts.get(file.path);
    if (!facts || facts.parseStatus !== 'parsed' || file.role === 'declaration') continue;
    const max = facts.complexity!.maxCyclomatic;
    if (max >= RULE_THRESHOLDS.complexCallable) {
      const callable = facts.callables.find((c) => c.complexity === max);
      const c = callable?.contributions;
      const breakdown = c ? (['if', 'loop', 'catch', 'conditional', 'case', 'logical'] as const).filter((k) => c[k] > 0).map((k) => `${c[k]} ${k}`).join(', ') : 'see source';
      emit('ATLAS_COMPLEX_CALLABLE', [file.id], {
        subjectIds: [file.id],
        range: callable?.range ?? null,
        messageCode: 'COMPLEX_CALLABLE',
        parameters: { callable: callable?.name ?? 'function', complexity: max, threshold: RULE_THRESHOLDS.complexCallable, breakdown: `1 base + ${breakdown}`, role: file.role },
        fingerprint: [lineageKey(file), callable?.name ?? null],
      });
    }
    if (file.role === 'source' && facts.codeLines !== null && facts.codeLines >= RULE_THRESHOLDS.largeSourceFileCodeLines) {
      emit('ATLAS_LARGE_SOURCE_FILE', [file.id], {
        subjectIds: [file.id],
        range: null,
        messageCode: 'LARGE_SOURCE_FILE',
        parameters: { codeLines: facts.codeLines, threshold: RULE_THRESHOLDS.largeSourceFileCodeLines },
        fingerprint: [lineageKey(file)],
      });
    }
  }

  // Fan-in outliers within the production-source cohort only.
  const cohort = files.filter((f) => f.role === 'source' && input.facts.get(f.path)?.parseStatus === 'parsed');
  const p95 = nearestRankPercentile(cohort.map((f) => metrics.get(f.id)?.fanIn ?? 0));
  if (p95 !== null) {
    for (const file of cohort) {
      const fanIn = metrics.get(file.id)?.fanIn ?? 0;
      if (fanIn < RULE_THRESHOLDS.highFanIn || fanIn < p95) continue;
      const consumers = index.fileNeighbors(file.id, 'incoming');
      const evidence = index.incoming(file.id, POLICIES.degree).flatMap((e) => e.evidenceIds.slice(0, 1));
      emit('ATLAS_HIGH_FAN_IN', [file.id], {
        subjectIds: [file.id, ...consumers],
        range: null,
        messageCode: 'HIGH_FAN_IN',
        parameters: { fanIn, threshold: RULE_THRESHOLDS.highFanIn, p95, cohort: cohort.length },
        evidenceIds: evidence,
        fingerprint: [lineageKey(file)],
      });
    }
  }

  for (const limit of input.limits) {
    emit('ATLAS_ANALYSIS_LIMIT', [limit.limit], {
      subjectIds: [repositoryId],
      range: null,
      messageCode: 'ANALYSIS_LIMIT',
      parameters: { limit: limit.limit, count: limit.count, stage: limit.stage },
      fingerprint: [limit.limit, limit.stage],
    });
  }

  out.sort((a, b) => compareAscii(a.id, b.id));
  const diagnostics = out.slice(0, LIMITS.diagnosticsPerFrame);
  return { diagnostics, omitted: out.length - diagnostics.length };
}

/** Deterministic order for display: severity, then rule, then subject path. */
export function displayOrder(index: GraphIndex): (a: Diagnostic, b: Diagnostic) => number {
  const rank = { error: 0, warning: 1, info: 2 } as const;
  return (a, b) => rank[a.severity] - rank[b.severity] || compareAscii(a.ruleId, b.ruleId) || compareUtf8(index.pathOf(a.subjectIds[0]!), index.pathOf(b.subjectIds[0]!));
}
