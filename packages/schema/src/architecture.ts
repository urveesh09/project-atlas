import { z } from 'zod';
import { FileRoleSchema, EdgeKindSchema, FILE_EDGE_KINDS } from './graph.js';
import { SnapshotCoverageSchema } from './coverage.js';
import { AnalysisIdSchema, RepositoryIdSchema, SnapshotIdSchema, GitOidSchema, NodeIdSchema, LineageIdSchema, EdgeIdSchema, ObservationIdSchema, PackagePathSchema, RepoPathSchema, ConfidenceSchema, SourceRangeSchema, Hex64Schema, CountSchema } from './primitives.js';
export const ARCHITECTURE_LIMITS = Object.freeze({ policyBytes: 64 * 1024, reportBytes: 8 * 1024 * 1024, jsonDepth: 32, rules: 16, selectorValues: 32, rows: 2000, members: 32, witness: 64, locations: 4 });
const name = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const ArchitectureSelectorSchema = z.strictObject({
  paths: z.array(PackagePathSchema).min(1).max(ARCHITECTURE_LIMITS.selectorValues).optional(),
  roles: z.array(FileRoleSchema).min(1).max(6).optional(),
  packages: z.array(PackagePathSchema).min(1).max(ARCHITECTURE_LIMITS.selectorValues).optional(),
});
export const ArchitectureRuleSchema = z.discriminatedUnion('kind', [
  z.strictObject({ id: name, kind: z.literal('forbidden-dependency'), from: ArchitectureSelectorSchema, to: ArchitectureSelectorSchema, edgeKinds: z.array(z.enum(FILE_EDGE_KINDS)).min(1).max(FILE_EDGE_KINDS.length) }),
  z.strictObject({ id: name, kind: z.literal('cycle') }),
]);
export const ArchitecturePolicySchema = z.strictObject({ format: z.literal('atlas.architecture-policy/1'), rules: z.array(ArchitectureRuleSchema).min(1).max(ARCHITECTURE_LIMITS.rules) });
export const ArchitectureFileSchema = z.strictObject({ nodeId: NodeIdSchema, lineageId: LineageIdSchema.nullable(), path: RepoPathSchema, role: FileRoleSchema, packagePath: PackagePathSchema });
export const ArchitectureEdgeSchema = z.strictObject({
  edgeId: EdgeIdSchema, from: ArchitectureFileSchema, to: ArchitectureFileSchema, kind: EdgeKindSchema, confidence: ConfidenceSchema,
  observations: z.number().int().positive(), locations: z.array(z.strictObject({ observationId: ObservationIdSchema, range: SourceRangeSchema })).max(ARCHITECTURE_LIMITS.locations), evidenceOmitted: CountSchema,
});
const row = { id: z.string().regex(/^ar_[0-9a-f]{64}$/), ruleId: name, state: z.enum(['uncompared', 'newly-observed', 'continuing']) };
export const ArchitectureRowSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...row, kind: z.literal('forbidden-dependency'), edge: ArchitectureEdgeSchema }),
  z.strictObject({ ...row, kind: z.literal('cycle'), members: z.array(ArchitectureFileSchema).min(1).max(ARCHITECTURE_LIMITS.members), memberCount: z.number().int().positive(), membersOmitted: CountSchema, witness: z.array(ArchitectureEdgeSchema).max(ARCHITECTURE_LIMITS.witness), witnessUnavailable: z.boolean() }),
]);
export const ArchitectureFrameSchema = z.strictObject({ snapshotId: SnapshotIdSchema, commitOid: GitOidSchema, coverage: SnapshotCoverageSchema });
export const ArchitectureReviewSchema = z.strictObject({
  format: z.literal('atlas.architecture-review/1'), analysisId: AnalysisIdSchema, repoId: RepositoryIdSchema, policy: ArchitecturePolicySchema, policySha256: Hex64Schema,
  current: ArchitectureFrameSchema, baseline: ArchitectureFrameSchema.nullable(),
  rules: z.array(z.strictObject({ ruleId: name, current: CountSchema, baseline: CountSchema.nullable(), newlyObserved: CountSchema.nullable(), continuing: CountSchema.nullable(), noLongerObserved: CountSchema.nullable(), currentFrom: CountSchema, currentTo: CountSchema, baselineFrom: CountSchema.nullable(), baselineTo: CountSchema.nullable() })).max(ARCHITECTURE_LIMITS.rules),
  reasons: z.array(z.enum(['current-coverage', 'baseline-coverage', 'unmatched-selector', 'lineage-unavailable', 'evidence-limit'])).max(5),
  rows: z.array(ArchitectureRowSchema).max(ARCHITECTURE_LIMITS.rows), rowsOmitted: CountSchema,
});
export type ArchitecturePolicy = z.infer<typeof ArchitecturePolicySchema>;
export type ArchitectureSelector = z.infer<typeof ArchitectureSelectorSchema>;
export type ArchitectureFile = z.infer<typeof ArchitectureFileSchema>;
export type ArchitectureEdge = z.infer<typeof ArchitectureEdgeSchema>;
export type ArchitectureRow = z.infer<typeof ArchitectureRowSchema>;
export type ArchitectureReview = z.infer<typeof ArchitectureReviewSchema>;
