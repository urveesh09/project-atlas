import {
  QUALITY_LIMITS,
  QualityReportSchema,
  QualityRuleSchema,
  RepoPathSchema,
  canonicalJson,
  compareUtf8,
  hashFields,
  utf8ByteLength,
  type GraphSnapshot,
  type QualityFinding,
  type QualityReport,
} from '@atlas/schema';

/** Narrow, serializable view of an already validated ATLAS frame. */
export interface QualityTarget {
  analysisId: string;
  repoId: string;
  snapshotId: string;
  commitOid: string;
  files: { nodeId: string; lineageId: string; path: string; blobOid: string; lines: number | null }[];
}

export class QualityImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QualityImportError';
  }
}
function fail(message: string): never {
  throw new QualityImportError(message);
}
const object = (x: unknown): Record<string, unknown> | null =>
  x !== null && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null;

export function qualityTarget(graph: GraphSnapshot, analysisId: string): QualityTarget {
  const metrics = new Map(graph.metrics.map((m) => [m.nodeId, m]));
  return {
    analysisId,
    repoId: graph.repoId,
    snapshotId: graph.snapshotId,
    commitOid: graph.commitOid,
    files: graph.nodes.flatMap((n) =>
      n.kind === 'file' && n.lineageId
        ? [
            {
              nodeId: n.id,
              lineageId: n.lineageId,
              path: n.path,
              blobOid: n.blobOid,
              lines: metrics.get(n.id)?.physicalLines ?? null,
            },
          ]
        : [],
    ),
  };
}

/** Errors are controlled text: never echo report content, URIs or parser messages. */
function parse(text: string): unknown {
  if (!text.isWellFormed() || utf8ByteLength(text) > QUALITY_LIMITS.bytes)
    fail('Report exceeds the 8 MiB limit or is not valid Unicode.');
  try {
    return JSON.parse(text);
  } catch {
    return fail('Report is not valid JSON.');
  }
}
export function parseQualityReport(text: string): QualityReport {
  const parsed = QualityReportSchema.safeParse(parse(text));
  if (!parsed.success) fail('Invalid or unsupported ATLAS quality report.');
  const report = parsed.data;
  const total = report.findings.length + Object.values(report.dropped).reduce((a, n) => a + n, 0);
  if (total !== report.inputResults) fail('Quality report counts do not reconcile.');
  let previous = '';
  const locations = new Set<string>();
  for (const finding of report.findings) {
    if (previous && compareUtf8(previous, finding.id) >= 0) fail('Quality findings must be unique and sorted.');
    if (finding.id !== findingId(report.snapshotId, finding))
      fail('Quality finding identity does not match its evidence.');
    const location = hashFields('atlas.quality.location/1', [
      finding.nodeId,
      finding.ruleId,
      finding.line,
      finding.column,
    ]);
    if (locations.has(location)) fail('Quality finding locations must be unique.');
    locations.add(location);
    previous = finding.id;
  }
  return report;
}

function findingId(snapshotId: string, f: Omit<QualityFinding, 'id'>): string {
  return `qf_${hashFields('atlas.quality.finding/1', [snapshotId, f.nodeId, f.blobOid, f.ruleId, f.line, f.column, f.level])}`;
}

/** Reference checks happen on every opening, not just when the sidecar is written. */
export function validateQualityReport(report: QualityReport, target: QualityTarget): void {
  for (const key of ['analysisId', 'repoId', 'snapshotId', 'commitOid'] as const)
    if (report[key] !== target[key]) fail('Quality report belongs to a different analysis or snapshot.');
  const files = new Map(target.files.map((f) => [f.nodeId, f]));
  for (const f of report.findings) {
    const file = files.get(f.nodeId);
    if (
      !file ||
      !/\.pyi?$/.test(file.path) ||
      file.path !== f.path ||
      file.lineageId !== f.lineageId ||
      file.blobOid !== f.blobOid ||
      (file.lines !== null && f.line > file.lines)
    )
      fail('Quality finding does not match a file and line in this snapshot.');
  }
}

