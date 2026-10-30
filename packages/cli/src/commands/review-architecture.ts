import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { openArtifactDirectory } from '@atlas/artifact/node';
import { ARCHITECTURE_LIMITS, canonicalJson } from '@atlas/schema';
import { architectureExit, architectureMarkdown, architectureReasonLabel, parseArchitecturePolicy, reviewArchitecture, QualityImportError } from '@atlas/graph';
import { EXIT, UsageError, type CommandContext } from '../context.js';
import { readReport } from './findings.js';
export async function reviewArchitectureCommand(ctx: CommandContext, args: {
  artifact: string;
  policy: string;
  commit: string;
  out: string;
  baseline?: string;
  markdown: boolean;
  failOn?: 'new' | 'all';
}): Promise<number> {
  try {
    if (ctx.io.signal.aborted)
      return EXIT.cancelled;
    const at = (value: string) => path.resolve(ctx.io.cwd, value);
    const artifactDir = await realpath(at(args.artifact));
    const requested = at(args.out), output = path.join(await realpath(path.dirname(requested)), path.basename(requested));
    const relative = path.relative(artifactDir, output);
    if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)))
      throw new UsageError('--out must be outside the ATLAS artifact directory.');
    const policy = parseArchitecturePolicy(await readReport(at(args.policy), ARCHITECTURE_LIMITS.policyBytes));
    const opened = await openArtifactDirectory(artifactDir);
    if (!opened.ok)
      throw new QualityImportError('ATLAS artifact did not validate.');
    const artifact = opened.artifact, frames = artifact.manifest.frames;
    const currentAt = frames.findIndex(f => f.commit.oid === args.commit);
    const baselineAt = args.baseline ? frames.findIndex(f => f.commit.oid === args.baseline) : -1;
    if (currentAt < 0 || (args.baseline && (baselineAt < 0 || baselineAt >= currentAt)))
      throw new UsageError('Choose full commit IDs from this artifact, with an earlier baseline.');
    const current = await artifact.frame(currentAt, ctx.io.signal);
    const baseline = baselineAt < 0 ? null : await artifact.frame(baselineAt, ctx.io.signal);
    if (!current.ok || (baseline && !baseline.ok))
      throw new QualityImportError('Architecture review frames did not validate.');
    const report = reviewArchitecture(artifact.manifest.analysisId, current.graph, policy, baseline?.ok ? baseline.graph : null);
    const code = architectureExit(report, args.failOn);
    const text = args.markdown ? architectureMarkdown(report) : canonicalJson(report) + '\n';
    if (Buffer.byteLength(text) > ARCHITECTURE_LIMITS.reportBytes)
      throw new QualityImportError('Architecture output exceeds 8 MiB. Narrow the policy.');
    if (ctx.io.signal.aborted)
      return EXIT.cancelled;
    const handle = await open(output, 'wx', 0o600);
    try {
      await handle.writeFile(text, 'utf8');
    }
    finally {
      await handle.close();
    }
    const counts = { current: report.rules.reduce((n, r) => n + r.current, 0), newlyObserved: report.baseline ? report.rules.reduce((n, r) => n + (r.newlyObserved ?? 0), 0) : null, rowsOmitted: report.rowsOmitted };
    if (ctx.json)
      ctx.print(JSON.stringify({ ok: true, format: report.format, counts, reasons: report.reasons, policyBlocked: code === 3, scope: 'observed-internal-file-dependencies', artifactProvenance: 'not-authenticated', securityVerdict: 'not-established' }));
    else {
      ctx.print(`Architecture review: ${counts.current} rule matches; ${counts.newlyObserved ?? 'uncompared'} newly observed; ${counts.rowsOmitted} evidence rows omitted.`);
      ctx.print(report.reasons.length ? `Incomplete evidence: ${report.reasons.map(architectureReasonLabel).join('; ')}.` : 'Evaluation complete within the declared graph scope.');
      ctx.print('Observed internal file dependencies only. Artifact provenance is not authenticated; no runtime, security or merge-approval verdict follows.');
      if (code === 3)
        ctx.print('The explicitly selected architecture policy check blocks this evidence.');
    }
    return code;
  }
  catch (error) {
    if (error instanceof UsageError)
      throw error;
    if (ctx.io.signal.aborted)
      return EXIT.cancelled;
    const message = error instanceof QualityImportError ? error.message : 'Architecture review failed. Check the artifact, bounded policy and new output filename; existing outputs were not replaced.';
    if (ctx.json)
      ctx.print(JSON.stringify({ ok: false, code: 'ARCHITECTURE_REVIEW_FAILED', message }));
    else
      ctx.note(message);
    return EXIT.failure;
  }
}
