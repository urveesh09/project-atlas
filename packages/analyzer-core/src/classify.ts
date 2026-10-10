import { isDeclarationPath, isSupportedSourcePath } from '@atlas/analyzer-ts';
import { repoBasename, repoExtension, type FileRole } from '@atlas/schema';
import { compileGlob, type CompiledGlob } from './globs.js';

/**
 * Built-in scope rules (plan §8.5) and file roles (plan §4.1). Every rule has a stable
 * reason code that appears in coverage, so nothing disappears silently.
 */
export interface ExclusionRule {
  reason: string;
  glob: CompiledGlob;
  source: 'builtin' | 'repository-config' | 'cli';
}

const BUILTIN: readonly (readonly [reason: string, patterns: readonly string[]])[] = [
  ['DEPENDENCY_DIRECTORY', ['node_modules/', 'bower_components/', 'jspm_packages/', 'vendor/']],
  ['BUILD_OUTPUT', ['dist/', '.next/', '.nuxt/', '.svelte-kit/', '.output/', '.vercel/', '.netlify/', 'storybook-static/', '.docusaurus/', '.expo/', 'coverage/']],
  ['CACHE_DIRECTORY', ['.cache/', '.turbo/', '.parcel-cache/', '.nx/', '.yarn/cache/', '.pnpm-store/', '.eslintcache']],
  ['MINIFIED_BUNDLE', ['*.min.js', '*.min.mjs', '*.min.cjs', '*.min.css']],
  ['SOURCE_MAP', ['*.map']],
];

export function builtinExclusions(): ExclusionRule[] {
  return BUILTIN.flatMap(([reason, patterns]) => patterns.map((p) => ({ reason, glob: compileGlob(p)!, source: 'builtin' as const })));
}

/** The applied built-in patterns, for reporting (plan §8.5: "Always report applied patterns"). */
export function builtinExclusionPatterns(): { reason: string; patterns: string[] }[] {
  return BUILTIN.map(([reason, patterns]) => ({ reason, patterns: [...patterns] }));
}

export function firstMatchingRule(path: string, rules: readonly ExclusionRule[]): ExclusionRule | null {
  for (const rule of rules) if (rule.glob.test(path)) return rule;
  return null;
}

const CONFIG_NAMES = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'yarn.lock',
  '.yarnrc',
  '.yarnrc.yml',
  'bun.lockb',
  'atlas.config.json',
  '.npmrc',
  '.nvmrc',
  '.node-version',
  '.editorconfig',
  '.gitignore',
  '.gitattributes',
  '.browserslistrc',
  'turbo.json',
  'nx.json',
  'lerna.json',
  'renovate.json',
  'biome.json',
]);
const CONFIG_PATTERNS = [/^tsconfig(?:\..+)?\.json$/, /^jsconfig(?:\..+)?\.json$/, /^\.(?:eslint|prettier|babel|stylelint|swc|mocha)rc(?:\..+)?$/, /^\.?[\w-]+\.config\.[cm]?[jt]s$/];

const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb']);

const ASSET_EXTENSIONS = new Set([
  '.css', '.scss', '.sass', '.less', '.styl',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico', '.bmp',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.webm', '.wav', '.ogg',
  '.json', '.json5', '.jsonc', '.html', '.htm', '.wasm',
]);

/** Recognized languages ATLAS does not analyze in V0.1 (counted, kept as opaque buildings). */
const UNSUPPORTED_LANGUAGES = new Set(['.vue', '.svelte', '.mdx', '.astro', '.coffee', '.elm', '.flow']);

const TEST_DIRECTORY = /(?:^|\/)(?:__tests__|__mocks__|tests?|spec|specs|e2e|__fixtures__)\//;
const TEST_FILE = /\.(?:test|spec|e2e|bench)\.[cm]?[jt]sx?$/;

export interface PathClassification {
  role: FileRole;
  language: 'typescript' | 'javascript' | null;
  /** TS/JS file that is a parse candidate (subject to content checks). */
  code: boolean;
  config: boolean;
  lockfile: boolean;
  unsupportedLanguage: boolean;
}

export function classifyPath(path: string): PathClassification {
  const base = repoBasename(path);
  const ext = repoExtension(path);
  const code = isSupportedSourcePath(path);
  const language = code ? (/\.[cm]?tsx?$|\.d\.[cm]?ts$/.test(path.toLowerCase()) ? 'typescript' : 'javascript') : null;
  const config = CONFIG_NAMES.has(base) || CONFIG_PATTERNS.some((re) => re.test(base));
  let role: FileRole;
  if (isDeclarationPath(path)) role = 'declaration';
  else if (config) role = 'config';
  else if (code) role = TEST_DIRECTORY.test(path) || TEST_FILE.test(base) ? 'test' : 'source';
  else if (ASSET_EXTENSIONS.has(ext)) role = 'asset';
  else role = 'opaque';
  return { role, language, code, config, lockfile: LOCKFILES.has(base), unsupportedLanguage: UNSUPPORTED_LANGUAGES.has(ext) };
}

/** Bounded generated-file header check (plan §8.5): only leading comments are inspected. */
export function hasGeneratedHeader(text: string): boolean {
  const head = text.slice(0, 1024);
  const comments = head.match(/^(?:\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/|#![^\n]*))+/);
  if (!comments) return false;
  return /@generated\b|\bDO NOT EDIT\b|\bauto-?generated\b|\bautomatically generated\b|\bThis file was generated\b/i.test(comments[0]);
}

/** Flow is detected by its pragma in the leading comment block. */
export function hasFlowPragma(text: string): boolean {
  const head = text.slice(0, 1024);
  const comments = head.match(/^(?:\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/|#![^\n]*))+/);
  return comments !== null && /@flow\b/.test(comments[0]);
}

export const LFS_POINTER_PREFIX = 'version https://git-lfs.github.com/spec/v1\n';
