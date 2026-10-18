import { open, realpath } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP, type AddressInfo } from 'node:net';
import nodePath from 'node:path';
import { migrationsCurrent, operatorMetrics, operatorMetricsText, PROMETHEUS_TEXT_CONTENT_TYPE, publicationReadResult, type ObjectStore, type PublicationReads, type PublicationStore } from '@atlas/control';
import { parseGithubRepositoryUrl } from '@atlas/ingest';
import { AnalysisAcceptedSchema, AnalysisSubmissionSchema, API_REQUEST_BODY_LIMIT, ARTIFACT_VERSION, CapabilitiesSchema, ErrorEnvelopeSchema, GRAPH_SCHEMA_VERSION, IdempotencyKeySchema, JobIdSchema, LAYOUT_VERSION, LegalNoticesSchema, LIMITS, METRIC_DEFINITION_VERSION, RELEASE_PROFILE, SessionStatusSchema, type LegalNotices } from '@atlas/schema';
import type { Pool } from 'pg';
import { UNCONFIGURED_LEGAL_NOTICES } from './legal.js';
import { AdmissionStore, type Credentials } from './store.js';
import { clientBucket, opaqueId, ServiceError, terminal } from './security.js';

const serviceCapabilities = (demoAnalysisId: string | null) => CapabilitiesSchema.parse({ service: 'atlas', apiVersion: 'v1',
  schemaVersions: { artifact: ARTIFACT_VERSION, graph: GRAPH_SCHEMA_VERSION, layout: LAYOUT_VERSION, metrics: METRIC_DEFINITION_VERSION },
  profiles: [RELEASE_PROFILE], repositorySources: ['public-github'], limits: LIMITS,
  languages: [
    { id: 'typescript-javascript', extensions: ['.ts','.tsx','.mts','.cts','.js','.jsx','.mjs','.cjs'], capabilities: ['syntax','imports','declarations','complexity'] },
    { id: 'python', extensions: ['.py','.pyi'], capabilities: ['syntax','imports','declarations','complexity'] }, // ADR-060
  ],
  demoAnalysisId,
});
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new ServiceError('VALIDATION_FAILED', 400, 'JSON content type is required.');
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new ServiceError('VALIDATION_FAILED', 400, 'Encoded request bodies are unsupported.');
  const chunks: Buffer[] = []; let length = 0;
  for await (const part of req) {
    const chunk = Buffer.from(part as Uint8Array); length += chunk.length;
    if (length > API_REQUEST_BODY_LIMIT) throw new ServiceError('VALIDATION_FAILED', 413, 'Request body exceeds the limit.');
    chunks.push(chunk);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new ServiceError('VALIDATION_FAILED', 400, 'Request body is not valid JSON.'); }
}
function cookie(req: IncomingMessage, name: string): string | null {
  const matches = (req.headers.cookie ?? '').split(';').map((s) => s.trim()).filter((s) => s.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0]!.slice(name.length + 1) : null;
}

/**
 * Client identity for quotas (P5.6). Only a configured reverse proxy's own address may
 * supply a forwarded client address, and only its last hop (the address the proxy itself
 * saw) is used: anything a client prepends is ignored. Without a trusted proxy the socket
 * address is the identity.
 */
export interface TrustedProxy { addresses: readonly string[] }
export function clientAddress(req: IncomingMessage, proxy?: TrustedProxy): string {
  const peer = req.socket.remoteAddress ?? 'unknown';
  if (!proxy || !proxy.addresses.includes(peer)) return peer;
  const header = req.headers['x-forwarded-for'];
  const hops = (Array.isArray(header) ? header.join(',') : header ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  const last = hops.at(-1);
  return last && isIP(last) ? last : peer;
}

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json',
  '.webp': 'image/webp', // entry-screen preview (ADR-058)
};
/** The viewer's CSP: same-origin scripts, workers and connections only (plan §8.6). */
const VIEWER_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
/** Client routes that render the single-page viewer (no server-side state in the path). */
const VIEWER_ROUTES = /^\/(?:|a\/analysis_[0-9a-f]{64}|jobs\/job_[0-9a-f]{32}|privacy|terms|takedown)$/;

/** A regular file whose real path is `full`, read through one handle (no check-then-read gap). */
async function readRegularFile(full: string): Promise<Buffer | null> {
  if ((await realpath(full).catch(() => null)) !== full) return null;
  const handle = await open(full, 'r').catch(() => null);
  if (!handle) return null;
  try {
    return (await handle.stat()).isFile() ? await handle.readFile() : null;
  } finally {
    await handle.close();
  }
}

