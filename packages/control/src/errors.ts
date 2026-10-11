import { isIngestError, type IngestError } from '@atlas/ingest';
import type { ErrorCode } from '@atlas/schema';

/** A caller-visible failure: stable code, HTTP status and an ATLAS-authored message (plan §13.5). */
export class ServiceError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    message: string,
    readonly retryAfter?: number,
    readonly details: Readonly<Record<string, string | number | boolean>> = {},
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

/**
 * Map an acquisition failure to its public code. Messages are fixed text: upstream
 * bodies, stderr and URLs never reach a caller, and a private repository is reported
 * exactly like a missing one.
 */
export function fromIngestError(error: IngestError): ServiceError {
  switch (error.code) {
    case 'INVALID_REPOSITORY_URL':
      return new ServiceError('INVALID_REPOSITORY_URL', 400, 'Use a public GitHub repository root URL.');
    case 'REPOSITORY_NOT_FOUND':
    case 'REPOSITORY_NOT_PUBLIC':
      return new ServiceError('REPOSITORY_NOT_FOUND', 404, 'The repository was not found or is not public.');
    case 'REPOSITORY_MOVED':
      return new ServiceError('REPOSITORY_MOVED', 409, 'The repository was renamed or transferred; submit its current URL.');
    case 'EMPTY_REPOSITORY':
      return new ServiceError('EMPTY_REPOSITORY', 409, 'The repository is empty or has no default branch commit.');
    case 'COMMIT_NOT_ACCESSIBLE':
    case 'REF_INVALID':
    case 'REF_NOT_FOUND':
    case 'REF_NOT_COMMIT':
      return new ServiceError('COMMIT_NOT_ACCESSIBLE', 404, 'The commit is not accessible on the default branch of this repository.');
    case 'UPSTREAM_RATE_LIMITED': {
      const retry = Number(error.details['retryAfterSeconds'] ?? 60);
      return new ServiceError('UPSTREAM_RATE_LIMITED', 503, 'GitHub is rate limiting requests; try again later.', Number.isFinite(retry) ? Math.min(Math.max(Math.ceil(retry), 1), 3600) : 60);
    }
    case 'REPOSITORY_TOO_LARGE':
      return new ServiceError('REPOSITORY_TOO_LARGE', 413, 'Repository acquisition exceeded the V0.1 transfer limit.', undefined, { limitMiB: 256 });
    case 'RESOURCE_LIMIT':
    case 'TIMEOUT':
      return new ServiceError('ANALYSIS_RESOURCE_LIMIT', 413, 'The job exceeded a V0.1 resource limit.');
    case 'UPSTREAM_UNAVAILABLE':
      return new ServiceError('UPSTREAM_UNAVAILABLE', 503, 'GitHub is unavailable; try again later.', 30);
    default:
      return new ServiceError('INTERNAL_ERROR', 503, 'The service is temporarily unavailable.');
  }
}

export function toServiceError(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
  if (isIngestError(error)) return fromIngestError(error);
  return new ServiceError('INTERNAL_ERROR', 503, 'The service is temporarily unavailable.');
}
