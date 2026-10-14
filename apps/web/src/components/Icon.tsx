/**
 * A small stroke icon set drawn for the viewer (24-unit grid, currentColor). Icons are
 * decorative: the control that holds one carries the accessible name.
 */
const PATHS = {
  back: 'M19 12H5M11 18l-6-6 6-6',
  forward: 'M5 12h14M13 6l6 6-6 6',
  home: 'M4 10.5 12 4l8 6.5M6 9v11h12V9M10 20v-5h4v5',
  panel: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM15 5v14',
  expand: 'M14 4h6v6M10 20H4v-6M20 4l-6.5 6.5M4 20l6.5-6.5',
  collapse: 'M4 14h6v6M20 10h-6V4M14 10l6.5-6.5M10 14l-6.5 6.5',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  north: 'M12 3.5 16.5 19 12 15.5 7.5 19z',
  focus: 'M12 3v3M12 18v3M3 12h3M18 12h3M12 7.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9z',
  chevronLeft: 'M14.5 6 8.5 12l6 6',
  chevronRight: 'M9.5 6l6 6-6 6',
  share: 'M12 15V4M7.5 8.5 12 4l4.5 4.5M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5',
  bookmark: 'M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1z',
  close: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
  tree: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM9 5v14',
  keyboard: 'M3 7h18v10H3zM7 10h.01M11 10h.01M15 10h.01M17 10h.01M7 13.5h10',
  external: 'M14 4h6v6M20 4l-8.5 8.5M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  copy: 'M9 9h10v11H9zM15 9V5a1 1 0 0 0-1-1H6a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3',
  download: 'M12 4v11M7.5 10.5 12 15l4.5-4.5M5 20h14',
  upload: 'M12 15V4M7.5 8.5 12 4l4.5 4.5M5 20h14',
  file: 'M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7zM14 3v4h4',
  play: 'M8 5.5v13l10-6.5z',
  pause: 'M8 5v14M16 5v14',
  compare: 'M4 5h6v14H4zM14 5h6v14h-6z',
  package: 'M12 3 20 7.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12 4 7.5',
  search: 'M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM15.5 15.5 20 20',
  scope: 'M6 3v12a3 3 0 0 0 3 3h12M3 6h12a3 3 0 0 1 3 3v12',
  hide: 'M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 8.5 4 9.5 6a12.6 12.6 0 0 1-2.8 3.6M6.6 6.6C4.4 8 3 10.2 2.5 12c1 2 4.5 6 9.5 6a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2',
  bands: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  note: 'M5 4h10l4 4v12H5zM15 4v4h4M8.5 12h7M8.5 15.5h5',
  cube: 'M12 3 20 7.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
  link: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1',
} as const;

export type IconName = keyof typeof PATHS;

const FILLED: ReadonlySet<IconName> = new Set(['north', 'play']);

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const filled = FILLED.has(name);
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={filled ? 1.5 : 1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
