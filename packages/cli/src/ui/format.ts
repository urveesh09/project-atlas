import { PALETTE, padEndVisible, visibleWidth, type Styler } from './style.js';

/** Small, composable text layout helpers for the CLI. */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatCount(n)} ${n === 1 ? singular : pluralForm}`;
}

/** A rounded box with an optional title on the top edge and a right-aligned tag. */
export function box(s: Styler, lines: string[], options: { title?: string; tag?: string; width: number }): string[] {
  const u = s.unicode;
  const [tl, tr, bl, br, h, v] = u ? ['╭', '╮', '╰', '╯', '─', '│'] : ['+', '+', '+', '+', '-', '|'];
  const inner = options.width - 2;
  const title = options.title ? ` ${options.title} ` : '';
  const tag = options.tag ? ` ${options.tag} ` : '';
  const fill = Math.max(1, inner - visibleWidth(title) - visibleWidth(tag) - 1);
  const top = s.fg(PALETTE.muted, tl + h) + s.bold(title) + s.fg(PALETTE.muted, h.repeat(fill)) + s.dim(tag) + s.fg(PALETTE.muted, tr);
  const body = lines.map((line) => `${s.fg(PALETTE.muted, v)} ${padEndVisible(line, inner - 2)} ${s.fg(PALETTE.muted, v)}`);
  return [top, ...body, s.fg(PALETTE.muted, bl + h.repeat(inner) + br)];
}

/** A section heading in small caps style. */
export function heading(s: Styler, text: string): string {
  return s.bold(s.fg(PALETTE.accent, text.toUpperCase()));
}

/** A horizontal bar with eighth-block precision. */
export function bar(s: Styler, value: number, max: number, width: number, color: string): string {
  if (max <= 0 || value <= 0) return '';
  const eighths = Math.max(1, Math.round((value / max) * width * 8));
  const full = Math.floor(eighths / 8);
  const rest = eighths % 8;
  const partials = s.unicode ? ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'] : ['', '', '', '', '', '', '', ''];
  return s.fg(color, (s.unicode ? '█' : '#').repeat(full) + partials[rest]);
}

/** A stacked bar of segments that sums to `width` cells. */
export function stackedBar(s: Styler, segments: { value: number; color: string; glyph?: string }[], width: number): string {
  const total = segments.reduce((a, b) => a + b.value, 0);
  if (total === 0) return s.dim('·'.repeat(width));
  let used = 0;
  let out = '';
  segments.forEach((segment, i) => {
    const cells = i === segments.length - 1 ? width - used : Math.round((segment.value / total) * width);
    const n = Math.max(segment.value > 0 ? 1 : 0, Math.min(cells, width - used));
    used += n;
    // Without color, segments stay distinguishable by glyph density.
    const glyph = s.level === 0 ? (segment.glyph ?? '#') : s.unicode ? '█' : '#';
    out += s.fg(segment.color, glyph.repeat(n));
  });
  return out;
}

export function swatch(s: Styler, color: string, glyph?: string): string {
  if (s.level === 0 && glyph) return glyph;
  return s.fg(color, s.unicode ? '■' : '#');
}

export function check(s: Styler, ok: boolean | 'warn' | 'info'): string {
  if (ok === 'info') return s.fg(PALETTE.muted, s.unicode ? '·' : '-');
  if (ok === 'warn') return s.fg(PALETTE.warn, s.unicode ? '▲' : '!');
  return ok ? s.fg(PALETTE.ok, s.unicode ? '✓' : 'ok') : s.fg(PALETTE.error, s.unicode ? '✗' : 'x');
}

/** Two-column rows with an aligned label column. */
export function rows(s: Styler, entries: [label: string, value: string][], labelWidth = 12): string[] {
  return entries.map(([label, value]) => `${s.fg(PALETTE.muted, label.padEnd(labelWidth))}${value}`);
}

export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = max - 1;
  return `${text.slice(0, Math.ceil(keep / 2))}…${text.slice(text.length - Math.floor(keep / 2))}`;
}

/** Word-wrap plain text to `width` columns, at most `maxLines` lines (last one ellipsized). */
export function wrapText(text: string, width: number, maxLines = 3): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= width || current === '') current = candidate.length > width ? truncateMiddle(candidate, width) : candidate;
    else {
      lines.push(current);
      current = word.length > width ? truncateMiddle(word, width) : word;
    }
  }
  if (current) lines.push(current);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1]!.slice(0, Math.max(0, width - 1))}…`;
    return kept;
  }
  return lines;
}
