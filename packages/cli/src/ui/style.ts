/**
 * Terminal styling with honest capability detection: NO_COLOR and non-TTY output get
 * plain text; FORCE_COLOR or a truecolor terminal gets 24-bit color; otherwise 256 colors.
 * JSON modes never use this module.
 */
export type ColorLevel = 0 | 1 | 2 | 3;

export interface Styler {
  level: ColorLevel;
  unicode: boolean;
  fg(hex: string, text: string): string;
  bg(hex: string, text: string): string;
  /** Foreground + background in one escape (used by the half-block map). */
  pair(fgHex: string, bgHex: string, text: string): string;
  bold(text: string): string;
  dim(text: string): string;
  italic(text: string): string;
}

export function detectColorLevel(env: Readonly<Record<string, string | undefined>>, isTTY: boolean): ColorLevel {
  if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') return 0;
  const force = env['FORCE_COLOR'];
  if (force !== undefined) return force === '0' || force === 'false' ? 0 : force === '1' ? 1 : force === '2' ? 2 : 3;
  if (!isTTY || env['TERM'] === 'dumb') return 0;
  if (env['COLORTERM'] === 'truecolor' || env['COLORTERM'] === '24bit' || env['WT_SESSION'] || env['TERM_PROGRAM'] === 'vscode' || env['TERM_PROGRAM'] === 'iTerm.app') return 3;
  if (/256/.test(env['TERM'] ?? '') || process.platform === 'win32') return 2;
  return 1;
}

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function to256([r, g, b]: [number, number, number]): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const q = (v: number) => Math.round((v / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

function to16([r, g, b]: [number, number, number]): number {
  const bright = Math.max(r, g, b) > 170 ? 60 : 0;
  const bit = (v: number) => (v > 100 ? 1 : 0);
  return 30 + bright + (bit(b) << 2) + (bit(g) << 1) + bit(r);
}

export function createStyler(level: ColorLevel, unicode = true): Styler {
  const code = (hex: string, layer: 'fg' | 'bg'): string => {
    const c = rgb(hex);
    if (level === 3) return `${layer === 'fg' ? 38 : 48};2;${c[0]};${c[1]};${c[2]}`;
    if (level === 2) return `${layer === 'fg' ? 38 : 48};5;${to256(c)}`;
    const base = to16(c);
    return String(layer === 'fg' ? base : base + 10);
  };
  const wrap = (open: string, text: string, close = '\u001b[0m') => (level === 0 ? text : `\u001b[${open}m${text}${close}`);
  return {
    level,
    unicode,
    fg: (hex, text) => wrap(code(hex, 'fg'), text, '\u001b[39m'),
    bg: (hex, text) => wrap(code(hex, 'bg'), text, '\u001b[49m'),
    pair: (fgHex, bgHex, text) => wrap(`${code(fgHex, 'fg')};${code(bgHex, 'bg')}`, text),
    bold: (text) => wrap('1', text, '\u001b[22m'),
    dim: (text) => wrap('2', text, '\u001b[22m'),
    italic: (text) => wrap('3', text, '\u001b[23m'),
  };
}

/** The ATLAS terminal palette: a miniature city at dusk. */
export const PALETTE = {
  brand: '#e8c170',
  accent: '#7fb4d8',
  ok: '#7fd1a8',
  warn: '#f0b45d',
  error: '#f07a6a',
  muted: '#8a93a3',
  text: '#d8dee9',
  ground: '#171c27',
  road: '#262e3d',
  districts: ['#2f4a63', '#4a3f63', '#2f5a4c', '#5e4a33', '#563450', '#33545e', '#4f5a33', '#5e3a3a'],
  roles: {
    source: '#e8c170',
    test: '#7fd1a8',
    config: '#f08a5d',
    asset: '#b48ead',
    declaration: '#88c0d0',
    opaque: '#9aa3ad',
  } as Record<string, string>,
} as const;

/** Lighten a hex color toward white by `amount` (0..1). */
export function lighten(hex: string, amount: number): string {
  const [r, g, b] = rgb(hex);
  const mix = (v: number) => Math.round(v + (255 - v) * amount);
  return `#${[mix(r), mix(g), mix(b)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Visible width of a string, ignoring ANSI escapes (all ATLAS glyphs are single-width). */
export function visibleWidth(text: string): number {
  // eslint-disable-next-line no-control-regex
  return [...text.replace(/\u001b\[[0-9;]*m/g, '')].length;
}

export function padEndVisible(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visibleWidth(text)));
}
