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
  language: z.enum(['typescript', 'javascript', 'python']).nullable(),
  role: FileRoleSchema,
  byteSize: CountSchema,
  parseStatus: ParseStatusSchema,
  declarations: z.array(DeclarationSummarySchema).max(LIMITS.declarationsPerFile),
  declarationsOmitted: CountSchema,
});

export const ExternalPackageNodeSchema = z.strictObject({
  ...nodeBase,
  kind: z.literal('external-package'),
  /** npm packages, or PyPI distributions (ADR-060) by their PEP 503 normalized name. */
  ecosystem: z.enum(['npm', 'pypi']),
  packageName: LabelSchema,
  declaredRanges: z.array(DeclaredRangeSchema).max(1024),
});

export const BuiltinNodeSchema = z.strictObject({
  ...nodeBase,
  kind: z.literal('builtin'),
  moduleName: LabelSchema,
  /** Absent for Node.js built-ins (the original meaning); `python` for the Python standard library and other runtimes' modules (ADR-060). */
  runtime: z.literal('python').optional(),
});

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

export interface CodeLabels {
  /** The analyzed languages: "TS/JS", "Python" or "TS/JS and Python". */
  code: string;
  /** Resolved external packages and built-ins, as long and short labels. */
  packages: string;
  packagesShort: string;
  builtins: string;
  builtinsShort: string;
}

/**
 * Labels naming what a snapshot analyzed (ADR-060). Coverage counts packages and built-ins
 * across ecosystems, so their labels name the ecosystems present. A snapshot without Python
 * keeps the original TS/JS wording.
 */
export function codeLabels(nodes: readonly GraphNode[]): CodeLabels {
  let tsjs = false;
  let python = false;
  for (const n of nodes) {
    if (n.kind === 'file') {
      if (n.language === 'python') python = true;
      else if (n.language !== null) tsjs = true;
    } else if (n.kind === 'external-package') {
      if (n.ecosystem === 'pypi') python = true;
      else tsjs = true;
    } else if (n.kind === 'builtin') {
      if (n.runtime === 'python') python = true;
      else tsjs = true;
    }
  }
  if (!python) return { code: 'TS/JS', packages: 'npm packages', packagesShort: 'npm', builtins: 'Node.js built-ins', builtinsShort: 'node' };
  if (!tsjs) return { code: 'Python', packages: 'PyPI packages', packagesShort: 'PyPI', builtins: 'Python built-ins', builtinsShort: 'built-in' };
  return { code: 'TS/JS and Python', packages: 'npm and PyPI packages', packagesShort: 'packages', builtins: 'Node.js and Python built-ins', builtinsShort: 'built-in' };
}

/** The fields that identify a node occurrence; wire rows without IDs carry them too. */
export type NodeIdentity =
  | { kind: 'repository' }
  | { kind: 'package' | 'directory' | 'file'; path: string }
  | { kind: 'external-package'; ecosystem: 'npm' | 'pypi'; packageName: string }
  | { kind: 'builtin'; moduleName: string; runtime?: 'python' | undefined };

/**
 * The canonical key hashed into a node occurrence ID (plan §7.1). The validator and both
 * graph wire encodings derive IDs through this one function. Python perimeter nodes carry
 * their ecosystem or runtime, so PyPI `six` and npm `six` stay distinct (ADR-060); npm and
 * Node.js keys are unchanged.
 */
export function nodeIdentityKey(node: NodeIdentity): string {
  switch (node.kind) {
    case 'repository':
      return '';
    case 'external-package':
      return node.ecosystem === 'pypi' ? `pypi:${node.packageName}` : node.packageName;
    case 'builtin':
      return node.runtime === 'python' ? `python:${node.moduleName}` : node.moduleName;
    default:
      return node.path;
  }
}

/**
 * Canonical perimeter name of an external package or built-in, shared by layout anchors,
 * frame comparison and the viewer (ADR-060): `npm:react`, `builtin:fs`, and for Python
 * `pypi:requests` and `builtin:python:os`. TS/JS names are unchanged.
 */
export function perimeterName(node: { kind: 'external-package'; ecosystem: 'npm' | 'pypi'; packageName: string } | { kind: 'builtin'; moduleName: string; runtime?: 'python' | undefined }): string {
  if (node.kind === 'external-package') return `${node.ecosystem}:${node.packageName}`;
  return node.runtime === 'python' ? `builtin:python:${node.moduleName}` : `builtin:${node.moduleName}`;
}
