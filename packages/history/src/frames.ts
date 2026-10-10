/**
 * Structural frame selection (plan §7.2). For a completed window of `n` commits in
 * oldest-to-newest chain order, select `k = min(requested, n)` indices
 * `floor(i * (n - 1) / (k - 1))` for `i = 0..k-1`; `k = 1` selects the newest commit
 * (HEAD) alone. The result is strictly increasing, deduplicated defensively, and always
 * ends with HEAD.
 */
export function selectFrameIndices(n: number, requested: number): number[] {
  if (!Number.isInteger(n) || n < 1) throw new RangeError('A history window has at least one commit');
  if (!Number.isInteger(requested) || requested < 1) throw new RangeError('At least one frame must be requested');
  const k = Math.min(requested, n);
  if (k === 1) return [n - 1];
  const indices = new Set<number>();
  for (let i = 0; i < k; i++) indices.add(Math.floor((i * (n - 1)) / (k - 1)));
  indices.add(n - 1);
  return [...indices].sort((a, b) => a - b);
}
