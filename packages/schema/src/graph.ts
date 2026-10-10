import { z } from 'zod';
import { SnapshotCoverageSchema } from './coverage.js';
import { LIMITS } from './limits.js';
import {
  AvailabilitySchema,
  CodeSchema,
  ConfidenceSchema,
  CountSchema,
  DiagnosticIdSchema,
  EdgeIdSchema,
  ExtensionsSchema,
  GitOidSchema,
  Hex64Schema,
  LabelSchema,
  LineageIdSchema,
  NodeIdSchema,
  NullableCountSchema,
  ObservationIdSchema,
  PackagePathSchema,
  RepoPathSchema,
  RepositoryIdSchema,
  SccIdSchema,
  SnapshotIdSchema,
  SourceRangeSchema,
  boundedString,
} from './primitives.js';

export const NodeKindSchema = z.enum(['repository', 'package', 'directory', 'file', 'external-package', 'builtin']);
export const FileRoleSchema = z.enum(['source', 'test', 'declaration', 'config', 'asset', 'opaque']);
export const ParseStatusSchema = z.enum(['parsed', 'failed', 'unsupported', 'skipped']);

export const DeclarationKindSchema = z.enum(['function', 'class', 'interface', 'type', 'enum', 'variable']);

export const DeclarationSummarySchema = z.strictObject({
  name: LabelSchema,
  kind: DeclarationKindSchema,
  exported: z.boolean(),
  range: SourceRangeSchema,
});

export const DependencyFieldSchema = z.enum([
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]);

export const DeclaredRangeSchema = z.strictObject({
  packageNodeId: NodeIdSchema,
  field: DependencyFieldSchema,
  range: LabelSchema,
});

const nodeBase = {
  id: NodeIdSchema,
  label: LabelSchema,
  parentId: NodeIdSchema.nullable(),
  lineageId: LineageIdSchema.nullable(),
};

export const RepositoryNodeSchema = z.strictObject({ ...nodeBase, kind: z.literal('repository') });

export const PackageNodeSchema = z.strictObject({
  ...nodeBase,
  kind: z.literal('package'),
  /** '' denotes the synthetic root package that owns unclaimed root files. */
  path: PackagePathSchema,
  manifestPath: RepoPathSchema.nullable(),
  packageName: LabelSchema.nullable(),
  workspace: z.boolean(),
});

export const DirectoryNodeSchema = z.strictObject({ ...nodeBase, kind: z.literal('directory'), path: RepoPathSchema });

export const FileNodeSchema = z.strictObject({
  ...nodeBase,
  kind: z.literal('file'),
  path: RepoPathSchema,
  blobOid: GitOidSchema,
  blobSha256: Hex64Schema.nullable(),
  language: z.enum(['typescript', 'javascript']).nullable(),
  role: FileRoleSchema,
  byteSize: CountSchema,
  parseStatus: ParseStatusSchema,
  declarations: z.array(DeclarationSummarySchema).max(LIMITS.declarationsPerFile),
  declarationsOmitted: CountSchema,
});

export const ExternalPackageNodeSchema = z.strictObject({
  ...nodeBase,
  kind: z.literal('external-package'),
  ecosystem: z.literal('npm'),
  packageName: LabelSchema,
  declaredRanges: z.array(DeclaredRangeSchema).max(1024),
});

export const BuiltinNodeSchema = z.strictObject({ ...nodeBase, kind: z.literal('builtin'), moduleName: LabelSchema });

export const GraphNodeSchema = z.discriminatedUnion('kind', [
  RepositoryNodeSchema,
  PackageNodeSchema,
  DirectoryNodeSchema,
  FileNodeSchema,
  ExternalPackageNodeSchema,
  BuiltinNodeSchema,
]);

export const EdgeKindSchema = z.enum([
  'imports-value',
  'imports-type',
  'reexports-value',
  'reexports-type',
  'imports-dynamic-literal',
  'requires-literal',
  'imports-resource',
  'declares-package',
  'project-reference',
]);

/** Edge kinds produced from statements inside a source file. */
export const FILE_EDGE_KINDS = [
  'imports-value',
  'imports-type',
  'reexports-value',
  'reexports-type',
  'imports-dynamic-literal',
  'requires-literal',
  'imports-resource',
] as const;

/**
 * Default static value-edge policy (plan §10.1): used for fan-in, fan-out and cycles.
 * Type-only, resource and dynamic edges are excluded; dynamic import is excluded from
 * cycles but included in fan-out/fan-in.
 */
export const DEGREE_EDGE_KINDS = ['imports-value', 'reexports-value', 'requires-literal', 'imports-dynamic-literal'] as const;
export const CYCLE_EDGE_KINDS = ['imports-value', 'reexports-value', 'requires-literal'] as const;