async function serveStatic(res: ServerResponse, root: string, pathname: string): Promise<boolean> {
  const relative = VIEWER_ROUTES.test(pathname) ? 'index.html' : pathname.startsWith('/assets/') ? pathname.slice(1) : null;
  if (!relative || relative.split('/').some((s) => s === '..' || s === '' || s.startsWith('.'))) return false;
  const full = nodePath.resolve(root, ...relative.split('/'));
  if (!full.startsWith(root + nodePath.sep)) return false;
  const bytes = await readRegularFile(full);
  if (!bytes) return false;
  res.writeHead(200, {
    'Content-Type': STATIC_TYPES[nodePath.extname(full)] ?? 'application/octet-stream',
    'Content-Length': bytes.length,
    'Content-Security-Policy': VIEWER_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    // Hashed asset names are immutable; the HTML shell is never cached.
    'Cache-Control': relative === 'index.html' ? 'no-store' : 'public, max-age=31536000, immutable',
  });
  res.end(bytes);
  return true;
}

export interface ApiOptions {
  store: AdmissionStore;
  quotaSecret: string;
  origin?: string;
  port?: number;
  /** Listen address; loopback unless a deployment puts the API behind its proxy network. */
  host?: string;
  developmentLoopback?: boolean;
  /** Publication lifecycle; without it public artifact routes fail closed (503). */
  publications?: PublicationStore;
  /** Object storage readiness, reported by /health/ready. */
  storage?: ObjectStore;
  /** Built viewer directory (index.html, assets/) served same-origin. */
  webRoot?: string;
  trustedProxy?: TrustedProxy;
  /** Publication of the authored demo shown on the landing page (operator-maintained). */
  demoAnalysisId?: string;
  /** Operator-supplied public-service texts (ADR-077); placeholders when absent. */
  legal?: LegalNotices;
}

