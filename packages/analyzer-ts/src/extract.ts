import ts from 'typescript';
import { codeLineCount, collectCallables, physicalLineCount, type CallableFacts, type ComplexitySummary } from './complexity.js';
import { parseDiagnosticsOf } from './internal.js';
import { LIMITS, compareAscii, compareUtf8, repoExtension, type DeclarationSummary, type SourceRange } from '@atlas/schema';

/**
 * Syntax facts for one TS/JS file (plan §9.2). The AST never leaves this module: callers
 * receive plain serializable records only.
 */
/** Recorded in artifacts and cache keys (plan §9.4). */
export const PARSER_VERSION = `typescript@${ts.version}`;
/** Version of the fact extraction rules; part of every fact-cache key (plan §9.4). */
export const EXTRACTOR_VERSION = 'atlas.extract/1';

export type ImportKind =
  | 'imports-value'
  | 'imports-type'
  | 'reexports-value'
  | 'reexports-type'
  | 'imports-dynamic-literal'
  | 'requires-literal';

/** How the specifier is consumed, which selects the resolver's ESM/CJS conditions. */
export type UsageMode = 'import' | 'require' | 'dynamic';

export interface RawImport {
  kind: ImportKind;
  /** null for non-literal dynamic import/require. */
  specifier: string | null;
  range: SourceRange;
  usage: UsageMode;
  /** Set when the construct cannot be represented as a static edge. */
  unsupportedReason: 'NONLITERAL_DYNAMIC_IMPORT' | 'NONLITERAL_REQUIRE' | 'REQUIRE_RESOLVE_UNSUPPORTED' | 'IMPORT_META_GLOB_UNSUPPORTED' | null;
  /** Import attribute `type` (e.g. `with { type: 'json' }`), when present. */
  attributeType: string | null;
}

export interface ParseError {
  code: number;
  range: SourceRange;
}

export type ParseFailureReason = 'SYNTAX_ERROR' | 'PARSER_STACK_LIMIT' | 'PARSE_TIMEOUT' | 'PARSER_CRASHED';

export interface FileFacts {
  language: 'typescript' | 'javascript';
  parseStatus: 'parsed' | 'failed';
  failureReason: ParseFailureReason | null;
  parseErrors: ParseError[];
  /** Empty when parsing failed: no dependency claims are made from malformed ASTs. */
  imports: RawImport[];
  declarations: DeclarationSummary[];
  declarationsOmitted: number;
  /** Text-based, so available even when parsing failed. */
  physicalLines: number;
  /** Token-based; null when parsing failed. */
  codeLines: number | null;
  /** Null when parsing failed; complexity is never claimed from a malformed AST. */
  complexity: ComplexitySummary | null;
  callables: CallableFacts[];
  callablesOmitted: number;
}

