import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { facadeMaterial, setFacadeTexture } from '../src/city/architecture';
import { OFFICE_ROOMS, ROOM_GRID, WALL_LAYERS, WALL_TILE, neutralRooms, neutralWalls, wallTexture } from '../src/city/walls';

/** Width, height and per-component sampling factors from a JPEG's frame header. */
function jpegFrame(bytes: Uint8Array) {
  expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
  let at = 2;
  while (at + 4 < bytes.length) {
    if (bytes[at] !== 0xff) throw new Error(`no marker at ${at}`);
    const marker = bytes[at + 1]!,
      length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
    if (marker >= 0xc0 && marker <= 0xc2) {
      const height = (bytes[at + 5]! << 8) | bytes[at + 6]!,
        width = (bytes[at + 7]! << 8) | bytes[at + 8]!,
        count = bytes[at + 9]!;
      const sampling = Array.from({ length: count }, (_, i) => bytes[at + 11 + i * 3]!);
      return { width, height, sampling };
    }
    at += 2 + length;
  }
  throw new Error('no frame header');
}

describe('baked wall materials (ADR-103)', () => {
  it('ships one square tile per facade material, without chroma subsampling, in a small file', () => {
    const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL('../src/assets/facade-walls.jpg', import.meta.url))));
    const frame = jpegFrame(bytes);
    expect(frame.height).toBe(frame.width * WALL_LAYERS);
    expect(frame.width).toBeGreaterThanOrEqual(256);
    // 4:4:4 keeps brightness and the two normal channels from bleeding into each other.
    expect(frame.sampling).toEqual([0x11, 0x11, 0x11]);
    expect(bytes.length).toBeLessThan(450 * 1024);
    expect(WALL_TILE).toHaveLength(WALL_LAYERS);
  });

  it('starts from flat, unchanged walls', () => {
    const t = neutralWalls();
    expect([t.image.width, t.image.height, t.image.depth]).toEqual([1, 1, WALL_LAYERS]);
    expect([...(t.image.data as Uint8Array)].every((v) => v === 128)).toBe(true);
    t.dispose();
  });

  it('flips each layer so texture v runs up the wall, keeping layers in order', () => {
    const size = 2,
      layers = 3,
      rgba = new Uint8Array(size * 4 * size * layers);
    // Tag every pixel with its layer and source row.
    for (let layer = 0; layer < layers; layer++)
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) rgba[((layer * size + y) * size + x) * 4] = layer * 10 + y;
    const t = wallTexture(rgba, size, layers);
    const data = t.image.data as Uint8Array;
    const at = (layer: number, row: number) => data[(layer * size + row) * size * 4]!;
    expect([at(0, 0), at(0, 1), at(1, 0), at(1, 1), at(2, 0), at(2, 1)]).toEqual([1, 0, 11, 10, 21, 20]);
    expect(t.wrapS).toBe(THREE.RepeatWrapping);
    expect(t.minFilter).toBe(THREE.LinearMipmapLinearFilter);
    t.dispose();
  });

  it('swaps loaded walls into a detailed facade only', () => {
    const placeholder = neutralWalls(),
      loaded = neutralWalls();
    const detailed = facadeMaterial(true, undefined, null, undefined, placeholder);
    expect(detailed.defines).toMatchObject({ ATLAS_WALLS: 1 });
    expect(setFacadeTexture(detailed, 'walls', loaded)).toBe(placeholder);
    const lite = facadeMaterial(false, undefined, null, undefined, null);
    expect(lite.defines).toMatchObject({ ATLAS_WALLS: 0 });
    expect(setFacadeTexture(lite, 'walls', loaded)).toBeNull();
    // The shader program differs with and without walls, so the two never share a cache entry.
    expect(detailed.customProgramCacheKey()).not.toBe(facadeMaterial(true).customProgramCacheKey());
    for (const t of [placeholder, loaded]) t.dispose();
  });

  it('ships the rooms behind the windows as a square atlas with offices on one column (ADR-104)', () => {
    const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL('../src/assets/facade-rooms.jpg', import.meta.url))));
    const frame = jpegFrame(bytes);
    expect(frame.width).toBe(frame.height);
    expect(frame.width % ROOM_GRID).toBe(0);
    expect(frame.width / ROOM_GRID).toBeGreaterThanOrEqual(128);
    expect(bytes.length).toBeLessThan(200 * 1024);
    // The shader picks offices as 1 + 4k: the second column of the atlas, as rooms.py renders them.
    expect([...OFFICE_ROOMS]).toEqual(Array.from({ length: ROOM_GRID }, (_, k) => 1 + ROOM_GRID * k));
  });

  it('swaps loaded rooms in without touching the walls', () => {
    const walls = neutralWalls(),
      rooms = neutralRooms(),
      loaded = neutralRooms();
    expect(rooms.colorSpace).toBe(THREE.SRGBColorSpace);
    const detailed = facadeMaterial(true, undefined, null, undefined, walls, rooms);
    expect(detailed.defines).toMatchObject({ ATLAS_WALLS: 1, ATLAS_ROOMS: 1 });
    expect(setFacadeTexture(detailed, 'rooms', loaded)).toBe(rooms);
    expect(setFacadeTexture(detailed, 'walls', walls)).toBe(walls);
    expect(facadeMaterial(true, undefined, null, undefined, walls).defines).toMatchObject({ ATLAS_ROOMS: 0 });
    expect(setFacadeTexture(facadeMaterial(true, undefined, null, undefined, walls), 'rooms', loaded)).toBeNull();
    for (const t of [walls, rooms, loaded]) t.dispose();
  });
});