/** Hosted HTTP surface (plan §13). No repository executes here; analysis runs only in worker sandboxes. */
export async function startApi(options: ApiOptions) {
  if (Buffer.byteLength(options.quotaSecret) < 32) throw new Error('Quota secret must contain at least 32 bytes');
  if (!options.origin && !options.developmentLoopback) throw new Error('An HTTPS public origin is required');
  let origin = options.origin ?? '';
  if (origin) {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || parsed.protocol !== 'https:') throw new Error('Public origin must be an HTTPS origin without a path');
  }
  const webRoot = options.webRoot ? await realpath(options.webRoot) : null;
  const capabilities = serviceCapabilities(options.demoAnalysisId ?? null);
  const legal = LegalNoticesSchema.parse(options.legal ?? UNCONFIGURED_LEGAL_NOTICES);
  const cookieName = options.developmentLoopback ? 'atlas_session' : '__Host-atlas-session';
  const streams = new Set<ServerResponse>();
  const streamsPerJob = new Map<string, number>();
  let closing = false;
  // Counted by final status, so failures the catch block answers are included (ADR-076).
  const publicationReads: PublicationReads = { ok: 0, ended: 0, rejected: 0, unavailable: 0 };
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const requestId = opaqueId('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    try {
      const expected = new URL(origin);
      if (req.headers.host !== expected.host || req.headers['sec-fetch-site'] === 'cross-site' ||
        (req.headers.origin && req.headers.origin !== origin)) throw new ServiceError('FORBIDDEN', 403, 'Request origin is not authorized.');
      if (!req.url || req.url.includes('?') || req.url.includes('%') || req.url.includes('\\')) throw new ServiceError('VALIDATION_FAILED', 400, 'Unsupported request path.');
      if (!['GET','POST','DELETE'].includes(req.method ?? '')) throw new ServiceError('VALIDATION_FAILED', 405, 'Unsupported method.');
      if (req.method !== 'GET' && req.headers.origin !== origin) throw new ServiceError('FORBIDDEN', 403, 'Same-origin admission is required.');
      const path = req.url;
      const declaredBytes = Number(req.headers['content-length'] ?? 0);
      if (declaredBytes > API_REQUEST_BODY_LIMIT) throw new ServiceError('VALIDATION_FAILED', 413, 'Request body exceeds the limit.');
      if (!(req.method === 'POST' && path === '/api/v1/analyses') && (declaredBytes > 0 || req.headers['transfer-encoding']))
        throw new ServiceError('VALIDATION_FAILED', 400, 'This route accepts no request body.');
      if (req.method === 'GET' && webRoot && !path.startsWith('/api/') && (await serveStatic(res, webRoot, path))) return;
      // The shared viewer probes this path to detect `atlas serve`; answering it here keeps
      // that bootstrap quiet and tells the viewer it is on the hosted service instead.
      if (req.method === 'GET' && path === '/api/session') return json(res, 200, { mode: 'hosted' });
      if (req.method === 'GET' && path === '/api/v1/health/live') return json(res, 200, { live: true });
      if (req.method === 'GET' && path === '/api/v1/health/ready') {
        // Readiness covers admission (database + exact migrations) and, when configured,
        // private storage. GitHub availability never fails liveness or readiness.
        const ready = !closing && (await migrationsCurrent(options.store.pool).catch(() => false)) && (!options.storage || (await options.storage.ready().catch(() => false)));
        return json(res, ready ? 200 : 503, { ready });
      }
      if (req.method === 'GET' && path === '/api/v1/capabilities') return json(res, 200, capabilities);
      if (req.method === 'GET' && path === '/api/v1/legal') return json(res, 200, legal);

      const analysis = /^\/api\/v1\/analyses\/(analysis_[0-9a-f]{64})(?:\/chunks\/([a-z0-9_]{1,80}))?$/.exec(path);
      if (analysis && req.method === 'GET') {
        res.once('finish', () => { publicationReads[publicationReadResult(res.statusCode)]++; });
        if (!options.publications) throw new ServiceError('UPSTREAM_UNAVAILABLE', 503, 'Public publication is not enabled on this service.');
        if (!analysis[2]) return json(res, 200, await options.publications.manifest(analysis[1]!));
        const bytes = await options.publications.chunk(analysis[1]!, analysis[2]);
        res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' });
        res.end(bytes);
        return;
      }

      const bucket = clientBucket(clientAddress(req, options.trustedProxy), options.quotaSecret, new Date());
      const sessionHash = await options.store.session(cookie(req, cookieName));
      const authorization = req.headers.authorization;
      if (authorization && !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) throw new ServiceError('FORBIDDEN', 403, 'Invalid management authorization.');
      const credentials: Credentials = { sessionHash, bearer: authorization?.slice(7) ?? null };
      if (analysis && req.method === 'DELETE' && !analysis[2]) {
        if (!options.publications) throw new ServiceError('UPSTREAM_UNAVAILABLE', 503, 'Public publication is not enabled on this service.');
        await options.publications.remove(analysis[1]!, (jobId) => options.store.authorize(jobId, credentials));
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      if (req.method === 'POST' && path === '/api/v1/session') {
        if (sessionHash) return json(res, 200, SessionStatusSchema.parse({ session: 'active' }));
        const token = await options.store.createSession(bucket);
        res.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${options.developmentLoopback ? '' : '; Secure'}`);
        return json(res, 201, SessionStatusSchema.parse({ session: 'active' }));
      }
      if (req.method === 'POST' && path === '/api/v1/analyses') {
        if (!sessionHash) throw new ServiceError('FORBIDDEN', 403, 'Create a same-origin session first.');
        const key = IdempotencyKeySchema.safeParse(req.headers['idempotency-key']);
        if (!key.success) throw new ServiceError('VALIDATION_FAILED', 400, 'A UUID Idempotency-Key is required.');
        const parsed = AnalysisSubmissionSchema.safeParse(await body(req));
        if (!parsed.success) throw new ServiceError('VALIDATION_FAILED', 400, 'Invalid analysis submission.');
        let ref;
        try { ref = parseGithubRepositoryUrl(parsed.data.repositoryUrl); }
        catch { throw new ServiceError('INVALID_REPOSITORY_URL', 400, 'Use a public GitHub repository root URL.'); }
        const input = { ...parsed.data, repositoryUrl: `https://github.com/${ref.owner.toLowerCase()}/${ref.name.toLowerCase()}` };
        const result = await options.store.admit(input, sessionHash, bucket, key.data);
        // A replay of a job that already published returns its result directly (plan §13.1).
        return json(res, result.repeated && result.accepted.analysisId ? 200 : 202, AnalysisAcceptedSchema.parse(result.accepted));
      }
      const match = /^\/api\/v1\/jobs\/([^/]+)(?:\/(events|cancel))?$/.exec(path);
      if (match) {
        const parsed = JobIdSchema.safeParse(match[1]);
        if (!parsed.success) throw new ServiceError('VALIDATION_FAILED', 400, 'Invalid job ID.');
        const id = parsed.data;
        if (!match[2] && req.method === 'GET') return json(res, 200, await options.store.status(id, credentials));
        if (match[2] === 'cancel' && req.method === 'POST') {
          const done = await options.store.cancel(id, credentials);
          return json(res, done ? 200 : 202, await options.store.status(id, credentials));
        }
        if (match[2] === 'events' && req.method === 'GET') {
          await options.store.status(id, credentials);
          if (streams.size >= 100 || (streamsPerJob.get(id) ?? 0) >= 2) throw new ServiceError('QUOTA_EXCEEDED', 429, 'Too many event streams.', 10);
          const last = req.headers['last-event-id'];
          if (last && (typeof last !== 'string' || !/^\d{1,9}$/.test(last))) throw new ServiceError('VALIDATION_FAILED', 400, 'Invalid event sequence.');
          let after = Number(last ?? 0), stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
          streams.add(res);
          streamsPerJob.set(id, (streamsPerJob.get(id) ?? 0) + 1);
          const stop = () => {
            if (stopped) return;
            stopped = true; clearTimeout(timer); streams.delete(res);
            const remaining = (streamsPerJob.get(id) ?? 1) - 1;
            if (remaining <= 0) streamsPerJob.delete(id); else streamsPerJob.set(id, remaining);
          };
          res.on('close', stop);
          const lifetime = setTimeout(() => res.end(), 300_000);
          res.on('close', () => clearTimeout(lifetime));
          const send = async () => {
            try {
              // Reauthorize every poll: an expired session cannot keep a stream alive.
              const activeCredentials = { ...credentials, sessionHash: await options.store.session(cookie(req, cookieName)) };
              const events = await options.store.events(id, activeCredentials, after);
              for (const event of events) {
                if (stopped || event.revision <= after) continue;
                after = event.revision;
                if (!res.write(`id: ${after}\nevent: ${event.kind}\ndata: ${JSON.stringify(event.payload)}\n\n`)) { res.end(); stop(); return; }
              }
              const state = await options.store.status(id, activeCredentials);
              if (terminal(state.state)) { res.end(); stop(); return; }
              if (!stopped) timer = setTimeout(() => void send(), 2000);
            } catch { res.end(); stop(); }
          };
          await send(); return;
        }
      }
      throw new ServiceError('VALIDATION_FAILED', 404, 'Route not found.');
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      const failure = error instanceof ServiceError ? error : new ServiceError('INTERNAL_ERROR', 503, 'The service is temporarily unavailable.');
      if (failure.retryAfter) res.setHeader('Retry-After', failure.retryAfter);
      json(res, failure.status, ErrorEnvelopeSchema.parse({ error: { code: failure.code, message: failure.message, retryable: failure.status >= 500 || failure.status === 429, details: { ...failure.details }, requestId } }));
    }
  };
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 10_000, keepAliveTimeout: 5000 }, (req, res) => { void handler(req, res); });
  server.maxConnections = 256;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve); });
  if (!origin) origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, server, publicationReads: publicationReads as Readonly<PublicationReads>, close: async () => { closing = true; for (const stream of streams) stream.end(); server.closeIdleConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); } };
}

