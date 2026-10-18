import {
  AnalysisAcceptedSchema,
  CapabilitiesSchema,
  ErrorEnvelopeSchema,
  JobStatusSchema,
  LegalNoticesSchema,
  type AnalysisAccepted,
  type Capabilities,
  type ErrorEnvelope,
  type JobStatus,
  type LegalNotices,
} from '@atlas/schema';

/**
 * Hosted API client (plan §13). Every response is validated against the shared runtime
 * schema. Authority is the HttpOnly same-origin session cookie: the management token
 * returned at admission is deliberately never read, stored or placed in a URL (plan §3.1).
 */
export type ApiError = ErrorEnvelope['error'] & { status: number };

export class HostedApiError extends Error {
  constructor(readonly detail: ApiError) {
    super(detail.message);
    this.name = 'HostedApiError';
  }
}

const API = '/api/v1';
const FALLBACK: Omit<ApiError, 'status'> = { code: 'INTERNAL_ERROR', message: 'The service is temporarily unavailable.', retryable: true, details: {}, requestId: `req_${'0'.repeat(32)}` };

async function failure(response: Response): Promise<HostedApiError> {
  const body = await response.json().catch(() => null);
  const parsed = ErrorEnvelopeSchema.safeParse(body);
  return new HostedApiError({ ...(parsed.success ? parsed.data.error : FALLBACK), status: response.status });
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, { credentials: 'same-origin', cache: 'no-store', ...init });
  } catch {
    throw new HostedApiError({ ...FALLBACK, message: 'The service could not be reached. Check your connection and try again.', status: 0 });
  }
  if (!response.ok) throw await failure(response);
  return response;
}

/** Null when this page is not served by a hosted ATLAS API (local or browser-only use). */
export async function detectHostedService(): Promise<Capabilities | null> {
  try {
    const response = await fetch(`${API}/capabilities`, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) return null;
    const parsed = CapabilitiesSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The operator's public-service texts; unconfigured if the service cannot answer. */
export async function fetchLegalNotices(): Promise<LegalNotices> {
  try {
    const response = await fetch(`${API}/legal`, { credentials: 'same-origin', cache: 'no-store' });
    const parsed = response.ok ? LegalNoticesSchema.safeParse(await response.json()) : null;
    if (parsed?.success) return parsed.data;
  } catch {
    // fall through
  }
  return { configured: false, contact: null, documents: { privacy: null, terms: null, takedown: null } };
}

export async function ensureSession(): Promise<void> {
  await call('/session', { method: 'POST' });
}

const KEY_STORE = 'atlas.pending-submission';

/**
 * Submit once per intent. The idempotency key lives in this tab's session storage until
 * the service answers, so a retried click or a reload reuses it rather than queueing a
 * second job (plan §13.4). A different repository or option starts a new key.
 */
export async function submitAnalysis(repositoryUrl: string, history: boolean): Promise<AnalysisAccepted> {
  await ensureSession();
  const body = JSON.stringify({ repositoryUrl, commitSha: null, profile: 'v0.1-default', history: { enabled: history }, publication: 'public-expiring' });
  let key: string = crypto.randomUUID();
  try {
    const pending = JSON.parse(sessionStorage.getItem(KEY_STORE) ?? 'null') as { body: string; key: string } | null;
    if (pending?.body === body && typeof pending.key === 'string') key = pending.key;
    else sessionStorage.setItem(KEY_STORE, JSON.stringify({ body, key }));
  } catch {
    // Storage unavailable: a fresh key per click is still safe (quotas bound duplicates).
  }
  const response = await call('/analyses', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body });
  const accepted = AnalysisAcceptedSchema.parse(await response.json());
  try {
    sessionStorage.removeItem(KEY_STORE);
  } catch {
    // ignore
  }
  // The management token is intentionally dropped here: the session authorizes this browser.
  return { ...accepted, managementToken: null };
}

export async function jobStatus(jobId: string, signal?: AbortSignal): Promise<JobStatus> {
  const response = await call(`/jobs/${jobId}`, signal ? { signal } : {});
  return JobStatusSchema.parse(await response.json());
}

export async function cancelJob(jobId: string): Promise<JobStatus> {
  const response = await call(`/jobs/${jobId}/cancel`, { method: 'POST' });
  return JobStatusSchema.parse(await response.json());
}

export async function deleteAnalysis(analysisId: string): Promise<void> {
  await call(`/analyses/${analysisId}`, { method: 'DELETE' });
}

export const TERMINAL = new Set<JobStatus['state']>(['READY', 'PARTIAL', 'FAILED', 'CANCELLED']);

/**
 * Follow a job: server-sent events while they work, polling as the supported fallback
 * (every 2 s, backing off to 10 s while nothing changes). Every event is followed by an
 * authoritative status read, so a dropped or replayed event can never show stale state.
 * Returns a function that stops everything (navigation, unmount).
 */
export function followJob(jobId: string, onStatus: (status: JobStatus) => void, onError: (error: HostedApiError) => void): () => void {
  let stopped = false;
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = 2000;
  let lastRevision = -1;
  const controller = new AbortController();

  const refresh = async (): Promise<boolean> => {
    try {
      const status = await jobStatus(jobId, controller.signal);
      if (stopped) return true;
      if (status.revision !== lastRevision) {
        lastRevision = status.revision;
        delay = 2000;
        onStatus(status);
      }
      if (TERMINAL.has(status.state)) {
        stop();
        return true;
      }
      return false;
    } catch (error) {
      if (stopped) return true;
      if (error instanceof HostedApiError && error.detail.status !== 0 && error.detail.status < 500) {
        onError(error);
        stop();
        return true;
      }
      return false;
    }
  };
  const poll = async () => {
    if (stopped) return;
    const done = await refresh();
    if (done || stopped) return;
    delay = Math.min(10_000, Math.round(delay * 1.5));
    timer = setTimeout(() => void poll(), delay);
  };
  const stop = () => {
    stopped = true;
    controller.abort();
    source?.close();
    clearTimeout(timer);
  };

  void refresh().then((done) => {
    if (done || stopped) return;
    if (typeof EventSource === 'undefined') return void poll();
    source = new EventSource(`${API}/jobs/${jobId}/events`);
    const onEvent = () => void refresh();
    for (const kind of ['state', 'progress', 'warning', 'terminal']) source.addEventListener(kind, onEvent);
    source.onerror = () => {
      // The browser reconnects with Last-Event-ID on its own; if it gives up, poll.
      if (source?.readyState === EventSource.CLOSED && !stopped) {
        source = null;
        void poll();
      }
    };
    // A slow safety poll catches anything a proxy might buffer.
    timer = setTimeout(() => void poll(), 10_000);
  });
  return stop;
}
