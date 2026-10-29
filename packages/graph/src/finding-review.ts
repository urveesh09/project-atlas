import {
  FindingReviewSchema,
  ReviewScanTrustSchema,
  SCAN_LIMITS,
  REVIEW_LIMITS,
  canonicalJson,
  canonicalJsonSha256,
  compareUtf8,
  hashFields,
  utf8ByteLength,
  type FindingAnchor,
  type FindingReview,
  type QualityFinding,
  type ReviewIssue,
  type ReviewReason,
  type ReviewSide,
  type ScanEvidence,
  type ScanTrustPolicy,
  type ReviewScanTrust,
} from '@atlas/schema';
import { parseQualityReport, validateQualityReport, QualityImportError, type QualityTarget } from './quality.js';
import { parseScanJson, validateScanEvidence } from './scan.js';

function fail(message: string): never {
  throw new QualityImportError(message);
}
export interface ContextIndex {
  contexts: (string | null)[];
  counts: Map<string, number>;
  lineBytes: number[];
}

/** No normalization of indentation, identifiers, strings or Unicode. No text escapes this index. */
export function indexFindingContexts(text: string, windowsRemaining: number): ContextIndex | null {
  if (!text.isWellFormed() || utf8ByteLength(text) > REVIEW_LIMITS.blobBytes) return null;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length > windowsRemaining) return null;
  const contexts: (string | null)[] = [],
    counts = new Map<string, number>(),
    lineBytes = lines.map(utf8ByteLength);
  for (let i = 0; i < lines.length; i++) {
    const from = Math.max(0, i - 2),
      to = Math.min(lines.length, i + 3);
    const window = lines.slice(from, to);
    if (window.reduce((n, line) => n + utf8ByteLength(line), 0) > REVIEW_LIMITS.contextBytes) {
      contexts.push(null);
      continue;
    }
    const digest = hashFields('atlas.finding.context/1', [i - from, to - i - 1, ...window]);
    contexts.push(digest);
    counts.set(digest, Math.min(2, (counts.get(digest) ?? 0) + 1));
  }
  return { contexts, counts, lineBytes };
}

/** Caller supplies only bounded committed blobs, after verifying the frame's Git tree. */
export function createFindingAnchors(
  report: ReviewSide['report'],
  target: QualityTarget,
  opposite: QualityTarget,
  indexes: ReadonlyMap<string, ContextIndex | null>,
): FindingAnchor[] {
  validateQualityReport(report, target);
  const otherFiles = new Map(opposite.files.filter((f) => /\.pyi?$/.test(f.path)).map((f) => [f.lineageId, f]));
  return report.findings.map((f): FindingAnchor => {
    const index = indexes.get(f.blobOid),
      context = index?.contexts[f.line - 1] ?? null;
    // UTF-8 byte width is a conservative upper bound for both code-point and UTF-16
    // SARIF columns. Reject impossible positions without guessing the producer's units.
    if (index && (f.line > index.contexts.length || (f.column !== null && f.column > index.lineBytes[f.line - 1]! + 1)))
      fail('Finding position exceeds its committed source line.');
    const basis: FindingAnchor['basis'] =
      f.column === null
        ? 'unknown-column'
        : !index
          ? 'source-unavailable'
          : !context
            ? 'context-unavailable'
            : index.counts.get(context) !== 1
              ? 'repeated-context'
              : 'unique-context';
    const other = otherFiles.get(f.lineageId),
      otherIndex = other ? indexes.get(other.blobOid) : null;
    const count = context ? (otherIndex?.counts.get(context) ?? 0) : 0;
    const counterpart: FindingAnchor['counterpart'] = !other
      ? 'file-not-in-scope'
      : basis === 'unique-context' && otherIndex
        ? count === 1
          ? 'unique-context'
          : count > 1
            ? 'repeated-context'
            : 'changed-context'
        : other.blobOid === f.blobOid
          ? 'same-blob'
          : !otherIndex
            ? 'source-unavailable'
            : basis === 'repeated-context'
              ? 'repeated-context'
              : 'changed-context';
    return { findingId: f.id, contextSha256: basis === 'unique-context' ? context : null, basis, counterpart };
  });
}

