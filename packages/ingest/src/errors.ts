/**
 * Ingestion failures carry stable codes (plan §8, §13.5). Messages are ATLAS-authored and
 * never include raw Git stderr, credentials or absolute machine paths.
 */
export type IngestErrorCode =
  | 'NOT_A_GIT_REPOSITORY'
  | 'LOCAL_OBJECT_STORE_UNSUPPORTED'
  | 'LOCAL_OBJECT_MISSING'
  | 'EMPTY_REPOSITORY'
  | 'REF_INVALID'
  | 'REF_NOT_FOUND'
  | 'REF_NOT_COMMIT'
  | 'GIT_UNAVAILABLE'
  | 'GIT_FAILED'
  | 'RESOURCE_LIMIT'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'INVALID_REPOSITORY_URL'
  | 'REPOSITORY_NOT_FOUND'
  | 'REPOSITORY_NOT_PUBLIC'
  | 'REPOSITORY_MOVED'
  | 'COMMIT_NOT_ACCESSIBLE'
  | 'UPSTREAM_RATE_LIMITED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'REPOSITORY_TOO_LARGE';

export class IngestError extends Error {
  constructor(
    readonly code: IngestErrorCode,
    message: string,
    readonly details: Readonly<Record<string, string | number | boolean>> = {},
  ) {
    super(message);
    this.name = 'IngestError';
  }
}

export function isIngestError(error: unknown, code?: IngestErrorCode): error is IngestError {
  return error instanceof IngestError && (code === undefined || error.code === code);
}
