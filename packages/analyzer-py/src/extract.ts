import { LIMITS, compareAscii, compareUtf8, repoBasename, repoExtension, type DeclarationSummary, type SourceRange } from '@atlas/schema';
import type { Node } from 'web-tree-sitter';
import type { CallableFacts, ComplexitySummary, DecisionKind, ParseError, PyImportKind, PyImportedName, PyRawImport, PythonFacts } from './facts.js';
import { pythonParser } from './parser.js';

/**
 * Python syntax facts (ADR-056), extracted from one tree-sitter tree. Every walk uses an
 * explicit stack, so deeply nested input cannot overflow the call stack, and the tree is
 * freed before returning: callers only ever see plain records.
 */
export const PYTHON_EXTRACTOR_VERSION = 'atlas.extract.python/1';
export const MAX_CALLABLES_RECORDED = 2_000;
export const PYTHON_EXTENSIONS: readonly string[] = ['.py', '.pyi'];

export function isPythonSourcePath(path: string): boolean {
  return PYTHON_EXTENSIONS.includes(repoExtension(path));
}
export function isPythonStubPath(path: string): boolean {
  return repoExtension(path) === '.pyi';
}

const kids = (node: Node): Node[] => node.children.filter((c): c is Node => c !== null);
const named = (node: Node): Node[] => node.namedChildren.filter((c): c is Node => c !== null);
const field = (node: Node, name: string): Node | null => node.childForFieldName(name);
const fields = (node: Node, name: string): Node[] => node.childrenForFieldName(name).filter((c): c is Node => c !== null);
/** Node wrappers are new objects on every access: compare by identity in the tree. */
const same = (a: Node | null, b: Node | null): boolean => a !== null && b !== null && a.equals(b);

function rangeOf(node: Node): SourceRange {
  return {
    startOffset: node.startIndex,
    endOffset: node.endIndex,
    startLine: node.startPosition.row + 1,
    startColumn: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column + 1,
  };
}

export function physicalLineCount(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  return text.charCodeAt(text.length - 1) === 10 ? lines - 1 : lines;
}

export function failedPythonFacts(text: string, reason: PythonFacts['failureReason'] & string, parseErrors: ParseError[] = []): PythonFacts {
  return {
    language: 'python',
    parseStatus: 'failed',
    failureReason: reason,
    parseErrors,
    imports: [],
    declarations: [],
    declarationsOmitted: 0,
    physicalLines: physicalLineCount(text),
    codeLines: null,
    complexity: null,
    callables: [],
    callablesOmitted: 0,
  };
}

/** Facts for one Python file. `initPythonParser()` must have completed. */
export function extractPythonFacts(path: string, text: string): PythonFacts {
  const tree = pythonParser().parse(text);
  if (!tree) return failedPythonFacts(text, 'PARSER_CRASHED');
  try {
    const root = tree.rootNode;
    if (root.hasError) return failedPythonFacts(text, 'SYNTAX_ERROR', parseErrorsOf(root));
    const context = moduleContext(root);
    const invalid: ParseError[] = [];
    const imports = extractImports(root, path, context, invalid);
    // The grammar accepts `lazy from __future__`; CPython's parser does not (ADR-080).
    if (invalid.length > 0) return failedPythonFacts(text, 'SYNTAX_ERROR', invalid);
    const { declarations, omitted } = extractDeclarations(root, context);
    const { callables, omitted: callablesOmitted, summary } = collectCallables(root);
    return {
      language: 'python',
      parseStatus: 'parsed',
      failureReason: null,
      parseErrors: [],
      imports,
      declarations,
      declarationsOmitted: omitted,
      physicalLines: physicalLineCount(text),
      codeLines: codeLineCount(root, text),
      complexity: summary,
      callables,
      callablesOmitted,
    };
  } finally {
    tree.delete();
  }
}

function parseErrorsOf(root: Node): ParseError[] {
  const errors: ParseError[] = [];
  const stack: Node[] = [root];
  while (stack.length > 0 && errors.length < 100) {
    const node = stack.pop()!;
    if (node.isError || node.isMissing) {
      errors.push({ code: node.isMissing ? 2 : 1, range: rangeOf(node) });
      continue;
    }
    if (!node.hasError) continue;
    const children = kids(node);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }
  return errors.sort((a, b) => a.range.startOffset - b.range.startOffset);
}

