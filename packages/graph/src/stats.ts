/**
 * Repository-relative statistics with the exact definitions from plan §10.2/§10.3.
 */

/** Nearest-rank 95th percentile: sorted ascending, index ceil(0.95·n) − 1. Null for n = 0. */
export function nearestRankPercentile(values: readonly number[], p = 0.95): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}

/**
 * Midrank empirical percentile of each value within a cohort: p = (midrank − 1)/(n − 1)
 * for n > 1 and 0 for n = 1. Ties share the midpoint of their ranks (plan §10.3).
 */
export function midrankPercentiles(values: readonly number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1) return [0];
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const result = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && order[j + 1]![0] === order[i]![0]) j++;
    const midrank = (i + 1 + (j + 1)) / 2;
    for (let k = i; k <= j; k++) result[order[k]![1]] = (midrank - 1) / (n - 1);
    i = j + 1;
  }
  return result;
}
