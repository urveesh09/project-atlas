/**
 * City styles (ADR-039, ADR-041). A style changes only decorative form: building silhouettes,
 * accent parts, ground storeys, window patterns, ground, greenery, walls, gates, lamps, water
 * and harbour depots. Every style keeps the same encodings: code-line height, one lens colour
 * on the facade (accents in darker shades of it), role roofs, plots.
 */
export type CityTheme = 'modern' | 'eastern' | 'western';
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

/** Parts that wrap the wall outline at a storey. */
export type StoreyPart = 'eave' | 'band' | 'crenel';
/** Parts that stand at the corners of a square top. */
export type CornerPart = 'turret' | 'pinnacle' | 'chimney' | 'rooftop';
/** Parts under the building. */
export type BasePart = 'platform' | 'terrace';
export type PartKind = StoreyPart | CornerPart | BasePart;
/**
 * Accent parts are fixed in world size and repeat by storey, so a taller file gains storeys
 * rather than stretched ones. Storey and corner parts take a darker shade of the lens colour;
 * base parts are stone.
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
  /** Corner parts: how many of the four corners (2 = a diagonal pair). */
  corners?: 2 | 4;
}
/** Ground-storey treatment drawn by the facade shader. */
export const BASE = { none: 0, lobby: 1, colonnade: 2, arcade: 3, door: 4 } as const;
export interface Archetype {
  name: string;
  tiers: readonly Tier[];
  parts?: readonly PartSpec[];
  /** Role roof scale on the top outline (crenels and turrets need a little room). */
  roof?: number;
  base?: (typeof BASE)[keyof typeof BASE];
}

export type TreeKind = 'round' | 'conifer' | 'pine' | 'blossom' | 'oak' | 'cypress' | 'willow' | 'plane';
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
  /** Wall materials (see `MATERIAL`); a district alternates two neighbouring ones. */
  materials: readonly number[];
  ground: {
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
  /** Header strips that become lotus ponds with an arched bridge (per cent of districts). */
  ponds: number;
  roofs: { source: string; test: string; other: string };
  /** Source roof silhouette: a plain pyramid, or a curved pavilion roof (still pointed). */
  sourceRoof: 'pyramid' | 'pavilion';
  platform: string;
  terminal: { pier: string; shed: string; roof: string; eaved: boolean };
  /** Sky dome, sea and the distant scenery around the island. */
  sky: { zenith: string; horizon: string; haze: string; sun: string; deep: string; shallow: string };
  scenery: 'bay' | 'karst' | 'alps';
  clouds: string;
}

/**
 * Wall materials drawn by the facade shader between the windows. They change brightness
 * only, never the lens hue, and appear only close up.
 */
export const MATERIAL = { render: 0, brick: 1, panel: 2, fins: 3, ashlar: 4 } as const;

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
  shutter: 9,
} as const;

const W = WINDOW;