export function createReviewSide(
  scan: ScanEvidence,
  scanSha256: string,
  target: QualityTarget,
  anchors: FindingAnchor[],
  declaredTrust: ReviewScanTrust | null = null,
): ReviewSide {
  return {
    report: scan.report,
    scanSha256,
    declaredTrust,
    profile: scan.profile,
    profileSha256: scan.profileSha256,
    coverage: validateScanEvidence(scan, target),
    anchors,
  };
}

/** Context IDs survive only within this analysis's bounded lineage and identical scan semantics. */
export function trackedFindingId(side: ReviewSide, f: QualityFinding, anchor: FindingAnchor): string {
  return `qi_${hashFields('atlas.finding.issue/1', [
    side.report.analysisId,
    f.lineageId,
    side.report.tool.version,
    side.profileSha256,
    f.ruleId,
    f.column,
    ...(anchor.contextSha256 ? ['context', anchor.contextSha256] : ['blob-location', f.blobOid, f.line]),
  ])}`;
}

function validateSide(side: ReviewSide): void {
  const report = parseQualityReport(canonicalJson(side.report));
  if (side.declaredTrust && side.declaredTrust.scanCommit !== report.commitOid)
    fail('Declared review trust target differs from the scan commit.');
  if (
    side.profileSha256 !== canonicalJsonSha256(side.profile) ||
    side.profile.rules.some((r, i) => i > 0 && compareUtf8(side.profile.rules[i - 1]!, r) >= 0) ||
    report.findings.some((f) => !side.profile.rules.includes(f.ruleId))
  )
    fail('Review profile does not match its report.');
  const c = side.coverage,
    dropped = report.dropped.unmapped + report.dropped.unsupported + report.dropped.suppressed;
  if (
    c.declaredScannedFiles + c.missingFiles !== c.analyzedPythonFiles ||
    new Set(report.findings.map((f) => f.nodeId)).size > c.declaredScannedFiles ||
    c.droppedRecords !== dropped ||
    c.scopeMatchesAnalysis !== (c.analyzedPythonFiles > 0 && c.missingFiles === 0 && dropped === 0)
  )
    fail('Review scope counts do not reconcile.');
  if (side.anchors.length !== report.findings.length) fail('Every finding requires exactly one review anchor.');
  const contextualLines = new Map<string, number>();
  for (let i = 0; i < side.anchors.length; i++) {
    const a = side.anchors[i]!,
      f = report.findings[i]!;
    if (
      a.findingId !== f.id ||
      (a.basis === 'unique-context') !== (a.contextSha256 !== null) ||
      (a.basis === 'unique-context' && f.column === null) ||
      (a.basis === 'unknown-column') !== (f.column === null) ||
      (a.counterpart === 'unique-context' && a.basis !== 'unique-context')
    )
      fail('Review anchors are invalid or out of order.');
    if (a.contextSha256) {
      const key = `${f.lineageId}:${a.contextSha256}`,
        prior = contextualLines.get(key);
      if (prior !== undefined && prior !== f.line) fail('A declared unique context appears on different lines.');
      contextualLines.set(key, f.line);
    }
  }
}

