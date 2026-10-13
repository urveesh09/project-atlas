/**
 * Overlap-free label placement for the 2D map (ADR-047): candidates are taken in priority
 * order, shortened with an ellipsis to fit their district, and dropped when they would
 * collide with a label already placed or leave the canvas. Pure, so it is tested directly.
 */
export interface MapLabelCandidate {
  /** Carried to the placed label, so the caller can style it. */
  key?: string;
  text: string;
  /** Lower is placed first. */
  priority: number;
  /** Larger wins among equal priorities (for example on-screen area). */
  weight: number;
  /** Centre of the label box, in canvas pixels. */
  x: number;
  y: number;
  maxWidth: number;
}
export interface PlacedMapLabel {
  key?: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export function placeMapLabels(
  candidates: readonly MapLabelCandidate[],
  measure: (text: string) => number,
  bounds: { width: number; height: number },
  options: { height: number; padding: number; gap: number; max: number },
): PlacedMapLabel[] {
  const placed: PlacedMapLabel[] = [];
  const order = [...candidates].sort((a, b) => a.priority - b.priority || b.weight - a.weight || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
  for (const c of order) {
    if (placed.length >= options.max) break;
    const text = fit(c.text, c.maxWidth - options.padding * 2, measure);
    if (!text) continue;
    const width = measure(text) + options.padding * 2;
    const box: PlacedMapLabel = { ...(c.key === undefined ? {} : { key: c.key }), text, x: c.x - width / 2, y: c.y - options.height / 2, width, height: options.height };
    if (box.x < 0 || box.y < 0 || box.x + width > bounds.width || box.y + box.height > bounds.height) continue;
    const g = options.gap;
    if (placed.some((p) => box.x < p.x + p.width + g && p.x < box.x + box.width + g && box.y < p.y + p.height + g && p.y < box.y + box.height + g)) continue;
    placed.push(box);
  }
  return placed;
}

/**
 * The text if it fits; otherwise a scoped package name without its `@scope/`; otherwise the
 * longest prefix with an ellipsis. Null when not even 4 characters fit.
 */
function fit(full: string, available: number, measure: (text: string) => number): string | null {
  if (measure(full) <= available) return full;
  const slash = full.startsWith('@') ? full.indexOf('/') : -1;
  const text = slash > 0 && slash < full.length - 1 ? full.slice(slash + 1) : full;
  if (measure(text) <= available) return text;
  for (let n = text.length - 1; n >= 4; n--) {
    const candidate = `${text.slice(0, n)}…`;
    if (measure(candidate) <= available) return candidate;
  }
  return null;
}
