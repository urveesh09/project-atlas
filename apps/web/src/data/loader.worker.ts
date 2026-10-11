import { gunzipWithStreams, openArtifact, pickedFilesSource, type ArtifactSource, type LoadResult, type PickedFile } from '@atlas/artifact';
import { GraphIndex, type GraphIndexData } from '@atlas/graph';
import { prepareCity, type CityData } from '@atlas/layout';
import type { ArtifactCore, GraphSnapshot } from '@atlas/schema';
import { FrameStore, initializeQueries, handleQuery, type QueryRequest } from './query.worker';

/**
 * Artifact import runs here, off the main thread (plan §6.5): bounded reads, streaming
 * decompression with caps, hash and canonical-form checks, then full bundle invariants.
 * Files picked locally are read in this worker and never leave the browser.
 */
export type LoaderRequest = ({ kind: 'server'; base: string } | { kind: 'hosted'; analysisId: string } | { kind: 'files'; files: PickedFile[] }) & {
  measure?: boolean;
};
/**
 * The opened artifact: manifest, history and layout validated, the selected (HEAD) frame
 * decoded and prepared. Other frames stay in this worker until requested (plan §11.7).
 */
export type ViewerLoadResult =
  | {
      ok: true;
      core: ArtifactCore;
      head: GraphSnapshot;
      prepared: GraphIndexData;
      city: CityData;
      stats: Extract<LoadResult, { ok: true }>['stats'];
      queryWorker?: Worker;
      requiredChunksAvailableAt?: number;
    }
  | Extract<LoadResult, { ok: false }>;
export type LoaderResponse =
  | { type: 'progress'; path: string }
  | { type: 'done'; result: ViewerLoadResult }
  | { type: 'unavailable'; code: string }
  | { type: 'crash'; message: string };

/** A hosted publication that answered 404/410 (or failed closed): shown as a lifecycle screen, never as a broken graph. */
class PublicationUnavailable extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** The worker scope, typed minimally so this file compiles alongside the DOM library. */
const scope = self as unknown as {
  postMessage(message: LoaderResponse): void;
  onmessage: ((event: MessageEvent<LoaderRequest>) => void) | null;
};

/**
 * Hosted publication routes (plan §13.1): the manifest and each chunk by opaque ID. Every
 * request repeats the service's visibility and expiry checks; the bytes then pass the
 * same validation as a local artifact.
 */
function hostedPath(analysisId: string, path: string): string {
  if (path === 'manifest.json') return `/api/v1/analyses/${analysisId}`;
  const chunk = path === 'history/history.json.gz' ? 'history' : path === 'layout/layout.json.gz' ? 'layout' : /^graphs\/(snap_[0-9a-f]{64})\.json\.gz$/.exec(path)?.[1];
  if (!chunk) throw new Error('Unexpected artifact path');
  return `/api/v1/analyses/${analysisId}/chunks/${chunk}`;
}

function serverSource(url: (path: string) => string, onRead: (path: string) => void, hosted = false): ArtifactSource {
  return {
    async read(path, maxBytes) {
      onRead(path);
      const response = await fetch(url(path), { credentials: 'same-origin', cache: 'no-store' });
      if (hosted && (response.status === 404 || response.status === 410 || response.status === 503)) {
        const body = (await response.json().catch(() => null)) as { error?: { code?: unknown } } | null;
        const code = typeof body?.error?.code === 'string' && /^[A-Z_]{1,64}$/.test(body.error.code) ? body.error.code : 'INTERNAL_ERROR';
        throw new PublicationUnavailable(code);
      }
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
    void handleQuery(request);
    return;
  }
  const report = (path: string) => scope.postMessage({ type: 'progress', path } satisfies LoaderResponse);
  try {
    const originalSource =
      request.kind === 'server'
        ? serverSource((path) => `${request.base}${path}`, report)
        : request.kind === 'hosted'
          ? serverSource((path) => hostedPath(request.analysisId, path), report, true)
          : pickedFilesSource(request.files);
    let requiredChunksAvailableAt = 0;
    const source: ArtifactSource = {
      async read(path, maxBytes) {
        const bytes = await originalSource.read(path, maxBytes);
        requiredChunksAvailableAt = performance.timeOrigin + performance.now();
        return bytes;
      },
    };
    const stages: Record<string, number> = {};
    const opened = await openArtifact(source, gunzipWithStreams, (stage, ms) => {
      stages[stage] = ms;
    });
    if (opened.ok) {
      const { artifact } = opened;
      const graph = artifact.head;
      const frame = artifact.manifest.frames.length - 1;
      if (request.measure) console.debug('ATLAS load stages', JSON.stringify(stages));
      const index = new GraphIndex(graph),
        city = prepareCity(graph, artifact.layout, { attention: FrameStore.attention(graph) });
      initializeQueries(new FrameStore(artifact, { frame, graph, index, city }));
      scope.postMessage({
        type: 'done',
        result: {
          ok: true,
          core: { manifest: artifact.manifest, history: artifact.history, layout: artifact.layout },
          head: graph,
          prepared: index.transferData(),
          city,
          stats: artifact.stats,
          ...(request.measure ? { requiredChunksAvailableAt } : {}),
        },
      });
    } else scope.postMessage({ type: 'done', result: opened });
  } catch (error) {
    if (error instanceof PublicationUnavailable) {
      scope.postMessage({ type: 'unavailable', code: error.code } satisfies LoaderResponse);
      return;
    }
    scope.postMessage({
      type: 'crash',
      message: error instanceof Error ? error.message : 'Unknown error',
    } satisfies LoaderResponse);
  }
};
