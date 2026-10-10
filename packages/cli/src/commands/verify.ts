import path from 'node:path';
import { verifyArtifactDirectory } from '@atlas/artifact/node';
import { EXIT, type CommandContext } from '../context.js';
import { check, formatBytes, formatCount } from '../ui/format.js';
import { PALETTE } from '../ui/style.js';

/**
 * `atlas verify`: every chunk and every frame validated exactly as an eager import would,
 * decoding one frame at a time; nonzero exit for any corruption or invariant failure.
 */
export async function verify(ctx: CommandContext, args: { artifact: string }): Promise<number> {
  const dir = path.resolve(ctx.io.cwd, args.artifact);
  const result = await verifyArtifactDirectory(dir);
  const s = ctx.out;
  if (ctx.json) {
    ctx.print(
      JSON.stringify(
        result.ok
          ? { ok: true, stats: result.summary.stats, frames: result.summary.frames, analysisId: result.opened.manifest.analysisId }
          : { ok: false, code: result.code, issues: result.issues },
        null,
        2,
      ),
    );
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
  const { summary, opened } = result;
  const encodings = new Set(opened.manifest.frames.map((f) => f.graphChunk.encoding ?? 'plain'));
  const lines: [string, string][] = [
    ['manifest', `${opened.manifest.artifactVersion} · ${opened.manifest.schemaVersion}`],
    ['chunks', `${summary.stats.chunks} chunks · ${formatBytes(summary.stats.compressedBytes)} compressed · ${formatBytes(summary.stats.uncompressedBytes)} stored JSON`],
    ['integrity', 'lengths, SHA-256 and canonical form verified for every chunk and every reconstructed graph'],
    ['graphs', `${summary.frames} ${summary.frames === 1 ? 'frame' : 'frames'} · ${formatCount(summary.nodes)} nodes · ${formatCount(summary.edges)} edges · ${[...encodings].join(', ')}`],
    ['history', `${formatCount(opened.history.commits.length)} mainline commits · ${formatCount(opened.history.lineages.length)} lineages · ${opened.manifest.coverage.history.status}`],
    ['layout', `${formatCount(opened.layout.plots.length)} plots in ${formatCount(opened.layout.districts.length)} districts · contained, no overlaps`],
  ];
  for (const [label, detail] of lines) ctx.print(`  ${check(s, true)} ${s.fg(PALETTE.muted, label.padEnd(11))}${detail}`);
  ctx.print();
  ctx.print(`  ${s.fg(PALETTE.ok, 'Artifact is valid.')}`);
  ctx.print();
  return EXIT.ok;
}
