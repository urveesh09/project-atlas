import path from 'node:path';
import { readArtifactDirectory, type LoadResult } from '@atlas/artifact/node';
import { RULE_CATALOG, compareAscii, compareUtf8, formatDiagnosticMessage, type ArtifactBundle, type GraphNode } from '@atlas/schema';
import { EXIT, type CommandContext } from '../context.js';
import { renderCityMap } from '../ui/city-map.js';
import { bar, box, check, formatBytes, formatCount, heading, plural, stackedBar, swatch, truncateMiddle, wrapText } from '../ui/format.js';
import { PALETTE, padEndVisible, type Styler } from '../ui/style.js';

/**
 * `atlas inspect` reads and fully validates an artifact, then reports it. Every number
 * comes from the validated chunks (never from summary.json, which is derived and optional).
 */
export interface InspectReport {
  repository: string;
  commit: string;
  committedAt: string;
  status: string;
  artifact: { version: string; schema: string; layout: string; compressedBytes: number; uncompressedBytes: number; chunks: number };
  files: { discovered: number; included: number; supported: number; opaque: number; excluded: number; omitted: number };
  roles: Record<string, number>;
  packages: { name: string | null; path: string; workspace: boolean; files: number; directories: number; declaredDependencies: number }[];
  externalPackages: string[];
  coverageReasons: { code: string; count: number }[];
  limitsHit: string[];
  warnings: { code: string; path: string | null }[];
  history: { status: string; framesCompleted: number };
  parse: { parsed: number; failed: number };
  imports: { observed: number; internal: number; external: number; builtin: number; unresolved: number; unsupported: number; excludedTargets: number };
  edges: number;
  findings: { ruleId: string; severity: string; title: string; message: string; path: string; line: number | null }[];
  mostComplex: { path: string; maxCyclomatic: number; codeLines: number | null }[];
  mostDependedOn: { path: string; fanIn: number }[];
}

