import { SCOPE_LIMITS, type CompiledScope, type Scope } from '../app/scope';
import { Icon } from './Icon';

/** The Scope menu (ADR-051): focus on one folder and hide paths; both keep plots fixed. */
export function ScopeMenu(props: { scope: Scope; compiled: CompiledScope; shown: number; total: number; setScope(next: Scope): void }) {
  const { scope, compiled, shown, total, setScope } = props;
  const hidden = total - shown;
  return (
    <details className="city-views city-scope">
      <summary>
        <Icon name="scope" />
        Scope{compiled.active ? ` (${hidden.toLocaleString('en-US')} hidden)` : ''}
      </summary>
      <div className="city-views-panel">
        <div className="scope-focus">
          <strong>Focus</strong>
          {compiled.focus ? (
            <p>
              Showing only <code>{compiled.focus}</code>.{' '}
              <button type="button" className="link" onClick={() => setScope({ ...scope, focus: null })}>
                Clear focus
              </button>
            </p>
          ) : (
            <p className="city-views-empty">Select a folder or package, then choose Focus on its card in the city.</p>
          )}
        </div>
        <label>
          Hide paths
          <textarea
            aria-label="Hide paths"
            aria-describedby="city-scope-help"
            aria-invalid={compiled.error ? true : undefined}
            rows={3}
            spellCheck={false}
            maxLength={SCOPE_LIMITS.hide}
            value={scope.hide}
            placeholder={'**/dist/**, *.d.ts, fixtures'}
            onChange={(e) => setScope({ ...scope, hide: e.target.value })}
          />
        </label>
        <p id="city-scope-help" className={`city-views-note${compiled.error ? ' city-note-error' : ''}`} role="status">
          {compiled.error
            ? `Hide: ${compiled.error}.`
            : `${shown.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} files shown. Hidden files leave their plots empty, so the city keeps its shape across snapshots. Use ! for exceptions.`}
        </p>
        {compiled.active && (
          <button type="button" onClick={() => setScope({ focus: null, hide: '' })}>
            Show everything
          </button>
        )}
      </div>
    </details>
  );
}
