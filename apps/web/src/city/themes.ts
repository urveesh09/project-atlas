/**
 * City styles (ADR-039). A style changes only decorative form: building silhouettes, accent
 * parts, window patterns, ground, greenery, walls, lamps and harbour depots. Every style keeps
 * the same encodings: code-line height, one lens colour on the facade, role roofs, plots.
 */
export type CityTheme = 'modern' | 'eastern' | 'western';
/** Camera mode: a perspective "cinematic" city, or the orthographic plan view. */
export type CityView = 'cinematic' | 'isometric';
export const CITY_VIEWS = ['cinematic', 'isometric'] as const;
export const CITY_VIEW_LABEL: Record<CityView, string> = {
  cinematic: 'Cinematic 3D',
  isometric: 'Isometric',
};
export const CITY_THEMES = ['modern', 'eastern', 'western'] as const;
export const CITY_THEME_LABEL: Record<CityTheme, string> = {
  modern: 'Modern city',
  eastern: 'Eastern fantasy',
  western: 'Western fantasy',
};

export interface Tier {
  /** Fraction of the body span; the instance scales y to the building's height. */
  y0: number;
  y1: number;
  sides: 4 | 8 | 12;
  /** Half extents in plot cells (circumradius for 8/12 sides). */
  hx: number;
  hz: number;
  /** Top outline scale relative to the bottom. */
  taper: number;
  /** Brightness multiplier that keeps the lens hue. */
  shade: number;
}
export const box = (y0: number, y1: number, hx: number, hz = hx, shade = 1, taper = 1): Tier => ({ y0, y1, sides: 4, hx, hz, taper, shade });
export const ring = (y0: number, y1: number, sides: 8 | 12, r: number, shade = 1, taper = 1): Tier => ({ y0, y1, sides, hx: r, hz: r, taper, shade });

export type PartKind = 'eave' | 'band' | 'crenel' | 'platform';
/**
 * Accent parts are fixed in world size and repeat by storey, so a taller file gains storeys
 * rather than stretched ones. Eaves, bands and crenels take a darker shade of the lens colour.
 */
export interface PartSpec {
  kind: PartKind;
  /** Storey spacing in world units; omitted for a single top or base part. */
  every?: number;
  /** First storey offset above the ground. */
  from?: number;
  /** Also place one just under the top. */
  top?: boolean;
  /** Outline scale relative to the wall at that height. */
  overhang?: number;
}
export interface Archetype {
  name: string;
  tiers: readonly Tier[];
  parts?: readonly PartSpec[];
  /** Role roof scale on the top outline (crenels need a little room). */
  roof?: number;
}

export type TreeKind = 'round' | 'conifer' | 'pine' | 'blossom' | 'oak' | 'cypress';
export type LampKind = 'street' | 'lantern' | 'iron';

export interface ThemeSpec {
  archetypes: readonly Archetype[];
  /** Neighbourhood families of tall archetypes; one is chosen per district. */
  families: readonly (readonly number[])[];
  /** Window patterns per family (same order as families). */
  windows: readonly (readonly number[])[];
  /** Fixed-height kiosk and declaration roles. */
  low: readonly number[];
  lowWindows: readonly number[];
  ground: {
    earth: string;
    water: string;
    beach: string;
    belt: string;
    road: string;
    rootKerb: string;
    rootSurface: string;
    packageKerb: string;
    packageSurface: string;
    directoryKerb: string;
    directory: readonly [string, string];
    lawn: string;
    marking: string | null;
  };
  trees: readonly { kind: TreeKind; weight: number; tints: readonly string[] }[];
  lamp: LampKind;
  walls: 'none' | 'eastern' | 'western';
  roofs: { source: string; test: string; other: string };
  platform: string;
  terminal: { pier: string; shed: string; roof: string; eaved: boolean };
  /** Cinematic view only: sky dome, ocean and the distant scenery around the island. */
  sky: { zenith: string; horizon: string; haze: string; sun: string; ocean: string };
  scenery: 'bay' | 'karst' | 'alps';
}

/** Window patterns understood by the facade shader. */
export const WINDOW = {
  punched: 0,
  ribbon: 1,
  vertical: 2,
  grid: 3,
  lattice: 4,
  arched: 5,
  timber: 6,
  curtain: 7,
  slit: 8,
} as const;

const W = WINDOW;