// ---------------------------------------------------------------------------------------
// Module context: __all__ and the names that bind importlib
// ---------------------------------------------------------------------------------------

interface ModuleContext {
  /** Literal names in `__all__`, or null when there is none or it is not a literal. */
  all: Set<string> | null;
  /** Names bound to the `importlib` module, and to `importlib.import_module`. */
  importlibNames: Set<string>;
  importModuleNames: Set<string>;
}

/** The text of a plain string literal, or null for f-strings, escapes or interpolation. */
function literalString(node: Node): string | null {
  if (node.type === 'concatenated_string') {
    const parts = named(node).map(literalString);
    return parts.every((p) => p !== null) ? parts.join('') : null;
  }
  if (node.type !== 'string') return null;
  let prefix = '';
  let content = '';
  for (const child of kids(node)) {
    if (child.type === 'string_start') prefix = child.text.replace(/["']+$/, '').toLowerCase();
    else if (child.type === 'string_content') {
      if (named(child).some((n) => n.type === 'escape_sequence')) return null;
      content += child.text;
    } else if (child.type === 'interpolation') return null;
  }
  // Bytes and f-strings are not module names.
  if (prefix.includes('b') || prefix.includes('f') || prefix.includes('t')) return null;
  return content;
}

function stringsOf(node: Node | null): string[] | null {
  if (!node || (node.type !== 'list' && node.type !== 'tuple')) return null;
  const out: string[] = [];
  for (const element of named(node)) {
    const text = literalString(element);
    if (text === null) return null;
    out.push(text);
  }
  return out;
}

function moduleContext(root: Node): ModuleContext {
  const context: ModuleContext = { all: null, importlibNames: new Set(), importModuleNames: new Set() };
  let allDynamic = false;
  const all = new Set<string>();
  let allSeen = false;
  // __all__ is read from module-level statements, including module-level if/try blocks.
  for (const statement of moduleStatements(root)) {
    if (statement.type !== 'expression_statement') continue;
    const expr = named(statement)[0];
    if (!expr) continue;
    if (expr.type === 'assignment' && field(expr, 'left')?.text === '__all__') {
      allSeen = true;
      const names = stringsOf(field(expr, 'right'));
      if (names === null) allDynamic = true;
      else {
        all.clear();
        for (const n of names) all.add(n);
      }
    } else if (expr.type === 'augmented_assignment' && field(expr, 'left')?.text === '__all__') {
      const names = stringsOf(field(expr, 'right'));
      if (names === null) allDynamic = true;
      else for (const n of names) all.add(n);
    } else if (expr.type === 'call') {
      const fn = field(expr, 'function');
      if (fn?.type === 'attribute' && field(fn, 'object')?.text === '__all__' && (field(fn, 'attribute')?.text === 'extend' || field(fn, 'attribute')?.text === 'append')) {
        const args = named(field(expr, 'arguments') ?? expr).filter((a) => a.type !== 'comment');
        const values = field(fn, 'attribute')?.text === 'append' ? (args[0] ? [literalString(args[0])] : [null]) : (stringsOf(args[0] ?? null) ?? [null]);
        if (values.some((v) => v === null)) allDynamic = true;
        else for (const v of values) all.add(v!);
      }
    }
  }
  if (allSeen && !allDynamic) context.all = all;

  // Every import of importlib in the file binds a name, at any depth.
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'import_statement') {
      for (const item of fields(node, 'name')) {
        // `import importlib` and `import importlib.util` both bind the name `importlib`.
        if (item.type === 'dotted_name' && (item.text === 'importlib' || item.text.startsWith('importlib.'))) context.importlibNames.add('importlib');
        else if (item.type === 'aliased_import' && field(item, 'name')?.text === 'importlib') context.importlibNames.add(field(item, 'alias')!.text);
      }
      continue;
    }
    if (node.type === 'import_from_statement') {
      if (field(node, 'module_name')?.text === 'importlib') {
        for (const item of fields(node, 'name')) {
          if (item.type === 'dotted_name' && item.text === 'import_module') context.importModuleNames.add('import_module');
          else if (item.type === 'aliased_import' && field(item, 'name')?.text === 'import_module') context.importModuleNames.add(field(item, 'alias')!.text);
        }
      }
      continue;
    }
    for (const child of named(node)) stack.push(child);
  }
  return context;
}

