import type { CityBuilding, CityData } from '@atlas/layout';
import { crc32 } from './export';

/**
 * 3D-print export (ADR-055). The model holds only what the data says:
 *
 * - a base plate under the whole city;
 * - one plinth per district, stepping up with nesting depth;
 * - one box per file, centred on its plot, standing on its district and as tall as the
 *   city shows it (code lines, logarithmic).
 *
 * Decorative parts (roofs, trees, windows, the harbour) are left out. Sizes are in
 * millimetres, scaled so the longer side of the city is `size` long.
 *
 * - STL is binary and single-colour.
 * - 3MF carries one colour per box: the colours on screen, whether from the lens, custom
 *   bands or change colouring.
 */
export interface PrintOptions {
  /** Longer side of the base in millimetres. */
  size: number;
  /** Base plate thickness, district step and the smallest building, in millimetres. */
  base: number;
  step: number;
  minHeight: number;
  /** Building footprint as a fraction of its plot. */
  footprint: number;
}
export const PRINT_DEFAULTS: PrintOptions = { size: 150, base: 2, step: 0.6, minHeight: 0.4, footprint: 0.7 };
export const PRINT_LIMITS = { boxes: 250_000 } as const;

export interface PrintBox {
  /** Minimum corner and size, in millimetres; z is up. */
  x: number;
  y: number;
  z: number;
  w: number;
  d: number;
  h: number;
  colour: string;
}
export interface PrintModel {
  boxes: PrintBox[];
  /** Overall size in millimetres. */
  width: number;
  depth: number;
  height: number;
  buildings: number;
}

const BASE_COLOUR = '#d9d3c4';
const DISTRICT_COLOURS = ['#e9e4d7', '#ddd8c6', '#d1cdb9'] as const;

export function buildPrintModel(city: CityData, colourOf: (b: CityBuilding) => string, options: Partial<PrintOptions> = {}): PrintModel {
  const o = { ...PRINT_DEFAULTS, ...options };
  if (city.buildings.length + city.districts.length + 1 > PRINT_LIMITS.boxes) throw new Error(`The model would need more than ${PRINT_LIMITS.boxes.toLocaleString('en-US')} solids`);
  // Layout units are 1/100 of a renderer world unit; heights are already world units.
  const k = o.size / (Math.max(city.root.width, city.root.depth) / 100);
  const mm = (layout: number) => (layout / 100) * k;
  const depthOf = new Map(city.districts.map((d) => [d.id, d.depth]));
  const plinth = (depth: number) => o.base + depth * o.step;
  const boxes: PrintBox[] = [
    { x: 0, y: 0, z: 0, w: mm(city.root.width), d: mm(city.root.depth), h: o.base, colour: BASE_COLOUR },
  ];
  // Districts nest: each plinth starts on the base and reaches its own level, so nested
  // plinths overlap their parents. Slicers merge overlapping solids.
  for (const d of city.districts) {
    if (d.depth === 0) continue;
    boxes.push({ x: mm(d.rect.x - city.root.x), y: mm(d.rect.z - city.root.z), z: 0, w: mm(d.rect.width), d: mm(d.rect.depth), h: plinth(d.depth), colour: DISTRICT_COLOURS[d.depth % DISTRICT_COLOURS.length]! });
  }
  let top = o.base;
  for (const b of city.buildings) {
    const w = mm(b.rect.width) * o.footprint,
      d = mm(b.rect.depth) * o.footprint;
    const floor = plinth(depthOf.get(b.districtId) ?? 0);
    const h = Math.max(o.minHeight, b.height * k);
    boxes.push({ x: mm(b.rect.x - city.root.x) + (mm(b.rect.width) - w) / 2, y: mm(b.rect.z - city.root.z) + (mm(b.rect.depth) - d) / 2, z: floor, w, d, h, colour: colourOf(b) });
    top = Math.max(top, floor + h);
  }
  return { boxes, width: mm(city.root.width), depth: mm(city.root.depth), height: Math.max(top, ...boxes.map((b) => b.z + b.h)), buildings: city.buildings.length };
}

