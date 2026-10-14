import { LIMITS } from '@atlas/schema';
import { CITY_LENSES, type CityLens } from '@atlas/layout';

/**
 * View state (plan §12.1): selection, inspector tab, tree expansion and transient panels.
 * Only a small allowlisted part is mirrored into the URL fragment.
 */
export type InspectorTab = 'overview' | 'dependencies' | 'findings' | 'history';
export const TABS: readonly InspectorTab[] = ['overview', 'dependencies', 'findings', 'history'];

export interface ViewState {
  lens: CityLens;
  mode: '3d' | 'map' | 'table' | 'packages';
  filter: 'all' | 'source' | 'test' | 'findings';
  direction: 'outgoing' | 'incoming' | 'both';
  includeTypes: boolean;
  pinnedEdgeId: string | null;
  packages: boolean;
  focusNonce: number;
  selectedId: string | null;
  tab: InspectorTab;
  expanded: ReadonlySet<string>;
  source: { nodeId: string; line: number | null } | null;
  /** Active analyzed frame (manifest ordinal); the newest frame is the selected commit. */
  frame: number;
  /** Explicit A -> B comparison; the city shows B with A's deleted plots as ghosts. */
  compare: { a: number; b: number } | null;
  /**
   * A selected file lineage that is absent from the active frame (plan §12.1): the
   * inspector shows its last/next occurrences instead of silently selecting another file.
   */
  tombstone: { lineageId: string } | null;
  /** One concise message for the polite live region. */
  announcement: string;
}

export type ViewAction =
  | { type: 'lens'; lens: CityLens }
  | { type: 'mode'; mode: ViewState['mode'] }
  | { type: 'filter'; filter: ViewState['filter'] }
  | {
      type: 'edges';
      direction?: ViewState['direction'];
      includeTypes?: boolean;
      pinnedEdgeId?: string | null;
      packages?: boolean;
    }
  | { type: 'focus' }
  | { type: 'select'; id: string | null; ancestors?: readonly string[]; announce?: string }
  | { type: 'frame'; frame: number; selectedId: string | null; tombstone: ViewState['tombstone']; expanded?: ReadonlySet<string>; announce: string }
  | { type: 'compare'; compare: ViewState['compare']; announce?: string }
  | { type: 'tab'; tab: InspectorTab }
  | { type: 'toggle'; id: string; open?: boolean }
  | { type: 'source'; nodeId: string; line: number | null }
  | { type: 'close-source' }
  | { type: 'announce'; message: string };

export function viewReducer(state: ViewState, action: ViewAction): ViewState {
  switch (action.type) {
    case 'lens':
      return { ...state, lens: action.lens };
    case 'mode':
      return { ...state, mode: action.mode };
    case 'filter':
      return { ...state, filter: action.filter };
    case 'edges': {
      const { type: _type, ...options } = action;
      return { ...state, ...options };
    }
    case 'focus':
      return { ...state, focusNonce: state.focusNonce + 1 };
    case 'select': {
      const expanded = new Set(state.expanded);
      for (const id of action.ancestors ?? []) expanded.add(id);
      return {
        ...state,
        selectedId: action.id,
        tombstone: null,
        pinnedEdgeId: null,
        expanded,
        source: null,
        announcement: action.announce ?? state.announcement,
      };
    }
    case 'frame': {
      const expanded = action.expanded ?? state.expanded;
      return {
        ...state,
        frame: action.frame,
        selectedId: action.selectedId,
        tombstone: action.tombstone,
        // Occurrence-scoped transient state never survives a frame change.
        pinnedEdgeId: null,
        source: null,
        expanded,
        announcement: action.announce,
      };
    }
    case 'compare':
      return { ...state, compare: action.compare, announcement: action.announce ?? state.announcement };
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
  lens: CityLens | null;
  mode: ViewState['mode'] | null;
  frame: string | null;
  file: string | null;
  tab: InspectorTab | null;
  rejected: boolean;
}

export function parseFragment(hash: string): FragmentState {
  const empty = { file: null, tab: null, lens: null, mode: null, frame: null, rejected: false };
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw.length === 0) return empty;
  if (new TextEncoder().encode(raw).length > LIMITS.shareFragmentBytes) return { ...empty, rejected: true };
  const params = new URLSearchParams(raw);
  let rejected = false;
  for (const key of params.keys()) if (!ALLOWED_KEYS.has(key)) rejected = true;
  for (const key of params.keys()) if (params.getAll(key).length > 1) rejected = true;
  if (params.has('v') && params.get('v') !== '1') return { ...empty, rejected: true };
  const lens = params.get('lens'),
    mode = params.get('mode'),
    frame = params.get('frame');
  if (lens !== null && !(CITY_LENSES as readonly string[]).includes(lens)) rejected = true;
  if (mode !== null && !['3d', 'map', 'table', 'packages'].includes(mode)) rejected = true;
  if (frame !== null && !/^snap_[0-9a-f]{64}$/.test(frame)) rejected = true;
  const file = params.get('file');
  const tab = params.get('tab');
  const validFile = file !== null && /^lin_[0-9a-f]{64}$/.test(file);
  const validTab = tab !== null && (TABS as readonly string[]).includes(tab);
  return {
    file: validFile ? file : null,
    tab: validTab ? (tab as InspectorTab) : null,
    lens: !rejected && lens ? (lens as CityLens) : null,
    mode: !rejected && mode ? (mode as ViewState['mode']) : null,
    frame: !rejected ? frame : null,
    rejected: rejected || (file !== null && !validFile) || (tab !== null && !validTab),
  };
}

/** `frame` is the snapshot ID of a historical frame; null for the selected commit. */
export function formatFragment(
  file: string | null,
  tab: InspectorTab,
  lens: CityLens = 'structure',
  mode: ViewState['mode'] = '3d',
  frame: string | null = null,
): string {
  if (!file && lens === 'structure' && mode === '3d' && !frame) return '';
  const params = new URLSearchParams({ v: '1' });
  if (frame) params.set('frame', frame);
  if (file) params.set('file', file);
  if (tab !== 'overview') params.set('tab', tab);
  if (lens !== 'structure') params.set('lens', lens);
  if (mode !== '3d') params.set('mode', mode);
  return `#${params}`;
}
