import { z } from 'zod';
import { GitOidSchema, Hex64Schema } from './primitives.js';
import { QUALITY_LIMITS, QualityReportSchema } from './quality.js';
import { RuffProfileSchema, ScanTrustPolicySchema } from './scan.js';
import { LIMITS } from './limits.js';

export const REVIEW_LIMITS = {
  bytes: 8 * 1024 * 1024,
  blobBytes: LIMITS.sourceBlobBytes,
  sourceBytes: LIMITS.headDecodedSourceBytes,
  blobBatch: 64,
  batchBytes: 8 * 1024 * 1024,
  contextWindows: 200_000,
  contextBytes: 16 * 1024,
  rows: 2 * QUALITY_LIMITS.findings,
} as const;
export const FindingAnchorSchema = z.strictObject({
  findingId: z.string().regex(/^qf_[0-9a-f]{64}$/),
  contextSha256: Hex64Schema.nullable(),
  basis: z.enum(['unique-context', 'repeated-context', 'unknown-column', 'source-unavailable', 'context-unavailable']),
  counterpart: z.enum([
    'unique-context',
    'same-blob',
    'changed-context',
    'repeated-context',
    'source-unavailable',
    'file-not-in-scope',
  ]),
});
/** The attested producer checkout and historical scan target are different pins. */
export const ReviewScanTrustSchema = z.strictObject({
  format: z.literal('atlas.review-scan-trust/1'),
  scanCommit: GitOidSchema,
  producer: ScanTrustPolicySchema,
});
export const ReviewSideSchema = z.strictObject({
  report: QualityReportSchema,
  scanSha256: Hex64Schema,
  declaredTrust: ReviewScanTrustSchema.nullable(),
  profile: RuffProfileSchema,
  profileSha256: Hex64Schema,
  coverage: z.strictObject({
    analyzedPythonFiles: z.number().int().min(0).max(LIMITS.includedFilesPerSnapshot),
    declaredScannedFiles: z.number().int().min(0).max(LIMITS.includedFilesPerSnapshot),
    missingFiles: z.number().int().min(0).max(LIMITS.includedFilesPerSnapshot),
    droppedRecords: z.number().int().min(0).max(QUALITY_LIMITS.results),
    scopeMatchesAnalysis: z.boolean(),
  }),
  anchors: z.array(FindingAnchorSchema).max(QUALITY_LIMITS.findings),
});
export const ReviewReasonSchema = z.enum([
  'unverified-provenance',
  'producer-policy-differs',
  'partial-current-scope',
  'partial-baseline-scope',
  'ruff-version-differs',
  'profile-differs',
]);
export const ReviewIssueSchema = z.strictObject({
  id: z.string().regex(/^qi_[0-9a-f]{64}$/),
  state: z.enum(['continuing', 'newly-reported', 'no-longer-reported', 'unmatched-current', 'unmatched-baseline']),
  baselineFindingId: z
    .string()
    .regex(/^qf_[0-9a-f]{64}$/)
    .nullable(),
  currentFindingId: z
    .string()
    .regex(/^qf_[0-9a-f]{64}$/)
    .nullable(),
  basis: z.enum([
    'unique-context',
    'exact-blob-location',
    'repeated-context',
    'unknown-column',
    'source-unavailable',
    'context-unavailable',
    'changed-context',
    'file-not-in-scope',
    'scan-not-comparable',
  ]),
});
export const FindingReviewSchema = z.strictObject({
  format: z.literal('atlas.finding-review/1'),
  algorithm: z.literal('exact-context/1'),
  current: ReviewSideSchema,
  baseline: ReviewSideSchema,
  // A stored declaration is never a cryptographic receipt. The browser must say so.
  declaredVerification: z.enum(['unverified', 'same-producer-policy', 'different-producer-policy']),
  reasons: z.array(ReviewReasonSchema).max(6),
  issues: z.array(ReviewIssueSchema).max(REVIEW_LIMITS.rows),
});
export type FindingAnchor = z.infer<typeof FindingAnchorSchema>;
export type ReviewSide = z.infer<typeof ReviewSideSchema>;
export type FindingReview = z.infer<typeof FindingReviewSchema>;
export type ReviewIssue = z.infer<typeof ReviewIssueSchema>;
export type ReviewReason = z.infer<typeof ReviewReasonSchema>;
export type ReviewScanTrust = z.infer<typeof ReviewScanTrustSchema>;
