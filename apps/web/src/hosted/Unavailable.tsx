import { useEffect, useRef } from 'react';
import { errorText } from './messages';
import { navigate } from './route';

/**
 * Expired, deleted, revoked or unknown analyses (plan §3.3): a human explanation and a
 * safe way forward, never a stale graph.
 */
export function Unavailable({ code }: { code: string }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const text = errorText(code);
  return (
    <main className="gate">
      <div className="gate-card hosted-card" role="alert">
        <p className="gate-brand">
          <span className="brand-mark" aria-hidden="true">◆</span> ATLAS
        </p>
        <h1 ref={heading} tabIndex={-1}>
          {text.title}
        </h1>
        <p className="gate-note">{text.guidance}</p>
        <a className="button primary" href="/" onClick={(e) => { e.preventDefault(); navigate('/'); }}>
          Start a new analysis
        </a>
      </div>
    </main>
  );
}
