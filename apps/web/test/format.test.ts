import { describe, expect, it } from 'vitest';
import { formatOrdinal } from '../src/app/model';

describe('formatOrdinal', () => {
  it('uses the English suffix of the last digits', () => {
    const cases: [number, string][] = [
      [0, '0th'],
      [1, '1st'],
      [2, '2nd'],
      [3, '3rd'],
      [4, '4th'],
      [11, '11th'],
      [12, '12th'],
      [13, '13th'],
      [21, '21st'],
      [22, '22nd'],
      [23, '23rd'],
      [31, '31st'],
      [50, '50th'],
      [100, '100th'],
      [101, '101st'],
      [111, '111th'],
      [112, '112th'],
      [1001, '1,001st'],
    ];
    for (const [value, text] of cases) expect(formatOrdinal(value)).toBe(text);
  });

  it('formats every percentile the inspector can show', () => {
    for (let p = 0; p <= 100; p++) {
      const tens = p % 100;
      const suffix = tens >= 11 && tens <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][p % 10] ?? 'th';
      expect(formatOrdinal(p)).toBe(`${p}${suffix}`);
    }
  });
});
