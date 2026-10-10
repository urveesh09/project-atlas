import { forwardRef, useId, useMemo, useState, type KeyboardEvent } from 'react';
import { useViewer } from '../app/context';

/**
 * Search combobox (ARIA 1.2 pattern): the input keeps focus, the active option is
 * announced through aria-activedescendant, Enter selects, Escape closes.
 */
export const Search = forwardRef<HTMLInputElement>(function Search(_props, ref) {
  const { model, select } = useViewer();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const results = useMemo(() => (query.trim() ? model.search.search(query, 30) : []), [model, query]);
  const expanded = open && query.trim().length > 0;

  const choose = (index: number) => {
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
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
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
          {results.length === 0 && (
            <li className="search-empty" role="option" aria-selected={false} aria-disabled="true">
              No matching files, packages or declarations
            </li>
          )}
          {results.map((hit, i) => (
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
