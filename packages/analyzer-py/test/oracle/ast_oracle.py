"""Independent oracle for ATLAS's Python syntax facts (ADR-056).

Reads Python files as data with CPython's `ast` and `tokenize` (nothing is executed or
imported from them) and prints, per file, the facts ATLAS must agree with under the same
definitions:

- parse: whether `ast.parse` accepts the file;
- imports: (line, specifier) for every import statement, `from __future__` excluded;
- declarations: module-level names, in source order;
- complexity: (def line, cyclomatic) for every def, async def and lambda;
- code_lines: lines touched by a token that is neither a comment nor a docstring.

Usage: python -I ast_oracle.py <file-list.txt>  (one path per line; JSON lines out)
"""
import ast
import io
import json
import sys
import tokenize
import warnings

warnings.simplefilter("ignore")


def module_statements(body):
    out = []
    stack = list(reversed(body))
    while stack:
        node = stack.pop()
        out.append(node)
        blocks = []
        if isinstance(node, ast.If):
            blocks = [node.body, node.orelse]
        elif isinstance(node, (ast.Try, getattr(ast, "TryStar", ast.Try))):
            blocks = [node.body] + [h.body for h in node.handlers] + [node.orelse, node.finalbody]
        elif isinstance(node, (ast.With, ast.AsyncWith)):
            blocks = [node.body]
        elif isinstance(node, ast.Match):
            blocks = [c.body for c in node.cases]
        statements = [s for block in blocks for s in block]
        stack.extend(reversed(statements))
    return out


def target_names(target, out):
    if isinstance(target, ast.Name):
        out.append(target.id)
    elif isinstance(target, (ast.Tuple, ast.List)):
        for element in target.elts:
            target_names(element, out)
    elif isinstance(target, ast.Starred):
        target_names(target.value, out)


def declarations(tree):
    names = []
    for node in module_statements(tree.body):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.append(node.name)
        elif hasattr(ast, "TypeAlias") and isinstance(node, ast.TypeAlias):
            names.append(node.name.id)
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                target_names(target, names)
        elif isinstance(node, ast.AnnAssign):
            target_names(node.target, names)
    return names


def imports(tree):
    out = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                out.append((alias.lineno if hasattr(alias, "lineno") else node.lineno, alias.name))
        elif isinstance(node, ast.ImportFrom):
            if node.module == "__future__" and node.level == 0:
                continue
            out.append((node.lineno, "." * node.level + (node.module or "")))
    return sorted(out)


def irrefutable(case):
    if case.guard is not None:
        return False
    pattern = case.pattern
    return isinstance(pattern, ast.MatchAs) and pattern.pattern is None


class Complexity(ast.NodeVisitor):
    """Cyclomatic complexity per callable under ADR-056's definition."""

    def __init__(self):
        self.results = []

    def count(self, nodes):
        total = 0
        stack = list(nodes)
        while stack:
            node = stack.pop()
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                # Decorators, defaults and annotations run in the enclosing scope.
                stack.extend(node.decorator_list)
                stack.extend(node.args.defaults)
                stack.extend(d for d in node.args.kw_defaults if d is not None)
                stack.extend(a.annotation for a in node.args.posonlyargs + node.args.args + node.args.kwonlyargs if a.annotation is not None)
                for a in (node.args.vararg, node.args.kwarg):
                    if a is not None and a.annotation is not None:
                        stack.append(a.annotation)
                if node.returns is not None:
                    stack.append(node.returns)
                self.results.append((node.lineno, 1 + self.count(node.body)))
                continue
            if isinstance(node, ast.Lambda):
                stack.extend(node.args.defaults)
                stack.extend(d for d in node.args.kw_defaults if d is not None)
                self.results.append((node.lineno, 1 + self.count([node.body])))
                continue
            if isinstance(node, (ast.If, ast.For, ast.AsyncFor, ast.While, ast.ExceptHandler, ast.IfExp)):
                total += 1
            elif isinstance(node, ast.comprehension):
                total += 1 + len(node.ifs)
            elif isinstance(node, ast.match_case):
                total += 0 if irrefutable(node) else 1
            elif isinstance(node, ast.BoolOp):
                total += len(node.values) - 1
            stack.extend(ast.iter_child_nodes(node))
        return total


def docstring_rows(tree):
    rows = set()
    holders = [tree] + [n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))]
    for holder in holders:
        body = holder.body
        if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) and isinstance(body[0].value.value, str):
            rows.add((body[0].lineno, body[0].end_lineno))
    return rows


def code_lines(text, tree):
    doc = docstring_rows(tree)
    skip = {tokenize.COMMENT, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT, tokenize.ENDMARKER, tokenize.ENCODING}
    lines = set()
    for token in tokenize.generate_tokens(io.StringIO(text).readline):
        if token.type in skip:
            continue
        if token.type == tokenize.STRING and any(start <= token.start[0] and token.end[0] <= end for start, end in doc):
            continue
        for row in range(token.start[0], token.end[0] + 1):
            lines.add(row)
    return len(lines)


def analyze(path):
    with open(path, "rb") as handle:
        raw = handle.read()
    if raw.startswith(b"\xef\xbb\xbf"):
        raw = raw[3:]
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return {"path": path, "parse": None}
    try:
        tree = ast.parse(text, filename="<atlas-oracle>", feature_version=None)
    except (SyntaxError, ValueError, MemoryError, RecursionError):
        return {"path": path, "parse": False}
    visitor = Complexity()
    visitor.results.extend([])
    module_total = visitor.count(tree.body)  # module-level decisions belong to no callable
    del module_total
    try:
        lines = code_lines(text, tree)
    except (tokenize.TokenError, SyntaxError):
        lines = None
    return {
        "path": path,
        "parse": True,
        "imports": imports(tree),
        "declarations": declarations(tree),
        "complexity": sorted(visitor.results),
        "code_lines": lines,
    }


def main():
    with open(sys.argv[1], encoding="utf-8") as handle:
        paths = [line.rstrip("\n") for line in handle if line.strip()]
    for path in paths:
        sys.stdout.write(json.dumps(analyze(path)) + "\n")


if __name__ == "__main__":
    main()
