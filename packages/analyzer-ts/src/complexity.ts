import ts from 'typescript';
import type { SourceRange } from '@atlas/schema';

/**
 * Size and complexity facts, exactly as defined in plan §10.1 (atlas.metrics/1):
 *
 * - Physical lines: LF-delimited; an empty file has 0; a trailing LF adds no line.
 * - Code lines: distinct physical lines intersecting a non-trivia token. Comments and
 *   blank lines are excluded; multi-line tokens count every line they touch.
 * - Cyclomatic complexity per callable: 1 + `if`, `for`, `for-in`, `for-of`, `while`,
 *   `do`, `catch`, conditional expressions, non-default `case`, and the short-circuit
 *   operators `&&`, `||`, `??`. Optional chaining and logical assignment operators are
 *   not counted.
 * - Callables: function declarations/expressions, arrows, methods, constructors,
 *   getters and setters with a body. Nested callables are computed separately and
 *   excluded from their parent; top-level statements belong to no callable.
 */
export type DecisionKind = 'if' | 'loop' | 'catch' | 'conditional' | 'case' | 'logical';

export interface CallableFacts {
  name: string;
  kind: 'function' | 'method' | 'constructor' | 'getter' | 'setter' | 'arrow';
  range: SourceRange;
  complexity: number;
  contributions: Record<DecisionKind, number>;
}

export const MAX_CALLABLES_RECORDED = 2_000;

export function physicalLineCount(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  return text.charCodeAt(text.length - 1) === 10 ? lines - 1 : lines;
}

/** Line index (0-based) for an offset, via a precomputed table of LF positions. */
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

export function codeLineCount(sf: ts.SourceFile): number {
  const text = sf.text;
  const lineOf = lineIndexer(text);
  const lines = new Set<number>();
  // Explicit stack: deep ASTs must not overflow the JS call stack here.
  const stack: ts.Node[] = [sf];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const children = node.getChildren(sf);
    if (children.length > 0) {
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
      continue;
    }
    if (node.kind === ts.SyntaxKind.EndOfFileToken) continue;
    if (ts.isJsxText(node) && node.containsOnlyTriviaWhiteSpaces) continue;
    const start = node.getStart(sf);
    const end = node.getEnd();
    if (end <= start) continue;
    // A JSX text token may begin or end with whitespace-only lines; count only lines that
    // carry visible characters.
    if (ts.isJsxText(node)) {
      const raw = text.slice(start, end);
      let offset = start;
      for (const line of raw.split('\n')) {
        if (line.trim().length > 0) lines.add(lineOf(offset));
        offset += line.length + 1;
      }
      continue;
    }
    const first = lineOf(start);
    const last = lineOf(end - 1);
    for (let line = first; line <= last; line++) lines.add(line);
  }
  return lines.size;
}

function emptyContributions(): Record<DecisionKind, number> {
  return { if: 0, loop: 0, catch: 0, conditional: 0, case: 0, logical: 0 };
}

function decisionOf(node: ts.Node): DecisionKind | null {
  switch (node.kind) {
    case ts.SyntaxKind.IfStatement:
      return 'if';
    case ts.SyntaxKind.ForStatement:
    case ts.SyntaxKind.ForInStatement:
    case ts.SyntaxKind.ForOfStatement:
    case ts.SyntaxKind.WhileStatement:
    case ts.SyntaxKind.DoStatement:
      return 'loop';
    case ts.SyntaxKind.CatchClause:
      return 'catch';
    case ts.SyntaxKind.ConditionalExpression:
      return 'conditional';
    case ts.SyntaxKind.CaseClause:
      return 'case';
    case ts.SyntaxKind.BinaryExpression: {
      const op = (node as ts.BinaryExpression).operatorToken.kind;
      return op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken ? 'logical' : null;
    }
    default:
      return null;
  }
}

type CallableNode = ts.FunctionLikeDeclaration & { body: ts.Node };

function asCallable(node: ts.Node): { node: CallableNode; kind: CallableFacts['kind'] } | null {
  const withBody = (n: ts.FunctionLikeDeclaration) => n.body !== undefined;
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) return withBody(node) ? { node: node as CallableNode, kind: 'function' } : null;
  if (ts.isArrowFunction(node)) return { node: node as CallableNode, kind: 'arrow' };
  if (ts.isMethodDeclaration(node)) return withBody(node) ? { node: node as CallableNode, kind: 'method' } : null;
  if (ts.isConstructorDeclaration(node)) return withBody(node) ? { node: node as CallableNode, kind: 'constructor' } : null;
  if (ts.isGetAccessorDeclaration(node)) return withBody(node) ? { node: node as CallableNode, kind: 'getter' } : null;
  if (ts.isSetAccessorDeclaration(node)) return withBody(node) ? { node: node as CallableNode, kind: 'setter' } : null;
  return null;
}

function propertyNameText(name: ts.PropertyName | ts.BindingName | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

/** A readable, non-identity display name for a callable (plan §9.2: safe labels). */
function callableName(node: CallableNode, kind: CallableFacts['kind'], sf: ts.SourceFile): string {
  if (kind === 'constructor') return 'constructor';
  const own = 'name' in node ? propertyNameText(node.name as ts.PropertyName | undefined) : null;
  if (own) return kind === 'getter' ? `get ${own}` : kind === 'setter' ? `set ${own}` : own;
  const parent = node.parent;
  if (parent) {
    if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
      const named = propertyNameText(parent.name);
      if (named) return named;
    }
    if (ts.isExportAssignment(parent)) return 'default';
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(parent.left)) return parent.left.name.text;
  }
  const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  return `anonymous ${kind === 'arrow' ? 'arrow' : 'function'} (line ${line})`;
}

export interface ComplexitySummary {
  callableCount: number;
  maxCyclomatic: number;
  sumCyclomatic: number;
}

export function collectCallables(sf: ts.SourceFile, rangeOf: (node: ts.Node) => SourceRange): { callables: CallableFacts[]; omitted: number; summary: ComplexitySummary } {
  const all: CallableFacts[] = [];
  // Each callable's body is walked with its own counter; nested callables are queued
  // rather than counted, so the parent's traversal never includes them.
  const roots: { node: ts.Node; owner: CallableFacts | null }[] = [{ node: sf, owner: null }];
  while (roots.length > 0) {
    const { node: root, owner } = roots.pop()!;
    const stack: ts.Node[] = [];
    ts.forEachChild(root, (child) => {
      stack.push(child);
    });
    while (stack.length > 0) {
      const node = stack.pop()!;
      const callable = asCallable(node);
      if (callable) {
        const facts: CallableFacts = {
          name: callableName(callable.node, callable.kind, sf).slice(0, 256),
          kind: callable.kind,
          range: rangeOf(callable.node),
          complexity: 1,
          contributions: emptyContributions(),
        };
        all.push(facts);
        roots.push({ node: callable.node, owner: facts });
        continue;
      }
      const decision = decisionOf(node);
      if (decision && owner) {
        owner.complexity++;
        owner.contributions[decision]++;
      }
      ts.forEachChild(node, (child) => {
        stack.push(child);
      });
    }
  }
  all.sort((a, b) => a.range.startOffset - b.range.startOffset || a.range.endOffset - b.range.endOffset);
  // Totals use every callable; only the recorded list is bounded.
  const summary = { callableCount: all.length, maxCyclomatic: all.reduce((m, c) => Math.max(m, c.complexity), 0), sumCyclomatic: all.reduce((sum, c) => sum + c.complexity, 0) };
  const callables = all.slice(0, MAX_CALLABLES_RECORDED);
  return { callables, omitted: all.length - callables.length, summary };
}
