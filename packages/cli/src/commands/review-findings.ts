import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openArtifactDirectory } from '@atlas/artifact/node';
import {
  createFindingAnchors,
  createFindingReview,
  createReviewSide,
  findingReviewIsPartial,
  indexFindingContexts,
  parseScanEvidence,
  parseScanTrust,
  parseScanJson,
  parseReviewScanTrust,
  sameReviewProducerPolicy,
  qualityTarget,
  validateScanEvidence,
  QualityImportError,
  type ContextIndex,
  type QualityTarget,
} from '@atlas/graph';
import { openLocalRepository, readCommit, listTree, batchCheck, readObjects } from '@atlas/ingest';
import {
  canonicalJson,
  LIMITS,
  REVIEW_LIMITS,
  SCAN_LIMITS,
  compareUtf8,
  type FindingReview,
  type ReviewScanTrust,
} from '@atlas/schema';
import { EXIT, UsageError, type CommandContext } from '../context.js';
import { installedScanVerifier, scanSha256, verifyScanProvenance } from '../scan-verifier.js';
import { readReport } from './findings.js';

interface ReviewArguments {
  current: string;
  baseline: string;
  artifact: string;
  repo: string;
  out: string;
  currentProof?: string;
  baselineProof?: string;
  gh?: string;
}

async function verifyProof(
  ctx: CommandContext,
  text: string,
  commit: string,
  directory: string,
  executable: string,
): Promise<ReviewScanTrust> {
  const raw = await readReport(path.join(directory, 'trust.json'), SCAN_LIMITS.policyBytes);
  const value = parseScanJson(raw, SCAN_LIMITS.policyBytes);
  let trust: ReviewScanTrust;
  if (value && typeof value === 'object' && 'format' in value && value.format === 'atlas.review-scan-trust/1') {
    trust = parseReviewScanTrust(raw);
  } else {
    const policy = parseScanTrust(raw);
    // Direct scan mode retains ADR-086's equality. Historical mode is an explicit
    // independent policy with TWO pins; a report cannot opt itself into that mode.
    trust = { format: 'atlas.review-scan-trust/1', scanCommit: policy.sourceCommit, producer: policy };
  }
  if (trust.scanCommit !== commit) throw new QualityImportError('Proof policy target commit differs from the scan.');
  await verifyScanProvenance({
    evidence: text,
    policy: trust.producer,
    executable,
    bundle: await readReport(path.join(directory, 'bundle.jsonl'), SCAN_LIMITS.bytes, true),
    trustedRoot: await readReport(path.join(directory, 'trusted-root.jsonl'), SCAN_LIMITS.rootBytes, true),
    env: ctx.io.env,
    signal: ctx.io.signal,
  });
  return trust;
}

