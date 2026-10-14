import { describe, expect, it } from 'vitest';
import type { CityBuilding, CityData } from '@atlas/layout';
import { crc32 } from '../src/city/export';
import { buildPrintModel, to3mf, toStl } from '../src/city/print3d';

const building = (id: string, x: number, z: number, height: number, districtId: string): CityBuilding =>
  ({ nodeId: id, lineageId: id, districtId, path: `${id}.ts`, rect: { x, z, width: 100, depth: 100 }, height }) as unknown as CityBuilding;
const city = {
  root: { x: 0, z: 0, width: 1000, depth: 500 },
  plotCount: 3,
  districts: [
    { id: 'root', rect: { x: 0, z: 0, width: 1000, depth: 500 }, depth: 0, path: '', nodeId: null, kind: 'directory', label: '' },
    { id: 'pkg', rect: { x: 100, z: 100, width: 400, depth: 300 }, depth: 1, path: 'pkg', nodeId: null, kind: 'package', label: 'pkg' },
  ],
  buildings: [building('a', 150, 150, 3, 'pkg'), building('b', 300, 150, 0.01, 'pkg'), building('c', 700, 200, 1.5, 'root')],
  terminals: [],
  allTerminals: [],
  terminalOmitted: 0,
} as unknown as CityData;
const colours: Record<string, string> = { a: '#b9d7da', b: '#785688', c: '#b9d7da' };

/** Reads a store-only ZIP, checking signatures and every CRC-32. */
function unzip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = new Map<string, string>();
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    const crc = view.getUint32(at + 14, true),
      size = view.getUint32(at + 18, true),
      nameLength = view.getUint16(at + 26, true);
    expect(view.getUint16(at + 8, true)).toBe(0);
    const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLength));
    const data = bytes.subarray(at + 30 + nameLength, at + 30 + nameLength + size);
    expect(crc32(data)).toBe(crc);
    files.set(name, new TextDecoder().decode(data));
    at += 30 + nameLength + size;
  }
  const endAt = bytes.length - 22;
  expect(view.getUint32(endAt, true)).toBe(0x06054b50);
  expect(view.getUint16(endAt + 10, true)).toBe(files.size);
  expect(view.getUint32(endAt + 16, true)).toBe(at);
  return files;
}

describe('3D print export (ADR-055)', () => {
  const model = buildPrintModel(city, (b) => colours[b.nodeId]!);

  it('builds a base, one plinth per nested district and one box per file, standing where the city shows them', () => {
    expect(model.boxes).toHaveLength(1 + 1 + 3);
    expect(model.width).toBeCloseTo(150);
    expect(model.depth).toBeCloseTo(75);
    const [base, plinth, a, b, c] = model.boxes;
    expect(base).toMatchObject({ x: 0, y: 0, z: 0, h: 2 });
    expect(plinth!.h).toBeCloseTo(2.6);
    expect(a!.z).toBeCloseTo(2.6);
    expect(c!.z).toBeCloseTo(2);
    // Height keeps the city's proportions; the smallest building stays printable.
    expect(a!.h / c!.h).toBeCloseTo(2);
    expect(b!.h).toBeCloseTo(0.4);
    // Centred on its plot at 70% of the plot.
    expect(a!.w).toBeCloseTo(15 * 0.7);
    expect(a!.x + a!.w / 2).toBeCloseTo(22.5 + 7.5);
    expect(model.height).toBeCloseTo(2.6 + a!.h);
  });

  it('writes a binary STL whose triangles all face outwards', () => {
    const stl = toStl(model);
    const view = new DataView(stl.buffer);
    const triangles = view.getUint32(80, true);
    expect(triangles).toBe(model.boxes.length * 12);
    expect(stl.length).toBe(84 + triangles * 50);
    for (let t = 0; t < triangles; t++) {
      const at = 84 + t * 50;
      const f = (i: number) => view.getFloat32(at + i * 4, true);
      const n = [f(0), f(1), f(2)];
      const v = [0, 1, 2].map((k) => [f(3 + k * 3), f(4 + k * 3), f(5 + k * 3)]);
      const e1 = [v[1]![0]! - v[0]![0]!, v[1]![1]! - v[0]![1]!, v[1]![2]! - v[0]![2]!];
      const e2 = [v[2]![0]! - v[0]![0]!, v[2]![1]! - v[0]![1]!, v[2]![2]! - v[0]![2]!];
      const cross = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
      expect(cross[0]! * n[0]! + cross[1]! * n[1]! + cross[2]! * n[2]!).toBeGreaterThan(0);
      for (const p of v) {
        expect(p[0]!).toBeGreaterThanOrEqual(-1e-4);
        expect(p[0]!).toBeLessThanOrEqual(model.width + 1e-4);
        expect(p[2]!).toBeLessThanOrEqual(model.height + 1e-4);
      }
    }
  });

  it('packages a coloured 3MF that unzips with valid CRCs', () => {
    const files = unzip(to3mf(model, 'acme/shop <main> & co'));
    expect([...files.keys()]).toEqual(['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model']);
    const xml = files.get('3D/3dmodel.model')!;
    expect(xml).toContain('unit="millimeter"');
    expect(xml).toContain('acme/shop &lt;main&gt; &amp; co');
    expect((xml.match(/<object /g) ?? []).length).toBe(model.boxes.length);
    expect((xml.match(/<item /g) ?? []).length).toBe(model.boxes.length);
    expect((xml.match(/<triangle /g) ?? []).length).toBe(model.boxes.length * 12);
    // Base, plinth and two lens colours: four materials, each an sRGB colour with alpha.
    const bases = xml.match(/displaycolor="#[0-9A-F]{8}"/g) ?? [];
    expect(bases).toHaveLength(4);
    expect(files.get('_rels/.rels')).toContain('/3D/3dmodel.model');
  });

  it('refuses models beyond its solid limit', () => {
    const huge = { ...city, buildings: Array.from({ length: 250_001 }, (_, i) => building(`f${i}`, 0, 0, 1, 'root')) } as CityData;
    expect(() => buildPrintModel(huge, () => '#000000')).toThrow(/more than 250,000/);
  });
});