/** Compound statements whose blocks run at module level when the module runs. */
const MODULE_COMPOUND = new Set(['if_statement', 'try_statement', 'with_statement', 'match_statement']);
const CLAUSES = new Set(['elif_clause', 'else_clause', 'except_clause', 'finally_clause', 'case_clause']);

/**
 * Statements that run at module level, in source order: the module body, and the blocks of
 * module-level `if`, `try`, `with` and `match` statements. Function and class bodies are
 * not module level.
 */
function moduleStatements(root: Node): Node[] {
  const out: Node[] = [];
  const stack: Node[] = named(root).filter((c) => c.type !== 'comment').reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    out.push(node);
    if (!MODULE_COMPOUND.has(node.type)) continue;
    const statements: Node[] = [];
    const pending: Node[] = [...named(node)];
    while (pending.length > 0) {
      const part = pending.shift()!;
      if (CLAUSES.has(part.type)) pending.unshift(...named(part));
      else if (part.type === 'block') {
        for (const child of named(part)) {
          if (child.type === 'comment') continue;
          if (CLAUSES.has(child.type)) pending.unshift(child);
          else statements.push(child);
        }
      }
    }
    for (let i = statements.length - 1; i >= 0; i--) stack.push(statements[i]!);
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------------------

const GUARD_EXCEPTIONS = new Set(['ImportError', 'ModuleNotFoundError', 'Exception', 'BaseException']);

function isTypeCheckingTest(condition: Node | null): boolean {
  if (!condition) return false;
  if (condition.type === 'identifier') return condition.text === 'TYPE_CHECKING';
  if (condition.type === 'attribute') return field(condition, 'attribute')?.text === 'TYPE_CHECKING';
  return false;
}

/** Whether a try statement's handlers catch import failures. */
function guardsImports(tryStatement: Node): boolean {
  for (const clause of kids(tryStatement)) {
    if (clause.type !== 'except_clause') continue;
    const value = field(clause, 'value');
    if (!value) return true; // bare except
    const names: string[] = [];
    const stack = [value];
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (n.type === 'identifier') names.push(n.text);
      else if (n.type === 'attribute') names.push(field(n, 'attribute')?.text ?? '');
      else for (const c of named(n)) stack.push(c);
    }
    if (names.some((n) => GUARD_EXCEPTIONS.has(n))) return true;
  }
  return false;
}