/** Committed source is local transient evidence, never included in the review output. */
async function committedContexts(
  ctx: CommandContext,
  repoPath: string,
  objectFormat: string,
  targets: readonly QualityTarget[],
  firstParents: readonly (string | null)[],
  requestedLineages: ReadonlySet<string>,
): Promise<Map<string, ContextIndex | null>> {
  const { git, repo } = await openLocalRepository(repoPath);
  try {
    if (repo.objectFormat !== objectFormat)
      throw new QualityImportError('Repository object format differs from the artifact.');
    const [baseline, current] = targets;
    const chain = await git.run(
      ['rev-list', '--first-parent', `--max-count=${LIMITS.firstParentCommits}`, current!.commitOid],
      { signal: ctx.io.signal, maxStdoutBytes: LIMITS.firstParentCommits * 66 },
    );
    if (!chain.stdout.toString('utf8').trim().split('\n').includes(baseline!.commitOid))
      throw new QualityImportError('Baseline is not in the current scan’s bounded first-parent history.');
    const sizes = new Map<string, number>();
    // Read finding files and their opposite-frame lineages, not every analyzed source blob.
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i]!,
        commit = await readCommit(git, target.commitOid, ctx.io.signal);
      if ((commit.parents[0] ?? null) !== firstParents[i])
        throw new QualityImportError('Commit parent differs from the artifact.');
      const tree = await listTree(git, commit.tree, {
        maxEntries: LIMITS.treeEntriesPerSnapshot,
        signal: ctx.io.signal,
      });
      if (tree.truncated) throw new QualityImportError('Committed tree exceeds its entry limit.');
      const entries = new Map(tree.entries.filter((e) => e.path !== null).map((e) => [e.path!, e]));
      for (const f of target.files) {
        const entry = entries.get(f.path);
        if (entry?.oid !== f.blobOid)
          throw new QualityImportError('Artifact file/blob inventory differs from its committed tree.');
        if (
          requestedLineages.has(f.lineageId) &&
          /\.pyi?$/.test(f.path) &&
          entry.kind === 'blob' &&
          entry.size !== null
        )
          sizes.set(f.blobOid, entry.size);
      }
    }
    const indexes = new Map<string, ContextIndex | null>(),
      selected: { oid: string; size: number }[] = [];
    let bytesRemaining = REVIEW_LIMITS.sourceBytes,
      windowsRemaining = REVIEW_LIMITS.contextWindows;
    for (const [oid, size] of [...sizes].sort(([a], [b]) => compareUtf8(a, b))) {
      if (size > REVIEW_LIMITS.blobBytes || size > bytesRemaining) {
        indexes.set(oid, null);
        continue;
      }
      bytesRemaining -= size;
      selected.push({ oid, size });
    }
    for (let offset = 0; offset < selected.length; ) {
      if (ctx.io.signal.aborted) throw new QualityImportError('Finding review cancelled.');
      const batch: { oid: string; size: number }[] = [];
      let bytes = 0;
      while (
        offset < selected.length &&
        batch.length < REVIEW_LIMITS.blobBatch &&
        bytes + selected[offset]!.size <= REVIEW_LIMITS.batchBytes
      ) {
        const item = selected[offset++]!;
        batch.push(item);
        bytes += item.size;
      }
      const infos = await batchCheck(
        git,
        batch.map((o) => o.oid),
        ctx.io.signal,
      );
      if (infos.some((info, i) => info.type !== 'blob' || info.size !== batch[i]!.size))
        throw new QualityImportError('Committed source blob is missing or inconsistent.');
      const objects = await readObjects(git, batch, ctx.io.signal);
      for (const { oid, size } of batch) {
        const object = objects.get(oid);
        if (!object || object.type !== 'blob' || object.bytes.length !== size)
          throw new QualityImportError('Committed source blob did not validate.');
        if (createHash(repo.objectFormat).update(`blob ${size}\0`).update(object.bytes).digest('hex') !== oid)
          throw new QualityImportError('Committed source bytes do not match their Git blob identity.');
        let index: ContextIndex | null;
        try {
          index = indexFindingContexts(
            new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(object.bytes),
            windowsRemaining,
          );
        } catch {
          index = null;
        }
        if (index) windowsRemaining -= index.contexts.length;
        indexes.set(oid, index);
      }
    }
    return indexes;
  } finally {
    await git.dispose();
  }
}

