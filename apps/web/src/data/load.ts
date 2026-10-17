import type { LoadResult } from '@atlas/artifact';
import type { LoaderRequest, LoaderResponse, ViewerLoadResult } from './loader.worker';

/** A hosted publication that is gone or unavailable (404/410/503 with a public code). */
export class PublicationUnavailableError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PublicationUnavailableError';
  }
}

/** Run one artifact load in a dedicated worker and resolve with its validated result. */
export function loadInWorker(
  request: LoaderRequest,
  onProgress?: (path: string) => void,
  signal?: AbortSignal,
): Promise<ViewerLoadResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./loader.worker.ts', import.meta.url), {
      type: 'module',
      name: 'atlas-artifact-loader',
    });
    const abort = () => {
      worker.terminate();
      reject(new DOMException('Artifact load cancelled', 'AbortError'));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<LoaderResponse>) => {
      const message = event.data;
      if (message.type === 'progress') onProgress?.(message.path);
      else {
        signal?.removeEventListener('abort', abort);
        if (message.type === 'done' && message.result.ok) resolve({ ...message.result, queryWorker: worker });
        else {
          worker.terminate();
          if (message.type === 'done') resolve(message.result);
          else if (message.type === 'unavailable') reject(new PublicationUnavailableError(message.code));
          else reject(new Error(message.message));
        }
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      signal?.removeEventListener('abort', abort);
      reject(new Error(event.message || 'The artifact loader stopped unexpectedly'));
    };
    worker.postMessage({ ...request, measure: new URLSearchParams(location.search).get('atlasBenchmark') === '1' });
  });
}

export type SourceStatus = { attached: true } | { attached: false; reason: string };

export interface LocalSession {
  mode: 'local';
  source: SourceStatus;
}

/** Detect the `atlas serve` environment; null when the page is not served by it. */
export async function detectLocalSession(): Promise<LocalSession | null> {
  try {
    const response = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) return null;
    const body = (await response.json()) as { mode?: string; source?: SourceStatus };
    return body.mode === 'local' && body.source ? { mode: 'local', source: body.source } : null;
  } catch {
    return null;
  }
}

export interface SourceText {
  path: string;
  text: string;
  lineCount: number;
}

export async function fetchSource(snapshotId: string, nodeId: string): Promise<SourceText | { error: string }> {
  const params = new URLSearchParams({ snapshot: snapshotId, node: nodeId });
  const response = await fetch(`/api/source?${params}`, { credentials: 'same-origin', cache: 'no-store' });
  const body = (await response.json().catch(() => ({ error: 'INVALID_RESPONSE' }))) as SourceText | { error: string };
  return response.ok ? body : { error: 'error' in body ? body.error : 'UNAVAILABLE' };
}