export function buildInspectReport(bundle: ArtifactBundle, stats: Extract<LoadResult, { ok: true }>['stats']): InspectReport {
  const { manifest } = bundle;
  const graph = bundle.graphs.at(-1)!;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const packageOf = (node: GraphNode): string | null => {
    let current: GraphNode | undefined = node;
    while (current && current.kind !== 'package') current = current.parentId ? byId.get(current.parentId) : undefined;
    return current?.id ?? null;
  };
  const roles: Record<string, number> = {};
  const files = new Map<string, number>();
  const directories = new Map<string, number>();
  for (const node of graph.nodes) {
    if (node.kind === 'file') {
      roles[node.role] = (roles[node.role] ?? 0) + 1;
      const pkg = packageOf(node);
      if (pkg) files.set(pkg, (files.get(pkg) ?? 0) + 1);
    } else if (node.kind === 'directory') {
      const pkg = packageOf(node);
      if (pkg) directories.set(pkg, (directories.get(pkg) ?? 0) + 1);
    }
  }
  const declared = new Map<string, number>();
  for (const edge of graph.edges) if (edge.kind === 'declares-package') declared.set(edge.sourceId, (declared.get(edge.sourceId) ?? 0) + 1);
  const c = graph.coverage;
  const severityRank = { error: 0, warning: 1, info: 2 } as const;
  const pathOf = (id: string | undefined) => {
    const node = id ? byId.get(id) : undefined;
    return node && (node.kind === 'file' || node.kind === 'directory' || node.kind === 'package') ? node.path || '.' : (node?.label ?? '');
  };
  const fileMetrics = graph.metrics.flatMap((metric) => {
    const node = byId.get(metric.nodeId);
    return node?.kind === 'file' ? [{ path: node.path, metric }] : [];
  });
  return {
    repository: manifest.repo.displayName,
    commit: manifest.selectedCommit.oid,
    committedAt: manifest.selectedCommit.committerTime,
    status: manifest.frames.at(-1)!.analysisStatus,
    artifact: { version: manifest.artifactVersion, schema: manifest.schemaVersion, layout: bundle.layout.layoutVersion, ...stats },
    files: { discovered: c.discoveredFiles, included: c.includedFiles, supported: c.supportedFiles, opaque: c.opaqueFiles, excluded: c.excludedFiles, omitted: c.omittedFiles },
    roles,
    packages: graph.nodes
      .flatMap((n) => (n.kind === 'package' ? [{ name: n.packageName, path: n.path, workspace: n.workspace, files: files.get(n.id) ?? 0, directories: directories.get(n.id) ?? 0, declaredDependencies: declared.get(n.id) ?? 0 }] : []))
      .sort((a, b) => b.files - a.files || compareUtf8(a.path, b.path)),
    externalPackages: graph.nodes.flatMap((n) => (n.kind === 'external-package' ? [n.packageName] : [])).sort(compareUtf8),
    coverageReasons: c.reasons,
    limitsHit: c.limitsHit,
    warnings: c.warnings,
    history: { status: manifest.coverage.history.status, framesCompleted: manifest.coverage.history.framesCompleted },
    parse: { parsed: c.parsedFiles, failed: c.parseFailedFiles },
    imports: { observed: c.observedImports, internal: c.internalResolved, external: c.externalResolved, builtin: c.builtinResolved, unresolved: c.unresolved, unsupported: c.unsupported, excludedTargets: c.excludedTargets },
    edges: graph.edges.filter((e) => e.kind !== 'declares-package' && e.kind !== 'project-reference').length,
    findings: [...graph.diagnostics]
      .sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || compareAscii(a.ruleId, b.ruleId) || compareUtf8(pathOf(a.subjectIds[0]), pathOf(b.subjectIds[0])))
      .map((d) => ({ ruleId: d.ruleId, severity: d.severity, title: RULE_CATALOG[d.ruleId as keyof typeof RULE_CATALOG]?.title ?? d.ruleId, message: formatDiagnosticMessage(d), path: pathOf(d.subjectIds[0]), line: d.range?.startLine ?? null })),
    mostComplex: fileMetrics
      .filter((m) => (m.metric.maxCyclomatic ?? 0) > 0)
      .sort((a, b) => b.metric.maxCyclomatic! - a.metric.maxCyclomatic! || compareUtf8(a.path, b.path))
      .slice(0, 5)
      .map((m) => ({ path: m.path, maxCyclomatic: m.metric.maxCyclomatic!, codeLines: m.metric.codeLines })),
    mostDependedOn: fileMetrics
      .filter((m) => (m.metric.fanIn ?? 0) > 0)
      .sort((a, b) => b.metric.fanIn! - a.metric.fanIn! || compareUtf8(a.path, b.path))
      .slice(0, 5)
      .map((m) => ({ path: m.path, fanIn: m.metric.fanIn! })),
  };
}

const REASON_TEXT: Record<string, string> = {
  DEPENDENCY_DIRECTORY: 'dependency directories',
  BUILD_OUTPUT: 'build output',
  CACHE_DIRECTORY: 'caches',
  MINIFIED_BUNDLE: 'minified bundles',
  SOURCE_MAP: 'source maps',
  GENERATED_HEADER: 'generated files',
  REPOSITORY_EXCLUDED: 'atlas.config.json exclusions',
  CLI_EXCLUDED: '--exclude patterns',
  SYMLINK: 'symbolic links (never followed)',
  SUBMODULE: 'submodules (not fetched)',
  INVALID_UTF8_PATH: 'paths that are not valid UTF-8',
  FILE_LIMIT: 'omitted by the file limit',
  OVERSIZE: 'over the per-file size limit',
  BINARY_CONTENT: 'binary content in a code file',
  INVALID_ENCODING: 'not valid UTF-8',
  LFS_NOT_FETCHED: 'Git LFS pointers (content not fetched)',
  FLOW_UNSUPPORTED: 'Flow files (unsupported)',
  LANGUAGE_UNSUPPORTED: 'unsupported languages (Vue, Svelte, MDX…)',
  SOURCE_BUDGET: 'over the total source budget',
  LOCKFILE_STRUCTURAL: 'lockfiles (structure only)',
};

