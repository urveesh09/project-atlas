import {
  gunzipWithStreams,
  loadArtifact,
  pickedFilesSource,
  type ArtifactSource,
  type LoadResult,
  type PickedFile,
} from '@atlas/artifact';
import { GraphIndex, type GraphIndexData } from '@atlas/graph';
import { prepareCity, type CityData } from '@atlas/layout';
import { initializeQueries, handleQuery, type QueryRequest } from './query.worker';

/**
 * Artifact import runs here, off the main thread (plan §6.5): bounded reads, streaming
 * decompression with caps, hash and canonical-form checks, then full bundle invariants.
 * Files picked locally are read in this worker and never leave the browser.
 */
export type LoaderRequest = ({ kind: 'server'; base: string } | { kind: 'files'; files: PickedFile[] }) & {
  measure?: boolean;
};
export type ViewerLoadResult = LoadResult & {
  prepared?: GraphIndexData;
  city?: CityData;
  queryWorker?: Worker;
  requiredChunksAvailableAt?: number;
};
export type LoaderResponse =
  | { type: 'progress'; path: string }
  | { type: 'done'; result: ViewerLoadResult }
  | { type: 'crash'; message: string };

/** The worker scope, typed minimally so this file compiles alongside the DOM library. */
const scope = self as unknown as {
  postMessage(message: LoaderResponse): void;
  onmessage: ((event: MessageEvent<LoaderRequest>) => void) | null;
};

function serverSource(base: string, onRead: (path: string) => void): ArtifactSource {
  return {
    async read(path, maxBytes) {
      onRead(path);
      const response = await fetch(`${base}${path}`, { credentials: 'same-origin', cache: 'no-store' });
      if (response.status === 404) return null;
      if (!response.ok || !response.body) throw new Error(`Artifact request failed (${response.status})`);
      // Read at most maxBytes + 1 so an oversized file is detected without buffering it.
      const reader = response.body.getReader();
      const parts: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        total += value.length;
        if (total > maxBytes) {
          await reader.cancel();
          break;
        }
      }
      const out = new Uint8Array(Math.min(total, maxBytes + 1));
      let offset = 0;
      for (const part of parts) {
        const take = Math.min(part.length, out.length - offset);
        out.set(part.subarray(0, take), offset);
        offset += take;
        if (offset >= out.length) break;
      }
      return out;
    },
  };
}

scope.onmessage = async (event: MessageEvent<LoaderRequest | QueryRequest>) => {
  const request = event.data;
  if (!('kind' in request)) {
    handleQuery(request);
    return;
  }
  const report = (path: string) => scope.postMessage({ type: 'progress', path } satisfies LoaderResponse);
  try {
    const originalSource =
      request.kind === 'server' ? serverSource(request.base, report) : pickedFilesSource(request.files);
    let requiredChunksAvailableAt = 0;
    const source: ArtifactSource = {
      async read(path, maxBytes) {
        const bytes = await originalSource.read(path, maxBytes);
        requiredChunksAvailableAt = performance.timeOrigin + performance.now();
        return bytes;
      },
    };
    const stages: Record<string, number> = {};
    const result = await loadArtifact(source, gunzipWithStreams, (stage, ms) => {
      stages[stage] = ms;
    });
    if (result.ok) {
      const graph = result.bundle.graphs.at(-1)!;
      if (request.measure) console.debug('ATLAS load stages', JSON.stringify(stages));
      const index = new GraphIndex(graph),
        city = prepareCity(graph, result.bundle.layout);
      initializeQueries(graph, city, index);
      scope.postMessage({
        type: 'done',
        result: {
          ...result,
          prepared: index.transferData(),
          city,
          ...(request.measure ? { requiredChunksAvailableAt } : {}),
        },
      });
    } else scope.postMessage({ type: 'done', result });
  } catch (error) {
    scope.postMessage({
      type: 'crash',
      message: error instanceof Error ? error.message : 'Unknown error',
    } satisfies LoaderResponse);
  }
};
