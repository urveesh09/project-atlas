import type { Diagnostic } from './graph.js';

/**
 * The built-in rule catalog (plan §10.2), shared by the analyzer and the viewer.
 * Diagnostics carry only a rule ID, a message code and bounded parameters; every
 * human-readable sentence is authored here, never taken from repository content.
 * Thresholds are versioned product defaults, not universal quality standards.
 */
export type RuleId =
  | 'ATLAS_PARSE_ERROR'
  | 'ATLAS_LOCAL_IMPORT_UNRESOLVED'
  | 'ATLAS_RESOLUTION_CONTEXT_INCOMPLETE'
  | 'ATLAS_STATIC_CYCLE'
  | 'ATLAS_COMPLEX_CALLABLE'
  | 'ATLAS_LARGE_SOURCE_FILE'
  | 'ATLAS_HIGH_FAN_IN'
  | 'ATLAS_CHANGE_CONCENTRATION'
  | 'ATLAS_ANALYSIS_LIMIT';

export interface RuleDefinition {
  id: RuleId;
  version: number;
  severity: Diagnostic['severity'];
  category: Diagnostic['category'];
  title: string;
  /** What the finding means and, as importantly, what it does not mean. */
  explanation: string;
  thresholds: Record<string, number>;
}

export const RULE_THRESHOLDS = Object.freeze({
  complexCallable: 20,
  largeSourceFileCodeLines: 500,
  highFanIn: 20,
  changeConcentrationCommits: 10,
  percentile: 0.95,
});

export const RULE_CATALOG: Readonly<Record<RuleId, RuleDefinition>> = Object.freeze({
  ATLAS_PARSE_ERROR: {
    id: 'ATLAS_PARSE_ERROR',
    version: 1,
    severity: 'error',
    category: 'parse',
    title: 'File could not be parsed',
    explanation: 'The pinned parser for its language (TypeScript, or tree-sitter for Python) could not read this file, so ATLAS makes no dependency or complexity claims about it. This describes the analysis input, not a failing build.',
    thresholds: {},
  },
  ATLAS_LOCAL_IMPORT_UNRESOLVED: {
    id: 'ATLAS_LOCAL_IMPORT_UNRESOLVED',
    version: 1,
    severity: 'warning',
    category: 'resolution',
    title: 'Local import target is missing',
    explanation: 'A relative or configured local import did not match any committed file after config-aware resolution.',
    thresholds: {},
  },
  ATLAS_RESOLUTION_CONTEXT_INCOMPLETE: {
    id: 'ATLAS_RESOLUTION_CONTEXT_INCOMPLETE',
    version: 1,
    severity: 'info',
    category: 'resolution',
    title: 'Some imports need configuration ATLAS does not execute',
    explanation: 'These imports depend on aliases, generated output or external configuration that ATLAS reads only from safe, committed data. They are not confirmed missing modules.',
    thresholds: {},
  },
  ATLAS_STATIC_CYCLE: {
    id: 'ATLAS_STATIC_CYCLE',
    version: 1,
    severity: 'warning',
    category: 'structure',
    title: 'Static value dependency cycle detected',
    explanation: 'These files import each other through static value imports, re-exports or literal requires. Type-only and dynamic imports are not counted. This is a structural observation, not a runtime deadlock.',
    thresholds: {},
  },
  ATLAS_COMPLEX_CALLABLE: {
    id: 'ATLAS_COMPLEX_CALLABLE',
    version: 1,
    severity: 'warning',
    category: 'complexity',
    title: 'Highly branched function',
    explanation: 'The most complex function in this file has cyclomatic complexity at or above the threshold. The counted decisions are listed so the number can be checked by reading the code.',
    thresholds: { complexity: RULE_THRESHOLDS.complexCallable },
  },
  ATLAS_LARGE_SOURCE_FILE: {
    id: 'ATLAS_LARGE_SOURCE_FILE',
    version: 1,
    severity: 'info',
    category: 'complexity',
    title: 'Large source file',
    explanation: 'This source file has many lines of code. Size alone is context, not a defect.',
    thresholds: { codeLines: RULE_THRESHOLDS.largeSourceFileCodeLines },
  },
  ATLAS_HIGH_FAN_IN: {
    id: 'ATLAS_HIGH_FAN_IN',
    version: 1,
    severity: 'info',
    category: 'structure',
    title: 'Many files depend on this file',
    explanation: 'This file has unusually many direct value consumers for this repository. A widely used, well-designed shared module will appear here too; it is a candidate for careful review of changes, not a problem in itself.',
    thresholds: { fanIn: RULE_THRESHOLDS.highFanIn, percentile: RULE_THRESHOLDS.percentile },
  },
  ATLAS_CHANGE_CONCENTRATION: {
    id: 'ATLAS_CHANGE_CONCENTRATION',
    version: 1,
    severity: 'info',
    category: 'history',
    title: 'Changes concentrate here',
    explanation:
      'This file changed in unusually many first-parent (mainline) commits of the bounded analysis window, counted up to the frame shown. Mainline changes can bundle several people\'s work; frequent change can reflect active development as much as instability. Requires usable history.',
    thresholds: { changedCommits: RULE_THRESHOLDS.changeConcentrationCommits, percentile: RULE_THRESHOLDS.percentile },
  },
  ATLAS_ANALYSIS_LIMIT: {
    id: 'ATLAS_ANALYSIS_LIMIT',
    version: 1,
    severity: 'info',
    category: 'coverage',
    title: 'Analysis limit reached',
    explanation: 'A documented resource limit omitted part of the analysis. Omitted items are counted in coverage.',
    thresholds: {},
  },
});