function extractImports(root: Node, path: string, context: ModuleContext, invalid: ParseError[]): PyRawImport[] {
  const stub = isPythonStubPath(path);
  const base = repoBasename(path);
  const packageInit = base === '__init__.py' || base === '__init__.pyi';
  const imports: PyRawImport[] = [];
  const stack: { node: Node; typeOnly: boolean; guarded: boolean }[] = [{ node: root, typeOnly: false, guarded: false }];
  const valueKind = (typeOnly: boolean, reexport: boolean): PyImportKind =>
    stub || typeOnly ? (reexport ? 'reexports-type' : 'imports-type') : reexport ? 'reexports-value' : 'imports-value';

  while (stack.length > 0) {
    const { node, typeOnly, guarded } = stack.pop()!;
    switch (node.type) {
      case 'future_import_statement':
        // A compiler directive, not a module dependency (ADR-056).
        continue;
      case 'lazy_import_statement': {
        // PEP 810: a lazy import is still a dependency, recorded like the import it wraps
        // (ADR-080). CPython's parser rejects only a lazy __future__ import; the scope rules
        // (no functions, classes or try blocks) are compile-time checks, as in `ast.parse`.
        const inner = named(node)[0];
        if (inner?.type === 'import_from_statement' && field(inner, 'module_name')?.text === '__future__') {
          invalid.push({ code: 1, range: rangeOf(node) });
          continue;
        }
        break;
      }
      case 'import_statement': {
        for (const item of fields(node, 'name')) {
          const dotted = item.type === 'aliased_import' ? field(item, 'name') : item;
          if (!dotted) continue;
          const alias = item.type === 'aliased_import' ? (field(item, 'alias')?.text ?? null) : null;
          // PEP 484: `import a as a` in a package's __init__ re-exports it.
          const reexport = packageInit && alias !== null && alias === dotted.text;
          imports.push({ kind: valueKind(typeOnly, reexport), specifier: dotted.text, range: rangeOf(dotted), usage: 'import', unsupportedReason: null, attributeType: null, names: null, wildcard: false, guarded });
        }
        continue;
      }
      case 'import_from_statement': {
        const module = field(node, 'module_name');
        if (!module) continue;
        const specifier = module.text.replace(/\s+/g, '');
        const wildcard = kids(node).some((c) => c.type === 'wildcard_import');
        const names: PyImportedName[] = [];
        for (const item of fields(node, 'name')) {
          const target = item.type === 'aliased_import' ? field(item, 'name') : item;
          if (!target) continue;
          names.push({ name: target.text, alias: item.type === 'aliased_import' ? (field(item, 'alias')?.text ?? null) : null, range: rangeOf(target) });
        }
        const reexport = packageInit && (wildcard || names.some((n) => n.alias === n.name || (context.all?.has(n.alias ?? n.name) ?? false)));
        imports.push({ kind: valueKind(typeOnly, reexport), specifier, range: rangeOf(module), usage: 'import', unsupportedReason: null, attributeType: null, names, wildcard, guarded });
        continue;
      }
      case 'call': {
        const dynamic = dynamicImport(node, context);
        if (dynamic) imports.push({ ...dynamic, guarded });
        break;
      }
      case 'if_statement': {
        const typeChecking = isTypeCheckingTest(field(node, 'condition'));
        for (const child of [...named(node)].reverse()) {
          stack.push({ node: child, typeOnly: typeOnly || (typeChecking && same(child, field(node, 'consequence'))), guarded });
        }
        continue;
      }
      case 'try_statement': {
        const guards = guardsImports(node);
        for (const child of [...named(node)].reverse()) stack.push({ node: child, typeOnly, guarded: guarded || (guards && same(child, field(node, 'body'))) });
        continue;
      }
    }
    const children = named(node);
    for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i]!, typeOnly, guarded });
  }
  imports.sort((a, b) => a.range.startOffset - b.range.startOffset || compareAscii(a.kind, b.kind));
  return imports;
}

function dynamicImport(call: Node, context: ModuleContext): Omit<PyRawImport, 'guarded'> | null {
  const fn = field(call, 'function');
  if (!fn) return null;
  let recognized = false;
  if (fn.type === 'attribute') recognized = context.importlibNames.has(field(fn, 'object')?.text ?? '') && field(fn, 'attribute')?.text === 'import_module';
  else if (fn.type === 'identifier') recognized = context.importModuleNames.has(fn.text) || fn.text === '__import__';
  if (!recognized) return null;
  const builtin = fn.type === 'identifier' && fn.text === '__import__';
  const args = field(call, 'arguments');
  const positional = args ? named(args).filter((a) => a.type !== 'keyword_argument' && a.type !== 'comment') : [];
  const first = positional[0] ?? null;
  const base = { kind: 'imports-dynamic-literal' as const, usage: 'dynamic' as const, attributeType: null, names: null, wildcard: false };
  const literal = first ? literalString(first) : null;
  if (!first || literal === null || literal.length === 0) return { ...base, specifier: null, range: rangeOf(first ?? call), unsupportedReason: 'NONLITERAL_DYNAMIC_IMPORT' };
  if (literal.startsWith('.')) {
    // A relative import_module needs its package; only `package=__package__` (or
    // `__name__`) is understood statically. `__import__` levels are not literal names.
    const keyword = args ? named(args).find((a) => a.type === 'keyword_argument' && field(a, 'name')?.text === 'package') : undefined;
    const second = positional[1];
    const pkg = keyword ? field(keyword, 'value')?.text : second?.text;
    if (builtin || (pkg !== '__package__' && pkg !== '__name__')) return { ...base, specifier: literal, range: rangeOf(first), unsupportedReason: 'RELATIVE_DYNAMIC_IMPORT_WITHOUT_PACKAGE' };
  }
  return { ...base, specifier: literal, range: rangeOf(first), unsupportedReason: null };
}

