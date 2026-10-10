import { forwardRef, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { SearchHit } from '@atlas/graph';
import { useViewer } from '../app/context';

/**
 * Search combobox (ARIA 1.2 pattern): the input keeps focus, the active option is
 * announced through aria-activedescendant, Enter selects, Escape closes.
 */
export const Search = forwardRef<HTMLInputElement>(function Search(_props, ref) {
  const { model, select, queries } = useViewer();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const [results, setResults] = useState<SearchHit[]>([]);
  const [resultQuery, setResultQuery] = useState('');
  const [error, setError] = useState('');
  const pendingChoice = useRef<string | null>(null);
  useEffect(() => {
    let stale = false;
    setError('');
    if (!query.trim()) { setResults([]); setResultQuery(query); return; }
    if (!queries) return;
    // Results belong to the frame they were computed for; a frame change re-runs the query.
    void queries.search(model.frame, query).then((hits) => {
      if (stale) return;
      setResults(hits); setResultQuery(query); setActive(0);
      if (pendingChoice.current === query && hits[0]) { pendingChoice.current = null; setOpen(false); select(hits[0].nodeId, { focusInspector: true }); }
    }).catch(() => { if (!stale) { setError('Search is unavailable. Use the repository tree.'); setResults([]); } });
    return () => { stale = true; };
  }, [queries, query, select, model.frame]);
  const expanded = open && query.trim().length > 0;

  const choose = (index: number) => {
    if (query !== resultQuery) { pendingChoice.current = query; return; }
    const hit = results[index];
    if (!hit) return;
    setOpen(false);
    select(hit.nodeId, { focusInspector: true });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      setOpen(true);
      setActive((a) => Math.min(results.length - 1, a + 1));
    } else if (event.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1));
    else if (event.key === 'Enter') choose(active);
    else if (event.key === 'Escape') {
      if (expanded) setOpen(false);
      else setQuery('');
    } else return;
    event.preventDefault();
  };

  return (
    <div className="search">
      <label htmlFor={`${listId}-input`} className="sr-only">
        Search files, packages and declarations
      </label>
      <span className="search-icon" aria-hidden="true">
        ⌕
      </span>
      <input
        ref={ref}
        id={`${listId}-input`}
        type="search"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        {...(expanded && results[active] ? { 'aria-activedescendant': `${listId}-${active}` } : {})}
        placeholder="Search files, packages, declarations"
        autoComplete="off"
        spellCheck={false}
        maxLength={512}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          pendingChoice.current = null;
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onFocus={() => setOpen(true)}
      />
      <kbd className="search-hint" aria-hidden="true">
        /
      </kbd>
      {expanded && (
        <ul className="search-results" id={listId} role="listbox" aria-label="Search results">
          {(results.length === 0 || query !== resultQuery) && (
            <li className="search-empty" role="option" aria-selected={false} aria-disabled="true">
              {error || (query !== resultQuery ? 'Searching…' : 'No matching files, packages or declarations')}
            </li>
          )}
          {(query === resultQuery ? results : []).map((hit, i) => (
            <li
              key={hit.nodeId}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`search-result${i === active ? ' active' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(i)}
              onMouseEnter={() => setActive(i)}
            >
              <span className="search-path">{hit.kind === 'package' ? (model.node(hit.nodeId) && model.title(model.node(hit.nodeId)!)) : hit.path}</span>
              <span className="search-meta">
                {hit.kind}
                {hit.match.field === 'declaration' ? ` · declares ${hit.match.text}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});
