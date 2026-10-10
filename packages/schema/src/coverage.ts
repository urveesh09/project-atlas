import { z } from 'zod';
import { LIMITS } from './limits.js';
import { AvailabilitySchema, CodeSchema, CountSchema, GitOidSchema, RepoPathSchema } from './primitives.js';

/**
 * Coverage is data (plan §4.3, §6.4). Absent metrics are never zero; every omission is a
 * counted reason.
 */
export const SnapshotCoverageSchema = z.strictObject({
  discoveredFiles: CountSchema,
  includedFiles: CountSchema,
  supportedFiles: CountSchema,
  parsedFiles: CountSchema,
  parseFailedFiles: CountSchema,
  opaqueFiles: CountSchema,
  excludedFiles: CountSchema,
  omittedFiles: CountSchema,
  observedImports: CountSchema,
  internalResolved: CountSchema,
  externalResolved: CountSchema,
  builtinResolved: CountSchema,
  unresolved: CountSchema,
  unsupported: CountSchema,
  excludedTargets: CountSchema,
  reasons: z.array(z.strictObject({ code: CodeSchema, count: z.number().int().positive() })).max(512),
  limitsHit: z.array(CodeSchema).max(64),
  warnings: z
    .array(z.strictObject({ code: CodeSchema, path: RepoPathSchema.nullable() }))
    .max(LIMITS.coverageWarnings),
});

export const HistoryBoundarySchema = z.enum(['root', 'days', 'commit-cap', 'shallow', 'resource-cap', 'none']);

export const HistoryCoverageSchema = z.strictObject({
  status: AvailabilitySchema,
  requestedDays: z.number().int().min(0).max(LIMITS.historyLookbackDays),
  requestedCommitCap: z.number().int().min(0).max(LIMITS.firstParentCommits),
  commitsTraversed: CountSchema,
  framesRequested: z.number().int().min(0).max(LIMITS.analyzedFrames),
  framesCompleted: z.number().int().min(0).max(LIMITS.analyzedFrames),
  boundary: HistoryBoundarySchema,
  oldestOid: GitOidSchema.nullable(),
  newestOid: GitOidSchema,
  renameDetection: AvailabilitySchema,
  lineDiffs: AvailabilitySchema,
  coChange: AvailabilitySchema,
});

export const AnalysisCoverageSchema = z.strictObject({
  head: SnapshotCoverageSchema,
  history: HistoryCoverageSchema,
});

export type SnapshotCoverage = z.infer<typeof SnapshotCoverageSchema>;
export type HistoryCoverage = z.infer<typeof HistoryCoverageSchema>;
export type AnalysisCoverage = z.infer<typeof AnalysisCoverageSchema>;

export function emptySnapshotCoverage(): SnapshotCoverage {
  return {
    discoveredFiles: 0,
    includedFiles: 0,
    supportedFiles: 0,
    parsedFiles: 0,
    parseFailedFiles: 0,
    opaqueFiles: 0,
    excludedFiles: 0,
    omittedFiles: 0,
    observedImports: 0,
    internalResolved: 0,
    externalResolved: 0,
    builtinResolved: 0,
    unresolved: 0,
    unsupported: 0,
    excludedTargets: 0,
    reasons: [],
    limitsHit: [],
    warnings: [],
  };
}
