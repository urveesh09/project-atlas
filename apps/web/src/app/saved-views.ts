import { CITY_LENSES, type CityLens } from '@atlas/layout';
import { PATH_PATTERN_LIMITS } from './path-pattern';

/**
 * Saved views (ADR-048): a named bundle of how the city is shown: lens, view, filters,
 * dependency options, highlight pattern, selection, camera and style. They are kept in
 * this browser per repository, and can be exported to a file and imported by a teammate.
 * Imported files are untrusted input: every field is validated and bounded, and a view
 * never carries source text or anything executable.
 */
export const SAVED_VIEWS_FORMAT = 'atlas.views/1';
export const SAVED_VIEW_LIMITS = { views: 100, name: 80, path: 1024, fileBytes: 512 * 1024 } as const;

export interface SavedView {
  name: string;
  savedAt: string;
  lens: CityLens;
  mode: '3d' | 'map' | 'table';
  filter: 'all' | 'source' | 'test' | 'findings';
  direction: 'outgoing' | 'incoming' | 'both';
  includeTypes: boolean;
  pattern: string;
  selectedPath: string | null;
  theme: string | null;
  camera: { position: number[]; target: number[]; zoom: number } | { x: number; z: number; scale: number } | null;
}
export interface SavedViewsFile {
  format: typeof SAVED_VIEWS_FORMAT;
  repository: string;
  views: SavedView[];
}

const MODES = ['3d', 'map', 'table'] as const;
const FILTERS = ['all', 'source', 'test', 'findings'] as const;
const DIRECTIONS = ['outgoing', 'incoming', 'both'] as const;
const THEMES = ['modern', 'eastern', 'western'] as const;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e7;
const vector = (v: unknown): v is number[] => Array.isArray(v) && v.length === 3 && v.every(finite);
const oneOf = <T extends string>(allowed: readonly T[], v: unknown): v is T => typeof v === 'string' && (allowed as readonly string[]).includes(v);

function camera(v: unknown): SavedView['camera'] {
  if (!v || typeof v !== 'object') return null;
  const c = v as Record<string, unknown>;
  if (vector(c['position']) && vector(c['target']) && finite(c['zoom']) && (c['zoom'] as number) > 0) return { position: c['position'], target: c['target'], zoom: c['zoom'] as number };
  if (finite(c['x']) && finite(c['z']) && finite(c['scale']) && (c['scale'] as number) > 0) return { x: c['x'] as number, z: c['z'] as number, scale: c['scale'] as number };
  return null;
}

/** One validated view, or null when anything required is missing or out of bounds. */
export function parseSavedView(v: unknown): SavedView | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const name = typeof o['name'] === 'string' ? o['name'].trim() : '';
  if (!name || name.length > SAVED_VIEW_LIMITS.name || /[\u0000-\u001f\u007f]/.test(name)) return null;
  if (!oneOf(CITY_LENSES, o['lens']) || !oneOf(MODES, o['mode']) || !oneOf(FILTERS, o['filter']) || !oneOf(DIRECTIONS, o['direction'])) return null;
  const pattern = typeof o['pattern'] === 'string' ? o['pattern'] : '';
  if (pattern.length > PATH_PATTERN_LIMITS.patterns * (PATH_PATTERN_LIMITS.length + 2)) return null;
  const selected = o['selectedPath'];
  if (selected !== null && selected !== undefined && (typeof selected !== 'string' || selected.length > SAVED_VIEW_LIMITS.path)) return null;
  const savedAt = typeof o['savedAt'] === 'string' && !Number.isNaN(Date.parse(o['savedAt'])) ? new Date(o['savedAt']).toISOString() : new Date(0).toISOString();
  return {
    name,
    savedAt,
    lens: o['lens'],
    mode: o['mode'],
    filter: o['filter'],
    direction: o['direction'],
    includeTypes: o['includeTypes'] === true,
    pattern,
    selectedPath: typeof selected === 'string' ? selected : null,
    theme: oneOf(THEMES, o['theme']) ? o['theme'] : null,
    camera: camera(o['camera']),
  };
}

/** Parses an exported views file; invalid entries are skipped and counted, never trusted. */
export function parseSavedViewsFile(text: string): { views: SavedView[]; skipped: number; repository: string | null } {
  if (text.length > SAVED_VIEW_LIMITS.fileBytes) throw new Error('The views file is larger than 512 KiB');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('The file is not JSON');
  }
  const o = json as Partial<SavedViewsFile> | null;
  if (!o || typeof o !== 'object' || o.format !== SAVED_VIEWS_FORMAT || !Array.isArray(o.views)) throw new Error(`The file is not an ATLAS views file (${SAVED_VIEWS_FORMAT})`);
  const views: SavedView[] = [];
  let skipped = 0;
  for (const entry of o.views.slice(0, SAVED_VIEW_LIMITS.views)) {
    const view = parseSavedView(entry);
    if (view) views.push(view);
    else skipped++;
  }
  skipped += Math.max(0, o.views.length - SAVED_VIEW_LIMITS.views);
  return { views, skipped, repository: typeof o.repository === 'string' ? o.repository.slice(0, 200) : null };
}

/** Adds or replaces views by name, keeping the newest first and the count bounded. */
export function mergeSavedViews(existing: readonly SavedView[], incoming: readonly SavedView[]): SavedView[] {
  const byName = new Map(existing.map((v) => [v.name, v]));
  for (const v of incoming) byName.set(v.name, v);
  return [...byName.values()].sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : a.name < b.name ? -1 : 1)).slice(0, SAVED_VIEW_LIMITS.views);
}

const storageKey = (repoId: string) => `atlas.views.${repoId}`;
export function loadSavedViews(repoId: string): SavedView[] {
  try {
    const raw = localStorage.getItem(storageKey(repoId));
    return raw ? parseSavedViewsFile(raw).views : [];
  } catch {
    return [];
  }
}
export function storeSavedViews(repoId: string, repository: string, views: readonly SavedView[]): boolean {
  try {
    localStorage.setItem(storageKey(repoId), serializeSavedViews(repository, views));
    return true;
  } catch {
    return false;
  }
}
export function serializeSavedViews(repository: string, views: readonly SavedView[]): string {
  const file: SavedViewsFile = { format: SAVED_VIEWS_FORMAT, repository, views: [...views] };
  return JSON.stringify(file, null, 2);
}
