import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, Parser } from 'web-tree-sitter';

/**
 * The Python grammar (ADR-056): tree-sitter-python 0.25.0, prebuilt to WebAssembly and
 * vendored with its hash, run by web-tree-sitter. Nothing here touches analyzed files: the
 * caller hands over text, and syntax trees never leave this package.
 */
export const PYTHON_GRAMMAR = {
  name: 'tree-sitter-python',
  version: '0.25.0',
  sha256: '16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47',
  runtime: 'web-tree-sitter@0.25.10',
} as const;

/** Recorded in artifacts and fact-cache keys, like the TypeScript parser version. */
export const PYTHON_PARSER_VERSION = `${PYTHON_GRAMMAR.name}@${PYTHON_GRAMMAR.version}+wts@0.25.10`;

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
