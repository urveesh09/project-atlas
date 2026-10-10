import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { MANIFEST_PATH, directorySource } from '@atlas/artifact/node';
import type { ArtifactBundle } from '@atlas/schema';
import type { SourceAttachment } from './source.js';

/**
 * The local viewer server (plan §14.3). Loopback only; authorization is a random,
 * single-use session capability exchanged for an HttpOnly, SameSite=Strict cookie —
 * being on loopback is never enough. Host and Origin are validated on every request to
 * defeat DNS rebinding and cross-origin reads; only GET/HEAD exist; there is no CORS,
 * no directory listing and no filesystem endpoint. It serves exactly three things: the
 * bundled viewer, the already-validated artifact files, and attached source by ID.
 */
export interface ViewerServerOptions {
  artifactDir: string;
  /** Only the validated manifest is needed: it names exactly the files that may be served. */
  bundle: Pick<ArtifactBundle, 'manifest'>;
  /** Directory holding the built viewer (index.html, assets/). */
  viewerDir: string;
  source: SourceAttachment;
  /** 0 selects a free port. */
  port?: number;
}

export interface RunningViewerServer {
  url: string;
  /** One-time URL that establishes the browser session. */
  sessionUrl: string;
  port: number;
  close(): Promise<void>;
}

const COOKIE = 'atlas_session';
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};

function token(): string {
  return randomBytes(32).toString('base64url');
}

function equal(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookieValue(req: IncomingMessage): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return rest.join('=');
  }
  return null;
}

export async function startViewerServer(options: ViewerServerOptions): Promise<RunningViewerServer> {
  const sessionCapability = token();
  let capabilityUsed = false;
  const sessions = new Set<string>();
  const viewerRoot = await realpath(options.viewerDir);
  const artifactFiles = new Set([MANIFEST_PATH, ...options.bundle.manifest.chunks.map((c) => c.path)]);
  const artifactSource = directorySource(options.artifactDir);
  let port = 0;

  const send = (res: ServerResponse, status: number, body: string | Buffer, type = 'text/plain; charset=utf-8', extra: Record<string, string> = {}) => {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...extra });
    res.end(res.req.method === 'HEAD' ? undefined : body);
  };
  const json = (res: ServerResponse, status: number, value: unknown) => send(res, status, JSON.stringify(value), 'application/json', { 'Cache-Control': 'no-store' });

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    // DNS rebinding defense: only our own loopback authority is accepted.
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!allowedHosts.has(req.headers.host ?? '')) return send(res, 421, 'Misdirected request');
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return send(res, 403, 'Cross-origin requests are not allowed');
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return send(res, 403, 'Cross-site requests are not allowed');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', undefined, { Allow: 'GET, HEAD' });

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname.startsWith('/_session/')) {
      const presented = url.pathname.slice('/_session/'.length);
      if (capabilityUsed || !equal(presented, sessionCapability)) return send(res, 403, 'This session link is invalid or was already used. Restart atlas serve for a new one.');
      capabilityUsed = true;
      const session = token();
      sessions.add(session);
      res.writeHead(303, { ...SECURITY_HEADERS, Location: '/', 'Set-Cookie': `${COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/`, 'Cache-Control': 'no-store' });
      return res.end();
    }
    const session = cookieValue(req);
    if (session === null || !sessions.has(session)) return send(res, 401, 'Open the session link printed by atlas serve.');

    if (url.pathname === '/api/session') {
      return json(res, 200, { mode: 'local', artifact: { analysisId: options.bundle.manifest.analysisId }, source: options.source.status });
    }
    if (url.pathname === '/api/source') {
      const result = await options.source.read(url.searchParams.get('snapshot') ?? '', url.searchParams.get('node') ?? '');
      return result.ok ? json(res, 200, result) : json(res, result.status, { error: result.reason });
    }
    if (url.pathname.startsWith('/artifact/')) {
      const relative = decodeURIComponent(url.pathname.slice('/artifact/'.length));
      // Only the exact validated manifest and its listed chunks; nothing else in the directory.
      if (!artifactFiles.has(relative)) return send(res, 404, 'Not found');
      const bytes = await artifactSource.read(relative, 32 * 1024 * 1024);
      if (!bytes) return send(res, 404, 'Not found');
      return send(res, 200, Buffer.from(bytes), relative.endsWith('.gz') ? 'application/gzip' : 'application/json', { 'Cache-Control': 'no-store' });
    }

    // Bundled viewer assets (no listing; every path must resolve inside the viewer root).
    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    if (relative.includes('\0') || relative.includes('\\') || relative.split('/').some((s) => s === '..' || s.startsWith('.'))) return send(res, 404, 'Not found');
    const full = path.resolve(viewerRoot, ...relative.split('/'));
    if (!full.startsWith(viewerRoot + path.sep)) return send(res, 404, 'Not found');
    const info = await stat(full).catch(() => null);
    if (!info?.isFile() || (await realpath(full)) !== full) return send(res, 404, 'Not found');
    return send(res, 200, await readFile(full), MIME[path.extname(full)] ?? 'application/octet-stream', { 'Cache-Control': relative.startsWith('assets/') ? 'max-age=3600' : 'no-store' });
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, 'Internal error');
      else res.destroy();
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/`;
  return {
    url,
    sessionUrl: `${url}_session/${sessionCapability}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
