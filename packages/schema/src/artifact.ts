import { z } from 'zod';
import { AnalysisCoverageSchema, SnapshotCoverageSchema } from './coverage.js';
import { LIMITS } from './limits.js';
import {
  AnalysisIdSchema,
  AnalysisKeySchema,
  AvailabilitySchema,
  CountSchema,
  ExtensionsSchema,
  GitOidSchema,
  Hex64Schema,
  IsoUtcSchema,
  LabelSchema,
  RepositoryIdSchema,
  SnapshotIdSchema,
} from './primitives.js';

/**
 * Chunk paths are fixed shapes, never free-form (plan §6.5): this makes traversal,
 * absolute paths and duplicate names unrepresentable in a valid manifest.
 */
export const CHUNK_PATH_PATTERN = /^(?:graphs\/snap_[0-9a-f]{64}|history\/history|layout\/layout)\.json\.gz$/;

export const ChunkRefSchema = z.strictObject({
  path: z.string().regex(CHUNK_PATH_PATTERN, 'Invalid chunk path'),
  sha256: Hex64Schema,
  uncompressedBytes: z.number().int().positive().max(LIMITS.artifactUncompressedBytes),
  compressedBytes: z.number().int().positive().max(LIMITS.artifactCompressedBytes),
  mediaType: z.literal('application/json'),
  /** Lossless graph transports (ADR-018 indexed, ADR-026 frame delta); absent for plain JSON. */
  encoding: z.enum(['atlas.graph.indexed/1', 'atlas.graph.delta/1', 'atlas.history.compact/1', 'atlas.layout.compact/1']).optional(),
  encodedSha256: Hex64Schema.optional(),
  decodedBytes: z.number().int().positive().max(LIMITS.artifactUncompressedBytes).optional(),
});

export const GitCommitRefSchema = z.strictObject({
  oid: GitOidSchema,
  committerTime: IsoUtcSchema,
  firstParentOid: GitOidSchema.nullable(),
});

export const RepositoryDescriptorSchema = z
  .strictObject({
    repoId: RepositoryIdSchema,
    displayName: LabelSchema,
    sourceKind: z.enum(['local-git', 'public-github']),
    remote: z
      .strictObject({
        host: z.literal('github.com'),
        owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
        name: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
        numericId: z.string().regex(/^[1-9]\d{0,19}$/),
      })
      .nullable(),
    objectFormat: z.enum(['sha1', 'sha256']),
  })
  .refine((r) => (r.sourceKind === 'public-github') === (r.remote !== null), 'remote is required exactly for public-github');

export const FrameDescriptorSchema = z.strictObject({
  snapshotId: SnapshotIdSchema,
  commit: GitCommitRefSchema,
  /** 0 is the oldest selected frame; the highest ordinal is the selected commit (HEAD). */
  ordinal: CountSchema,
  graphChunk: ChunkRefSchema,
  nodeCount: CountSchema,
  edgeCount: CountSchema,
  analysisStatus: AvailabilitySchema,
  coverage: SnapshotCoverageSchema,
});

export const ArtifactManifestSchema = z.strictObject({
  artifactVersion: z.enum(['atlas.artifact/1.0.0', 'atlas.artifact/1.1.0', 'atlas.artifact/1.2.0', 'atlas.artifact/1.3.0', 'atlas.artifact/1.4.0']),
  /** 1.1.0 adds Python (ADR-060); 1.0.0 artifacts remain valid. */
  schemaVersion: z.enum(['atlas.graph/1.0.0', 'atlas.graph/1.1.0']),
  analysisId: AnalysisIdSchema,
  analysisKey: AnalysisKeySchema,
  repo: RepositoryDescriptorSchema,
  selectedCommit: GitCommitRefSchema,
  analyzer: z.strictObject({
    version: z.string().min(1).max(64),
    parserVersion: z.string().min(1).max(64),
    gitVersion: z.string().min(1).max(64),
  }),
  optionsDigest: Hex64Schema,
  metricDefinitionVersion: z.literal('atlas.metrics/1'),
  frames: z.array(FrameDescriptorSchema).min(1).max(LIMITS.analyzedFrames),
  historyChunk: ChunkRefSchema,
  layoutChunk: ChunkRefSchema,
  chunks: z.array(ChunkRefSchema).min(3).max(LIMITS.analyzedFrames + 2),
  coverage: AnalysisCoverageSchema,
  createdAt: IsoUtcSchema,
  expiresAt: IsoUtcSchema.nullable(),
  sourceTextIncluded: z.literal(false),
  extensions: ExtensionsSchema.optional(),
});

export type ChunkRef = z.infer<typeof ChunkRefSchema>;
export type GitCommitRef = z.infer<typeof GitCommitRefSchema>;
export type RepositoryDescriptor = z.infer<typeof RepositoryDescriptorSchema>;
export type FrameDescriptor = z.infer<typeof FrameDescriptorSchema>;
export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;