function describeReason(code: string): string {
  if (REASON_TEXT[code]) return REASON_TEXT[code]!;
  if (code.startsWith('INVALID_PATH_')) return `unsafe paths (${code.slice(13).toLowerCase().replaceAll('_', ' ')})`;
  return code.toLowerCase().replaceAll('_', ' ');
}

function render(ctx: CommandContext, report: InspectReport, bundle: ArtifactBundle, showMap: boolean): void {
  const s: Styler = ctx.out;
  const w = ctx.width;
  const statusText = report.status === 'complete' ? s.fg(PALETTE.ok, 'complete') : s.fg(PALETTE.warn, report.status);
  ctx.print();
  for (const line of box(
    s,
    [
      `${statusText} ${s.dim('·')} ${plural(report.files.included, 'file')} ${s.dim('·')} ${plural(report.packages.length, 'package')} ${s.dim('·')} ${plural(report.externalPackages.length, 'external dependency', 'external dependencies')}`,
      s.dim(`committed ${report.committedAt.slice(0, 10)} · ${formatBytes(report.artifact.compressedBytes)} on disk · ${formatBytes(report.artifact.uncompressedBytes)} canonical JSON · no source text`),
    ],
    { title: `${report.repository} ${s.fg(PALETTE.brand, `@ ${report.commit.slice(0, 7)}`)}`, tag: report.artifact.version, width: w - 2 },
  ))
    ctx.print(` ${line}`);

  if (showMap) {
    const map = renderCityMap(bundle, s, { maxWidth: w - 6, maxRows: 22 });
    ctx.print();
    ctx.print(`  ${heading(s, 'City plan')}  ${s.dim('top-down · every block is a district, every dot a file plot')}`);
    ctx.print();
    for (const line of map.lines) ctx.print(`   ${line}`);
    ctx.print();
    const legend = map.roles.map((r) => `${swatch(s, r.color)} ${r.role} ${s.dim(formatCount(r.count))}`).join('   ');
    ctx.print(`   ${legend}`);
    const districtLegend = map.districts.slice(0, 8).map((d, n) => `${s.level === 0 ? `[${n + 1}]` : s.bg(d.color, '  ')} ${truncateMiddle(d.label, 24)}`).join('  ');
    ctx.print(`   ${districtLegend}${map.districts.length > 8 ? s.dim(`  +${map.districts.length - 8} more`) : ''}`);
  }

  ctx.print();
  ctx.print(`  ${heading(s, 'Districts')}`);
  const maxFiles = Math.max(1, ...report.packages.map((p) => p.files));
  const nameWidth = Math.min(32, Math.max(12, ...report.packages.map((p) => (p.name ?? p.path).length + (p.path === '' ? 9 : 2))));
  for (const pkg of report.packages.slice(0, 12)) {
    // Truncate plain text first, then style: escapes must never be cut in half.
    const raw = truncateMiddle(pkg.path === '' ? `${pkg.name ?? report.repository} (root)` : (pkg.name ?? pkg.path), nameWidth);
    const name = raw.endsWith(' (root)') ? `${raw.slice(0, -7)} ${s.dim('(root)')}` : raw;
    const meta = s.dim(`${pkg.path || '.'} · ${plural(pkg.directories, 'folder')} · ${plural(pkg.declaredDependencies, 'dependency', 'dependencies')}`);
    ctx.print(`  ${padEndVisible(name, nameWidth)} ${String(pkg.files).padStart(6)}  ${padEndVisible(bar(s, pkg.files, maxFiles, 24, PALETTE.accent), 25)} ${meta}`);
  }
  if (report.packages.length > 12) ctx.print(s.dim(`  … ${report.packages.length - 12} more packages`));

  ctx.print();
  ctx.print(`  ${heading(s, 'Coverage')}`);
  const f = report.files;
  ctx.print(
    `  ${stackedBar(
      s,
      [
        { value: f.supported, color: PALETTE.roles['source']!, glyph: '#' },
        { value: f.opaque, color: PALETTE.roles['opaque']!, glyph: '+' },
        { value: f.excluded, color: PALETTE.road, glyph: '.' },
        { value: f.omitted, color: PALETTE.warn, glyph: '!' },
      ],
      Math.min(60, w - 8),
    )}`,
  );
  ctx.print(
    `  ${swatch(s, PALETTE.roles['source']!, '#')} ${formatCount(f.supported)} TS/JS  ${swatch(s, PALETTE.roles['opaque']!, '+')} ${formatCount(f.opaque)} other included  ${swatch(s, PALETTE.road, '.')} ${formatCount(f.excluded)} excluded  ${swatch(s, PALETTE.warn, '!')} ${formatCount(f.omitted)} omitted  ${s.dim(`of ${formatCount(f.discovered)} committed entries`)}`,
  );
  const roleLine = Object.entries(report.roles)
    .sort((a, b) => b[1] - a[1])
    .map(([role, n]) => `${swatch(s, PALETTE.roles[role] ?? PALETTE.muted)} ${role} ${s.dim(formatCount(n))}`)
    .join('   ');
  ctx.print(`  ${roleLine}`);

  if (report.coverageReasons.length > 0) {
    ctx.print();
    ctx.print(`  ${heading(s, 'Not analyzed, and why')}`);
    for (const reason of report.coverageReasons) {
      const tone = reason.code === 'FILE_LIMIT' || reason.code === 'SOURCE_BUDGET' ? PALETTE.warn : PALETTE.muted;
      ctx.print(`  ${s.fg(tone, formatCount(reason.count).padStart(7))}  ${describeReason(reason.code)} ${s.dim(reason.code)}`);
    }
  }
  const configWarnings = report.warnings.filter((w2) => !w2.code.startsWith('EXCLUDED_') && !REASON_TEXT[w2.code]);
  if (configWarnings.length > 0) {
    ctx.print();
    ctx.print(`  ${heading(s, 'Configuration notes')}`);
    for (const warning of configWarnings.slice(0, 10)) ctx.print(`  ${check(s, 'warn')} ${warning.code} ${s.dim(warning.path ?? '')}`);
    if (configWarnings.length > 10) ctx.print(s.dim(`  … ${configWarnings.length - 10} more (see --json)`));
  }

  ctx.print();
  ctx.print(`  ${heading(s, 'Dependencies')}  ${s.dim(`${formatCount(report.imports.observed)} import statements · ${formatCount(report.edges)} file edges`)}`);
  const im = report.imports;
  ctx.print(
    `  ${stackedBar(
      s,
      [
        { value: im.internal, color: PALETTE.accent, glyph: '#' },
        { value: im.external + im.builtin, color: PALETTE.roles['asset']!, glyph: '+' },
        { value: im.unresolved, color: PALETTE.warn, glyph: '?' },
        { value: im.unsupported + im.excludedTargets, color: PALETTE.muted, glyph: '.' },
      ],
      Math.min(60, w - 8),
    )}`,
  );
  ctx.print(
    `  ${swatch(s, PALETTE.accent, '#')} ${formatCount(im.internal)} internal  ${swatch(s, PALETTE.roles['asset']!, '+')} ${formatCount(im.external)} npm · ${formatCount(im.builtin)} node  ${swatch(s, PALETTE.warn, '?')} ${formatCount(im.unresolved)} unresolved  ${swatch(s, PALETTE.muted, '.')} ${formatCount(im.unsupported)} unsupported · ${formatCount(im.excludedTargets)} to excluded files`,
  );
  if (report.parse.failed > 0) ctx.print(`  ${check(s, 'warn')} ${s.fg(PALETTE.warn, `${plural(report.parse.failed, 'file')} could not be parsed`)} ${s.dim('— no dependency or complexity claims are made for them')}`);

  ctx.print();
  const counts = { error: 0, warning: 0, info: 0 } as Record<string, number>;
  for (const finding of report.findings) counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
  ctx.print(`  ${heading(s, 'Findings')}  ${s.dim(report.findings.length === 0 ? 'none under the default rules' : `${counts['error']} error · ${counts['warning']} warning · ${counts['info']} info`)}`);
  for (const finding of report.findings.slice(0, 12)) {
    const icon = finding.severity === 'error' ? s.fg(PALETTE.error, s.unicode ? '●' : 'E') : finding.severity === 'warning' ? s.fg(PALETTE.warn, s.unicode ? '▲' : 'W') : s.fg(PALETTE.accent, s.unicode ? '◆' : 'i');
    const where = `${finding.path}${finding.line ? `:${finding.line}` : ''}`;
    ctx.print(`  ${icon} ${s.bold(finding.title)} ${s.dim(truncateMiddle(where, 60))}`);
    for (const line of wrapText(finding.message, w - 8)) ctx.print(`    ${s.dim(line)}`);
  }
  if (report.findings.length > 12) ctx.print(s.dim(`  … ${report.findings.length - 12} more (atlas inspect --json)`));

  if (report.mostComplex.length > 0 || report.mostDependedOn.length > 0) {
    ctx.print();
    ctx.print(`  ${heading(s, 'Look closer')}  ${s.dim('raw metrics, repository-relative; not a quality score')}`);
    const left = report.mostComplex.map((m) => `${String(m.maxCyclomatic).padStart(4)}  ${truncateMiddle(m.path, 34)}`);
    const right = report.mostDependedOn.map((m) => `${String(m.fanIn).padStart(4)}  ${truncateMiddle(m.path, 34)}`);
    ctx.print(`  ${s.fg(PALETTE.muted, padEndVisible('max complexity', 42))}${s.fg(PALETTE.muted, 'direct consumers')}`);
    for (let i = 0; i < Math.max(left.length, right.length); i++) ctx.print(`  ${padEndVisible(left[i] ?? '', 42)}${right[i] ?? ''}`);
  }

  ctx.print();
  ctx.print(`  ${heading(s, 'Not yet in this artifact')}`);
  ctx.print(s.dim(`  Git history ${report.history.status} (P4) · 3D city viewer (P3) · browse this artifact now with: atlas serve <artifact>`));
  if (report.externalPackages.length > 0) {
    ctx.print();
    ctx.print(`  ${heading(s, 'Declared external packages')}`);
    ctx.print(`  ${s.dim(truncateMiddle(report.externalPackages.join(', '), (w - 4) * 2))}`);
  }
  ctx.print();
}

export async function inspect(ctx: CommandContext, args: { artifact: string; map: boolean }): Promise<number> {
  const dir = path.resolve(ctx.io.cwd, args.artifact);
  const loaded = await readArtifactDirectory(dir);
  if (!loaded.ok) {
    if (ctx.json) ctx.print(JSON.stringify({ ok: false, code: loaded.code, issues: loaded.issues }, null, 2));
    else {
      ctx.note(`  ${check(ctx.err, false)} ${loaded.code}: the artifact did not validate. Run atlas verify for details.`);
    }
    return EXIT.failure;
  }
  const report = buildInspectReport(loaded.bundle, loaded.stats);
  if (ctx.json) ctx.print(JSON.stringify(report, null, 2));
  else render(ctx, report, loaded.bundle, args.map);
  return EXIT.ok;
}
