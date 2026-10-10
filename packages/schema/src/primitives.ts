import { z } from 'zod';
import { utf8ByteLength } from './canonical.js';
import { idPattern, type IdKind } from './ids.js';
import { LIMITS } from './limits.js';
import { checkRepoPath } from './paths.js';

export const idSchema = (kind: IdKind) => z.string().regex(idPattern(kind), `Expected a ${kind} ID`);

export const RepositoryIdSchema = idSchema('repository');
export const SnapshotIdSchema = idSchema('snapshot');
export const NodeIdSchema = idSchema('node');
export const LineageIdSchema = idSchema('lineage');
export const ObservationIdSchema = idSchema('observation');
export const EdgeIdSchema = idSchema('edge');
export const DiagnosticIdSchema = idSchema('diagnostic');
export const SccIdSchema = idSchema('scc');
export const DistrictIdSchema = idSchema('district');
export const LayoutIdSchema = idSchema('layout');
export const HistoryIdSchema = idSchema('history');
export const AnalysisKeySchema = idSchema('analysisKey');
export const AnalysisIdSchema = idSchema('analysis');

export const Hex64Schema = z.string().regex(/^[0-9a-f]{64}$/, 'Expected 64 lowercase hex characters');
export const GitOidSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, 'Expected a full Git object ID');

export const boundedString = (maxBytes: number) =>
  z
    .string()
    .refine((s) => s.isWellFormed(), 'Ill-formed Unicode')
    .refine((s) => utf8ByteLength(s) <= maxBytes, `Exceeds ${maxBytes} UTF-8 bytes`);

export const LabelSchema = boundedString(LIMITS.labelBytes);

export const RepoPathSchema = z.string().superRefine((value, ctx) => {
  const check = checkRepoPath(value);
  if (!check.ok) ctx.addIssue({ code: 'custom', message: `Invalid repository path: ${check.reason}` });
});

/** Package hierarchy paths additionally allow '' for the synthetic root package. */
export const PackagePathSchema = z.union([z.literal(''), RepoPathSchema]);

export const IsoUtcSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/, 'Expected an ISO 8601 UTC timestamp');

export const CountSchema = z.number().int().nonnegative();
export const NullableCountSchema = CountSchema.nullable();

export const AvailabilitySchema = z.enum(['complete', 'partial', 'unavailable']);
export const ConfidenceSchema = z.enum(['exact', 'inferred', 'heuristic']);

export const CodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/, 'Expected an UPPER_SNAKE code');

/**
 * Reserved extension namespace (plan §1.3, §6.1). Keys are dotted namespaces; values are
 * opaque JSON that consumers may ignore. No V0.1 producer writes extensions.
 */
export const ExtensionsSchema = z
  .record(z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/), z.json())
  .refine((value) => Object.keys(value).length <= 16, 'At most 16 extension namespaces');

export const SourceRangeSchema = z
  .strictObject({
    startOffset: CountSchema,
    endOffset: CountSchema,
    startLine: z.number().int().min(1),
    startColumn: z.number().int().min(1),
    endLine: z.number().int().min(1),
    endColumn: z.number().int().min(1),
  })
  .refine((r) => r.startOffset <= r.endOffset, 'startOffset must not exceed endOffset')
  .refine(
    (r) => r.startLine < r.endLine || (r.startLine === r.endLine && r.startColumn <= r.endColumn),
    'Range end must not precede its start',
  );

export type Availability = z.infer<typeof AvailabilitySchema>;
export type Confidence = z.infer<typeof ConfidenceSchema>;
export type SourceRange = z.infer<typeof SourceRangeSchema>;
