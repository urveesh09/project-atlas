import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openArtifactDirectory } from '@atlas/artifact/node';
import {
  importRuffSarif,
  parseQualityReport,
  qualityTarget,
  validateQualityReport,
  compareQualityReports,
  QualityImportError,
} from '@atlas/graph';
import { canonicalJson, QUALITY_LIMITS } from '@atlas/schema';
import { EXIT, UsageError, type CommandContext } from '../context.js';

/** Bounded descriptor read: do not stat one path and later read its replacement. */
async function readReport(file: string): Promise<string> {
  // A POSIX FIFO must not block open before the descriptor's regular-file check.
  const flags = process.platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NONBLOCK;
  const handle = await open(file, flags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > QUALITY_LIMITS.bytes)
      throw new QualityImportError('Report must be a regular file of at most 8 MiB.');
    const buffer = Buffer.alloc(QUALITY_LIMITS.bytes + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
      if (bytesRead === 0) break;
      used += bytesRead;
    }
    if (used > QUALITY_LIMITS.bytes) throw new QualityImportError('Report exceeds the 8 MiB limit.');
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, used));
    } catch {
      throw new QualityImportError('Report is not valid UTF-8.');
    }
  } finally {
    await handle.close();
  }
}

export async function findings(
  ctx: CommandContext,
  args: { report: string; artifact: string; commit: string; out: string; sourceRoot?: string; baseline?: string },
): Promise<number> {
  try {
    if (ctx.io.signal.aborted) return EXIT.cancelled;
    const artifactDirectory = await realpath(path.resolve(ctx.io.cwd, args.artifact));
    const requestedOutput = path.resolve(ctx.io.cwd, args.out);
    const output = path.join(await realpath(path.dirname(requestedOutput)), path.basename(requestedOutput));
    // Sidecars never enter the immutable artifact or its strict served file inventory.
    const relative = path.relative(artifactDirectory, output);
    if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)))
      throw new UsageError('--out must be outside the ATLAS artifact directory.');
    const opened = await openArtifactDirectory(artifactDirectory);
    if (!opened.ok) throw new QualityImportError('ATLAS artifact did not validate.');
    const artifact = opened.artifact;
    const index = artifact.manifest.frames.findIndex((f) => f.commit.oid === args.commit);
    if (index < 0) throw new UsageError('--commit must be the full ID of an analyzed snapshot.');
    const frame = await artifact.frame(index, ctx.io.signal);
    if (!frame.ok) throw new QualityImportError('Selected artifact snapshot did not validate.');
    const sourceRoot =
      args.sourceRoot === undefined
        ? undefined
        : pathToFileURL(path.resolve(ctx.io.cwd, args.sourceRoot) + path.sep).href;
    const target = qualityTarget(frame.graph, artifact.manifest.analysisId);
    const report = importRuffSarif(
      await readReport(path.resolve(ctx.io.cwd, args.report)),
      target,
      args.commit,
      sourceRoot,
    );
    let comparison: { newlyReported: number; noLongerReported: number; sameLocation: number } | null = null;
    if (args.baseline) {
      const baseline = parseQualityReport(await readReport(path.resolve(ctx.io.cwd, args.baseline)));
      const at = artifact.manifest.frames.findIndex((f) => f.snapshotId === baseline.snapshotId);
      if (at < 0) throw new QualityImportError('Baseline snapshot is not in this analysis.');
      const old = await artifact.frame(at, ctx.io.signal);
      if (!old.ok) throw new QualityImportError('Baseline snapshot did not validate.');
      validateQualityReport(baseline, qualityTarget(old.graph, artifact.manifest.analysisId));
      const compared = compareQualityReports(report, baseline);
      comparison = {
        newlyReported: compared.newlyReported.length,
        noLongerReported: compared.noLongerReported.length,
        sameLocation: compared.sameLocation.length,
      };
    }
    if (ctx.io.signal.aborted) return EXIT.cancelled;
    const bytes = canonicalJson(report) + '\n';
    if (Buffer.byteLength(bytes) > QUALITY_LIMITS.bytes)
      throw new QualityImportError('Normalized report exceeds the 8 MiB limit. Narrow the scan.');
    // Exclusive output: a failed import cannot truncate a previous report or follow its symlink.
    const handle = await open(output, 'wx', 0o600);
    try {
      await handle.writeFile(bytes, 'utf8');
    } finally {
      await handle.close();
    }
    const dropped = Object.values(report.dropped).reduce((a, n) => a + n, 0);
    if (ctx.json)
      ctx.print(
        JSON.stringify({
          ok: true,
          format: report.format,
          findings: report.findings.length,
          dropped: report.dropped,
          comparison,
          binding: report.binding,
          scanScope: report.scanScope,
        }),
      );
    else {
      ctx.print(
        `Imported ${report.findings.length} Ruff findings; ${dropped} records dropped (${report.dropped.duplicates} duplicates).`,
      );
      ctx.print(
        'Commit binding is user-declared. Scan scope and configuration are unverified; this is not a clean-scan verdict.',
      );
      if (comparison)
        ctx.print(
          `Exact locations: ${comparison.newlyReported} newly reported; ${comparison.noLongerReported} no longer reported; ${comparison.sameLocation} at the same location. Absence does not establish resolution.`,
        );
      ctx.print('Open the separate quality JSON through External findings in the viewer. Nothing was uploaded.');
    }
    return dropped - report.dropped.duplicates > 0 ? EXIT.partial : EXIT.ok;
  } catch (error) {
    if (error instanceof UsageError) throw error;
    // Filesystem/parser errors may contain a machine path or report text; never echo them.
    const message =
      error instanceof QualityImportError
        ? error.message
        : 'Quality report could not be read or written; check the files and choose a new output filename.';
    if (ctx.json) ctx.print(JSON.stringify({ ok: false, code: 'QUALITY_IMPORT_FAILED', message }));
    else ctx.note(message);
    return ctx.io.signal.aborted ? EXIT.cancelled : EXIT.failure;
  }
}
