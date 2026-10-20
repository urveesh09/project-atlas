import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, Parser } from 'web-tree-sitter';

const PYTHON_RUNTIME_VERSION = '0.27.1';

/**
 * The Python grammar (ADR-056): tree-sitter-python 0.25.0 with the Python 3.15 syntax
 * patch (ADR-080), built reproducibly to WebAssembly by scripts/build-python-grammar.mjs and
 * vendored with its hash, run by web-tree-sitter. Nothing here touches analyzed files: the
 * caller hands over text, and syntax trees never leave this package.
 */
export const PYTHON_GRAMMAR = {
  name: 'tree-sitter-python',
  version: '0.25.0+atlas.1',
  sha256: '40f01ba5e3ef4e4ff3d697d00ac290270ca64843b29a7126ba87ad3747aed3bb',
  runtime: `web-tree-sitter@${PYTHON_RUNTIME_VERSION}`,
} as const;

/** Recorded in artifacts and fact-cache keys, like the TypeScript parser version. */
export const PYTHON_PARSER_VERSION = `${PYTHON_GRAMMAR.name}@${PYTHON_GRAMMAR.version}+wts@${PYTHON_RUNTIME_VERSION}`;

/** The grammar file, found next to `src/` or `dist/` in the package. */
export function pythonGrammarPath(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(dir, '..', 'grammar', 'tree-sitter-python.wasm');
}

let loading: Promise<Parser> | null = null;
let loaded: Parser | null = null;

/** Loads the runtime and grammar once per process, refusing a grammar whose hash differs. */
export function initPythonParser(): Promise<Parser> {
  loading ??= (async () => {
    const bytes = readFileSync(pythonGrammarPath());
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== PYTHON_GRAMMAR.sha256) throw new Error(`The Python grammar does not match its recorded hash (${digest})`);
    await Parser.init();
    const language = await Language.load(bytes);
    const parser = new Parser();
    parser.setLanguage(language);
    loaded = parser;
    return parser;
  })();
  return loading;
}

/** The loaded parser; `initPythonParser` must have finished first. */
export function pythonParser(): Parser {
  if (!loaded) throw new Error('The Python parser is not initialized; await initPythonParser() first');
  return loaded;
}