export function failedFacts(path: string, text: string, reason: ParseFailureReason, parseErrors: ParseError[] = []): FileFacts {
  const script = SCRIPT_KINDS[repoExtension(path)];
  return {
    language: script?.language ?? 'typescript',
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

const SCRIPT_KINDS: Record<string, { kind: ts.ScriptKind; language: 'typescript' | 'javascript' }> = {
  '.ts': { kind: ts.ScriptKind.TS, language: 'typescript' },
  '.mts': { kind: ts.ScriptKind.TS, language: 'typescript' },
  '.cts': { kind: ts.ScriptKind.TS, language: 'typescript' },
  '.d.ts': { kind: ts.ScriptKind.TS, language: 'typescript' },
  '.d.mts': { kind: ts.ScriptKind.TS, language: 'typescript' },
  '.d.cts': { kind: ts.ScriptKind.TS, language: 'typescript' },
  '.tsx': { kind: ts.ScriptKind.TSX, language: 'typescript' },
  '.js': { kind: ts.ScriptKind.JS, language: 'javascript' },
  '.mjs': { kind: ts.ScriptKind.JS, language: 'javascript' },
  '.cjs': { kind: ts.ScriptKind.JS, language: 'javascript' },
  '.jsx': { kind: ts.ScriptKind.JSX, language: 'javascript' },
};

export const SUPPORTED_EXTENSIONS: readonly string[] = Object.keys(SCRIPT_KINDS);

export function isSupportedSourcePath(path: string): boolean {
  return repoExtension(path) in SCRIPT_KINDS;
}

export function isDeclarationPath(path: string): boolean {
  const ext = repoExtension(path);
  return ext === '.d.ts' || ext === '.d.mts' || ext === '.d.cts';
}

function rangeOf(sf: ts.SourceFile, start: number, end: number): SourceRange {
  const a = sf.getLineAndCharacterOfPosition(start);
  const b = sf.getLineAndCharacterOfPosition(end);
  return { startOffset: start, endOffset: end, startLine: a.line + 1, startColumn: a.character + 1, endLine: b.line + 1, endColumn: b.character + 1 };
}

function nodeRange(sf: ts.SourceFile, node: ts.Node): SourceRange {
  return rangeOf(sf, node.getStart(sf), node.getEnd());
}

function literalText(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function attributeType(attributes: ts.ImportAttributes | undefined): string | null {
  for (const element of attributes?.elements ?? []) {
    const name = ts.isIdentifier(element.name) ? element.name.text : element.name.text;
    if (name === 'type' && ts.isStringLiteral(element.value)) return element.value.text;
  }
  return null;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false);
}

// ---------------------------------------------------------------------------------------
// Lexical `require` shadowing (plan §9.2: literal require only when not locally bound).
// ---------------------------------------------------------------------------------------

function isBlockScopeContainer(node: ts.Node): boolean {
  return (
    ts.isBlock(node) ||
    ts.isSourceFile(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseBlock(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isFunctionLike(node) ||
    ts.isClassStaticBlockDeclaration(node)
  );
}

function isVarScopeContainer(node: ts.Node): boolean {
  return ts.isSourceFile(node) || ts.isModuleBlock(node) || ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node);
}

function closest(node: ts.Node, predicate: (n: ts.Node) => boolean): ts.Node {
  let current = node.parent;
  while (current && !predicate(current)) current = current.parent;
  return current ?? node.getSourceFile();
}

function bindsRequire(name: ts.BindingName | ts.Identifier | undefined): boolean {
  if (!name) return false;
  if (ts.isIdentifier(name)) return name.text === 'require';
  return name.elements.some((element) => !ts.isOmittedExpression(element) && bindsRequire(element.name));
}

function collectRequireScopes(sf: ts.SourceFile): Set<ts.Node> {
  const scopes = new Set<ts.Node>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && bindsRequire(node.name)) {
      const list = node.parent;
      const blockScoped = ts.isVariableDeclarationList(list) && (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing)) !== 0;
      if (ts.isCatchClause(list)) scopes.add(list);
      else scopes.add(closest(list, blockScoped ? isBlockScopeContainer : isVarScopeContainer));
    } else if (ts.isParameter(node) && bindsRequire(node.name)) {
      scopes.add(node.parent);
    } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) && node.name?.text === 'require') {
      scopes.add(closest(node, isBlockScopeContainer));
    } else if ((ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name?.text === 'require') {
      scopes.add(node);
    } else if (
      (ts.isImportClause(node) || ts.isImportSpecifier(node) || ts.isNamespaceImport(node) || ts.isImportEqualsDeclaration(node)) &&
      node.name?.text === 'require'
    ) {
      scopes.add(closest(node, (n) => ts.isSourceFile(n) || ts.isModuleBlock(n)));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return scopes;
}

function isShadowed(node: ts.Node, scopes: Set<ts.Node>): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (scopes.has(current)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------

export function extractFileFacts(path: string, text: string): FileFacts {
  try {
    return extractUnchecked(path, text);
  } catch (error) {
    // Pathologically deep input can exhaust the parser's recursion: contain it as a
    // failed parse instead of crashing the analysis (plan §16.1 "huge token/deep nesting").
    if (error instanceof RangeError) return failedFacts(path, text, 'PARSER_STACK_LIMIT');
    throw error;
  }
}

function extractUnchecked(path: string, text: string): FileFacts {
  const script = SCRIPT_KINDS[repoExtension(path)];
  if (!script) throw new TypeError(`Unsupported source extension for ${path}`);
  const sf = ts.createSourceFile(path, text, { languageVersion: ts.ScriptTarget.Latest, jsDocParsingMode: ts.JSDocParsingMode.ParseNone }, true, script.kind);
  const diagnostics = parseDiagnosticsOf(sf);
  const parseErrors = diagnostics.slice(0, 100).map((d) => ({ code: d.code, range: rangeOf(sf, d.start, Math.min(d.start + d.length, text.length)) }));
  if (parseErrors.length > 0) {
    return failedFacts(path, text, 'SYNTAX_ERROR', parseErrors);
  }

  const imports: RawImport[] = [];
  const push = (kind: ImportKind, specifierNode: ts.Node, usage: UsageMode, attributes: string | null = null) => {
    imports.push({ kind, specifier: literalText(specifierNode), range: nodeRange(sf, specifierNode), usage, unsupportedReason: null, attributeType: attributes });
  };
  const unsupported = (reason: NonNullable<RawImport['unsupportedReason']>, node: ts.Node, kind: ImportKind, usage: UsageMode) => {
    imports.push({ kind, specifier: null, range: nodeRange(sf, node), usage, unsupportedReason: reason, attributeType: null });
  };
  const requireScopes = collectRequireScopes(sf);

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const attr = attributeType(node.attributes);
      if (!clause) push('imports-value', node.moduleSpecifier, 'import', attr);
      else if (clause.isTypeOnly) push('imports-type', node.moduleSpecifier, 'import', attr);
      else {
        const bindings = clause.namedBindings;
        const named = bindings && ts.isNamedImports(bindings) ? bindings.elements : null;
        const hasValue = clause.name !== undefined || (bindings !== undefined && ts.isNamespaceImport(bindings)) || named === null || named.length === 0 || named.some((e) => !e.isTypeOnly);
        const hasType = named?.some((e) => e.isTypeOnly) ?? false;
        if (hasValue) push('imports-value', node.moduleSpecifier, 'import', attr);
        if (hasType) push('imports-type', node.moduleSpecifier, 'import', attr);
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const attr = attributeType(node.attributes);
      if (node.isTypeOnly) push('reexports-type', node.moduleSpecifier, 'import', attr);
      else {
        const clause = node.exportClause;
        const named = clause && ts.isNamedExports(clause) ? clause.elements : null;
        const hasValue = named === null || named.length === 0 || named.some((e) => !e.isTypeOnly);
        const hasType = named?.some((e) => e.isTypeOnly) ?? false;
        if (hasValue) push('reexports-value', node.moduleSpecifier, 'import', attr);
        if (hasType) push('reexports-type', node.moduleSpecifier, 'import', attr);
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      if (literalText(expression) !== null) push(node.isTypeOnly ? 'imports-type' : 'imports-value', expression, 'require');
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      push('imports-type', node.argument.literal, 'import');
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const first = node.arguments[0];
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        if (first && literalText(first) !== null) push('imports-dynamic-literal', first, 'dynamic');
        else unsupported('NONLITERAL_DYNAMIC_IMPORT', first ?? node, 'imports-dynamic-literal', 'dynamic');
      } else if (ts.isIdentifier(callee) && callee.text === 'require' && !isShadowed(node, requireScopes)) {
        if (first && literalText(first) !== null && node.arguments.length === 1) push('requires-literal', first, 'require');
        else unsupported('NONLITERAL_REQUIRE', first ?? node, 'requires-literal', 'require');
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'require' &&
        callee.name.text === 'resolve' &&
        !isShadowed(node, requireScopes)
      ) {
        unsupported('REQUIRE_RESOLVE_UNSUPPORTED', node, 'requires-literal', 'require');
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isMetaProperty(callee.expression) &&
        callee.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
        (callee.name.text === 'glob' || callee.name.text === 'globEager')
      ) {
        unsupported('IMPORT_META_GLOB_UNSUPPORTED', node, 'imports-dynamic-literal', 'dynamic');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  imports.sort((a, b) => a.range.startOffset - b.range.startOffset || compareAscii(a.kind, b.kind));

  const { declarations, omitted } = extractDeclarations(sf);
  const { callables, omitted: callablesOmitted, summary } = collectCallables(sf, (node) => nodeRange(sf, node));
  return {
    language: script.language,
    parseStatus: 'parsed',
    failureReason: null,
    parseErrors: [],
    imports,
    declarations,
    declarationsOmitted: omitted,
    physicalLines: physicalLineCount(text),
    codeLines: codeLineCount(sf),
    complexity: summary,
    callables,
    callablesOmitted,
  };
}

function extractDeclarations(sf: ts.SourceFile): { declarations: DeclarationSummary[]; omitted: number } {
  const all: DeclarationSummary[] = [];
  const locallyExported = new Set<string>();
  const add = (name: string, kind: DeclarationSummary['kind'], exported: boolean, node: ts.Node) => {
    all.push({ name: name.slice(0, 256), kind, exported, range: nodeRange(sf, node) });
  };
  const bindingNames = (name: ts.BindingName, out: string[]) => {
    if (ts.isIdentifier(name)) out.push(name.text);
    else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bindingNames(element.name, out);
  };
  for (const statement of sf.statements) {
    const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    if (ts.isFunctionDeclaration(statement)) add(statement.name?.text ?? 'default', 'function', exported, statement);
    else if (ts.isClassDeclaration(statement)) add(statement.name?.text ?? 'default', 'class', exported, statement);
    else if (ts.isInterfaceDeclaration(statement)) add(statement.name.text, 'interface', exported, statement);
    else if (ts.isTypeAliasDeclaration(statement)) add(statement.name.text, 'type', exported, statement);
    else if (ts.isEnumDeclaration(statement)) add(statement.name.text, 'enum', exported, statement);
    else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const names: string[] = [];
        bindingNames(declaration.name, names);
        for (const name of names) add(name, 'variable', exported, declaration);
      }
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals && !ts.isIdentifier(statement.expression)) {
      add('default', 'variable', true, statement);
    } else if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) locallyExported.add((element.propertyName ?? element.name).text);
    } else if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      locallyExported.add(statement.expression.text);
    }
  }
  for (const declaration of all) if (locallyExported.has(declaration.name)) declaration.exported = true;
  all.sort((a, b) => a.range.startOffset - b.range.startOffset || compareUtf8(a.name, b.name));
  const declarations = all.slice(0, LIMITS.declarationsPerFile);
  return { declarations, omitted: all.length - declarations.length };
}
