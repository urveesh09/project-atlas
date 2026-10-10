import { z } from 'zod';
import { LIMITS } from './limits.js';
import { AnalysisIdSchema, CountSchema, IsoUtcSchema } from './primitives.js';
import { RELEASE_PROFILE } from './versions.js';

/** Hosted HTTP contracts (plan §13). Routes are prefixed with /api/v1. */
export const ERROR_CODES = [
  'INVALID_REPOSITORY_URL',
  'REPOSITORY_NOT_PUBLIC',
  'REPOSITORY_NOT_FOUND',
  'REPOSITORY_MOVED',
  'EMPTY_REPOSITORY',
  'COMMIT_NOT_ACCESSIBLE',
  'UPSTREAM_RATE_LIMITED',
  'UPSTREAM_UNAVAILABLE',
  'REPOSITORY_TOO_LARGE',
  'ANALYSIS_RESOURCE_LIMIT',
  'UNSUPPORTED_SCHEMA',
  'ARTIFACT_INVALID',
  'JOB_CANCELLED',
  'ARTIFACT_EXPIRED',
  'ARTIFACT_REVOKED',
  'FORBIDDEN',
  'VALIDATION_FAILED',
  'IDEMPOTENCY_CONFLICT',
  'QUOTA_EXCEEDED',
  'INTERNAL_ERROR',
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const JobIdSchema = z.string().regex(/^job_[0-9a-f]{32}$/);
export const RequestIdSchema = z.string().regex(/^req_[0-9a-f]{32}$/);

export const ErrorEnvelopeSchema = z.strictObject({
  error: z.strictObject({
    code: ErrorCodeSchema,
    message: z.string().max(512),
    retryable: z.boolean(),
    details: z.record(z.string().max(64), z.union([z.string().max(256), z.number(), z.boolean()])),
    requestId: RequestIdSchema,
  }),
});

export const AnalysisSubmissionSchema = z.strictObject({
  repositoryUrl: z.string().min(1).max(512),
  commitSha: z
    .string()
    .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
    .nullable(),
  profile: z.literal(RELEASE_PROFILE),
  history: z.strictObject({ enabled: z.boolean() }),
  publication: z.literal('public-expiring'),
});

export const JOB_STATES = [
  'QUEUED',
  'ACQUIRING',
  'ANALYZING',
  'HISTORY',
  'LAYOUT',
  'VALIDATING',
  'READY',
  'PARTIAL',
  'CANCEL_REQUESTED',
  'CANCELLED',
  'FAILED',
] as const;
export const JobStateNameSchema = z.enum(JOB_STATES);
export type JobStateName = z.infer<typeof JobStateNameSchema>;

export const AnalysisAcceptedSchema = z.strictObject({
  jobId: JobIdSchema,
  state: JobStateNameSchema,
  managementToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/).nullable(),
  statusUrl: z.string().startsWith('/api/v1/jobs/'),
  eventsUrl: z.string().startsWith('/api/v1/jobs/'),
  analysisId: AnalysisIdSchema.nullable(),
});

export const JobStatusSchema = z.strictObject({
  jobId: JobIdSchema,
  revision: CountSchema,
  state: JobStateNameSchema,
  stage: z.enum(['validate', 'acquire', 'index', 'analyze', 'history', 'layout', 'publish']).nullable(),
  queuePosition: CountSchema.nullable(),
  counts: z.record(z.string().regex(/^[a-zA-Z]{1,32}$/), CountSchema),
  warnings: z.array(z.strictObject({ code: z.string().max(64), count: CountSchema })).max(64),
  analysisId: AnalysisIdSchema.nullable(),
  error: ErrorEnvelopeSchema.shape.error.nullable(),
  updatedAt: IsoUtcSchema,
});

export const CapabilitiesSchema = z.strictObject({
  service: z.literal('atlas'),
  apiVersion: z.literal('v1'),
  schemaVersions: z.strictObject({
    graph: z.string(),
    layout: z.string(),
    artifact: z.string(),
    metrics: z.string(),
  }),
  profiles: z.array(z.literal(RELEASE_PROFILE)),
  languages: z.array(
    z.strictObject({
      id: z.string(),
      extensions: z.array(z.string()),
      capabilities: z.array(z.enum(['syntax', 'imports', 'declarations', 'complexity'])),
    }),
  ),
  limits: z.record(z.string(), z.number()),
  repositorySources: z.array(z.enum(['public-github'])),
});

export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
export type AnalysisSubmission = z.infer<typeof AnalysisSubmissionSchema>;
export type AnalysisAccepted = z.infer<typeof AnalysisAcceptedSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

export const API_REQUEST_BODY_LIMIT = LIMITS.apiRequestBodyBytes;
