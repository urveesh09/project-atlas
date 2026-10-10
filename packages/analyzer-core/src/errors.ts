/** Analysis failures with stable codes (plan §13.5); messages never contain source or absolute paths. */
export type AnalysisErrorCode = 'ANALYSIS_RESOURCE_LIMIT' | 'EMPTY_REPOSITORY' | 'CANCELLED' | 'INTERNAL_ERROR';

export class AnalysisError extends Error {
  constructor(
    readonly code: AnalysisErrorCode,
    message: string,
    readonly details: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = 'AnalysisError';
  }
}