function deriveReview(
  current: ReviewSide,
  baseline: ReviewSide,
  declaredVerification: FindingReview['declaredVerification'],
) {
  validateSide(current);
  validateSide(baseline);
  if (declaredVerification === 'unverified') {
    if (current.declaredTrust || baseline.declaredTrust) fail('Unsigned review cannot claim verified trust policies.');
  } else {
    if (
      !current.declaredTrust ||
      !baseline.declaredTrust ||
      (declaredVerification === 'same-producer-policy') !==
        sameReviewProducerPolicy(current.declaredTrust.producer, baseline.declaredTrust.producer)
    )
      fail('Declared producer policy compatibility does not reconcile.');
  }
  if (
    current.report.analysisId !== baseline.report.analysisId ||
    current.report.repoId !== baseline.report.repoId ||
    current.report.snapshotId === baseline.report.snapshotId ||
    current.report.commitOid === baseline.report.commitOid
  )
    fail('Finding review requires different snapshots in the same analysis.');
  const reasons: ReviewReason[] = [];
  if (declaredVerification === 'unverified') reasons.push('unverified-provenance');
  if (declaredVerification === 'different-producer-policy') reasons.push('producer-policy-differs');
  if (!current.coverage.scopeMatchesAnalysis) reasons.push('partial-current-scope');
  if (!baseline.coverage.scopeMatchesAnalysis) reasons.push('partial-baseline-scope');
  if (current.report.tool.version !== baseline.report.tool.version) reasons.push('ruff-version-differs');
  if (current.profileSha256 !== baseline.profileSha256) reasons.push('profile-differs');
  reasons.sort(compareUtf8);
  const occurrences = (side: ReviewSide) =>
    new Map(
      side.report.findings.map((f, i) => {
        const anchor = side.anchors[i]!;
        return [trackedFindingId(side, f, anchor), { finding: f, anchor }] as const;
      }),
    );
  const now = occurrences(current),
    before = occurrences(baseline);
  if (now.size !== current.report.findings.length || before.size !== baseline.report.findings.length)
    fail('Review anchors do not identify unique occurrences.');
  const issues: ReviewIssue[] = [];
  for (const id of [...new Set([...now.keys(), ...before.keys()])].sort(compareUtf8)) {
    const n = now.get(id),
      b = before.get(id);
    if (n && b) {
      if (n.anchor.contextSha256 && n.finding.blobOid === b.finding.blobOid && n.finding.line !== b.finding.line)
        fail('Unique context cannot move inside an unchanged blob.');
      issues.push({
        id,
        state: 'continuing',
        baselineFindingId: b.finding.id,
        currentFindingId: n.finding.id,
        basis: n.anchor.contextSha256 ? 'unique-context' : 'exact-blob-location',
      });
      continue;
    }
    const a = (n ?? b)!.anchor;
    const canAccount = a.counterpart === 'unique-context' || a.counterpart === 'same-blob';
    const state: ReviewIssue['state'] =
      reasons.length === 0 && canAccount
        ? n
          ? 'newly-reported'
          : 'no-longer-reported'
        : n
          ? 'unmatched-current'
          : 'unmatched-baseline';
    const basis: ReviewIssue['basis'] =
      reasons.length === 0 && canAccount
        ? a.contextSha256
          ? 'unique-context'
          : 'exact-blob-location'
        : a.counterpart === 'file-not-in-scope'
          ? 'file-not-in-scope'
          : a.basis !== 'unique-context'
            ? a.basis
            : !canAccount
              ? a.counterpart === 'same-blob'
                ? 'exact-blob-location'
                : a.counterpart
              : reasons.length
                ? 'scan-not-comparable'
                : 'unique-context';
    issues.push({
      id,
      state,
      baselineFindingId: b?.finding.id ?? null,
      currentFindingId: n?.finding.id ?? null,
      basis,
    });
  }
  return { reasons, issues };
}

export function createFindingReview(
  current: ReviewSide,
  baseline: ReviewSide,
  declaredVerification: FindingReview['declaredVerification'] = 'unverified',
): FindingReview {
  return parseFindingReview(
    canonicalJson({
      format: 'atlas.finding-review/1',
      algorithm: 'exact-context/1',
      current,
      baseline,
      declaredVerification,
      ...deriveReview(current, baseline, declaredVerification),
    }),
  );
}

