export interface CityHandle {
  reset(): void;
  zoom(factor: number): void;
  north(): void;
  focus(ids: ReadonlySet<string>): void;
  exportPng(): Promise<Blob>;
  cameraState(): unknown;
  /** Return to a camera from `cameraState` (saved views, ADR-048); invalid input is ignored. */
  restoreCamera?(state: unknown): void;
  /** Fly to the previous (-1) or next (+1) remembered camera view, where supported. */
  travel?(step: -1 | 1): void;
}

/**
 * Colours that replace the lens colours, such as change colouring in a comparison
 * (ADR-050). `key` changes whenever any colour does, so renderers know to recolour.
 */
export interface CityPaint {
  key: string;
  color(building: import('@atlas/layout').CityBuilding): string;
  /** Unknown values are drawn with the missing-value cross, as in the lenses. */
  unknown(building: import('@atlas/layout').CityBuilding): boolean;
}