// ---------------------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------------------

const PROTOCOL_BASES = new Set(['Protocol', 'TypedDict']);
const ENUM_BASES = new Set(['Enum', 'IntEnum', 'StrEnum', 'Flag', 'IntFlag', 'ReprEnum']);

function baseNames(classNode: Node): string[] {
  const args = field(classNode, 'superclasses');
  if (!args) return [];
  return named(args).flatMap((a) => {
    if (a.type === 'identifier') return [a.text];
    if (a.type === 'attribute') return [field(a, 'attribute')?.text ?? ''];
    if (a.type === 'subscript') {
      const value = field(a, 'value');
      return value ? [value.type === 'attribute' ? (field(value, 'attribute')?.text ?? '') : value.text] : [];
    }
    return [];
  });
}

function patternNames(node: Node, out: string[]): void {
  const stack = [node];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.type === 'identifier') out.push(n.text);
    else if (n.type === 'pattern_list' || n.type === 'tuple_pattern' || n.type === 'list_pattern' || n.type === 'list_splat_pattern' || n.type === 'parenthesized_expression' || n.type === 'tuple' || n.type === 'list') {
      const children = named(n);
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
    }
    // Attributes and subscripts assign into existing objects: they declare nothing.
  }
}

function extractDeclarations(root: Node, context: ModuleContext): { declarations: DeclarationSummary[]; omitted: number } {
  const all: DeclarationSummary[] = [];
  const exported = (name: string) => (context.all ? context.all.has(name) : !name.startsWith('_'));
  const add = (name: string, kind: DeclarationSummary['kind'], node: Node) => all.push({ name: name.slice(0, 256), kind, exported: exported(name), range: rangeOf(node) });
  for (const statement of moduleStatements(root)) {
    const definition = statement.type === 'decorated_definition' ? field(statement, 'definition') : statement;
    if (!definition) continue;
    if (definition.type === 'function_definition') {
      const name = field(definition, 'name')?.text;
      if (name) add(name, 'function', statement);
    } else if (definition.type === 'class_definition') {
      const name = field(definition, 'name')?.text;
      if (!name) continue;
      const bases = baseNames(definition);
      add(name, bases.some((b) => PROTOCOL_BASES.has(b)) ? 'interface' : bases.some((b) => ENUM_BASES.has(b)) ? 'enum' : 'class', statement);
    } else if (definition.type === 'type_alias_statement') {
      const left = field(definition, 'left');
      const id = left ? (left.type === 'identifier' ? left : (named(left).find((c) => c.type === 'identifier') ?? named(named(left)[0] ?? left).find((c) => c.type === 'identifier'))) : undefined;
      if (id) add(id.text, 'type', statement);
    } else if (definition.type === 'expression_statement') {
      // `a = b = value` declares every target; `x: TypeAlias = …` declares a type.
      let expr: Node | undefined = named(definition)[0];
      while (expr && expr.type === 'assignment') {
        const left = field(expr, 'left');
        const annotation = field(expr, 'type');
        const names: string[] = [];
        if (left) patternNames(left, names);
        const isAlias = annotation !== null && /(^|\.)TypeAlias$/.test(annotation.text.trim());
        for (const name of names) add(name, isAlias ? 'type' : 'variable', statement);
        expr = field(expr, 'right') ?? undefined;
      }
    }
  }
  all.sort((a, b) => a.range.startOffset - b.range.startOffset || compareUtf8(a.name, b.name));
  const declarations = all.slice(0, LIMITS.declarationsPerFile);
  return { declarations, omitted: all.length - declarations.length };
}

// ---------------------------------------------------------------------------------------
// Code lines
// ---------------------------------------------------------------------------------------