export function parseFindingReview(text: string): FindingReview {
  const parsed = FindingReviewSchema.safeParse(parseScanJson(text, REVIEW_LIMITS.bytes));
  if (!parsed.success) fail('Invalid or unsupported finding review.');
  const review = parsed.data,
    derived = deriveReview(review.current, review.baseline, review.declaredVerification);
  if (canonicalJson(derived) !== canonicalJson({ reasons: review.reasons, issues: review.issues }))
    fail('Review rows, counts or tracking identities do not match their evidence.');
  return review;
}

export function validateFindingReview(review: FindingReview, current: QualityTarget, baseline: QualityTarget): void {
  validateQualityReport(review.current.report, current);
  validateQualityReport(review.baseline.report, baseline);
  for (const [side, target] of [
    [review.current, current],
    [review.baseline, baseline],
  ] as const) {
    if (target.files.filter((f) => /\.pyi?$/.test(f.path)).length !== side.coverage.analyzedPythonFiles)
      fail('Review scope differs from the analyzed Python file inventory.');
  }
  for (const [side, other] of [
    [review.current, baseline],
    [review.baseline, current],
  ] as const) {
    const files = new Map(other.files.filter((f) => /\.pyi?$/.test(f.path)).map((f) => [f.lineageId, f]));
    for (let i = 0; i < side.anchors.length; i++) {
      const anchor = side.anchors[i]!,
        finding = side.report.findings[i]!,
        file = files.get(finding.lineageId);
      if (
        (anchor.counterpart === 'file-not-in-scope') !== !file ||
        (anchor.counterpart === 'same-blob' && file?.blobOid !== finding.blobOid)
      )
        fail('Review counterpart evidence differs from the analyzed file inventory.');
    }
  }
}
export function findingReviewIsPartial(review: FindingReview): boolean {
  return review.reasons.length > 0 || review.issues.some((r) => r.state.startsWith('unmatched-'));
}

export function parseReviewScanTrust(text: string): ReviewScanTrust {
  const parsed = ReviewScanTrustSchema.safeParse(parseScanJson(text, SCAN_LIMITS.policyBytes));
  if (!parsed.success) fail('Invalid or unsupported historical scan trust policy.');
  return parsed.data;
}
export function sameReviewProducerPolicy(a: ScanTrustPolicy, b: ScanTrustPolicy): boolean {
  return (
    a.repository === b.repository &&
    a.workflow === b.workflow &&
    a.sourceRef === b.sourceRef &&
    a.trustedRootSha256 === b.trustedRootSha256
  );
}

const reasonLabels: Record<ReviewReason, string> = {
  'unverified-provenance': 'Scan signatures were not verified',
  'producer-policy-differs': 'Approved producer policies differ',
  'partial-current-scope': 'Current declared scan scope is partial',
  'partial-baseline-scope': 'Baseline declared scan scope is partial',
  'ruff-version-differs': 'Ruff versions differ',
  'profile-differs': 'Declared Ruff settings differ',
};
const basisLabels: Record<ReviewIssue['basis'], string> = {
  'unique-context': 'Unique unchanged code context',
  'exact-blob-location': 'Identical blob and reported location',
  'repeated-context': 'Repeated code context; identity is uncertain',
  'unknown-column': 'Reported column is unknown',
  'source-unavailable': 'Committed context is unavailable',
  'context-unavailable': 'Context exceeds its limit or location is unavailable',
  'changed-context': 'Surrounding code changed',
  'file-not-in-scope': 'Python file lineage is absent from the other snapshot',
  'scan-not-comparable': 'Scan declarations are not comparable',
};
const stateLabels: Record<ReviewIssue['state'], string> = {
  continuing: 'Continuing evidence',
  'newly-reported': 'Newly reported',
  'no-longer-reported': 'No longer reported',
  'unmatched-current': 'Unmatched current evidence',
  'unmatched-baseline': 'Unmatched baseline evidence',
};
export const findingReviewReasonLabel = (reason: ReviewReason): string => reasonLabels[reason];
export const findingReviewBasisLabel = (basis: ReviewIssue['basis']): string => basisLabels[basis];
export const findingReviewStateLabel = (state: ReviewIssue['state']): string => stateLabels[state];