export const THEMES: Record<CityTheme, ThemeSpec> = {
  modern: {
    archetypes: [
      { name: 'block', tiers: [box(0, 1, 0.44)] },
      { name: 'slab', tiers: [box(0, 1, 0.45, 0.3)] },
      { name: 'setback', tiers: [box(0, 0.5, 0.45, 0.45, 0.94), box(0.5, 0.8, 0.37), box(0.8, 1, 0.29, 0.29, 1.05)] },
      { name: 'podium', tiers: [box(0, 0.16, 0.46, 0.46, 0.88), ring(0.16, 1, 8, 0.42)] },
      { name: 'rotunda', tiers: [ring(0, 1, 12, 0.44, 1, 0.9)] },
      { name: 'tapered', tiers: [box(0, 1, 0.44, 0.44, 1, 0.74)] },
      { name: 'cornice', tiers: [box(0, 0.92, 0.4), box(0.92, 0.945, 0.45, 0.45, 0.84), box(0.945, 1, 0.37)] },
      { name: 'stepped', tiers: [box(0, 0.62, 0.44, 0.36), box(0.62, 1, 0.3, 0.36, 1.05)] },
      { name: 'glass-tower', tiers: [box(0, 0.12, 0.45, 0.45, 0.86), box(0.12, 1, 0.4, 0.34)], parts: [{ kind: 'band', every: 1.8, from: 0.9, overhang: 1.06 }] },
    ],
    families: [
      [0, 6, 2],
      [1, 3, 4, 8],
      [2, 5, 6],
      [0, 1, 4, 5, 8],
    ],
    windows: [
      [W.punched, W.grid],
      [W.curtain, W.ribbon],
      [W.vertical, W.punched],
      [W.grid, W.curtain, W.ribbon],
    ],
    low: [0, 1, 7],
    lowWindows: [W.punched, W.ribbon, W.grid],
    ground: {
      earth: '#8a8070',
      water: '#8fbac1',
      beach: '#e3d4ab',
      belt: '#a9be8c',
      road: '#bcb8aa',
      rootKerb: '#a9a598',
      rootSurface: '#c2beb0',
      packageKerb: '#bab29c',
      packageSurface: '#e8e1cd',
      directoryKerb: '#c9c2ac',
      directory: ['#dfd8c4', '#ece6d4'],
      lawn: '#b3c795',
      marking: '#f3efe4',
    },
    trees: [
      { kind: 'round', weight: 65, tints: ['#6f9a5c', '#7fa866', '#5f8d58', '#8aaf6a', '#6a9468'] },
      { kind: 'conifer', weight: 35, tints: ['#5c8a5e', '#4f7f58', '#668f5f'] },
    ],
    lamp: 'street',
    walls: 'none',
    roofs: { source: '#5e6971', test: '#456471', other: '#5e6971' },
    platform: '#d9d4c6',
    terminal: { pier: '#8c7660', shed: '#c3b49a', roof: '#687e85', eaved: false },
    sky: { zenith: '#6f9cd0', horizon: '#e4edf1', haze: '#dbe5ea', sun: '#fff3d6', ocean: '#6a9db0' },
    scenery: 'bay',
  },
  eastern: {
    archetypes: [
      { name: 'pagoda', tiers: [box(0, 1, 0.38, 0.38, 1, 0.7)], parts: [{ kind: 'platform' }, { kind: 'eave', every: 1.05, from: 0.85, top: true }] },
      { name: 'octagonal-pagoda', tiers: [ring(0, 1, 8, 0.4, 1, 0.68)], parts: [{ kind: 'platform' }, { kind: 'eave', every: 1, from: 0.8, top: true }] },
      { name: 'palace-hall', tiers: [box(0, 1, 0.42, 0.3)], parts: [{ kind: 'platform' }, { kind: 'eave', every: 1.7, from: 1.2, top: true }] },
      { name: 'tower-pavilion', tiers: [box(0, 0.22, 0.42, 0.42, 0.9), ring(0.22, 1, 12, 0.36, 1, 0.9)], parts: [{ kind: 'eave', every: 1.4, from: 1.1, top: true }] },
      { name: 'gate-tower', tiers: [box(0, 0.55, 0.44, 0.36, 0.9), box(0.55, 1, 0.34, 0.28)], parts: [{ kind: 'platform' }, { kind: 'eave', every: 1.25, from: 1, top: true }] },
      { name: 'hall', tiers: [box(0, 1, 0.38, 0.3)], parts: [{ kind: 'platform' }, { kind: 'eave', top: true }] },
      { name: 'pavilion', tiers: [ring(0, 1, 8, 0.34)], parts: [{ kind: 'platform' }, { kind: 'eave', top: true }] },
    ],
    families: [
      [0, 2],
      [1, 3],
      [0, 4, 2],
      [1, 0, 4, 3],
    ],
    windows: [[W.lattice], [W.lattice, W.grid], [W.lattice, W.vertical], [W.lattice]],
    low: [5, 6],
    lowWindows: [W.lattice],
    ground: {
      earth: '#7e7462',
      water: '#86b9ab',
      beach: '#d8ceb4',
      belt: '#a2bb8a',
      road: '#c7bda7',
      rootKerb: '#a69c86',
      rootSurface: '#cbc1aa',
      packageKerb: '#b9ad94',
      packageSurface: '#ebe2cb',
      directoryKerb: '#c8bea6',
      directory: ['#e2d9c1', '#efe7d2'],
      lawn: '#acc392',
      marking: null,
    },
    trees: [
      { kind: 'pine', weight: 45, tints: ['#4f7a52', '#5b8659', '#45704c'] },
      { kind: 'blossom', weight: 35, tints: ['#e7a8b8', '#efbccb', '#dc97ac', '#f2c9d3'] },
      { kind: 'round', weight: 20, tints: ['#6f9a5c', '#7fa866'] },
    ],
    lamp: 'lantern',
    walls: 'eastern',
    roofs: { source: '#4a3c37', test: '#3e5a55', other: '#4a3c37' },
    platform: '#ebe6da',
    terminal: { pier: '#7d6450', shed: '#a8584a', roof: '#4a3c37', eaved: true },
    sky: { zenith: '#86aebf', horizon: '#f1e7d4', haze: '#e7e2d6', sun: '#ffe6b5', ocean: '#6fa898' },
    scenery: 'karst',
  },
  western: {
    archetypes: [
      { name: 'keep', tiers: [box(0, 1, 0.41)], parts: [{ kind: 'band', every: 2.1, from: 1.6, overhang: 1.07 }, { kind: 'crenel', top: true }], roof: 0.82 },
      { name: 'round-tower', tiers: [ring(0, 1, 12, 0.4)], parts: [{ kind: 'band', every: 2.3, from: 1.7, overhang: 1.07 }, { kind: 'crenel', top: true }], roof: 0.82 },
      { name: 'timber-house', tiers: [box(0, 0.36, 0.37, 0.35, 0.96), box(0.36, 0.68, 0.405, 0.38), box(0.68, 1, 0.44, 0.41, 1.03)] },
      { name: 'wizard-tower', tiers: [ring(0, 1, 12, 0.36, 1, 0.72)], parts: [{ kind: 'band', every: 1.6, from: 1.2, overhang: 1.2 }] },
      { name: 'chapel', tiers: [box(0, 1, 0.44, 0.3)], parts: [{ kind: 'band', every: 1.9, from: 1.3, overhang: 1.06 }] },
      { name: 'guild-hall', tiers: [box(0, 0.6, 0.45, 0.4, 0.94), box(0.6, 1, 0.35, 0.31)], parts: [{ kind: 'band', every: 2, from: 1.5, overhang: 1.06 }, { kind: 'crenel', top: true }], roof: 0.82 },
      { name: 'cottage', tiers: [box(0, 1, 0.38, 0.32)] },
      { name: 'turret', tiers: [ring(0, 1, 8, 0.34)], parts: [{ kind: 'crenel', top: true }], roof: 0.82 },
    ],
    families: [
      [0, 1, 0],
      [2, 5, 2],
      [3, 1, 4],
      [0, 2, 3, 4],
    ],
    windows: [
      [W.slit, W.arched],
      [W.timber, W.timber, W.arched],
      [W.arched, W.slit],
      [W.arched, W.timber, W.slit],
    ],
    low: [6, 7],
    lowWindows: [W.timber, W.arched],
    ground: {
      earth: '#7a7060',
      water: '#7fa6bb',
      beach: '#d9cba6',
      belt: '#9cb97c',
      road: '#b2a790',
      rootKerb: '#958a75',
      rootSurface: '#b9ae97',
      packageKerb: '#ada18a',
      packageSurface: '#e3d9c1',
      directoryKerb: '#c0b59e',
      directory: ['#d9cfb6', '#e7dec8'],
      lawn: '#a3bf85',
      marking: null,
    },
    trees: [
      { kind: 'oak', weight: 55, tints: ['#5f8a4f', '#6c9658', '#557f48', '#78a060'] },
      { kind: 'cypress', weight: 30, tints: ['#4c744e', '#557f55'] },
      { kind: 'conifer', weight: 15, tints: ['#4f7f58', '#5c8a5e'] },
    ],
    lamp: 'iron',
    walls: 'western',
    roofs: { source: '#4d5967', test: '#3f5a6a', other: '#4d5967' },
    platform: '#c9c0ae',
    terminal: { pier: '#7d6450', shed: '#a88a66', roof: '#4d5967', eaved: false },
    sky: { zenith: '#5f86c0', horizon: '#f2e3c8', haze: '#e4dccb', sun: '#ffdf9f', ocean: '#55869f' },
    scenery: 'alps',
  },
};
