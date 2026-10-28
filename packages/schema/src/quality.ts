import { z } from 'zod';
import {
  AnalysisIdSchema,
  GitOidSchema,
  LineageIdSchema,
  NodeIdSchema,
  RepoPathSchema,
  RepositoryIdSchema,
  SnapshotIdSchema,
} from './primitives.js';

/** Separate, optional evidence; never changes an analysis's canonical artifact. */
export const QUALITY_LIMITS = {
  bytes: 8 * 1024 * 1024,
  results: 20_000,
  findings: 4_096,
  position: 10_000_000,
} as const;
export const QualityRuleSchema = z.string().regex(/^[A-Z]{1,5}[0-9]{3,4}$/);
export const QualityFindingSchema = z.strictObject({
  id: z.string().regex(/^qf_[0-9a-f]{64}$/),
  nodeId: NodeIdSchema,
  lineageId: LineageIdSchema,
  path: RepoPathSchema,
  blobOid: GitOidSchema,
  ruleId: QualityRuleSchema,
  level: z.enum(['error', 'warning', 'note']),
  line: z.number().int().min(1).max(QUALITY_LIMITS.position),
  column: z.number().int().min(1).max(QUALITY_LIMITS.position).nullable(),
});
export const QualityReportSchema = z.strictObject({
  format: z.literal('atlas.quality/1'),
  analysisId: AnalysisIdSchema,
  repoId: RepositoryIdSchema,
  snapshotId: SnapshotIdSchema,
  commitOid: GitOidSchema,
  binding: z.literal('user-declared'),
  scanScope: z.literal('unverified'),
  tool: z.strictObject({ name: z.literal('ruff'), version: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/) }),
  inputResults: z.number().int().min(0).max(QUALITY_LIMITS.results),
  dropped: z.strictObject({
    unmapped: z.number().int().nonnegative().max(QUALITY_LIMITS.results),
    unsupported: z.number().int().nonnegative().max(QUALITY_LIMITS.results),
    suppressed: z.number().int().nonnegative().max(QUALITY_LIMITS.results),
    duplicates: z.number().int().nonnegative().max(QUALITY_LIMITS.results),
  }),
  findings: z.array(QualityFindingSchema).max(QUALITY_LIMITS.findings),
});
export type QualityFinding = z.infer<typeof QualityFindingSchema>;
export type QualityReport = z.infer<typeof QualityReportSchema>;
