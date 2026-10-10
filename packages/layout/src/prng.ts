/**
 * Seeded styling randomness (plan §11.5). Versioned xorshift32; never Math.random().
 * Seeds derive from the SHA-256 bytes embedded in an ATLAS ID, so they are stable for a
 * lineage across frames, lenses and platforms.
 */
export const PRNG_VERSION = 'xorshift32/1';

export function seedFromId(id: string): number {
  const hex = id.slice(id.indexOf('_') + 1, id.indexOf('_') + 9);
  const seed = Number.parseInt(hex, 16) >>> 0;
  return seed === 0 ? 0x9e3779b9 : seed;
}

export function xorshift32(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

/** Uniform integer in [0, n) from a seeded generator (modulo bias is irrelevant for style). */
export function pick(next: () => number, n: number): number {
  return next() % n;
}
