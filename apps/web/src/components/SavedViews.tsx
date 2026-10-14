import { useRef, useState } from 'react';
import { useViewer } from '../app/context';
import { downloadBlob } from '../city/export';
import { loadSavedViews, mergeSavedViews, parseSavedViewsFile, serializeSavedViews, storeSavedViews, SAVED_VIEW_LIMITS, type SavedView } from '../app/saved-views';
import { Icon } from './Icon';

/**
 * Named views of the city (ADR-048), kept in this browser for this repository and
 * shareable as a small JSON file. Applying one restores lens, view, filters, dependency
 * options, highlight, selection, style and camera.
 */
export function SavedViews({ current, apply }: { current(): Omit<SavedView, 'name' | 'savedAt'>; apply(view: SavedView): void }) {
  const { model, dispatch } = useViewer();
  const repoId = model.manifest.repo.repoId;
  const repository = model.manifest.repo.displayName;
  const [views, setViews] = useState<SavedView[]>(() => loadSavedViews(repoId));
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const update = (next: SavedView[], message: string) => {
    setViews(next);
    const kept = storeSavedViews(repoId, repository, next);
    const text = kept ? message : `${message} Browser storage is unavailable, so the list lasts for this page only.`;
    setNote(text);
    dispatch({ type: 'announce', message: text });
  };
  const save = () => {
    const trimmed = name.trim().slice(0, SAVED_VIEW_LIMITS.name);
    if (!trimmed) return;
    update(mergeSavedViews(views, [{ ...current(), name: trimmed, savedAt: new Date().toISOString() }]), `Saved the view “${trimmed}”.`);
    setName('');
  };
  const importFile = async (file: File) => {
    try {
      const parsed = parseSavedViewsFile(await file.text());
      update(
        mergeSavedViews(views, parsed.views),
        `Imported ${parsed.views.length} view${parsed.views.length === 1 ? '' : 's'}${parsed.skipped ? `; skipped ${parsed.skipped} invalid` : ''}${parsed.repository && parsed.repository !== repository ? ` (saved for ${parsed.repository}; paths that do not exist here select nothing)` : ''}.`,
      );
    } catch (error) {
      setNote(error instanceof Error ? error.message : 'The file could not be read.');
    }
  };
  return (
    <details className="city-views">
      <summary>
        <Icon name="bookmark" />
        Saved views{views.length ? ` (${views.length})` : ''}
      </summary>
      <div className="city-views-panel">
        {views.length > 0 ? (
          <ul aria-label="Saved views">
            {views.map((v) => (
              <li key={v.name}>
                <button type="button" className="link" onClick={() => apply(v)} title={`${v.lens} · ${v.mode}${v.pattern ? ` · ${v.pattern}` : ''}`}>
                  {v.name}
                </button>
                <button type="button" className="city-views-delete" aria-label={`Delete the view ${v.name}`} onClick={() => update(views.filter((x) => x.name !== v.name), `Deleted the view “${v.name}”.`)}>
                  <Icon name="close" size={14} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="city-views-empty">No saved views yet. A view keeps the lens, filters, highlight, selection and camera.</p>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <label>
            Name
            <input type="text" value={name} maxLength={SAVED_VIEW_LIMITS.name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Runtime hotspots" />
          </label>
          <button type="submit" className="primary" disabled={!name.trim()}>
            Save current view
          </button>
        </form>
        <div className="city-views-files">
          <button
            type="button"
            disabled={!views.length}
            onClick={() => {
              downloadBlob(new Blob([serializeSavedViews(repository, views)], { type: 'application/json' }), 'atlas-views.json');
              setNote('Started the download of atlas-views.json.');
            }}
          >
            <Icon name="download" />
            Export views
          </button>
          <button type="button" onClick={() => fileInput.current?.click()}>
            <Icon name="upload" />
            Import views…
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void importFile(file);
              e.target.value = '';
            }}
          />
        </div>
        {note && (
          <p className="city-views-note" role="status">
            {note}
          </p>
        )}
      </div>
    </details>
  );
}
