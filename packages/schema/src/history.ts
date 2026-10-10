import { z } from 'zod';
import { LIMITS } from './limits.js';
import {
  AvailabilitySchema,
  CodeSchema,
  CountSchema,
  GitOidSchema,
  HistoryIdSchema,
  IsoUtcSchema,
  LineageIdSchema,
  NodeIdSchema,
  NullableCountSchema,
  RepoPathSchema,
  SnapshotIdSchema,
} from './primitives.js';

/** Plan §6.4 and §7.2–7.5. Lineage is bounded to the artifact's history window. */
export const FileChangeSchema = z.strictObject({
  kind: z.enum(['add', 'modify', 'delete', 'rename', 'type-change']),
  oldPath: RepoPathSchema.nullable(),
  newPath: RepoPathSchema.nullable(),
  oldBlobOid: GitOidSchema.nullable(),
  newBlobOid: GitOidSchema.nullable(),
  lineageId: LineageIdSchema.nullable(),
  renameSimilarity: z.number().int().min(0).max(100).nullable(),
  added: NullableCountSchema,
  deleted: NullableCountSchema,
});

export const FileLineageSchema = z.strictObject({
  id: LineageIdSchema,
  anchorCommitOid: GitOidSchema,
  anchorPath: RepoPathSchema,
  continuity: z.enum(['exact-path', 'git-rename', 'ambiguous']),
  occurrences: z
    .array(z.strictObject({ snapshotId: SnapshotIdSchema, nodeId: NodeIdSchema, path: RepoPathSchema }))
    .max(LIMITS.analyzedFrames),
});

export const CoChangePairSchema = z
  .strictObject({
    aLineageId: LineageIdSchema,
    bLineageId: LineageIdSchema,
    togetherCommits: z.number().int().min(LIMITS.coChangeMinTogether),
    eligibleUnionCommits: z.number().int().positive(),
    jaccard: z.number().min(0).max(1),
  })
  .refine((p) => p.aLineageId < p.bLineageId, 'Co-change pairs are ordered with aLineageId < bLineageId')
  .refine((p) => p.togetherCommits <= p.eligibleUnionCommits, 'togetherCommits cannot exceed eligibleUnionCommits');

export const HistoryCommitSchema = z.strictObject({
  oid: GitOidSchema,
  firstParentOid: GitOidSchema.nullable(),
  committerTime: IsoUtcSchema,
  changes: z.array(FileChangeSchema).max(LIMITS.treeEntriesPerSnapshot),
  changesAvailability: AvailabilitySchema,
});

/**
 * Which commits were requested as structural frames and what became of them (plan §7.2:
 * an over-limit frame is unavailable and dropped from rendering, but its requested commit
 * stays visible). `chainIndex` counts from the oldest included commit (0). Additive in
 * artifact 1.3; absent in older artifacts.
 */
export const FrameSelectionSchema = z.strictObject({
  requested: z.number().int().min(1).max(LIMITS.analyzedFrames),
  windowCommits: z.number().int().min(1).max(LIMITS.firstParentCommits),
  commits: z
    .array(
      z.strictObject({
        commitOid: GitOidSchema,
        chainIndex: z.number().int().min(0).max(LIMITS.firstParentCommits - 1),
        status: z.enum(['analyzed', 'unavailable']),
        reason: CodeSchema.nullable(),
      }),
    )
    .min(1)
    .max(LIMITS.analyzedFrames),
});

/** The fixed change/rename/co-change policy used to build this history (plan §7.3, §4.2). */
export const HistoryPolicySchema = z.strictObject({
  firstParentOnly: z.literal(true),
  renameSimilarityPercent: z.number().int().min(1).max(100),
  renameCandidateLimit: z.number().int().positive(),
  copies: z.literal(false),
  coChangeMaxFilesPerCommit: z.number().int().positive(),
  coChangeMinTogether: z.number().int().positive(),
  coChangeMaxPartners: z.number().int().positive(),
  /** Commits excluded from co-change pairs because they changed too many files. */
  coChangeExcludedCommits: CountSchema,
  /** Lineages that appear in no analyzed frame and were dropped to respect the lineage cap. */
  transientLineagesOmitted: CountSchema,
});

export const HistoryArtifactSchema = z.strictObject({
  historyId: HistoryIdSchema,
  frames: z
    .array(z.strictObject({ snapshotId: SnapshotIdSchema, commitOid: GitOidSchema, ordinal: CountSchema }))
    .max(LIMITS.analyzedFrames),
  commits: z.array(HistoryCommitSchema).max(LIMITS.firstParentCommits + 1),
  lineages: z.array(FileLineageSchema).max(LIMITS.historicalUnionLineages),
  coChangePairs: z.array(CoChangePairSchema).max(LIMITS.historicalUnionLineages * LIMITS.coChangeMaxPartners),
  frameSelection: FrameSelectionSchema.optional(),
  policy: HistoryPolicySchema.optional(),
});

export type FileChange = z.infer<typeof FileChangeSchema>;
export type FileLineage = z.infer<typeof FileLineageSchema>;
export type CoChangePair = z.infer<typeof CoChangePairSchema>;
export type HistoryCommit = z.infer<typeof HistoryCommitSchema>;
export type HistoryArtifact = z.infer<typeof HistoryArtifactSchema>;
export type FrameSelection = z.infer<typeof FrameSelectionSchema>;
export type HistoryPolicy = z.infer<typeof HistoryPolicySchema>;
