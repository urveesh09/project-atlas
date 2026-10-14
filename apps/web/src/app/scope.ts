import { compilePathPattern, PATH_PATTERN_LIMITS } from './path-pattern';

/**
 * Scope (ADR-051): what part of the repository the city shows.
 *
 * - `focus` keeps one folder or package: only files inside it are drawn.
 * - `hide` removes files matching path patterns, in the highlight syntax of ADR-048
 *   (`**\/dist/**, *.d.ts, !packages/keep/dist`). At least one pattern without `!` is
 *   needed; a list of exceptions alone hides nothing.
 *
 * Hidden files leave their plots empty: the layout never reflows, so a scoped city still
 * lines up with every snapshot and every other view. Scope never changes analysis
 * results; counts name what is shown and what is hidden.
 */
export interface Scope {
  focus: string | null;
  hide: string;
}
export const NO_SCOPE: Scope = { focus: null, hide: '' };
export const SCOPE_LIMITS = { focus: 1024, hide: PATH_PATTERN_LIMITS.patterns * (PATH_PATTERN_LIMITS.length + 2) } as const;

export interface CompiledScope {
  /** Whether anything is focused or hidden. */
  active: boolean;
  focus: string | null;
  error: string | null;
  visible(path: string): boolean;
}

/** A folder path without leading or trailing slashes; '' (the root) means no focus. */
export function normalizeFocus(path: string | null): string | null {
  if (path === null) return null;
  let start = 0,
    end = path.length;
  while (start < end && path[start] === '/') start++;
  while (end > start && path[end - 1] === '/') end--;
  const clean = path.slice(start, end);
  return clean === '' ? null : clean;
}

export function compileScope(scope: Scope): CompiledScope {
  const focus = normalizeFocus(scope.focus);
  let error: string | null = null;
  let hide: ReturnType<typeof compilePathPattern> = null;
  const hasInclude = scope.hide.split(/[,\n]/).some((p) => {
    const t = p.trim();
    return t !== '' && !t.startsWith('!');
  });
  if (hasInclude) {
    try {
      hide = compilePathPattern(scope.hide);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Invalid pattern';
    }
  }
  const prefix = focus === null ? null : `${focus}/`;
  return {
    active: focus !== null || hide !== null,
    focus,
    error,
    visible: (path) => (prefix === null || path === focus || path.startsWith(prefix)) && !(hide && hide.test(path)),
  };
}