/** The bare-string first statement of a module, class or function body. */
function docstringOf(body: Node | null): Node | null {
  if (!body) return null;
  const first = named(body).find((c) => c.type !== 'comment');
  if (!first || first.type !== 'expression_statement') return null;
  const expressions = named(first);
  if (expressions.length !== 1) return null;
  const e = expressions[0]!;
  if (e.type === 'string' || e.type === 'concatenated_string') {
    const parts = e.type === 'string' ? [e] : named(e);
    // f-strings are expressions and bytes are not text: neither is a docstring.
    if (parts.every((p) => !/^[a-z]*[fbt]/i.test(kids(p).find((c) => c.type === 'string_start')?.text ?? ''))) return first;
  }
  return null;
}

function lineIndexer(text: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
}

export function codeLineCount(root: Node, text: string): number {
  // Docstring statements by start offset (wrappers are new objects on every access).
  const docstrings = new Set<number>();
  const mark = (n: Node | null) => {
    if (n) docstrings.add(n.startIndex);
  };
  const lineOf = lineIndexer(text);
  const lines = new Set<number>();
  mark(docstringOf(root));
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'comment' || node.type === 'line_continuation') continue;
    if (node.type === 'expression_statement' && docstrings.has(node.startIndex)) continue;
    if (node.type === 'function_definition' || node.type === 'class_definition') mark(docstringOf(field(node, 'body')));
    const start = node.startIndex;
    const end = node.endIndex;
    // String content is text, counted on every line it covers, blank lines included: it is
    // not a leaf when it holds escape sequences. Interpolations are walked like any code,
    // so a comment inside an f-string replacement field (PEP 701) stays a comment.
    if (node.type === 'string_content') {
      if (end > start) for (let line = lineOf(start); line <= lineOf(end - 1); line++) lines.add(line);
      continue;
    }
    const children = kids(node);
    if (children.length > 0) {
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
      continue;
    }
    if (end <= start) continue;
    // A leaf can begin with the newline that ends the previous line (block tokens).
    let first = start;
    while (first < end && /\s/.test(text[first]!)) first++;
    let last = end - 1;
    while (last > first && /\s/.test(text[last]!)) last--;
    if (first > last) continue;
    for (let line = lineOf(first); line <= lineOf(last); line++) lines.add(line);
  }
  return lines.size;
}

// ---------------------------------------------------------------------------------------
// Callables and cyclomatic complexity
// ---------------------------------------------------------------------------------------

function emptyContributions(): Record<DecisionKind, number> {
  return { if: 0, loop: 0, catch: 0, conditional: 0, case: 0, logical: 0 };
}

/**
 * `case _:` or a capture `case name:` (also parenthesized) without a guard matches
 * everything: Python's default, which adds no decision.
 */
function isIrrefutableCase(clause: Node): boolean {
  if (field(clause, 'guard')) return false;
  const patterns = named(clause).filter((c) => c.type === 'case_pattern');
  // `case y,:` is a one-element sequence pattern: its comma sits on the clause.
  if (patterns.length !== 1 || kids(clause).some((c) => c.type === ',')) return false;
  let pattern: Node = patterns[0]!;
  for (;;) {
    const inner = named(pattern);
    if (inner.length === 0) return pattern.text.trim() === '_';
    if (inner.length !== 1) return false;
    const only = inner[0]!;
    // A capture is a single name; `A.B` is a value pattern and can fail.
    if (only.type === 'identifier') return true;
    if (only.type === 'dotted_name') return named(only).length === 1;
    // `(p)` is a group, not a one-element sequence (that would need a comma).
    if (only.type === 'tuple_pattern' && !only.text.includes(',')) {
      const element = named(only)[0];
      if (!element) return false;
      pattern = element;
      continue;
    }
    if (only.type === 'case_pattern') {
      pattern = only;
      continue;
    }
    return false;
  }
}