export const THEMES: Record<CityTheme, ThemeSpec> = {
  modern: {
    archetypes: [
      { name: 'block', tiers: [box(0, 1, 0.44)], base: BASE.lobby, parts: [{ kind: 'rooftop', corners: 2 }] },
      { name: 'slab', tiers: [box(0, 1, 0.45, 0.3)], base: BASE.lobby, parts: [{ kind: 'rooftop', corners: 2 }] },
      { name: 'setback', tiers: [box(0, 0.5, 0.45, 0.45, 0.94), box(0.5, 0.8, 0.37), box(0.8, 1, 0.29, 0.29, 1.05)], base: BASE.lobby },
      { name: 'podium', tiers: [box(0, 0.16, 0.46, 0.46, 0.88), ring(0.16, 1, 8, 0.42)], base: BASE.lobby },
      { name: 'rotunda', tiers: [ring(0, 1, 12, 0.44, 1, 0.9)], base: BASE.lobby },
      { name: 'tapered', tiers: [box(0, 1, 0.44, 0.44, 1, 0.74)], base: BASE.lobby },
      { name: 'cornice', tiers: [box(0, 0.92, 0.4), box(0.92, 0.945, 0.45, 0.45, 0.84), box(0.945, 1, 0.37)], base: BASE.lobby, parts: [{ kind: 'rooftop', corners: 2 }] },
      { name: 'stepped', tiers: [box(0, 0.62, 0.44, 0.36), box(0.62, 1, 0.3, 0.36, 1.05)], base: BASE.door },
      {
        name: 'glass-tower',
        tiers: [box(0, 0.12, 0.45, 0.45, 0.86), box(0.12, 1, 0.4, 0.34)],
        parts: [{ kind: 'band', every: 1.8, from: 0.9, overhang: 1.06 }, { kind: 'rooftop', corners: 2 }],
        base: BASE.lobby,
      },
      // Art deco: a shaft stepping in three times to a crown.
      { name: 'deco', tiers: [box(0, 0.6, 0.44, 0.44, 1, 0.97), box(0.6, 0.8, 0.36), box(0.8, 0.92, 0.29), box(0.92, 1, 0.24, 0.24, 1.05)], base: BASE.lobby },
      // Octagonal shaft on a low podium, gently tapering.
      { name: 'octagon', tiers: [box(0, 0.1, 0.46, 0.46, 0.88), ring(0.1, 1, 8, 0.41, 1, 0.9)], base: BASE.lobby },
      // A slab whose upper floors step back on one side.
      { name: 'split-slab', tiers: [box(0, 0.7, 0.45, 0.32), box(0.7, 1, 0.45, 0.23, 1.05)], base: BASE.lobby, parts: [{ kind: 'rooftop', corners: 2 }] },
    ],
    families: [
      [0, 6, 2, 9],
      [1, 3, 4, 8, 11],
      [2, 5, 6, 10],
      [0, 1, 4, 5, 8, 9, 11],
    ],
    windows: [
      [W.punched, W.grid],
      [W.curtain, W.ribbon],
      [W.vertical, W.punched],
      [W.grid, W.curtain, W.ribbon],
    ],
    low: [0, 1, 7],
    lowWindows: [W.punched, W.ribbon, W.grid],
    materials: [MATERIAL.panel, MATERIAL.fins, MATERIAL.brick, MATERIAL.render],
    ground: {
      beach: '#e3d4ab',
      belt: '#a9be8c',
      road: '#bcb8aa',
      rootKerb: '#a9a598',
      rootSurface: '#c2beb0',
      packageKerb: '#bab29c',
      packageSurface: '#e8e1cd',
      directoryKerb: '#c9c2ac',
      directory: ['#dfd8c4', '#ece6d4'],
      lawn: '#a9c287',
      marking: '#f3efe4',
    },
    trees: [
      { kind: 'plane', weight: 45, tints: ['#6c9a52', '#7aa65c', '#5f8c4c', '#86ad62'] },
      { kind: 'round', weight: 25, tints: ['#6f9a5c', '#7fa866', '#5f8d58'] },
      { kind: 'conifer', weight: 30, tints: ['#4f7f58', '#5c8a5e', '#466f4e'] },
    ],
    lamp: 'street',
    walls: 'none',
    ponds: 0,
    roofs: { source: '#5e6971', test: '#456471', other: '#5e6971' },
    sourceRoof: 'pyramid',
    platform: '#d9d4c6',
    terminal: { pier: '#8c7660', shed: '#c3b49a', roof: '#687e85', eaved: false },
    sky: { zenith: '#6f9cd0', horizon: '#e4edf1', haze: '#dbe5ea', sun: '#fff3d6', deep: '#2f6d8c', shallow: '#4fb3b2' },
    scenery: 'bay',
    clouds: '#ffffff',
  },
  eastern: {
    archetypes: [
      // Multi-storey pagoda: an eave over every storey, on a marble plinth.
      { name: 'pagoda', tiers: [box(0, 1, 0.38, 0.38, 1, 0.7)], parts: [{ kind: 'platform' }, { kind: 'eave', every: 1.05, from: 0.85, top: true }], base: BASE.colonnade },
      { name: 'octagonal-pagoda', tiers: [ring(0, 1, 8, 0.4, 1, 0.68)], parts: [{ kind: 'platform' }, { kind: 'eave', every: 1, from: 0.8, top: true }], base: BASE.colonnade },
      // Palace hall: three-tier marble terrace, colonnade, double eaves near the top.
      {
        name: 'palace-hall',
        tiers: [box(0, 1, 0.42, 0.3)],
        parts: [{ kind: 'terrace' }, { kind: 'eave', every: 1.7, from: 1.2, top: true }],
        base: BASE.colonnade,
      },
      { name: 'tower-pavilion', tiers: [box(0, 0.22, 0.42, 0.42, 0.9), ring(0.22, 1, 12, 0.36, 1, 0.9)], parts: [{ kind: 'eave', every: 1.4, from: 1.1, top: true }], base: BASE.colonnade },
      { name: 'gate-tower', tiers: [box(0, 0.55, 0.44, 0.36, 0.9), box(0.55, 1, 0.34, 0.28)], parts: [{ kind: 'platform' }, { kind: 'eave', every: 1.25, from: 1, top: true }], base: BASE.arcade },
      { name: 'hall', tiers: [box(0, 1, 0.38, 0.3)], parts: [{ kind: 'terrace' }, { kind: 'eave', top: true }], base: BASE.colonnade },
      { name: 'pavilion', tiers: [ring(0, 1, 8, 0.34)], parts: [{ kind: 'platform' }, { kind: 'eave', top: true }], base: BASE.colonnade },
      // Two halls stacked on a terrace: a broad lower hall and a smaller upper hall.
      {
        name: 'tiered-hall',
        tiers: [box(0, 0.5, 0.44, 0.34), box(0.5, 1, 0.32, 0.25, 1.04)],
        parts: [{ kind: 'terrace' }, { kind: 'eave', every: 1.5, from: 1, top: true }],
        base: BASE.colonnade,
      },
      // Lofty pavilion hall: octagonal, open below, eaves at long intervals.
      { name: 'pavilion-hall', tiers: [ring(0, 1, 8, 0.42, 1, 0.86)], parts: [{ kind: 'terrace' }, { kind: 'eave', every: 2, from: 1.3, top: true }], base: BASE.colonnade },
    ],
    families: [
      [0, 2, 7],
      [1, 3, 8],
      [2, 4, 7],
      [1, 0, 4, 3, 8],
    ],
    windows: [[W.lattice], [W.lattice, W.grid], [W.lattice, W.vertical], [W.lattice]],
    low: [5, 6],
    lowWindows: [W.lattice],
    materials: [MATERIAL.render, MATERIAL.brick, MATERIAL.ashlar],
    ground: {
      beach: '#d8ceb4',
      belt: '#a2bb8a',
      road: '#c7bda7',
      rootKerb: '#a69c86',
      rootSurface: '#cbc1aa',
      packageKerb: '#b9ad94',
      packageSurface: '#ebe2cb',
      directoryKerb: '#c8bea6',
      directory: ['#e2d9c1', '#efe7d2'],
      lawn: '#a6bf8a',
      marking: null,
    },
    trees: [
      { kind: 'pine', weight: 35, tints: ['#4f7a52', '#5b8659', '#45704c'] },
      { kind: 'blossom', weight: 30, tints: ['#e7a8b8', '#efbccb', '#dc97ac', '#f2c9d3'] },
      { kind: 'willow', weight: 20, tints: ['#8bab5e', '#97b766', '#7f9f56'] },
      { kind: 'round', weight: 15, tints: ['#6f9a5c', '#7fa866'] },
    ],
    lamp: 'lantern',
    walls: 'eastern',
    ponds: 40,
    roofs: { source: '#4a3c37', test: '#3e5a55', other: '#4a3c37' },
    sourceRoof: 'pavilion',
    platform: '#ebe6da',
    terminal: { pier: '#7d6450', shed: '#a8584a', roof: '#4a3c37', eaved: true },
    sky: { zenith: '#86aebf', horizon: '#f1e7d4', haze: '#e7e2d6', sun: '#ffe6b5', deep: '#2f7a72', shallow: '#68c2a8' },
    scenery: 'karst',
    clouds: '#fff8ee',
  },
  western: {
    archetypes: [
      { name: 'keep', tiers: [box(0, 1, 0.41)], parts: [{ kind: 'band', every: 2.1, from: 1.6, overhang: 1.07 }, { kind: 'crenel', top: true }], roof: 0.82, base: BASE.arcade },
      { name: 'round-tower', tiers: [ring(0, 1, 12, 0.4)], parts: [{ kind: 'band', every: 2.3, from: 1.7, overhang: 1.07 }, { kind: 'crenel', top: true }], roof: 0.82, base: BASE.door },
      { name: 'timber-house', tiers: [box(0, 0.36, 0.37, 0.35, 0.96), box(0.36, 0.68, 0.405, 0.38), box(0.68, 1, 0.44, 0.41, 1.03)], parts: [{ kind: 'chimney', corners: 2 }], base: BASE.door },
      { name: 'wizard-tower', tiers: [ring(0, 1, 12, 0.36, 1, 0.72)], parts: [{ kind: 'band', every: 1.6, from: 1.2, overhang: 1.2 }], base: BASE.door },
      // Chapel: arcaded nave with pinnacles at the corners.
      { name: 'chapel', tiers: [box(0, 1, 0.44, 0.3)], parts: [{ kind: 'band', every: 1.9, from: 1.3, overhang: 1.06 }, { kind: 'pinnacle', corners: 4 }], roof: 0.86, base: BASE.arcade },
      { name: 'guild-hall', tiers: [box(0, 0.6, 0.45, 0.4, 0.94), box(0.6, 1, 0.35, 0.31)], parts: [{ kind: 'band', every: 2, from: 1.5, overhang: 1.06 }, { kind: 'crenel', top: true }], roof: 0.82, base: BASE.arcade },
      { name: 'cottage', tiers: [box(0, 1, 0.38, 0.32)], parts: [{ kind: 'chimney', corners: 2 }], base: BASE.door },
      { name: 'turret', tiers: [ring(0, 1, 8, 0.34)], parts: [{ kind: 'crenel', top: true }], roof: 0.82, base: BASE.door },
      // Fortress: a battered (sloped) base, a keep, four corner turrets and battlements.
      {
        name: 'fortress',
        tiers: [box(0, 0.16, 0.46, 0.46, 0.9, 0.9), box(0.16, 1, 0.38)],
        parts: [{ kind: 'crenel', top: true }, { kind: 'turret', corners: 4 }, { kind: 'band', every: 2.4, from: 1.8, overhang: 1.06 }],
        roof: 0.72,
        base: BASE.arcade,
      },
      // Manor: a broad mansion with chimneys, shuttered windows and a central door.
      { name: 'manor', tiers: [box(0, 1, 0.45, 0.33)], parts: [{ kind: 'band', every: 1.4, from: 1.1, overhang: 1.04 }, { kind: 'chimney', corners: 4 }], roof: 0.9, base: BASE.door },
      // Bell tower: a shaft with two set-back stages and corner pinnacles.
      {
        name: 'bell-tower',
        tiers: [box(0, 0.72, 0.4), box(0.72, 0.86, 0.33), box(0.86, 1, 0.27)],
        parts: [{ kind: 'band', every: 2, from: 1.5, overhang: 1.07 }, { kind: 'pinnacle', corners: 4 }],
        roof: 0.86,
        base: BASE.arcade,
      },
    ],
    families: [
      [0, 1, 8, 10],
      [2, 9, 5],
      [3, 1, 4, 10],
      [8, 9, 3, 4],
    ],
    windows: [
      [W.slit, W.arched],
      [W.timber, W.shutter, W.arched],
      [W.arched, W.slit],
      [W.arched, W.shutter, W.slit],
    ],
    low: [6, 7],
    lowWindows: [W.timber, W.shutter],
    materials: [MATERIAL.ashlar, MATERIAL.brick, MATERIAL.render],
    ground: {
      beach: '#d9cba6',
      belt: '#9cb97c',
      road: '#b2a790',
      rootKerb: '#958a75',
      rootSurface: '#b9ae97',
      packageKerb: '#ada18a',
      packageSurface: '#e3d9c1',
      directoryKerb: '#c0b59e',
      directory: ['#d9cfb6', '#e7dec8'],
      lawn: '#9fbe80',
      marking: null,
    },
    trees: [
      { kind: 'oak', weight: 50, tints: ['#5f8a4f', '#6c9658', '#557f48', '#78a060'] },
      { kind: 'cypress', weight: 30, tints: ['#4c744e', '#557f55'] },
      { kind: 'conifer', weight: 20, tints: ['#4f7f58', '#5c8a5e'] },
    ],
    lamp: 'iron',
    walls: 'western',
    ponds: 0,
    roofs: { source: '#4d5967', test: '#3f5a6a', other: '#4d5967' },
    sourceRoof: 'pyramid',
    platform: '#c9c0ae',
    terminal: { pier: '#7d6450', shed: '#a88a66', roof: '#4d5967', eaved: false },
    sky: { zenith: '#5f86c0', horizon: '#f2e3c8', haze: '#e4dccb', sun: '#ffdf9f', deep: '#24587a', shallow: '#4f9db0' },
    scenery: 'alps',
    clouds: '#fff6e8',
  },
};
