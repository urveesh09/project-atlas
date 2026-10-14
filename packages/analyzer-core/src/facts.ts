import { EXTRACTOR_VERSION, PARSER_VERSION, failedFacts, type FileFacts } from '@atlas/analyzer-ts';
import { PYTHON_EXTRACTOR_VERSION, PYTHON_PARSER_VERSION, failedPythonFacts, isPythonSourcePath, type PythonFacts } from '@atlas/analyzer-py';

/**
 * Syntax facts from any language adapter (ADR-058). TS/JS and Python facts share one shape;
 * Python adds the names a from-import binds and whether an import is guarded.
 */
export type SyntaxFacts = FileFacts | PythonFacts;

/** Every parser the analyzer uses, recorded in manifests and analysis keys (at most 64 characters). */
export const PARSER_VERSIONS = `${PARSER_VERSION} ${PYTHON_PARSER_VERSION}`;
export const EXTRACTOR_VERSIONS = `${EXTRACTOR_VERSION} ${PYTHON_EXTRACTOR_VERSION}`;

/** A failed parse in the right language's shape (deadlines and crashes in the pool). */
export function failedSyntaxFacts(path: string, text: string, reason: 'PARSE_TIMEOUT' | 'PARSER_CRASHED' | 'PARSER_STACK_LIMIT'): SyntaxFacts {
  return isPythonSourcePath(path) ? failedPythonFacts(text, reason) : failedFacts(path, text, reason);
}
