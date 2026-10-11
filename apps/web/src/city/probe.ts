/** Opt-in benchmark surface, populated only for ?atlasBenchmark=1. */
export interface CityProbe {
  stats(): {
    drawCalls: number;
    geometries: number;
    textures: number;
    buildings: number;
    pickCells: number;
    ghosts: number;
    added: number;
    lens: string;
    theme: string;
    animated: boolean;
    lite: boolean;
    cameraMoving: boolean;
    shadowDrawCalls: number;
    zoom: number;
    renderer: string;
    heapBytes: number | null;
  };
  screenPointOf(id: string): { x: number; y: number } | null;
  pickAt(x: number, y: number): string | null;
  measureFrames(count: number): Promise<number[]>;
  cameraState(): { position: number[]; target: number[]; zoom: number };
  loseContext(): void;
}
declare global {
  interface Window {
    __atlasCity?: CityProbe;
    __atlasChunksAvailableAt?: number;
  }
}
