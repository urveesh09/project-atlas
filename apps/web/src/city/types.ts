export interface CityHandle {
  reset(): void;
  zoom(factor: number): void;
  north(): void;
  focus(ids: ReadonlySet<string>): void;
  exportPng(): Promise<Blob>;
  cameraState(): unknown;
  /** Fly to the previous (-1) or next (+1) remembered camera view, where supported. */
  travel?(step: -1 | 1): void;
}
