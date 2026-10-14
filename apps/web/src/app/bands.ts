/**
 * Colour bands for metric lenses (ADR-052). A band list is five ascending integer stops
 * starting at 0; a value takes the band of the last stop it reaches. Users may set their
 * own stops, or split the files shown into five even groups. Values are never rescaled.
 */
export const BAND_LIMITS = { max: 1_000_000 } as const;

/** Null when `stops` is a valid band list, otherwise a short reason. */
export function invalidStops(stops: readonly number[]): string | null {
  if (stops.length !== 5) return 'Five band starts are needed';
  if (stops[0] !== 0) return 'The first band starts at 0';
  for (const s of stops) if (!Number.isInteger(s) || s < 0 || s > BAND_LIMITS.max) return `Band starts are whole numbers from 0 to ${BAND_LIMITS.max.toLocaleString('en-US')}`;
  for (let i = 1; i < stops.length; i++) if (stops[i]! <= stops[i - 1]!) return 'Each band must start above the one before';
  return null;
}

/** Nearest-rank percentile of sorted values. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1]!;
}

/**
 * Stops that split the known values into five groups as evenly as ties allow: each stop is
 * a quintile of the values, rounded up, and raised by one where ties would repeat a stop.
 */
export function evenStops(values: readonly number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const stops = [0];
  for (const p of [20, 40, 60, 80]) {
    stops.push(Math.min(BAND_LIMITS.max, Math.max(Math.ceil(percentile(sorted, p)), stops.at(-1)! + 1)));
  }
  return stops;
}

export interface Distribution {
  known: number;
  unknown: number;
  median: number | null;
  p90: number | null;
  max: number | null;
  counts: number[];
}

export function distribution(values: readonly (number | null)[], stops: readonly number[]): Distribution {
  const known = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  const counts = new Array<number>(stops.length).fill(0);
  for (const v of known) {
    let band = 0;
    while (band + 1 < stops.length && v >= stops[band + 1]!) band++;
    counts[band]!++;
  }
  return {
    known: known.length,
    unknown: values.length - known.length,
    median: known.length ? percentile(known, 50) : null,
    p90: known.length ? percentile(known, 90) : null,
    max: known.length ? known.at(-1)! : null,
    counts,
  };
}