/** URI resolution is purely textual. No host paths, files, URL requests or base-name guessing. */
function mappedPath(uri: unknown, sourceRoot: string | undefined): string | null {
  if (typeof uri !== 'string' || uri.length > 16_384 || /[\x00-\x20\x7f\\?#]/.test(uri) || /%2f|%5c/i.test(uri))
    return null;
  let relative = uri;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(uri)) {
    if (!sourceRoot) return null;
    let full: URL, root: URL;
    try {
      full = new URL(uri);
      root = new URL(sourceRoot);
    } catch {
      return null;
    }
    if (
      full.protocol !== 'file:' ||
      root.protocol !== 'file:' ||
      full.host ||
      root.host ||
      full.search ||
      root.search ||
      full.hash ||
      root.hash
    )
      return null;
    const prefix = root.pathname.endsWith('/') ? root.pathname : `${root.pathname}/`;
    // Reject dot segments BEFORE URL normalization, including percent-encoded dots.
    try {
      if (
        decodeURIComponent(uri)
          .split('/')
          .some((p) => p === '.' || p === '..')
      )
        return null;
    } catch {
      return null;
    }
    if (!full.pathname.startsWith(prefix)) return null;
    relative = full.pathname.slice(prefix.length);
  } else if (uri.startsWith('/') || uri.includes(':')) return null;
  try {
    relative = decodeURIComponent(relative);
  } catch {
    return null;
  }
  if (relative.startsWith('./')) relative = relative.slice(2);
  return RepoPathSchema.safeParse(relative).success ? relative : null;
}

export function importRuffSarif(
  text: string,
  target: QualityTarget,
  declaredCommit: string,
  sourceRoot?: string,
): QualityReport {
  if (declaredCommit !== target.commitOid) fail('Declare the full commit ID of the selected analyzed snapshot.');
  if (sourceRoot !== undefined) {
    try {
      const root = new URL(sourceRoot);
      if (root.protocol !== 'file:' || root.host || root.search || root.hash)
        fail('Source root must be a local file URI.');
    } catch {
      fail('Source root must be a local file URI.');
    }
  }
  const data = object(parse(text));
  const runs = data?.runs;
  if (data?.version !== '2.1.0' || !Array.isArray(runs) || runs.length !== 1)
    fail('Only one-run Ruff SARIF 2.1.0 reports are supported.');
  const run = object(runs[0]),
    driver = object(object(run?.tool)?.driver);
  const results = run?.results;
  const tool = QualityReportSchema.shape.tool.safeParse({ name: driver?.name, version: driver?.version });
  if (!tool.success || !Array.isArray(results) || results.length > QUALITY_LIMITS.results)
    fail('Ruff version and at most 20,000 result records are required.');
  // Explicit producer failures cannot masquerade as a usable report. Ruff currently omits invocation records.
  if (
    run?.invocations !== undefined &&
    (!Array.isArray(run.invocations) ||
      !run.invocations.length ||
      run.invocations.some((i) => object(i)?.executionSuccessful !== true))
  )
    fail('The producer did not report a successful invocation.');
  if (run?.versionControlProvenance !== undefined) {
    const vcs = run.versionControlProvenance;
    if (!Array.isArray(vcs) || vcs.length !== 1 || object(vcs[0])?.revisionId !== declaredCommit)
      fail('Producer revision conflicts with the declared commit.');
  }
  const files = new Map(target.files.map((f) => [f.path, f]));
  const dropped = { unmapped: 0, unsupported: 0, suppressed: 0, duplicates: 0 };
  const kept = new Map<string, Omit<QualityFinding, 'id'>>();
  for (const raw of results) {
    const r = object(raw);
    if (r?.suppressions !== undefined && !Array.isArray(r.suppressions)) {
      dropped.unsupported++;
      continue;
    }
    if (Array.isArray(r?.suppressions) && r.suppressions.length) {
      dropped.suppressed++;
      continue;
    }
    if (
      !r ||
      !QualityRuleSchema.safeParse(r.ruleId).success ||
      (r.kind !== undefined && r.kind !== 'fail') ||
      !['error', 'warning', 'note'].includes(String(r.level ?? 'warning'))
    ) {
      dropped.unsupported++;
      continue;
    }
    const locations = r.locations;
    const physical =
      Array.isArray(locations) && locations.length === 1 ? object(object(locations[0])?.physicalLocation) : null;
    const location = object(physical?.artifactLocation),
      region = object(physical?.region);
    const filePath = location?.uriBaseId === undefined ? mappedPath(location?.uri, sourceRoot) : null;
    const file = filePath ? files.get(filePath) : undefined;
    if (!file || !/\.pyi?$/.test(file.path)) {
      dropped.unmapped++;
      continue;
    }
    const line = region?.startLine,
      column = region?.startColumn ?? null;
    if (
      !Number.isSafeInteger(line) ||
      Number(line) < 1 ||
      Number(line) > QUALITY_LIMITS.position ||
      (file.lines !== null && Number(line) > file.lines) ||
      (column !== null &&
        (!Number.isSafeInteger(column) || Number(column) < 1 || Number(column) > QUALITY_LIMITS.position))
    ) {
      dropped.unsupported++;
      continue;
    }
    const f: Omit<QualityFinding, 'id'> = {
      nodeId: file.nodeId,
      lineageId: file.lineageId,
      path: file.path,
      blobOid: file.blobOid,
      ruleId: r.ruleId as string,
      level: (r.level ?? 'warning') as QualityFinding['level'],
      line: Number(line),
      column: column as number | null,
    };
    const key = hashFields('atlas.quality.location/1', [f.nodeId, f.ruleId, f.line, f.column]);
    const old = kept.get(key);
    if (old) {
      dropped.duplicates++;
      const rank = { note: 0, warning: 1, error: 2 };
      if (rank[f.level] > rank[old.level]) kept.set(key, f);
    } else {
      if (kept.size === QUALITY_LIMITS.findings) fail('Report exceeds the 4,096 finding limit. Narrow the scan.');
      kept.set(key, f);
    }
  }
  const report: QualityReport = {
    format: 'atlas.quality/1',
    analysisId: target.analysisId,
    repoId: target.repoId,
    snapshotId: target.snapshotId,
    commitOid: target.commitOid,
    binding: 'user-declared',
    scanScope: 'unverified',
    tool: tool.data,
    inputResults: results.length,
    dropped,
    findings: [...kept.values()]
      .map((f) => ({ ...f, id: findingId(target.snapshotId, f) }))
      .sort((a, b) => compareUtf8(a.id, b.id)),
  };
  const checked = parseQualityReport(canonicalJson(report));
  validateQualityReport(checked, target);
  return checked;
}

/** Exact locations only. A moved line can be unmatched on BOTH sides; never call absence resolved. */
export function compareQualityReports(current: QualityReport, baseline: QualityReport) {
  if (
    current.analysisId !== baseline.analysisId ||
    current.repoId !== baseline.repoId ||
    current.tool.version !== baseline.tool.version
  )
    fail('Comparison needs the same analysis and Ruff version.');
  const key = (f: QualityFinding) => hashFields('atlas.quality.compare/1', [f.lineageId, f.ruleId, f.line, f.column]);
  const now = new Set(current.findings.map(key)),
    before = new Set(baseline.findings.map(key));
  return {
    newlyReported: current.findings.filter((f) => !before.has(key(f))),
    noLongerReported: baseline.findings.filter((f) => !now.has(key(f))),
    sameLocation: current.findings.filter((f) => before.has(key(f))),
  };
}

/** Controlled labels: never render a producer's message, rule help, fixes or source snippets. */
export function qualityRuleLabel(ruleId: string): string {
  return (
    ({ F401: 'Unused import', F821: 'Undefined name' } as Record<string, string>)[ruleId] ?? 'Reported lint finding'
  );
}
