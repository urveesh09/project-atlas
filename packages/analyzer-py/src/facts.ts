import type { DeclarationSummary, SourceRange } from '@atlas/schema';

/**
 * Python syntax facts (ADR-056). The record has the same shape and meaning as the TS/JS
 * adapter's facts, so the rest of the analyzer treats every language alike. Python adds the
 * names a from-import binds (a name can be a submodule) and whether an import is guarded.
 */
export type PyImportKind = 'imports-value' | 'imports-type' | 'reexports-value' | 'reexports-type' | 'imports-dynamic-literal';

export interface PyImportedName {
  name: string;
  alias: string | null;
  range: SourceRange;
}

export interface PyRawImport {
  kind: PyImportKind;
  /** `a.b` or `..a.b` (leading dots are the relative level); null for a non-literal dynamic import. */
  specifier: string | null;
  range: SourceRange;
  usage: 'import' | 'dynamic';
  unsupportedReason: 'NONLITERAL_DYNAMIC_IMPORT' | 'RELATIVE_DYNAMIC_IMPORT_WITHOUT_PACKAGE' | null;
  attributeType: null;
  /** Names bound by `from m import …`; null for `import m` and dynamic imports. */
  names: PyImportedName[] | null;
  /** `from m import *`. */
  wildcard: boolean;
  /** Inside a `try` whose handlers catch ImportError, ModuleNotFoundError, Exception or anything. */
  guarded: boolean;
}

export type DecisionKind = 'if' | 'loop' | 'catch' | 'conditional' | 'case' | 'logical';

export interface CallableFacts {
  name: string;
  /** TS vocabulary: a lambda is recorded as `arrow`, its closest counterpart. */
  kind: 'function' | 'method' | 'constructor' | 'getter' | 'setter' | 'arrow';
  range: SourceRange;
  complexity: number;
  contributions: Record<DecisionKind, number>;
}

export interface ComplexitySummary {
  callableCount: number;
  maxCyclomatic: number;
  sumCyclomatic: number;
}

export interface ParseError {
  /** tree-sitter reports no error codes: 1 = unexpected syntax (ERROR), 2 = missing token (MISSING). */
  code: number;
  range: SourceRange;
}

export type ParseFailureReason = 'SYNTAX_ERROR' | 'PARSER_STACK_LIMIT' | 'PARSE_TIMEOUT' | 'PARSER_CRASHED';

export interface PythonFacts {
  language: 'python';
  parseStatus: 'parsed' | 'failed';
  failureReason: ParseFailureReason | null;
  parseErrors: ParseError[];
  /** Empty when parsing failed: no dependency claims are made from malformed trees. */
  imports: PyRawImport[];
  declarations: DeclarationSummary[];
  declarationsOmitted: number;
  physicalLines: number;
  codeLines: number | null;
  complexity: ComplexitySummary | null;
  callables: CallableFacts[];
  callablesOmitted: number;
}
