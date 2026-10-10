import path from 'node:path';
import { readArtifactDirectory } from '@atlas/artifact/node';
import { EXIT, type CommandContext } from '../context.js';
import { check, formatBytes, formatCount } from '../ui/format.js';
import { PALETTE } from '../ui/style.js';

/** `atlas verify`: full bounded import; nonzero exit for any corruption or invariant failure. */
export async function verify(ctx: CommandContext, args: { artifact: string }): Promise<number> {
  const dir = path.resolve(ctx.io.cwd, args.artifact);
  const result = await readArtifactDirectory(dir);
  const s = ctx.out;
  if (ctx.json) {
    ctx.print(JSON.stringify(result.ok ? { ok: true, stats: result.stats, analysisId: result.bundle.manifest.analysisId } : { ok: false, code: result.code, issues: result.issues }, null, 2));
    return result.ok ? EXIT.ok : EXIT.failure;
  }
  ctx.print();
  if (!result.ok) {
    ctx.print(`  ${check(s, false)} ${s.bold(result.code)} ${s.dim(path.relative(ctx.io.cwd, dir) || '.')}`);
    for (const issue of result.issues.slice(0, 20)) ctx.print(`    ${s.fg(PALETTE.error, issue.code.padEnd(18))}${issue.path}  ${s.dim(issue.message)}`);
    if (result.issues.length > 20) ctx.print(s.dim(`    … ${result.issues.length - 20} more`));
    ctx.print();
    return EXIT.failure;
  }
  const { bundle, stats } = result;
  const graphs = bundle.graphs;
  const nodes = graphs.reduce((a, g) => a + g.nodes.length, 0);
  const edges = graphs.reduce((a, g) => a + g.edges.length, 0);
  const lines: [string, string][] = [
    ['manifest', `${bundle.manifest.artifactVersion} · ${bundle.manifest.schemaVersion}`],
    ['chunks', `${stats.chunks} chunks · ${formatBytes(stats.compressedBytes)} compressed · ${formatBytes(stats.uncompressedBytes)} canonical JSON`],
    ['integrity', 'lengths, SHA-256 and canonical form verified for every chunk'],
    ['graph', `${graphs.length} frame · ${formatCount(nodes)} nodes · ${formatCount(edges)} edges · IDs re-derived`],
    ['history', `${formatCount(bundle.history.lineages.length)} lineages · ${bundle.manifest.coverage.history.status}`],
    ['layout', `${formatCount(bundle.layout.plots.length)} plots in ${formatCount(bundle.layout.districts.length)} districts · contained, no overlaps`],
  ];
  for (const [label, detail] of lines) ctx.print(`  ${check(s, true)} ${s.fg(PALETTE.muted, label.padEnd(11))}${detail}`);
  ctx.print();
  ctx.print(`  ${s.fg(PALETTE.ok, 'Artifact is valid.')}`);
  ctx.print();
  return EXIT.ok;
}
