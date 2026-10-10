import { z } from 'zod';
import { LIMITS } from './limits.js';
import {
  AvailabilitySchema,
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

export const HistoryArtifactSchema = z.strictObject({
  historyId: HistoryIdSchema,
  frames: z
    .array(z.strictObject({ snapshotId: SnapshotIdSchema, commitOid: GitOidSchema, ordinal: CountSchema }))
    .max(LIMITS.analyzedFrames),
  commits: z.array(HistoryCommitSchema).max(LIMITS.firstParentCommits + 1),
  lineages: z.array(FileLineageSchema).max(LIMITS.historicalUnionLineages),
  coChangePairs: z.array(CoChangePairSchema).max(LIMITS.historicalUnionLineages * LIMITS.coChangeMaxPartners),
});

export type FileChange = z.infer<typeof FileChangeSchema>;
export type FileLineage = z.infer<typeof FileLineageSchema>;
export type CoChangePair = z.infer<typeof CoChangePairSchema>;
export type HistoryCommit = z.infer<typeof HistoryCommitSchema>;
export type HistoryArtifact = z.infer<typeof HistoryArtifactSchema>;
