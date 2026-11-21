import * as THREE from 'three';
import wallsUrl from '../assets/facade-walls.jpg';

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
  const texture = new THREE.DataArrayTexture(new Uint8Array(4 * WALL_LAYERS).fill(128), 1, 1, WALL_LAYERS);
  texture.needsUpdate = true;
  return texture;
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
export async function loadWalls(url: string = wallsUrl, signal?: AbortSignal): Promise<THREE.DataArrayTexture> {
  const response = await fetch(url, { signal: signal ?? null });
  if (!response.ok) throw new Error(`walls: HTTP ${response.status}`);
  // Raw bytes: no colour management, since the channels are data, not colour.
  const bitmap = await createImageBitmap(await response.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  try {
    const size = bitmap.width;
    if (bitmap.height !== size * WALL_LAYERS) throw new Error(`walls: unexpected size ${bitmap.width}×${bitmap.height}`);
    const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(size, bitmap.height) : Object.assign(document.createElement('canvas'), { width: size, height: bitmap.height });
    const context = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!context) throw new Error('walls: no 2D context');
    context.drawImage(bitmap, 0, 0);
    return wallTexture(context.getImageData(0, 0, size, bitmap.height).data, size);
  } finally {
    bitmap.close();
  }
}