const REASONS: Record<string, string> = {
  LOCAL_TARGET_MISSING: 'no committed file matches',
  CASE_MISMATCH: 'a file exists with different letter case',
  ALIAS_UNSUPPORTED: 'an alias not declared in safe configuration',
  CONFIG_CONTEXT_MISSING: 'configuration context is missing or extends an external package',
  GENERATED_TARGET_MISSING: 'the target is uncommitted build output',
  PACKAGE_EXPORT_UNSUPPORTED: 'the package export could not be mapped',
  AMBIGUOUS_WORKSPACE_PACKAGE: 'two workspace packages share this name',
  SYNTAX_ERROR: 'syntax error',
  PARSE_TIMEOUT: 'parsing exceeded its time limit',
  PARSER_CRASHED: 'the parser process stopped unexpectedly',
  PARSER_STACK_LIMIT: 'nesting is too deep for the parser',
  // Python (ADR-057, ADR-060)
  RELATIVE_BEYOND_TOP_LEVEL: 'the relative import climbs above its top-level package',
  OPTIONAL_TARGET_MISSING: 'an optional (guarded) import whose target is not committed',
  NAMESPACE_PACKAGE: 'a namespace package has no file of its own',
  STDLIB_SHADOWED: 'a module in the script directory shadows the standard library',
  WORKSPACE_PROJECT_MODULE: 'found in another project of this repository',
  REPOSITORY_ROOT_MODULE: 'found at the repository root, outside the project roots',
  AMBIGUOUS_MODULE_ROOT: 'more than one import root has this module',
  PYTHON2_STDLIB: 'a Python 2 standard-library module',
  PYPY_BUILTIN: 'a PyPy built-in module',
  TYPESHED_ONLY: 'a module that exists only for type checkers',
  OPTIONAL_EXTERNAL_IMPORT: 'an optional (guarded) import of an undeclared distribution',
  RELATIVE_DYNAMIC_IMPORT_WITHOUT_PACKAGE: 'a relative import_module without a known package',
};

export function describeReason(code: string): string {
  return REASONS[code] ?? code.toLowerCase().replaceAll('_', ' ');
}

const str = (v: string | number | undefined) => (v === undefined ? '' : String(v));

/** Render a diagnostic as plain text from ATLAS-authored templates (never HTML). */
export function formatDiagnosticMessage(diagnostic: Pick<Diagnostic, 'messageCode' | 'parameters'>): string {
  const p = diagnostic.parameters;
  switch (diagnostic.messageCode) {
    case 'PARSE_ERROR':
      return `Syntax error TS${str(p['tsCode'])}${Number(p['errorCount']) > 1 ? ` (and ${Number(p['errorCount']) - 1} more)` : ''}; no dependency or complexity facts were extracted.`;
    case 'PYTHON_SYNTAX_ERROR':
      return `Python syntax error at line ${str(p['line'])}${Number(p['missingToken']) === 1 ? ' (a token is missing)' : ''}${Number(p['errorCount']) > 1 ? ` (and ${Number(p['errorCount']) - 1} more)` : ''}; no dependency or complexity facts were extracted.`;
    case 'PARSE_FAILED':
      return `Not parsed: ${describeReason(str(p['reason']))}.`;
    case 'LOCAL_IMPORT_UNRESOLVED':
      return `"${str(p['specifier'])}" did not resolve: ${describeReason(str(p['reason']))}.`;
    case 'RESOLUTION_CONTEXT_INCOMPLETE':
      return `${str(p['count'])} import${Number(p['count']) === 1 ? '' : 's'} could not be resolved from safe configuration (${str(p['reasons']).split(',').map(describeReason).join('; ')}).`;
    case 'STATIC_CYCLE':
      return `${str(p['size'])} file${Number(p['size']) === 1 ? ' imports itself' : 's import each other'} under the static value-edge policy: ${str(p['witness'])}.`;
    case 'COMPLEX_CALLABLE':
      return `${str(p['callable'])} has cyclomatic complexity ${str(p['complexity'])} (threshold ${str(p['threshold'])}): ${str(p['breakdown'])}.`;
    case 'LARGE_SOURCE_FILE':
      return `${str(p['codeLines'])} lines of code (threshold ${str(p['threshold'])}).`;
    case 'HIGH_FAN_IN':
      return `${str(p['fanIn'])} files depend on this file directly (threshold ${str(p['threshold'])}; repository 95th percentile ${str(p['p95'])} across ${str(p['cohort'])} source files).`;
    case 'CHANGE_CONCENTRATION':
      return `Changed in ${str(p['changedCommits'])} of ${str(p['windowCommits'])} analyzed mainline commits up to this frame (threshold ${str(p['threshold'])}; repository 95th percentile ${str(p['p95'])} across ${str(p['cohort'])} source files with history).`;
    case 'ANALYSIS_LIMIT':
      return `${str(p['limit'])}: ${str(p['count'])} item${Number(p['count']) === 1 ? '' : 's'} omitted during ${str(p['stage'])}.`;
    default:
      return diagnostic.messageCode.toLowerCase().replaceAll('_', ' ');
  }
}