// A box's 8 corners and its 12 outward-facing triangles (counter-clockwise seen from outside).
const CORNERS = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
] as const;
const FACES = [
  [0, 2, 1], [0, 3, 2], // bottom (z = 0, facing down)
  [4, 5, 6], [4, 6, 7], // top
  [0, 1, 5], [0, 5, 4], // y = 0
  [1, 2, 6], [1, 6, 5], // x = 1
  [2, 3, 7], [2, 7, 6], // y = 1
  [3, 0, 4], [3, 4, 7], // x = 0
] as const;
const NORMALS = [
  [0, 0, -1], [0, 0, -1],
  [0, 0, 1], [0, 0, 1],
  [0, -1, 0], [0, -1, 0],
  [1, 0, 0], [1, 0, 0],
  [0, 1, 0], [0, 1, 0],
  [-1, 0, 0], [-1, 0, 0],
] as const;
const corner = (b: PrintBox, i: number) => {
  const c = CORNERS[i]!;
  return [b.x + c[0] * b.w, b.y + c[1] * b.d, b.z + c[2] * b.h] as const;
};

/** Binary STL: 80-byte header, triangle count, 50 bytes per triangle. */
export function toStl(model: PrintModel, header = 'ATLAS city model (static analysis)'): Uint8Array {
  const triangles = model.boxes.length * 12;
  const out = new Uint8Array(84 + triangles * 50);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode(header.slice(0, 80)));
  view.setUint32(80, triangles, true);
  let at = 84;
  for (const b of model.boxes)
    FACES.forEach((face, f) => {
      const n = NORMALS[f]!;
      for (const v of n) (view.setFloat32(at, v, true), (at += 4));
      for (const i of face) for (const v of corner(b, i)) (view.setFloat32(at, v, true), (at += 4));
      at += 2;
    });
  return out;
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (n: number) => (Math.round(n * 1000) / 1000).toString();

/** The 3MF model part: one mesh object per box, each with its colour as a base material. */
export function threeMfModel(model: PrintModel, title: string): string {
  const colours = [...new Set(model.boxes.map((b) => b.colour.toUpperCase()))];
  const colourIndex = new Map(colours.map((c, i) => [c, i]));
  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
    `<metadata name="Title">${xml(title)}</metadata>`,
    '<metadata name="Application">ATLAS</metadata>',
    '<resources>',
    `<basematerials id="1">${colours.map((c, i) => `<base name="c${i}" displaycolor="${c}FF"/>`).join('')}</basematerials>`,
  ];
  model.boxes.forEach((b, i) => {
    const vertices = CORNERS.map((_, c) => {
      const [x, y, z] = corner(b, c);
      return `<vertex x="${num(x)}" y="${num(y)}" z="${num(z)}"/>`;
    }).join('');
    // The colour is set on the object and repeated on each triangle, which more readers honour.
    const index = colourIndex.get(b.colour.toUpperCase());
    const triangles = FACES.map(([a, c, d]) => `<triangle v1="${a}" v2="${c}" v3="${d}" pid="1" p1="${index}"/>`).join('');
    parts.push(`<object id="${i + 2}" type="model" pid="1" pindex="${index}"><mesh><vertices>${vertices}</vertices><triangles>${triangles}</triangles></mesh></object>`);
  });
  parts.push('</resources>', '<build>', ...model.boxes.map((_, i) => `<item objectid="${i + 2}"/>`), '</build>', '</model>');
  return parts.join('\n');
}

/** An uncompressed ZIP (store method) with CRC-32s, as 3MF packages require. */
export function zipStore(files: readonly { name: string; data: Uint8Array }[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const crc = crc32(file.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, file.data.length, true);
    lv.setUint32(22, file.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, file.data.length, true);
    cv.setUint32(24, file.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, file.data);
    centrals.push(central);
    offset += local.length + file.data.length;
  }
  const centralSize = centrals.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function to3mf(model: PrintModel, title: string): Uint8Array {
  const encoder = new TextEncoder();
  return zipStore([
    {
      name: '[Content_Types].xml',
      data: encoder.encode(
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>',
      ),
    },
    {
      name: '_rels/.rels',
      data: encoder.encode(
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
      ),
    },
    { name: '3D/3dmodel.model', data: encoder.encode(threeMfModel(model, title)) },
  ]);
}
