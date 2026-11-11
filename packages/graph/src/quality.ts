import {
  QUALITY_LIMITS,
  EslintRuleSchema,
  EslintToolSchema,
  QualityReportSchema,
  QualityRuleSchema,
  RepoPathSchema,
  RuffToolSchema,
  canonicalJson,
  compareUtf8,
  hashFields,
  repoExtension,
  utf8ByteLength,
  type GraphSnapshot,
  type QualityFinding,
  type QualityReport,
  type RuffQualityReport,
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
    if (finding.id !== findingId(report.tool.name, report.snapshotId, finding))
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

type QualityTool = QualityReport['tool'];
type LocatedFinding = Omit<QualityFinding, 'id'>;

function findingId(producer: QualityTool['name'], snapshotId: string, f: LocatedFinding): string {
  const domain = producer === 'ruff' ? 'atlas.quality.finding/1' : 'atlas.quality.eslint.finding/1';
  return `qf_${hashFields(domain, [snapshotId, f.nodeId, f.blobOid, f.ruleId, f.line, f.column, f.level])}`;
}

function supportsFile(producer: QualityTool['name'], path: string): boolean {
  return producer === 'ruff' ? /\.pyi?$/.test(path) : /^(?:\.d)?\.(?:[cm]?[jt]s|[jt]sx)$/.test(repoExtension(path));
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
      !supportsFile(report.tool.name, file.path) ||
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
): RuffQualityReport {
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
  const tool = RuffToolSchema.safeParse({ name: driver?.name, version: driver?.version });
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
  return collectReport(target, tool.data, results.length, ruffRecords(results, sourceRoot));
}

type ImportRecord =
  | 'unsupported'
  | 'suppressed'
  | {
      path: string | null;
      ruleId: string;
      level: QualityFinding['level'];
      line: unknown;
      column: unknown;
    };

function* ruffRecords(results: unknown[], sourceRoot?: string): Generator<ImportRecord> {
  for (const raw of results) {
    const r = object(raw);
    if (r?.suppressions !== undefined && !Array.isArray(r.suppressions)) {
      yield 'unsupported';
      continue;
    }
    if (Array.isArray(r?.suppressions) && r.suppressions.length) {
      yield 'suppressed';
      continue;
    }
    const rule = QualityRuleSchema.safeParse(r?.ruleId);
    const level = r?.level ?? 'warning';
    if (!r || !rule.success || (r.kind !== undefined && r.kind !== 'fail') ||
        (level !== 'error' && level !== 'warning' && level !== 'note')) {
      yield 'unsupported';
      continue;
    }
    const locations = r.locations;
    const physical =
      Array.isArray(locations) && locations.length === 1 ? object(object(locations[0])?.physicalLocation) : null;
    const location = object(physical?.artifactLocation),
      region = object(physical?.region);
    yield {
      path: location?.uriBaseId === undefined ? mappedPath(location?.uri, sourceRoot) : null,
      ruleId: rule.data,
      level,
      line: region?.startLine,
      column: region?.startColumn ?? null,
    };
  }
}

/** Compare reported paths as text, without resolving or inspecting a machine's filesystem. */
function absolutePathParts(value: string, root = false): string[] | null {
  if (value.length > 16_384 || !value.isWellFormed() || /[\x00-\x1f\x7f]/.test(value)) return null;
  const drive = /^[A-Za-z]:[/\\]/.test(value);
  if (!drive && (!value.startsWith('/') || value.includes('\\'))) return null;
  const parts = (drive ? value.replaceAll('\\', '/') : value).split('/');
  if (root && parts.at(-1) === '') parts.pop();
  if (parts.slice(1).some((p) => !p || p === '.' || p === '..' || (drive && p.includes(':')))) return null;
  parts[0] = parts[0]!.toLowerCase();
  return parts;
}

export function importEslintJson(
  text: string,
  target: QualityTarget,
  declaredCommit: string,
  version: string,
  sourceRoot: string,
): QualityReport {
  if (declaredCommit !== target.commitOid) fail('Declare the full commit ID of the selected analyzed snapshot.');
  const tool = EslintToolSchema.safeParse({ name: 'eslint', version });
  if (!tool.success) fail('Declare an ESLint release version such as 10.14.0.');
  const root = absolutePathParts(sourceRoot, true);
  if (!root) fail('ESLint source root must be an absolute local path.');
  const data = parse(text);
  if (!Array.isArray(data) || data.length > QUALITY_LIMITS.results)
    fail('Expected an ESLint JSON formatter array with at most 20,000 file records.');

  const records: ImportRecord[] = [];
  for (const raw of data) {
    const result = object(raw);
    if (!result || typeof result.filePath !== 'string' || !Array.isArray(result.messages) ||
        !Array.isArray(result.suppressedMessages))
      fail('Invalid ESLint JSON file record.');
    if (records.length + result.messages.length + result.suppressedMessages.length > QUALITY_LIMITS.results)
      fail('ESLint report exceeds the 20,000 result limit. Narrow the scan.');
    const parts = absolutePathParts(result.filePath);
    const relative = parts && root.every((segment, i) => segment === parts[i]) ? parts.slice(root.length).join('/') : null;
    const path = relative && RepoPathSchema.safeParse(relative).success ? relative : null;
    let errors = 0;
    let warnings = 0;
    let fatal = 0;
    for (const rawMessage of result.messages) {
      const message = object(rawMessage);
      if (message?.severity === 2) errors++;
      if (message?.severity === 1) warnings++;
      if (message?.fatal === true) fatal++;
      const rule = EslintRuleSchema.safeParse(message?.ruleId);
      if (!message || (message.fatal !== undefined && message.fatal !== false) || !rule.success ||
          (message.severity !== 1 && message.severity !== 2)) {
        records.push('unsupported');
        continue;
      }
      records.push({ path, ruleId: rule.data, level: message.severity === 2 ? 'error' : 'warning',
        line: message.line, column: message.column ?? null });
    }
    if (result.errorCount !== errors || result.warningCount !== warnings || result.fatalErrorCount !== fatal)
      fail('ESLint file counts do not match its reported messages.');
    for (let i = 0; i < result.suppressedMessages.length; i++) records.push('suppressed');
  }
  return collectReport(target, tool.data, records.length, records);
}

function position(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= QUALITY_LIMITS.position;
}

function collectReport<Tool extends QualityTool>(
  target: QualityTarget,
  tool: Tool,
  inputResults: number,
  records: Iterable<ImportRecord>,
): Omit<QualityReport, 'tool'> & { tool: Tool } {
  const files = new Map(target.files.map((f) => [f.path, f]));
  const dropped = { unmapped: 0, unsupported: 0, suppressed: 0, duplicates: 0 };
  const kept = new Map<string, LocatedFinding>();
  const rank = { note: 0, warning: 1, error: 2 };
  for (const record of records) {
    if (typeof record === 'string') {
      dropped[record]++;
      continue;
    }
    const file = record.path ? files.get(record.path) : undefined;
    if (!file || !supportsFile(tool.name, file.path)) {
      dropped.unmapped++;
      continue;
    }
    const { line, column, ruleId, level } = record;
    if (!position(line) || (file.lines !== null && line > file.lines) || (column !== null && !position(column))) {
      dropped.unsupported++;
      continue;
    }
    const f: LocatedFinding = {
      nodeId: file.nodeId,
      lineageId: file.lineageId,
      path: file.path,
      blobOid: file.blobOid,
      ruleId,
      level,
      line,
      column,
    };
    const key = hashFields('atlas.quality.location/1', [f.nodeId, f.ruleId, f.line, f.column]);
    const old = kept.get(key);
    if (old) {
      dropped.duplicates++;
      if (rank[f.level] > rank[old.level]) kept.set(key, f);
    } else {
      if (kept.size === QUALITY_LIMITS.findings) fail('Report exceeds the 4,096 finding limit. Narrow the scan.');
      kept.set(key, f);
    }
  }
  const report: Omit<QualityReport, 'tool'> & { tool: Tool } = {
    format: 'atlas.quality/1',
    analysisId: target.analysisId,
    repoId: target.repoId,
    snapshotId: target.snapshotId,
    commitOid: target.commitOid,
    binding: 'user-declared',
    scanScope: 'unverified',
    tool,
    inputResults,
    dropped,
    findings: [...kept.values()]
      .map((f) => ({ ...f, id: findingId(tool.name, target.snapshotId, f) }))
      .sort((a, b) => compareUtf8(a.id, b.id)),
  };
  validateQualityReport(parseQualityReport(canonicalJson(report)), target);
  return report;
}

/** Exact locations only. A moved line can be unmatched on BOTH sides; never call absence resolved. */
export function compareQualityReports(current: QualityReport, baseline: QualityReport) {
  if (
    current.analysisId !== baseline.analysisId ||
    current.repoId !== baseline.repoId ||
    current.tool.name !== baseline.tool.name ||
    current.tool.version !== baseline.tool.version
  )
    fail('Comparison needs the same analysis, producer and version.');
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
export function qualityRuleLabel(ruleId: string, producer: QualityTool['name'] = 'ruff'): string {
  if (producer === 'ruff' && ruleId === 'F401') return 'Unused import';
  if (producer === 'ruff' && ruleId === 'F821') return 'Undefined name';
  return 'Reported lint finding';
}
