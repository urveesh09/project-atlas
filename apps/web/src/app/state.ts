import { LIMITS } from '@atlas/schema';

/**
 * View state (plan §12.1): selection, inspector tab, tree expansion and transient panels.
 * Only a small allowlisted part is mirrored into the URL fragment.
 */
export type InspectorTab = 'overview' | 'dependencies' | 'findings' | 'history';
export const TABS: readonly InspectorTab[] = ['overview', 'dependencies', 'findings', 'history'];

export interface ViewState {
  selectedId: string | null;
  tab: InspectorTab;
  expanded: ReadonlySet<string>;
  source: { nodeId: string; line: number | null } | null;
  /** One concise message for the polite live region. */
  announcement: string;
}

export type ViewAction =
  | { type: 'select'; id: string | null; ancestors?: readonly string[]; announce?: string }
  | { type: 'tab'; tab: InspectorTab }
  | { type: 'toggle'; id: string; open?: boolean }
  | { type: 'source'; nodeId: string; line: number | null }
  | { type: 'close-source' }
  | { type: 'announce'; message: string };

export function viewReducer(state: ViewState, action: ViewAction): ViewState {
  switch (action.type) {
    case 'select': {
      const expanded = new Set(state.expanded);
      for (const id of action.ancestors ?? []) expanded.add(id);
      return { ...state, selectedId: action.id, expanded, source: null, announcement: action.announce ?? state.announcement };
    }
    case 'tab':
      return { ...state, tab: action.tab };
    case 'toggle': {
      const expanded = new Set(state.expanded);
      const open = action.open ?? !expanded.has(action.id);
      if (open) expanded.add(action.id);
      else expanded.delete(action.id);
      return { ...state, expanded };
    }
    case 'source':
      return { ...state, source: { nodeId: action.nodeId, line: action.line } };
    case 'close-source':
      return { ...state, source: null };
    case 'announce':
      return { ...state, announcement: action.message };
  }
}

/** Fragment keys accepted from a URL (plan §12.1); everything else is ignored. */
const ALLOWED_KEYS = new Set(['v', 'frame', 'file', 'lens', 'mode', 'tab']);

export interface FragmentState {
  file: string | null;
  tab: InspectorTab | null;
  rejected: boolean;
}

export function parseFragment(hash: string): FragmentState {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw.length === 0) return { file: null, tab: null, rejected: false };
  if (new TextEncoder().encode(raw).length > LIMITS.shareFragmentBytes) return { file: null, tab: null, rejected: true };
  const params = new URLSearchParams(raw);
  let rejected = false;
  for (const key of params.keys()) if (!ALLOWED_KEYS.has(key)) rejected = true;
  if (params.has('v') && params.get('v') !== '1') return { file: null, tab: null, rejected: true };
  const file = params.get('file');
  const tab = params.get('tab');
  const validFile = file !== null && /^lin_[0-9a-f]{64}$/.test(file);
  const validTab = tab !== null && (TABS as readonly string[]).includes(tab);
  return { file: validFile ? file : null, tab: validTab ? (tab as InspectorTab) : null, rejected: rejected || (file !== null && !validFile) || (tab !== null && !validTab) };
}

export function formatFragment(file: string | null, tab: InspectorTab): string {
  if (!file) return '';
  const params = new URLSearchParams({ v: '1', file });
  if (tab !== 'overview') params.set('tab', tab);
  return `#${params}`;
}