export const GraphEdgeSchema = z.strictObject({
  id: EdgeIdSchema,
  sourceId: NodeIdSchema,
  targetId: NodeIdSchema,
  kind: EdgeKindSchema,
  confidence: ConfidenceSchema,
  observationCount: z.number().int().positive(),
  evidenceIds: z.array(ObservationIdSchema).max(LIMITS.dependencyEvidenceRowsPerSnapshot),
  evidenceOmitted: CountSchema,
});

export const ObservationStatusSchema = z.enum([
  'resolved-internal',
  'resolved-external',
  'builtin',
  'unresolved',
  'unsupported',
  'excluded-target',
]);

export const ImportObservationSchema = z.strictObject({
  id: ObservationIdSchema,
  sourceId: NodeIdSchema,
  kind: EdgeKindSchema,
  specifier: LabelSchema.nullable(),
  range: SourceRangeSchema,
  status: ObservationStatusSchema,
  targetId: NodeIdSchema.nullable(),
  reasonCode: CodeSchema.nullable(),
  resolverMode: z.string().regex(/^[a-z0-9]+(?:[/-][a-z0-9]+)*$/).max(64),
  confidence: ConfidenceSchema.nullable(),
});

export const DiagnosticSchema = z.strictObject({
  id: DiagnosticIdSchema,
  ruleId: z.string().regex(/^ATLAS_[A-Z0-9_]+$/),
  ruleVersion: z.number().int().positive(),
  severity: z.enum(['info', 'warning', 'error']),
  category: z.enum(['parse', 'resolution', 'structure', 'complexity', 'history', 'coverage']),
  subjectIds: z.array(NodeIdSchema).min(1).max(2_000),
  range: SourceRangeSchema.nullable(),
  messageCode: CodeSchema,
  parameters: z
    .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,63}$/), z.union([boundedString(LIMITS.diagnosticParameterBytes), z.number()]))
    .refine((p) => Object.keys(p).length <= LIMITS.diagnosticParameters, 'Too many diagnostic parameters'),
  evidenceIds: z.array(ObservationIdSchema).max(2_000),
  fingerprint: Hex64Schema,
});

export const NodeMetricsSchema = z.strictObject({
  nodeId: NodeIdSchema,
  physicalLines: NullableCountSchema,
  codeLines: NullableCountSchema,
  declarationCount: NullableCountSchema,
  maxCyclomatic: NullableCountSchema,
  sumCyclomatic: NullableCountSchema,
  callableCount: NullableCountSchema,
  fanIn: NullableCountSchema,
  fanOut: NullableCountSchema,
  sccId: SccIdSchema.nullable(),
  changedCommits: NullableCountSchema,
  linesAdded: NullableCountSchema,
  linesDeleted: NullableCountSchema,
  hotspotScore: z.number().int().min(0).max(100).nullable(),
  availability: z.strictObject({
    syntax: AvailabilitySchema,
    dependencies: AvailabilitySchema,
    history: AvailabilitySchema,
  }),
});

export const GraphSnapshotSchema = z.strictObject({
  snapshotId: SnapshotIdSchema,
  repoId: RepositoryIdSchema,
  commitOid: GitOidSchema,
  nodes: z.array(GraphNodeSchema).max(LIMITS.treeEntriesPerSnapshot),
  edges: z.array(GraphEdgeSchema).max(LIMITS.sourceDependencyEdgesPerSnapshot),
  importObservations: z.array(ImportObservationSchema).max(LIMITS.dependencyEvidenceRowsPerSnapshot),
  diagnostics: z.array(DiagnosticSchema).max(LIMITS.diagnosticsPerFrame),
  metrics: z.array(NodeMetricsSchema).max(LIMITS.treeEntriesPerSnapshot),
  coverage: SnapshotCoverageSchema,
  extensions: ExtensionsSchema.optional(),
});

export type NodeKind = z.infer<typeof NodeKindSchema>;
export type FileRole = z.infer<typeof FileRoleSchema>;
export type ParseStatus = z.infer<typeof ParseStatusSchema>;
export type DeclarationSummary = z.infer<typeof DeclarationSummarySchema>;
export type DeclaredRange = z.infer<typeof DeclaredRangeSchema>;
export type RepositoryNode = z.infer<typeof RepositoryNodeSchema>;
export type PackageNode = z.infer<typeof PackageNodeSchema>;
export type DirectoryNode = z.infer<typeof DirectoryNodeSchema>;
export type FileNode = z.infer<typeof FileNodeSchema>;
export type ExternalPackageNode = z.infer<typeof ExternalPackageNodeSchema>;
export type BuiltinNode = z.infer<typeof BuiltinNodeSchema>;
export type GraphNode = z.infer<typeof GraphNodeSchema>;
export type EdgeKind = z.infer<typeof EdgeKindSchema>;
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;
export type ObservationStatus = z.infer<typeof ObservationStatusSchema>;
export type ImportObservation = z.infer<typeof ImportObservationSchema>;
export type Diagnostic = z.infer<typeof DiagnosticSchema>;
export type NodeMetrics = z.infer<typeof NodeMetricsSchema>;
export type GraphSnapshot = z.infer<typeof GraphSnapshotSchema>;
