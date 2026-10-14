/**
 * Annotations (ADR-053): a colour and a note on a folder or package, kept in this browser
 * per repository and shared as an `atlas.notes/1` file. Imported files are untrusted:
 * every field is checked against an allowlist or bound, and a note is plain text that is
 * only ever rendered as text.
 */
export const NOTES_FORMAT = 'atlas.notes/1';
export const NOTE_LIMITS = { notes: 200, path: 1024, text: 500, fileBytes: 256 * 1024 } as const;

/** Marker colours, chosen apart from the metric and package palettes, each with a name. */
export const MARK_COLOURS = {
  red: { label: 'Red', hex: '#d1495b' },
  amber: { label: 'Amber', hex: '#edae49' },
  green: { label: 'Green', hex: '#2e9e6a' },
  blue: { label: 'Blue', hex: '#2f7fd1' },
  purple: { label: 'Purple', hex: '#9b5de5' },
  graphite: { label: 'Graphite', hex: '#4d5561' },
} as const;
export type MarkColour = keyof typeof MARK_COLOURS;
export const MARK_COLOUR_KEYS = Object.keys(MARK_COLOURS) as MarkColour[];

export interface Annotation {
  path: string;
  colour: MarkColour;
  note: string;
  updatedAt: string;
}

// Control characters other than tab and new line are refused.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

export function parseAnnotation(v: unknown): Annotation | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const path = typeof o['path'] === 'string' ? o['path'] : '';
  if (!path || path.length > NOTE_LIMITS.path || CONTROL.test(path) || path.startsWith('/') || path.endsWith('/')) return null;
  if (typeof o['colour'] !== 'string' || !(MARK_COLOUR_KEYS as string[]).includes(o['colour'])) return null;
  const note = typeof o['note'] === 'string' ? o['note'] : '';
  if (note.length > NOTE_LIMITS.text || CONTROL.test(note)) return null;
  const updatedAt = typeof o['updatedAt'] === 'string' && !Number.isNaN(Date.parse(o['updatedAt'])) ? new Date(o['updatedAt']).toISOString() : new Date(0).toISOString();
  return { path, colour: o['colour'] as MarkColour, note, updatedAt };
}

/** One entry per path, newest first when two files disagree, at most the limit. */
export function mergeAnnotations(existing: readonly Annotation[], incoming: readonly Annotation[]): Annotation[] {
  const byPath = new Map<string, Annotation>();
  for (const a of [...existing, ...incoming]) {
    const old = byPath.get(a.path);
    if (!old || a.updatedAt >= old.updatedAt) byPath.set(a.path, a);
  }
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).slice(0, NOTE_LIMITS.notes);
}

export function parseNotesFile(text: string): { notes: Annotation[]; skipped: number; repository: string | null } {
  if (text.length > NOTE_LIMITS.fileBytes) throw new Error('The notes file is larger than 256 KiB');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('The file is not JSON');
  }
  if (!json || typeof json !== 'object' || (json as Record<string, unknown>)['format'] !== NOTES_FORMAT) throw new Error(`The file is not an ${NOTES_FORMAT} notes file`);
  const raw = (json as Record<string, unknown>)['notes'];
  if (!Array.isArray(raw)) throw new Error('The file has no notes list');
  const notes: Annotation[] = [];
  let skipped = 0;
  for (const entry of raw.slice(0, NOTE_LIMITS.notes)) {
    const a = parseAnnotation(entry);
    if (a) notes.push(a);
    else skipped++;
  }
  skipped += Math.max(0, raw.length - NOTE_LIMITS.notes);
  const repository = (json as Record<string, unknown>)['repository'];
  return { notes: mergeAnnotations([], notes), skipped, repository: typeof repository === 'string' ? repository.slice(0, 200) : null };
}

export function serializeNotes(repository: string, notes: readonly Annotation[]): string {
  return `${JSON.stringify({ format: NOTES_FORMAT, repository, notes }, null, 2)}\n`;
}

const key = (repoId: string) => `atlas.notes.${repoId}`;
export function loadNotes(repoId: string): Annotation[] {
  try {
    const text = localStorage.getItem(key(repoId));
    return text ? parseNotesFile(text).notes : [];
  } catch {
    return [];
  }
}
export function storeNotes(repoId: string, repository: string, notes: readonly Annotation[]): boolean {
  try {
    localStorage.setItem(key(repoId), serializeNotes(repository, notes));
    return true;
  } catch {
    return false;
  }
}
