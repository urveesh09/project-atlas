/**
 * A baked sky-occlusion field over the island (ADR-042): how much open sky each patch of
 * ground can see past nearby buildings, trees and walls. It is computed once per frame's
 * buildings, off the main thread, into a small single-channel texture that the ground,
 * district and facade shaders read with one filtered fetch. Streets between tall blocks
 * darken, buildings sit on soft contact shadows, and the cost per pixel is a texture read
 * instead of a screen-space ambient-occlusion pass that a low-end GPU cannot afford.
 *
 * Pure and deterministic: the same occluders give the same bytes on every machine.
 */

/** World-space grid of the field: origin, texel size and texel counts. */
export interface OcclusionGrid {
  minX: number;
  minZ: number;
  texel: number;
  width: number;
  depth: number;
}

/** Occluders are packed for transfer to the worker: x, z, half-width, half-depth, height, strength. */
export const OCCLUDER_STRIDE = 6;
/**
 * Largest texture side and finest texel. Contact shadows need texels well under a plot
 * (1 unit), so large islands get a larger texture (at most 3072^2 bytes) rather than blur.
 */
const MAX_SIDE = 3072;
const FINEST = 0.14;
/** Farthest reach of one occluder, in world units. */
const MAX_REACH = 4;

/** A grid covering the island bounds plus a margin, at the finest texel that fits. */
export function occlusionGrid(minX: number, minZ: number, maxX: number, maxZ: number, margin = 2): OcclusionGrid {
  const spanX = maxX - minX + margin * 2,
    spanZ = maxZ - minZ + margin * 2;
  const texel = Math.max(FINEST, Math.max(spanX, spanZ) / MAX_SIDE);
  return {
    minX: minX - margin,
    minZ: minZ - margin,
    texel,
    width: Math.max(1, Math.ceil(spanX / texel)),
    depth: Math.max(1, Math.ceil(spanZ / texel)),
  };
}

/**
 * Bake visibility (255 = open sky) for each texel. Each occluder is an axis-aligned box on
 * the ground. Its occlusion at ground distance d from the footprint follows the elevation
 * it subtends, 1 - d / sqrt(d^2 + h^2), narrowed by the azimuth it spans, w / (w + d) with
 * a width w that grows with height (a tower hides more sky sideways), and tapered to zero
 * at its reach. Overlapping occluders multiply visibility, so a canyon
 * between two towers is darker than either side alone.
 */
export function bakeOcclusion(grid: OcclusionGrid, occluders: Float32Array): Uint8Array {
  const { minX, minZ, texel, width, depth } = grid;
  // 16-bit fixed point keeps a 3072^2 bake at 18 MB while multiplying many occluders.
  const visibility = new Uint16Array(width * depth).fill(65535);
  for (let o = 0; o + OCCLUDER_STRIDE <= occluders.length; o += OCCLUDER_STRIDE) {
    const x = occluders[o]!,
      z = occluders[o + 1]!,
      hx = occluders[o + 2]!,
      hz = occluders[o + 3]!,
      h = occluders[o + 4]!,
      strength = occluders[o + 5]!;
    if (!(h > 0) || !(strength > 0)) continue;
    const reach = Math.min(MAX_REACH, 0.5 + h * 0.6),
      r = (hx + hz) / 2 + 0.05 + Math.min(h, 8) * 0.12,
      h2 = h * h;
    const i0 = Math.max(0, Math.floor((x - hx - reach - minX) / texel)),
      i1 = Math.min(width - 1, Math.ceil((x + hx + reach - minX) / texel)),
      j0 = Math.max(0, Math.floor((z - hz - reach - minZ) / texel)),
      j1 = Math.min(depth - 1, Math.ceil((z + hz + reach - minZ) / texel));
    for (let j = j0; j <= j1; j++) {
      const dz = Math.max(0, Math.abs(minZ + (j + 0.5) * texel - z) - hz);
      if (dz > reach) continue;
      const row = j * width;
      for (let i = i0; i <= i1; i++) {
        const dx = Math.max(0, Math.abs(minX + (i + 0.5) * texel - x) - hx);
        const d2 = dx * dx + dz * dz;
        if (d2 >= reach * reach) continue;
        const d = Math.sqrt(d2);
        const occ = strength * (1 - d / Math.sqrt(d2 + h2)) * (r / (r + d)) * (1 - d / reach);
        visibility[row + i] = visibility[row + i]! * (1 - occ);
      }
    }
  }
  const out = new Uint8Array(width * depth);
  for (let k = 0; k < out.length; k++) out[k] = Math.round(visibility[k]! / 257);
  return out;
}
