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
export const EslintRuleSchema = z.string().max(128).regex(/^@?[A-Za-z0-9][A-Za-z0-9_-]*(?:\/[A-Za-z0-9][A-Za-z0-9_-]*){0,2}$/);
const ToolVersionSchema = z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/);
export const RuffToolSchema = z.strictObject({ name: z.literal('ruff'), version: ToolVersionSchema });
export const EslintToolSchema = z.strictObject({ name: z.literal('eslint'), version: ToolVersionSchema });
const qualityFindingSchema = (ruleId: typeof QualityRuleSchema) => z.strictObject({
  id: z.string().regex(/^qf_[0-9a-f]{64}$/),
  nodeId: NodeIdSchema,
  lineageId: LineageIdSchema,
  path: RepoPathSchema,
  blobOid: GitOidSchema,
  ruleId,
  level: z.enum(['error', 'warning', 'note']),
  line: z.number().int().min(1).max(QUALITY_LIMITS.position),
  column: z.number().int().min(1).max(QUALITY_LIMITS.position).nullable(),
});
export const QualityFindingSchema = qualityFindingSchema(QualityRuleSchema);
const qualityReportSchema = <Tool extends typeof RuffToolSchema | typeof EslintToolSchema>(
  tool: Tool, finding: typeof QualityFindingSchema,
) => z.strictObject({
  format: z.literal('atlas.quality/1'),
  analysisId: AnalysisIdSchema,
  repoId: RepositoryIdSchema,
  snapshotId: SnapshotIdSchema,
  commitOid: GitOidSchema,
  binding: z.literal('user-declared'),
  scanScope: z.literal('unverified'),
  tool,
  inputResults: z.number().int().min(0).max(QUALITY_LIMITS.results),
  dropped: z.strictObject({
    unmapped: z.number().int().nonnegative().max(QUALITY_LIMITS.results),
    unsupported: z.number().int().nonnegative().max(QUALITY_LIMITS.results),
    suppressed: z.number().int().nonnegative().max(QUALITY_LIMITS.results),
    duplicates: z.number().int().nonnegative().max(QUALITY_LIMITS.results),
  }),
  findings: z.array(finding).max(QUALITY_LIMITS.findings),
});
export const RuffQualityReportSchema = qualityReportSchema(RuffToolSchema, QualityFindingSchema);
const EslintQualityReportSchema = qualityReportSchema(EslintToolSchema, qualityFindingSchema(EslintRuleSchema));
export const QualityReportSchema = z.union([RuffQualityReportSchema, EslintQualityReportSchema]);
export type QualityFinding = z.infer<typeof QualityFindingSchema>;
export type RuffQualityReport = z.infer<typeof RuffQualityReportSchema>;
export type QualityReport = z.infer<typeof QualityReportSchema>;
export const QUALITY_TOOL_LABELS = { ruff: 'Ruff', eslint: 'ESLint' } as const satisfies Record<QualityReport['tool']['name'], string>;
