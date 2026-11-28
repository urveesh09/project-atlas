/**
 * Floating layers that take the keyboard first (ADR-107): an open dropdown list (ADR-106)
 * and an open city menu. While one is open, viewer shortcuts stand aside, so type-ahead
 * letters reach the list and Escape closes the layer instead of also leaving the workspace
 * or clearing the selection.
 */
const LAYERS = '.select-content, .city-views-panel';

/** True when the key event's target is inside an open layer. */
export const inLayer = (target: EventTarget | null) => target instanceof Element && target.closest(LAYERS) !== null;

/** True while any layer is open (closed layers are unmounted). */
export const layerOpen = () => typeof document !== 'undefined' && document.querySelector(LAYERS) !== null;
