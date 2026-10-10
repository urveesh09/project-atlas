import type { FileRole, ParseStatus } from '@atlas/schema';

/**
 * Building height encoding (plan §11.5). Height reflects code lines only — not bytes,
 * complexity or importance — and footprints never change with it.
 */
export const OPAQUE_HEIGHT = 0.8;
export const DECLARATION_HEIGHT = 0.6;
export const MIN_HEIGHT = 1;
export const MAX_HEIGHT = 14;

export function quantizeThousandths(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function buildingHeight(role: FileRole, parseStatus: ParseStatus, codeLines: number | null): number {
  if (role === 'declaration') return DECLARATION_HEIGHT;
  if ((role !== 'source' && role !== 'test') || parseStatus !== 'parsed' || codeLines === null) return OPAQUE_HEIGHT;
  const raw = 1 + 1.5 * Math.log2(1 + codeLines / 25);
  return quantizeThousandths(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, raw)));
}
