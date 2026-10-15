import { useState, type ReactNode } from 'react';
import type { Availability, Diagnostic } from '@atlas/schema';

/** Severity is always text plus a shape, never color alone (plan §12.4). */
export function SeverityBadge({ severity }: { severity: Diagnostic['severity'] }) {
  const glyph = severity === 'error' ? '●' : severity === 'warning' ? '▲' : '◆';
  return (
    <span className={`badge badge-${severity}`}>
      <span aria-hidden="true">{glyph}</span> {severity}
    </span>
  );
}

export function Chip({ children, tone = 'neutral', title }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'warn' | 'muted'; title?: string }) {
  return (
    <span className={`chip chip-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function AvailabilityNote({ value }: { value: Availability }) {
  if (value === 'complete') return null;
  return <Chip tone={value === 'partial' ? 'warn' : 'muted'}>{value === 'partial' ? 'partial' : 'unavailable'}</Chip>;
}

export function Section({ title, count, children, description }: { title: string; count?: number; children: ReactNode; description?: ReactNode }) {
  return (
    <section className="section">
      <h3 className="section-title">
        {title}
        {count !== undefined && <span className="section-count">{count.toLocaleString('en-US')}</span>}
      </h3>
      {description && <p className="section-description">{description}</p>}
      {children}
    </section>
  );
}

/**
 * Show the first `pageSize` items with an explicit, keyboard-reachable "show more" that adds
 * `step` at a time (default `pageSize`). `listClassName` styles the list (rows by default).
 */
export function Paged<T>({ items, pageSize = 50, step = pageSize, listClassName = 'rows', render, empty }: { items: readonly T[]; pageSize?: number; step?: number; listClassName?: string; render: (item: T, index: number) => ReactNode; empty: ReactNode }) {
  const [visible, setVisible] = useState(pageSize);
  if (items.length === 0) return <p className="empty">{empty}</p>;
  return (
    <>
      <ul className={listClassName}>{items.slice(0, visible).map(render)}</ul>
      {items.length > visible && (
        <button type="button" className="more" onClick={() => setVisible((v) => v + step)}>
          Show {Math.min(step, items.length - visible).toLocaleString('en-US')} more of {(items.length - visible).toLocaleString('en-US')}
        </button>
      )}
    </>
  );
}

export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <span className="meter" role="img" aria-label={label}>
      <span className="meter-fill" style={{ width: `${pct}%` }} />
    </span>
  );
}

export function StackBar({ segments, label }: { segments: { value: number; className: string; name: string }[]; label: string }) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  return (
    <div className="stackbar" role="img" aria-label={label}>
      {segments
        .filter((s) => s.value > 0)
        .map((s) => (
          <span key={s.name} className={`stack ${s.className}`} style={{ flexGrow: s.value / Math.max(1, total) }} />
        ))}
    </div>
  );
}
