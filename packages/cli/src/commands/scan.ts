import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { openArtifactDirectory } from '@atlas/artifact/node';
import {
  createScanEvidence,
  parseScanJson,
  parseScanEvidence,
  parseScanTrust,
  parseQualityReport,
  qualityTarget,
  validateScanEvidence,
  QualityImportError,
  type QualityTarget,
} from '@atlas/graph';
import { SCAN_LIMITS, canonicalJson } from '@atlas/schema';
import { EXIT, UsageError, type CommandContext } from '../context.js';
import { installedScanVerifier, verifyScanProvenance, scanSha256 } from '../scan-verifier.js';
import { readReport } from './findings.js';

async function targetAt(artifactDir: string, commit: string, ctx: CommandContext): Promise<QualityTarget> {
  const opened = await openArtifactDirectory(artifactDir);
  if (!opened.ok) throw new QualityImportError('ATLAS artifact did not validate.');
  const index = opened.artifact.manifest.frames.findIndex((f) => f.commit.oid === commit);
  if (index < 0) throw new QualityImportError('Scan commit is not an analyzed snapshot.');
  const frame = await opened.artifact.frame(index, ctx.io.signal);
  if (!frame.ok) throw new QualityImportError('Scan snapshot did not validate.');
  return qualityTarget(frame.graph, opened.artifact.manifest.analysisId);
}
function failure(ctx: CommandContext, error: unknown): number {
  if (ctx.io.signal.aborted) return EXIT.cancelled;
  const message =
    error instanceof QualityImportError
      ? error.message
      : 'Scan operation failed. Check the bounded input files and trusted verifier; no previous output was replaced.';
  if (ctx.json) ctx.print(JSON.stringify({ ok: false, code: 'SCAN_EVIDENCE_FAILED', message }));
  else ctx.note(message);
  return EXIT.failure;
}
export async function scanEvidence(
  ctx: CommandContext,
  args: { quality: string; artifact: string; profile: string; scope: string; exitCode: number; out: string },
): Promise<number> {
  try {
    if (ctx.io.signal.aborted) return EXIT.cancelled;
    const at = (file: string) => path.resolve(ctx.io.cwd, file);
    const artifact = await realpath(at(args.artifact));
    const requested = at(args.out),
      output = path.join(await realpath(path.dirname(requested)), path.basename(requested));
    const relative = path.relative(artifact, output);
    if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)))
      throw new UsageError('--out must be outside the ATLAS artifact directory.');
    const report = parseQualityReport(await readReport(at(args.quality)));
    const target = await targetAt(artifact, report.commitOid, ctx);
    const evidence = createScanEvidence(
      report,
      parseScanJson(await readReport(at(args.profile), SCAN_LIMITS.policyBytes)),
      parseScanJson(await readReport(at(args.scope))),
      args.exitCode,
      target,
    );
    const coverage = validateScanEvidence(evidence, target);
    const text = canonicalJson(evidence) + '\n';
    if (Buffer.byteLength(text) > SCAN_LIMITS.bytes)
      throw new QualityImportError('Scan evidence exceeds the 8 MiB limit.');
    if (ctx.io.signal.aborted) return EXIT.cancelled;
    const handle = await open(output, 'wx', 0o600);
    try {
      await handle.writeFile(text, 'utf8');
    } finally {
      await handle.close();
    }
    if (ctx.json)
      ctx.print(JSON.stringify({ ok: true, provenance: 'unverified', execution: 'producer-asserted', ...coverage }));
    else
      ctx.print(
        `Scan evidence created. ${coverage.declaredScannedFiles} of ${coverage.analyzedPythonFiles} analyzed Python files declared; provenance is unverified. No scanner ran and nothing was uploaded.`,
      );
    return coverage.scopeMatchesAnalysis ? EXIT.ok : EXIT.partial;
  } catch (error) {
    if (error instanceof UsageError) throw error;
    return failure(ctx, error);
  }
}
export async function verifyScan(
  ctx: CommandContext,
  args: { evidence: string; artifact: string; bundle: string; policy: string; trustedRoot: string; gh?: string },
): Promise<number> {
  try {
    if (ctx.io.signal.aborted) return EXIT.cancelled;
    const at = (file: string) => path.resolve(ctx.io.cwd, file);
    const text = await readReport(at(args.evidence), SCAN_LIMITS.bytes, true);
    const evidence = parseScanEvidence(text);
    const policy = parseScanTrust(await readReport(at(args.policy), SCAN_LIMITS.policyBytes));
    if (policy.sourceCommit !== evidence.report.commitOid)
      throw new QualityImportError('Trust policy source commit differs from the scan commit.');
    const coverage = validateScanEvidence(evidence, await targetAt(at(args.artifact), evidence.report.commitOid, ctx));
    const bundle = await readReport(at(args.bundle), SCAN_LIMITS.bytes, true),
      trustedRoot = await readReport(at(args.trustedRoot), SCAN_LIMITS.rootBytes, true);
    await verifyScanProvenance({
      evidence: text,
      bundle,
      trustedRoot,
      policy,
      executable: await installedScanVerifier(args.gh),
      signal: ctx.io.signal,
      env: ctx.io.env,
    });
    if (ctx.json)
      ctx.print(
        JSON.stringify({
          ok: true,
          provenance: 'github-actions-verified',
          execution: 'producer-asserted',
          evidenceSha256: scanSha256(text),
          sourceCommit: evidence.report.commitOid,
          profileSha256: evidence.profileSha256,
          ruffVersion: evidence.report.tool.version,
          signer: { repository: policy.repository, workflow: policy.workflow, commit: policy.workflowCommit },
          findings: evidence.report.findings.length,
          ...coverage,
          cleanVerdict: 'not-established',
        }),
      );
    else {
      ctx.print('GitHub Actions provenance verified against the selected immutable workflow/source policy.');
      ctx.print(
        `${coverage.declaredScannedFiles} of ${coverage.analyzedPythonFiles} analyzed Python files declared; ${evidence.report.findings.length} findings retained.`,
      );
      ctx.print(
        'Execution and scope are producer assertions. This does not establish a clean scan, issue resolution or a merge verdict. No reusable browser trust receipt is created.',
      );
    }
    return coverage.scopeMatchesAnalysis ? EXIT.ok : EXIT.partial;
  } catch (error) {
    return failure(ctx, error);
  }
}
