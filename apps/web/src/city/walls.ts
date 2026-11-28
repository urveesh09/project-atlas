import * as THREE from 'three';
import wallsUrl from '../assets/facade-walls.jpg';
import roomsUrl from '../assets/facade-rooms.jpg';
import surfacesUrl from '../assets/surface-detail.jpg';

/**
 * Baked wall materials (ADR-103): render, brick, precast concrete, metal cladding and ashlar,
 * in the facade shader's material order. Each layer is one tile of real wall baked in
 * Blender from displaced geometry (`scripts/facade-textures`): red is brightness as a ratio
 * (0.5 = unchanged, mean exactly 1), green and blue the surface normal across and up.
 * No hue is stored, so the lens colour always reads. The viewer only loads the image;
 * Blender is needed only to bake it again.
 */
export const WALL_LAYERS = 5;

/** Size of each layer's tile in world units, where a storey is 0.3 (about 3 m). */
export const WALL_TILE = [0.3, 0.25, 0.3, 0.2, 0.3] as const;

/** Flat, unchanged walls: what the facade shows until the baked texture arrives. */
export function neutralWalls(): THREE.DataArrayTexture {
  return neutralLayers(WALL_LAYERS);
}

/** Flat, unchanged layers (brightness 1, normal straight out) of any baked set. */
function neutralLayers(layers: number): THREE.DataArrayTexture {
  const texture = new THREE.DataArrayTexture(new Uint8Array(4 * layers).fill(128), 1, 1, layers);
  texture.needsUpdate = true;
  return texture;
}

/**
 * Baked ground and roof surfaces (ADR-107), the same format as the walls, from CC0 ambientCG
 * materials: plaza pavers for each city style (modern concrete blocks, eastern flagstones,
 * western cobbles), street asphalt and clay roof tiles.
 */
export const SURFACE_LAYERS = 5;
export const SURFACE = { plazaModern: 0, plazaEastern: 1, plazaWestern: 2, asphalt: 3, roof: 4 } as const;
/**
 * Size of each surface layer's tile in world units (a storey is 0.3). Ground is drawn at the
 * city's own stylised scale, as its procedural paving was (5 m plaza slabs, cobbles of about
 * 1.5 m), not at true scale: true-size pavers average away at the distances the city is
 * seen from, while at this scale they read as paving (ADR-107). The roof layer is tiled by
 * courses instead (shading.ts).
 */
export const SURFACE_TILE = [2.0, 1.8, 1.4, 0.5, 0.29] as const;

/** Flat surfaces: what the ground and roofs show until the baked texture arrives. */
export function neutralSurfaces(): THREE.DataArrayTexture {
  return neutralLayers(SURFACE_LAYERS);
}

/** Fetch and decode the baked surfaces. Rejects where the browser cannot decode an image off-screen. */
export function loadSurfaces(url: string = surfacesUrl, signal?: AbortSignal): Promise<THREE.DataArrayTexture> {
  return loadLayers(url, SURFACE_LAYERS, signal);
}

/**
 * Build the array texture from the decoded image's RGBA rows (top row first, layers stacked
 * top to bottom). Rows are flipped per layer so texture v runs up the wall, as baked.
 */
export function wallTexture(rgba: Uint8Array | Uint8ClampedArray, size: number, layers = WALL_LAYERS): THREE.DataArrayTexture {
  const row = size * 4,
    data = new Uint8Array(row * size * layers);
  for (let layer = 0; layer < layers; layer++)
    for (let y = 0; y < size; y++) {
      const from = (layer * size + y) * row,
        to = (layer * size + (size - 1 - y)) * row;
      data.set(rgba.subarray(from, from + row), to);
    }
  const texture = new THREE.DataArrayTexture(data, size, size, layers);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  // Mipmapped: at a distance each layer averages to brightness 1 and a flat normal.
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/** Fetch and decode the baked walls. Rejects where the browser cannot decode an image off-screen. */
export function loadWalls(url: string = wallsUrl, signal?: AbortSignal): Promise<THREE.DataArrayTexture> {
  return loadLayers(url, WALL_LAYERS, signal);
}

/** Fetch one baked set (layers stacked top to bottom) into an array texture. */
async function loadLayers(url: string, layers: number, signal?: AbortSignal): Promise<THREE.DataArrayTexture> {
  // Raw bytes: no colour management, since the channels are data, not colour.
  const bitmap = await fetchBitmap(url, signal, 'none');
  try {
    const size = bitmap.width;
    if (bitmap.height !== size * layers) throw new Error(`baked layers: unexpected size ${bitmap.width}×${bitmap.height}`);
    const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(size, bitmap.height) : Object.assign(document.createElement('canvas'), { width: size, height: bitmap.height });
    const context = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!context) throw new Error('baked layers: no 2D context');
    context.drawImage(bitmap, 0, 0);
    return wallTexture(context.getImageData(0, 0, size, bitmap.height).data, size, layers);
  } finally {
    bitmap.close();
  }
}

async function fetchBitmap(url: string, signal: AbortSignal | undefined, colorSpaceConversion: ColorSpaceConversion): Promise<ImageBitmap> {
  const response = await fetch(url, { signal: signal ?? null });
  if (!response.ok) throw new Error(`facade texture: HTTP ${response.status}`);
  return createImageBitmap(await response.blob(), { colorSpaceConversion, premultiplyAlpha: 'none' });
}

/**
 * Rooms behind the windows (ADR-104): 16 furnished rooms rendered in Blender, 4 × 4, room 0
 * at the top left. Each is pre-projected from a camera `ROOM_CN` half-depths in front of its
 * window, so the facade shader maps a point it finds on the room box straight to the image.
 * Rooms 1, 5, 9 and 13 (`OFFICE_ROOMS`) are offices.
 */
export const ROOM_GRID = 4;
export const ROOM_CN = 2;
export const OFFICE_ROOMS = [1, 5, 9, 13] as const;

/** A dim, neutral interior until the rooms arrive. */
export function neutralRooms(): THREE.DataTexture {
  const texture = new THREE.DataTexture(new Uint8Array([40, 42, 46, 255]), 1, 1);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** Fetch and decode the room atlas. Rejects where the browser cannot decode an image off-screen. */
export async function loadRooms(url: string = roomsUrl, signal?: AbortSignal): Promise<THREE.Texture> {
  const bitmap = await fetchBitmap(url, signal, 'default');
  if (bitmap.width !== bitmap.height) {
    bitmap.close();
    throw new Error(`rooms: unexpected size ${bitmap.width}×${bitmap.height}`);
  }
  const texture = new THREE.Texture(bitmap);
  // An ImageBitmap is never flipped on upload: texture v 0 is the image's top row.
  texture.flipY = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}