function decisionOf(node: Node): DecisionKind | null {
  switch (node.type) {
    case 'if_statement':
    case 'elif_clause':
    case 'if_clause':
      // A guard on a case clause is its `if`: it is part of the case decision, not another.
      return node.type === 'if_clause' && node.parent?.type === 'case_clause' ? null : 'if';
    case 'for_statement':
    case 'while_statement':
    case 'for_in_clause':
      return 'loop';
    case 'except_clause':
      return 'catch';
    case 'conditional_expression':
      return 'conditional';
    case 'case_clause':
      return isIrrefutableCase(node) ? null : 'case';
    case 'boolean_operator':
      return 'logical';
    default:
      return null;
  }
}

function decoratorNames(definition: Node): string[] {
  const parent = definition.parent;
  if (parent?.type !== 'decorated_definition') return [];
  return kids(parent)
    .filter((c) => c.type === 'decorator')
    .map((d) => d.text.replace(/^@\s*/, '').replace(/\(.*$/s, '').trim());
}

function enclosingClass(definition: Node): boolean {
  let parent = definition.parent;
  if (parent?.type === 'decorated_definition') parent = parent.parent;
  return parent?.type === 'block' && parent.parent?.type === 'class_definition';
}

function callableOf(node: Node): { kind: CallableFacts['kind']; name: string } | null {
  if (node.type === 'function_definition') {
    const name = field(node, 'name')?.text ?? 'function';
    if (!enclosingClass(node)) return { kind: 'function', name };
    if (name === '__init__') return { kind: 'constructor', name: '__init__' };
    const decorators = decoratorNames(node);
    if (decorators.some((d) => d.endsWith('.setter'))) return { kind: 'setter', name: `set ${name}` };
    if (decorators.some((d) => d === 'property' || d.endsWith('.getter') || d === 'cached_property' || d.endsWith('.cached_property'))) return { kind: 'getter', name: `get ${name}` };
    return { kind: 'method', name };
  }
  if (node.type === 'lambda') {
    const parent = node.parent;
    if (parent?.type === 'assignment' && same(field(parent, 'right'), node)) {
      const left = field(parent, 'left');
      if (left?.type === 'identifier') return { kind: 'arrow', name: left.text };
    }
    if (parent?.type === 'keyword_argument') {
      const name = field(parent, 'name')?.text;
      if (name) return { kind: 'arrow', name };
    }
    return { kind: 'arrow', name: `lambda (line ${node.startPosition.row + 1})` };
  }
  return null;
}

export function collectCallables(root: Node): { callables: CallableFacts[]; omitted: number; summary: ComplexitySummary } {
  const all: CallableFacts[] = [];
  // Each scope is walked with its own owner. A def's body is a block; a lambda's body is a
  // single expression, examined itself (it can be a decision or another lambda).
  const scopes: { nodes: Node[]; owner: CallableFacts | null }[] = [{ nodes: named(root), owner: null }];
  while (scopes.length > 0) {
    const { nodes, owner } = scopes.pop()!;
    const stack: Node[] = [...nodes].reverse();
    while (stack.length > 0) {
      const node = stack.pop()!;
      const callable = callableOf(node);
      if (callable) {
        const facts: CallableFacts = { name: callable.name.slice(0, 256), kind: callable.kind, range: rangeOf(node), complexity: 1, contributions: emptyContributions() };
        all.push(facts);
        const body = field(node, 'body');
        if (body) scopes.push({ nodes: node.type === 'lambda' ? [body] : named(body), owner: facts });
        // Default values and annotations run in the enclosing scope, not the callable's.
        for (const part of [field(node, 'parameters'), field(node, 'return_type')]) if (part) stack.push(part);
        continue;
      }
      const decision = decisionOf(node);
      if (decision && owner) {
        owner.complexity++;
        owner.contributions[decision]++;
      }
      const children = named(node);
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
    }
  }
  all.sort((a, b) => a.range.startOffset - b.range.startOffset || a.range.endOffset - b.range.endOffset);
  const summary = { callableCount: all.length, maxCyclomatic: all.reduce((m, c) => Math.max(m, c.complexity), 0), sumCyclomatic: all.reduce((sum, c) => sum + c.complexity, 0) };
  const callables = all.slice(0, MAX_CALLABLES_RECORDED);
  return { callables, omitted: all.length - callables.length, summary };
}
