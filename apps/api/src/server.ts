import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { parseGithubRepositoryUrl } from '@atlas/ingest';
import { AnalysisAcceptedSchema, AnalysisSubmissionSchema, API_REQUEST_BODY_LIMIT, ARTIFACT_VERSION, CapabilitiesSchema, ErrorEnvelopeSchema, GRAPH_SCHEMA_VERSION, IdempotencyKeySchema, JobIdSchema, LAYOUT_VERSION, LIMITS, METRIC_DEFINITION_VERSION, RELEASE_PROFILE, SessionStatusSchema } from '@atlas/schema';
import { AdmissionStore, type Credentials } from './store.js';
import { clientBucket, opaqueId, ServiceError, terminal } from './security.js';

const capabilities = CapabilitiesSchema.parse({ service: 'atlas', apiVersion: 'v1',
  schemaVersions: { artifact: ARTIFACT_VERSION, graph: GRAPH_SCHEMA_VERSION, layout: LAYOUT_VERSION, metrics: METRIC_DEFINITION_VERSION },
  profiles: [RELEASE_PROFILE], repositorySources: ['public-github'], limits: LIMITS,
  languages: [{ id: 'typescript-javascript', extensions: ['.ts','.tsx','.mts','.cts','.js','.jsx','.mjs','.cjs'], capabilities: ['syntax','imports','declarations','complexity'] }],
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
/** Preview control plane only. No repository executes here; publication routes stay closed until P5.4. */
export async function startApi(options: {
  store: AdmissionStore; quotaSecret: string; origin?: string; port?: number; developmentLoopback?: boolean;
}) {
  if (Buffer.byteLength(options.quotaSecret) < 32) throw new Error('Quota secret must contain at least 32 bytes');
  if (!options.origin && !options.developmentLoopback) throw new Error('An HTTPS public origin is required');
  let origin = options.origin ?? '';
  if (origin) {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || parsed.protocol !== 'https:') throw new Error('Public origin must be an HTTPS origin without a path');
  }
  const cookieName = options.developmentLoopback ? 'atlas_session' : '__Host-atlas-session';
  const streams = new Set<ServerResponse>();
  const streamsPerJob = new Map<string, number>();
  let closing = false;
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
      if (req.method === 'GET' && path === '/api/v1/health/live') return json(res, 200, { live: true });
      if (req.method === 'GET' && path === '/api/v1/health/ready') {
        const migration = await options.store.pool.query('SELECT version FROM atlas_migrations WHERE version=1');
        return json(res, closing || !migration.rowCount ? 503 : 200, { ready: !closing && migration.rowCount === 1 });
      }
      if (req.method === 'GET' && path === '/api/v1/capabilities') return json(res, 200, capabilities);
      const bucket = clientBucket(req.socket.remoteAddress ?? 'unknown', options.quotaSecret, new Date());
      const sessionHash = await options.store.session(cookie(req, cookieName));
      const authorization = req.headers.authorization;
      if (authorization && !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) throw new ServiceError('FORBIDDEN', 403, 'Invalid management authorization.');
      const credentials: Credentials = { sessionHash, bearer: authorization?.slice(7) ?? null };
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
        return json(res, 202, AnalysisAcceptedSchema.parse(result.accepted));
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
      if (path.startsWith('/api/v1/analyses/')) throw new ServiceError('UPSTREAM_UNAVAILABLE', 503, 'Public publication is not enabled in this preview.');
      throw new ServiceError('VALIDATION_FAILED', 404, 'Route not found.');
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      const failure = error instanceof ServiceError ? error : new ServiceError('INTERNAL_ERROR', 503, 'The service is temporarily unavailable.');
      if (failure.retryAfter) res.setHeader('Retry-After', failure.retryAfter);
      json(res, failure.status, ErrorEnvelopeSchema.parse({ error: { code: failure.code, message: failure.message, retryable: failure.status >= 500 || failure.status === 429, details: {}, requestId } }));
    }
  };
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 10_000, keepAliveTimeout: 5000 }, (req, res) => { void handler(req, res); });
  server.maxConnections = 256;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', resolve); });
  if (!origin) origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, server, close: async () => { closing = true; for (const stream of streams) stream.end(); server.closeIdleConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); } };
}
