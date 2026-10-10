export interface CityHandle {
  reset(): void;
  zoom(factor: number): void;
  north(): void;
  focus(ids: ReadonlySet<string>): void;
  exportPng(): Promise<Blob>;
  cameraState(): unknown;
}
