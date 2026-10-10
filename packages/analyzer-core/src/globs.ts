/**
 * Exclusion globs with a documented gitignore-like subset (ADR-017):
 *   `name`      matches a file or directory with that name at any depth
 *   `dir/`      matches only directories (everything beneath them)
 *   `/x` or `a/b` (contains a slash before the end) is anchored at the repository root
 *   `*` within one segment, `**` across segments, `?` one character
 * Patterns are data: no negation, braces or character classes, so they cannot express
 * anything surprising. Invalid patterns are reported, never guessed.
 */
export interface CompiledGlob {
  pattern: string;
  test(path: string): boolean;
}

const MAX_PATTERN_LENGTH = 256;

function segmentToRegex(segment: string): string {
  let out = '';
  for (const ch of segment) {
    if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}

export function compileGlob(pattern: string): CompiledGlob | null {
  if (pattern.length === 0 || pattern.length > MAX_PATTERN_LENGTH || /[\u0000-\u001f\\!{}[\]]/.test(pattern)) return null;
  let body = pattern;
  const dirOnly = body.endsWith('/');
  if (dirOnly) body = body.slice(0, -1);
  const anchored = body.startsWith('/') || body.includes('/');
  body = body.replace(/^\//, '');
  if (body === '' || body.split('/').some((s) => s === '' || s === '.' || s === '..')) return null;
  const segments = body.split('/');
  let regex = '';
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === '**') regex += last ? '.*' : '(?:[^/]+/)*';
    else regex += segmentToRegex(segment) + (last ? '' : '/');
  });
  const prefix = anchored ? '^' : '^(?:.*/)?';
  const suffix = dirOnly ? '/.+$' : '(?:/.+)?$';
  const re = new RegExp(prefix + regex + suffix);
  return { pattern, test: (path) => re.test(path) };
}