export async function reviewFindings(ctx: CommandContext, args: ReviewArguments): Promise<number> {
  try {
    if (ctx.io.signal.aborted) return EXIT.cancelled;
    const at = (file: string) => path.resolve(ctx.io.cwd, file);
    const artifactDir = await realpath(at(args.artifact)),
      requested = at(args.out);
    const output = path.join(await realpath(path.dirname(requested)), path.basename(requested));
    const relative = path.relative(artifactDir, output);
    if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)))
      throw new UsageError('--out must be outside the ATLAS artifact directory.');
    const currentText = await readReport(at(args.current), SCAN_LIMITS.bytes, true),
      baselineText = await readReport(at(args.baseline), SCAN_LIMITS.bytes, true);
    const current = parseScanEvidence(currentText),
      baseline = parseScanEvidence(baselineText);
    const opened = await openArtifactDirectory(artifactDir);
    if (!opened.ok) throw new QualityImportError('ATLAS artifact did not validate.');
    const frames = opened.artifact.manifest.frames;
    const currentAt = frames.findIndex((f) => f.snapshotId === current.report.snapshotId),
      baselineAt = frames.findIndex((f) => f.snapshotId === baseline.report.snapshotId);
    if (baselineAt < 0 || currentAt <= baselineAt)
      throw new QualityImportError('Choose an earlier baseline and a later current snapshot in this analysis.');
    const old = await opened.artifact.frame(baselineAt, ctx.io.signal),
      now = await opened.artifact.frame(currentAt, ctx.io.signal);
    if (!old.ok || !now.ok) throw new QualityImportError('Finding-review snapshots did not validate.');
    const oldTarget = qualityTarget(old.graph, opened.artifact.manifest.analysisId),
      nowTarget = qualityTarget(now.graph, opened.artifact.manifest.analysisId);
    validateScanEvidence(baseline, oldTarget);
    validateScanEvidence(current, nowTarget);
    const contexts = await committedContexts(
      ctx,
      at(args.repo),
      opened.artifact.manifest.repo.objectFormat,
      [oldTarget, nowTarget],
      [frames[baselineAt]!.commit.firstParentOid, frames[currentAt]!.commit.firstParentOid],
      new Set([...baseline.report.findings, ...current.report.findings].map((f) => f.lineageId)),
    );
    let declaredVerification: FindingReview['declaredVerification'] = 'unverified';
    let oldTrust: ReviewScanTrust | null = null,
      nowTrust: ReviewScanTrust | null = null;
    if (args.currentProof && args.baselineProof) {
      const executable = await installedScanVerifier(args.gh);
      oldTrust = await verifyProof(ctx, baselineText, baseline.report.commitOid, at(args.baselineProof), executable);
      nowTrust = await verifyProof(ctx, currentText, current.report.commitOid, at(args.currentProof), executable);
      declaredVerification = sameReviewProducerPolicy(oldTrust.producer, nowTrust.producer)
        ? 'same-producer-policy'
        : 'different-producer-policy';
    }
    const review = createFindingReview(
      createReviewSide(
        current,
        scanSha256(currentText),
        nowTarget,
        createFindingAnchors(current.report, nowTarget, oldTarget, contexts),
        nowTrust,
      ),
      createReviewSide(
        baseline,
        scanSha256(baselineText),
        oldTarget,
        createFindingAnchors(baseline.report, oldTarget, nowTarget, contexts),
        oldTrust,
      ),
      declaredVerification,
    );
    const text = canonicalJson(review) + '\n';
    if (Buffer.byteLength(text) > REVIEW_LIMITS.bytes)
      throw new QualityImportError('Finding review exceeds the 8 MiB output limit.');
    if (ctx.io.signal.aborted) return EXIT.cancelled;
    const handle = await open(output, 'wx', 0o600);
    try {
      await handle.writeFile(text, 'utf8');
    } finally {
      await handle.close();
    }
    const counts = {
      continuing: 0,
      'newly-reported': 0,
      'no-longer-reported': 0,
      'unmatched-current': 0,
      'unmatched-baseline': 0,
    };
    for (const issue of review.issues) counts[issue.state]++;
    if (ctx.json)
      ctx.print(
        JSON.stringify({
          ok: true,
          counts,
          reasons: review.reasons,
          provenanceVerifiedInThisProcess: declaredVerification !== 'unverified',
          cleanVerdict: 'not-established',
        }),
      );
    else {
      ctx.print(
        `Finding review: ${counts.continuing} continuing; ${counts['newly-reported']} newly reported; ${counts['no-longer-reported']} no longer reported; ${counts['unmatched-current'] + counts['unmatched-baseline']} unmatched.`,
      );
      ctx.print(
        declaredVerification === 'unverified'
          ? 'Scan provenance was not verified. Unmatched evidence stays uncertain.'
          : 'Both scan signatures verified against independently selected policies; execution and scope remain producer assertions.',
      );
      ctx.print(
        'Tracking follows bounded file lineage, exact context or unchanged blob locations. No result is labeled resolved or clean. The saved review is an unauthenticated declaration in the browser.',
      );
    }
    return findingReviewIsPartial(review) ? EXIT.partial : EXIT.ok;
  } catch (error) {
    if (error instanceof UsageError) throw error;
    if (ctx.io.signal.aborted) return EXIT.cancelled;
    const message =
      error instanceof QualityImportError
        ? error.message
        : 'Finding review failed. Check local committed objects and bounded inputs; no previous output was replaced.';
    if (ctx.json) ctx.print(JSON.stringify({ ok: false, code: 'FINDING_REVIEW_FAILED', message }));
    else ctx.note(message);
    return EXIT.failure;
  }
}
