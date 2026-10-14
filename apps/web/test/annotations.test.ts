import { describe, expect, it } from 'vitest';
import { MARK_COLOUR_KEYS, NOTE_LIMITS, mergeAnnotations, parseAnnotation, parseNotesFile, serializeNotes, type Annotation } from '../src/app/annotations';

const note: Annotation = { path: 'packages/payments', colour: 'amber', note: 'Owned by payments.\nRefactor planned.', updatedAt: '2026-10-14T08:00:00.000Z' };

describe('annotations (ADR-053)', () => {
  it('round-trips through an exported file', () => {
    const text = serializeNotes('acme/shop', [note]);
    expect(parseNotesFile(text)).toEqual({ notes: [note], skipped: 0, repository: 'acme/shop' });
  });

  it('treats imported files as untrusted', () => {
    const hostile = {
      format: 'atlas.notes/1',
      repository: 'x',
      notes: [
        { ...note, colour: 'javascript:alert(1)' },
        { ...note, path: '' },
        { ...note, path: '/etc' },
        { ...note, path: 'a/' },
        { ...note, path: 'x'.repeat(NOTE_LIMITS.path + 1) },
        { ...note, note: 'x'.repeat(NOTE_LIMITS.text + 1) },
        { ...note, note: 'bell\u0007' },
        { ...note, path: 'kept', note: '<img src=x onerror=alert(1)>' },
        '__proto__',
      ],
    };
    const parsed = parseNotesFile(JSON.stringify(hostile));
    expect(parsed.skipped).toBe(8);
    // Markup is kept as plain text; the viewer only renders it as text.
    expect(parsed.notes).toEqual([{ ...note, path: 'kept', note: '<img src=x onerror=alert(1)>' }]);
    expect(() => parseNotesFile('{"format":"atlas.views/1"}')).toThrow(/notes file/);
    expect(() => parseNotesFile('not json')).toThrow(/JSON/);
    expect(() => parseNotesFile(' '.repeat(NOTE_LIMITS.fileBytes + 1))).toThrow(/256 KiB/);
  });

  it('merges by path, newest wins, sorted and capped', () => {
    const older = { ...note, colour: 'red' as const, updatedAt: '2026-01-01T00:00:00.000Z' };
    expect(mergeAnnotations([older], [note])).toEqual([note]);
    expect(mergeAnnotations([note], [older])).toEqual([note]);
    const many = Array.from({ length: 250 }, (_, i) => ({ ...note, path: `p${String(i).padStart(3, '0')}` }));
    const merged = mergeAnnotations([], many);
    expect(merged).toHaveLength(NOTE_LIMITS.notes);
    expect(merged[0]!.path).toBe('p000');
    for (const colour of MARK_COLOUR_KEYS) expect(parseAnnotation({ ...note, colour })?.colour).toBe(colour);
  });
});
