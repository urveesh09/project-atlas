import { bakeOcclusion, type OcclusionGrid } from './occlusion';

/** Bakes the sky-occlusion field off the main thread; the bytes are transferred back. */
const scope = self as unknown as {
  postMessage(message: { id: number; field: Uint8Array }, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent<{ id: number; grid: OcclusionGrid; occluders: Float32Array }>) => void) | null;
};
scope.onmessage = ({ data }) => {
  const field = bakeOcclusion(data.grid, data.occluders);
  scope.postMessage({ id: data.id, field }, [field.buffer]);
};
