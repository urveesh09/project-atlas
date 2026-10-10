import { z } from 'zod';
import { AnalysisAcceptedSchema, AnalysisSubmissionSchema, CapabilitiesSchema, ErrorEnvelopeSchema, JobStatusSchema } from './api.js';
import { ArtifactManifestSchema } from './artifact.js';
import { GraphSnapshotSchema } from './graph.js';
import { HistoryArtifactSchema } from './history.js';
import { LayoutArtifactSchema } from './layout.js';
import { LIMITS } from './limits.js';
import { ARTIFACT_VERSION, GRAPH_SCHEMA_VERSION, LAYOUT_VERSION, METRIC_DEFINITION_VERSION } from './versions.js';

/**
 * JSON Schema and OpenAPI are generated from the runtime schemas, which remain the single
 * definition (plan §5.2). Semantic invariants (sorting, references, coverage arithmetic,
 * geometry) are enforced by the runtime validators and are not expressible here.
 */
const ARTIFACT_SCHEMAS = {
  'graph-snapshot': GraphSnapshotSchema,
  'history-artifact': HistoryArtifactSchema,
  'layout-artifact': LayoutArtifactSchema,
  'artifact-manifest': ArtifactManifestSchema,
} as const;

const API_SCHEMAS = {
  AnalysisSubmission: AnalysisSubmissionSchema,
  AnalysisAccepted: AnalysisAcceptedSchema,
  JobStatus: JobStatusSchema,
  ErrorEnvelope: ErrorEnvelopeSchema,
  Capabilities: CapabilitiesSchema,
} as const;

function convert(schema: z.ZodType, io: 'input' | 'output' = 'output'): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'any', io }) as Record<string, unknown>;
}

export function artifactJsonSchemas(): Record<string, Record<string, unknown>> {
  const versions: Record<string, string> = {
    'graph-snapshot': GRAPH_SCHEMA_VERSION,
    'history-artifact': GRAPH_SCHEMA_VERSION,
    'layout-artifact': LAYOUT_VERSION,
    'artifact-manifest': ARTIFACT_VERSION,
  };
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, schema] of Object.entries(ARTIFACT_SCHEMAS)) {
    out[name] = {
      $id: `https://atlas.invalid/schemas/${name}.schema.json`,
      title: `ATLAS ${name} (${versions[name]})`,
      $comment: 'Generated from @atlas/schema. Runtime validators additionally enforce ordering, references, coverage arithmetic and geometry invariants.',
      ...convert(schema),
    };
  }
  return out;
}

export function openApiDocument(): Record<string, unknown> {
  const schemas: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(API_SCHEMAS)) {
    const { $schema: _ignored, ...rest } = convert(schema, name === 'AnalysisSubmission' ? 'input' : 'output');
    schemas[name] = rest;
  }
  const error = (description: string) => ({ description, content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } } });
  const jobId = { name: 'jobId', in: 'path', required: true, schema: { type: 'string', pattern: '^job_[0-9a-f]{32}$' } };
  const analysisId = { name: 'analysisId', in: 'path', required: true, schema: { type: 'string', pattern: '^analysis_[0-9a-f]{64}$' } };
  const management = [{ managementToken: [] }, { session: [] }];
  return {
    openapi: '3.1.0',
    info: {
      title: 'ATLAS hosted API',
      version: '1.0.0',
      description: `Plan §13. Contract versions: ${GRAPH_SCHEMA_VERSION}, ${LAYOUT_VERSION}, ${ARTIFACT_VERSION}, ${METRIC_DEFINITION_VERSION}. Request bodies are limited to ${LIMITS.apiRequestBodyBytes} bytes. Implemented in Phase 5; this document is the initial contract.`,
    },
    servers: [{ url: '/api/v1' }],
    components: {
      schemas,
      securitySchemes: {
        managementToken: { type: 'http', scheme: 'bearer', description: 'Management capability returned once at admission; never placed in URLs.' },
        session: { type: 'apiKey', in: 'cookie', name: '__Host-atlas-session', description: 'HttpOnly same-origin session bound to a management capability.' },
      },
    },
    paths: {
      '/analyses': {
        post: {
          operationId: 'submitAnalysis',
          parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/AnalysisSubmission' } } } },
          responses: {
            '200': { description: 'Completed cached analysis reused', content: { 'application/json': { schema: { $ref: '#/components/schemas/AnalysisAccepted' } } } },
            '202': { description: 'Job queued', content: { 'application/json': { schema: { $ref: '#/components/schemas/AnalysisAccepted' } } } },
            '400': error('Invalid submission or repository URL'),
            '403': error('Policy violation'),
            '404': error('Repository not found or not public'),
            '409': error('Idempotency conflict'),
            '413': error('Request or repository exceeds limits'),
            '429': error('Quota exceeded (Retry-After)'),
            '503': error('Upstream or service unavailable (Retry-After)'),
          },
        },
      },
      '/jobs/{jobId}': {
        get: {
          operationId: 'getJob',
          parameters: [jobId],
          security: management,
          responses: { '200': { description: 'Job state', content: { 'application/json': { schema: { $ref: '#/components/schemas/JobStatus' } } } }, '403': error('Forbidden'), '404': error('Unknown job') },
        },
      },
      '/jobs/{jobId}/events': {
        get: {
          operationId: 'streamJobEvents',
          parameters: [jobId, { name: 'Last-Event-ID', in: 'header', required: false, schema: { type: 'string' } }],
          security: [{ session: [] }],
          responses: { '200': { description: 'Server-sent events: state, progress, warning, terminal', content: { 'text/event-stream': { schema: { type: 'string' } } } }, '403': error('Forbidden') },
        },
      },
      '/jobs/{jobId}/cancel': {
        post: {
          operationId: 'cancelJob',
          parameters: [jobId],
          security: management,
          responses: { '200': { description: 'Already terminal' }, '202': { description: 'Cancellation accepted' }, '403': error('Forbidden') },
        },
      },
      '/analyses/{analysisId}': {
        get: {
          operationId: 'getManifest',
          parameters: [analysisId],
          responses: {
            '200': { description: 'Artifact manifest', content: { 'application/json': { schema: { $ref: 'https://atlas.invalid/schemas/artifact-manifest.schema.json' } } } },
            '404': error('Unknown analysis'),
            '410': error('Expired, deleted or revoked'),
          },
        },
        delete: {
          operationId: 'deleteAnalysis',
          parameters: [analysisId],
          security: management,
          responses: { '204': { description: 'Publication purged' }, '403': error('Forbidden'), '410': error('Already gone') },
        },
      },
      '/analyses/{analysisId}/chunks/{chunkId}': {
        get: {
          operationId: 'getChunk',
          parameters: [analysisId, { name: 'chunkId', in: 'path', required: true, schema: { type: 'string', pattern: '^[a-z0-9_]{1,80}$' } }],
          responses: { '200': { description: 'Gzip-compressed canonical JSON chunk', content: { 'application/gzip': { schema: { type: 'string', format: 'binary' } } } }, '404': error('Unknown chunk'), '410': error('Expired, deleted or revoked') },
        },
      },
      '/capabilities': {
        get: { operationId: 'getCapabilities', responses: { '200': { description: 'Static service contract', content: { 'application/json': { schema: { $ref: '#/components/schemas/Capabilities' } } } } } },
      },
      '/health/live': { get: { operationId: 'live', responses: { '200': { description: 'Process is alive' } } } },
      '/health/ready': { get: { operationId: 'ready', responses: { '200': { description: 'Ready to admit jobs' }, '503': { description: 'Not ready' } } } },
    },
  };
}
