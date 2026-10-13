/**
 * Path patterns for highlighting files (ADR-048), in the familiar `.gitignore` style:
 *
 * - patterns are separated by commas or new lines; a leading `!` excludes;
 * - `*` and `?` stay within one path segment, `**` spans any number of segments;
 * - a pattern without `/` matches any segment, so `*.test.ts` matches file names
 *   anywhere and `fixtures` matches everything inside any `fixtures` folder;
 * - a pattern with `/` is anchored at the repository root and matches a whole path or a
 *   folder prefix, so `packages/core` covers everything inside it;
 * - a trailing `/` matches folders only.
 *
 * Matching is a bounded table over segments with a two-pointer wildcard match, so a pasted
 * pattern can never make the viewer backtrack exponentially.
 */
export interface PathPattern {
  test(path: string): boolean;
  /** Number of include and exclude patterns. */
  size: number;
}

export const PATH_PATTERN_LIMITS = { patterns: 32, length: 256 } as const;

interface Compiled {
  exclude: boolean;
  anchored: boolean;
  foldersOnly: boolean;
  segments: string[];
}

function segmentMatches(pattern: string, text: string): boolean {
  let p = 0,
    t = 0,
    star = -1,
    resume = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === '?' || (pattern[p] !== '*' && pattern[p] === text[t]))) {
      p++;
      t++;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      resume = t;
    } else if (star >= 0) {
      p = star + 1;
      t = ++resume;
    } else return false;
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

/** Whether `pattern` (with `**`) consumes exactly `parts[0..n)` for some allowed `n`. */
function reaches(pattern: readonly string[], parts: readonly string[], accept: (consumed: number) => boolean): boolean {
  let reach = new Uint8Array(parts.length + 1);
  reach[0] = 1;
  for (const segment of pattern) {
    const next = new Uint8Array(parts.length + 1);
    for (let j = 0; j <= parts.length; j++) {
      if (!reach[j]) continue;
      if (segment === '**') for (let k = j; k <= parts.length; k++) next[k] = 1;
      else if (j < parts.length && segmentMatches(segment, parts[j]!)) next[j + 1] = 1;
    }
    reach = next;
  }
  for (let n = 0; n <= parts.length; n++) if (reach[n] && accept(n)) return true;
  return false;
}

function matches(rule: Compiled, parts: readonly string[]): boolean {
  // A folder rule must stop before the file name; any other rule may end on it.
  const last = rule.foldersOnly ? parts.length - 1 : parts.length;
  if (rule.anchored) return reaches(rule.segments, parts, (n) => n >= 1 && n <= last);
  const segment = rule.segments[0]!;
  for (let i = 0; i < last; i++) if (segmentMatches(segment, parts[i]!)) return true;
  return false;
}

/** Null for empty input; throws a readable `Error` for input over the limits. */
export function compilePathPattern(input: string): PathPattern | null {
  const raw = input
    .split(/[,\n]/)
    .map((p) => p.trim())
    .filter((p) => p !== '' && p !== '!');
  if (raw.length === 0) return null;
  if (raw.length > PATH_PATTERN_LIMITS.patterns) throw new Error(`At most ${PATH_PATTERN_LIMITS.patterns} patterns`);
  const rules: Compiled[] = raw.map((text) => {
    if (text.length > PATH_PATTERN_LIMITS.length) throw new Error(`A pattern is longer than ${PATH_PATTERN_LIMITS.length} characters`);
    const exclude = text.startsWith('!');
    let body = exclude ? text.slice(1) : text;
    const foldersOnly = body.endsWith('/');
    let end = body.length;
    while (end > 0 && body[end - 1] === '/') end--;
    body = body.slice(0, end);
    const leading = body.startsWith('/');
    let start = 0;
    while (start < body.length && body[start] === '/') start++;
    body = body.slice(start);
    const segments = body.split('/').filter((s, i, all) => s !== '' || all.length === 1);
    const anchored = leading || segments.length > 1;
    return { exclude, anchored, foldersOnly, segments: segments.length ? segments : ['**'] };
  });
  const include = rules.filter((r) => !r.exclude);
  const exclude = rules.filter((r) => r.exclude);
  return {
    size: rules.length,
    test(path: string): boolean {
      const parts = path.split('/');
      if (include.length > 0 && !include.some((r) => matches(r, parts))) return false;
      return !exclude.some((r) => matches(r, parts));
    },
  };
}
