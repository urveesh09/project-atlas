import { useEffect, useRef, useState } from 'react';
import { downloadBlob } from '../city/export';
import { MARK_COLOURS, MARK_COLOUR_KEYS, NOTE_LIMITS, mergeAnnotations, parseNotesFile, serializeNotes, type Annotation, type MarkColour } from '../app/annotations';
import { Icon } from './Icon';
import { MenuSummary } from './MenuSummary';

/**
 * The Notes menu (ADR-053): mark the selected folder or package with a colour and a note,
 * review every mark, and share them as an atlas.notes/1 file.
 */
export function NotesMenu(props: {
  repository: string;
  notes: readonly Annotation[];
  setNotes(next: Annotation[], message: string): void;
  /** The selected folder or package path, when one is selected. */
  target: string | null;
  select(path: string): void;
}) {
  const { repository, notes, setNotes, target, select } = props;
  const current = target === null ? undefined : notes.find((n) => n.path === target);
  const [colour, setColour] = useState<MarkColour>(current?.colour ?? 'amber');
  const [text, setText] = useState(current?.note ?? '');
  const [status, setStatus] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setColour(current?.colour ?? 'amber');
    setText(current?.note ?? '');
  }, [target, current?.colour, current?.note]);
  const update = (next: Annotation[], message: string) => {
    setNotes(next, message);
    setStatus(message);
  };
  return (
    <details className="city-views city-notes">
      <MenuSummary icon="note" label={`Notes${notes.length ? ` (${notes.length})` : ''}`} badge={notes.length ? String(notes.length) : null} />
      <div className="city-views-panel">
        {target ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const mark: Annotation = { path: target, colour, note: text.trim(), updatedAt: new Date().toISOString() };
              update(mergeAnnotations(notes.filter((n) => n.path !== target), [mark]), `Marked ${target} ${MARK_COLOURS[colour].label.toLowerCase()}.`);
            }}
          >
            <strong>
              Mark <code>{target}</code>
            </strong>
            <fieldset className="notes-colours">
              <legend className="sr-only">Colour</legend>
              {MARK_COLOUR_KEYS.map((key) => (
                <label key={key} title={MARK_COLOURS[key].label}>
                  <input type="radio" name="mark-colour" value={key} checked={colour === key} onChange={() => setColour(key)} />
                  <i style={{ background: MARK_COLOURS[key].hex }} aria-hidden="true" />
                  <span className="sr-only">{MARK_COLOURS[key].label}</span>
                </label>
              ))}
            </fieldset>
            <label>
              Note
              <textarea rows={2} maxLength={NOTE_LIMITS.text} value={text} placeholder="e.g. Owned by payments; refactor planned" onChange={(e) => setText(e.target.value)} />
            </label>
            <div className="city-views-files">
              <button type="submit" className="primary">
                {current ? 'Update mark' : 'Mark'}
              </button>
              {current && (
                <button type="button" onClick={() => update(notes.filter((n) => n.path !== target), `Removed the mark on ${target}.`)}>
                  Remove mark
                </button>
              )}
            </div>
          </form>
        ) : (
          <p className="city-views-empty">Select a folder or package to mark it with a colour and a note.</p>
        )}
        {notes.length > 0 && (
          <ul aria-label="Marked folders">
            {notes.map((n) => (
              <li key={n.path}>
                <i className="notes-dot" style={{ background: MARK_COLOURS[n.colour].hex }} aria-hidden="true" />
                <button type="button" className="link" onClick={() => select(n.path)}>
                  {n.path}
                </button>
                <span className="sr-only">, {MARK_COLOURS[n.colour].label}</span>
                {n.note && <span className="notes-text">{n.note}</span>}
              </li>
            ))}
          </ul>
        )}
        <div className="city-views-files">
          <button
            type="button"
            disabled={!notes.length}
            onClick={() => {
              downloadBlob(new Blob([serializeNotes(repository, notes)], { type: 'application/json' }), 'atlas-notes.json');
              setStatus('Started the download of atlas-notes.json.');
            }}
          >
            <Icon name="download" />
            Export notes
          </button>
          <button type="button" onClick={() => fileInput.current?.click()}>
            <Icon name="upload" />
            Import notes…
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              try {
                if (file.size > NOTE_LIMITS.fileBytes) throw new Error('The notes file is larger than 256 KiB');
                const parsed = parseNotesFile(await file.text());
                update(
                  mergeAnnotations(notes, parsed.notes),
                  `Imported ${parsed.notes.length} note${parsed.notes.length === 1 ? '' : 's'}${parsed.skipped ? `; skipped ${parsed.skipped} invalid` : ''}${parsed.repository && parsed.repository !== repository ? ` (made for ${parsed.repository})` : ''}.`,
                );
              } catch (error) {
                setStatus(error instanceof Error ? error.message : 'The file could not be read.');
              }
            }}
          />
        </div>
        {status && (
          <p className="city-views-note" role="status">
            {status}
          </p>
        )}
        <p className="city-views-empty">Notes stay in this browser until you export them. They never leave it otherwise.</p>
      </div>
    </details>
  );
}