/**
 * Whether a `/metrics` request prefers Prometheus text to JSON (M4.2, ADR-073). Prometheus
 * offers `text/plain` above its `*` fallback; curl's and browsers' defaults keep JSON.
 */
export function prefersPrometheusText(accept: string | undefined): boolean {
  let text = 0;
  let json = 0;
  for (const part of (accept ?? '').split(',')) {
    const [range = '', ...params] = part.split(';').map((item) => item.trim().toLowerCase());
    const weight = params.find((param) => param.startsWith('q='));
    const q = weight === undefined ? 1 : Number(weight.slice(2));
    if (!Number.isFinite(q)) continue;
    if (range === 'text/plain') text = Math.max(text, q);
    else if (range === 'application/json' || range === 'application/*' || range === '*/*') json = Math.max(json, q);
  }
  return text > json;
}

/**
 * Operator endpoint (plan §15.4) on its own loopback listener: aggregate metrics and
 * readiness for dashboards and runbooks. It is never exposed through the public origin.
 * `/metrics` answers JSON, or Prometheus text when the client prefers it. The address is
 * fixed: a scraper shares the API's network namespace instead (ADR-073). With the API's
 * `publicationReads`, it also reports that process's read counters (ADR-076).
 */
export async function startOperatorServer(options: { pool: Pool; port?: number; publicationReads?: Readonly<PublicationReads> }) {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (req.method !== 'GET') return json(res, 405, { error: 'method' });
        if (req.url === '/metrics') {
          const metrics = await operatorMetrics(options.pool);
          const reads = options.publicationReads ? { ...options.publicationReads } : undefined;
          if (!prefersPrometheusText(req.headers.accept)) return json(res, 200, reads ? { ...metrics, publicationReads: reads } : metrics);
          res.writeHead(200, { 'Content-Type': PROMETHEUS_TEXT_CONTENT_TYPE, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Accept' });
          return res.end(operatorMetricsText(metrics, reads));
        }
        if (req.url === '/ready') return json(res, 200, { migrations: await migrationsCurrent(options.pool) });
        return json(res, 404, { error: 'not found' });
      } catch {
        return json(res, 503, { error: 'unavailable' });
      }
    })();
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', resolve); });
  const { address, port } = server.address() as AddressInfo;
  return { address, port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
