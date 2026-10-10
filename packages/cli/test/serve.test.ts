import { request } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readArtifactDirectory } from '@atlas/artifact/node';
import { run, type CliIO } from '@atlas/cli';
import { SourceAttachment } from '../src/server/source.js';
import { startViewerServer, type RunningViewerServer } from '../src/server/server.js';
import { buildDemoRepository, createGitFixture, type GitFixture } from '@atlas/test-fixtures';
import type { ArtifactBundle } from '@atlas/schema';

/**
 * P2.6 / plan §14.3 server restrictions, exercised over raw HTTP so every header can be
 * forged: Host, Origin, Sec-Fetch-Site, methods, session reuse and path traversal.
 */
interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function http(port: number, pathname: string, options: { method?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: pathname, method: options.method ?? 'GET', headers: { host: `127.0.0.1:${port}`, ...options.headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

let work: string;
let demo: GitFixture;
let bundle: ArtifactBundle;
let server: RunningViewerServer;
let cookie: string;
const artifactDir = () => path.join(work, 'harbor-out');

async function analyzeDemo(): Promise<void> {
  const io: CliIO = { stdout: { write: () => true }, stderr: { write: () => true }, env: { NO_COLOR: '1' }, cwd: work, signal: new AbortController().signal };
  expect(await run(['analyze', demo.dir, '--out', 'harbor-out'], io)).toBe(0);
}

beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'atlas-serve-'));
  demo = buildDemoRepository();
  await analyzeDemo();
  const loaded = await readArtifactDirectory(artifactDir());
  if (!loaded.ok) throw new Error('fixture artifact invalid');
  bundle = loaded.bundle;
  const viewer = path.join(work, 'viewer');
  mkdirSync(path.join(viewer, 'assets'), { recursive: true });
  writeFileSync(path.join(viewer, 'index.html'), '<!doctype html><title>viewer</title>');
  writeFileSync(path.join(viewer, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(path.join(work, 'secret.txt'), 'outside the viewer root');
  server = await startViewerServer({ artifactDir: artifactDir(), bundle, viewerDir: viewer, source: await SourceAttachment.attach(demo.dir, bundle) });
  const exchange = await http(server.port, new URL(server.sessionUrl).pathname);
  cookie = String(exchange.headers['set-cookie']).split(';')[0]!;
});

afterAll(async () => {
  await server?.close();
  demo?.dispose();
  rmSync(work, { recursive: true, force: true });
});

const authed = (pathname: string, headers: Record<string, string> = {}) => http(server.port, pathname, { headers: { cookie, ...headers } });

describe('session capability', () => {
  it('binds to loopback only', () => {
    expect(new URL(server.url).hostname).toBe('127.0.0.1');
  });

  it('issues an HttpOnly, SameSite=Strict cookie once, then refuses the link', async () => {
    expect(cookie).toMatch(/^atlas_session=[A-Za-z0-9_-]{43}$/);
    const reuse = await http(server.port, new URL(server.sessionUrl).pathname);
    expect(reuse.status).toBe(403);
    expect(await http(server.port, `/_session/${'A'.repeat(43)}`)).toMatchObject({ status: 403 });
  });

  it('requires the session for every route, including assets and the artifact', async () => {
    for (const route of ['/', '/assets/app.js', '/api/session', '/artifact/manifest.json']) {
      expect((await http(server.port, route)).status, route).toBe(401);
    }
    expect((await authed('/api/session')).status).toBe(200);
  });
});

describe('origin and method policy', () => {
  it('rejects foreign Host headers (DNS rebinding)', async () => {
    expect((await authed('/api/session', { host: `evil.example:${server.port}` })).status).toBe(421);
    expect((await authed('/api/session', { host: '127.0.0.1:1' })).status).toBe(421);
  });

  it('rejects cross-origin and cross-site requests', async () => {
    expect((await authed('/api/session', { origin: 'http://evil.example' })).status).toBe(403);
    expect((await authed('/api/session', { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await authed('/api/session', { origin: `http://127.0.0.1:${server.port}`, 'sec-fetch-site': 'same-origin' })).status).toBe(200);
  });

  it('allows only GET and HEAD and sends no CORS headers', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) expect((await http(server.port, '/api/session', { method, headers: { cookie } })).status, method).toBe(405);
    const reply = await authed('/api/session', { origin: `http://127.0.0.1:${server.port}` });
    expect(reply.headers['access-control-allow-origin']).toBeUndefined();
    expect(reply.headers['content-security-policy']).toContain("default-src 'self'");
    expect(reply.headers['x-content-type-options']).toBe('nosniff');
    expect(reply.headers['cache-control']).toBe('no-store');
  });
});

describe('what can be served', () => {
  it('serves the validated manifest and its chunks, and nothing else from the artifact folder', async () => {
    expect((await authed('/artifact/manifest.json')).status).toBe(200);
    expect((await authed(`/artifact/${bundle.manifest.layoutChunk.path}`)).status).toBe(200);
    for (const route of ['/artifact/summary.json', '/artifact/repository-id.json', '/artifact/../secret.txt', '/artifact/%2e%2e/secret.txt', '/artifact/graphs/']) {
      expect((await authed(route)).status, route).toBe(404);
    }
  });

  it('never escapes the viewer directory or lists it', async () => {
    for (const route of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/assets/..%5c..%5csecret.txt', '/%5c..%5csecret.txt', '/assets/', '/.env', '/assets/%00app.js']) {
      expect((await authed(route)).status, route).toBe(404);
    }
    expect((await authed('/assets/app.js')).status).toBe(200);
  });
});

describe('read-only source attachment', () => {
  // The selected (newest) frame; older frames are validated against their own commits.
  const fileNode = (p: string) => bundle.graphs.at(-1)!.nodes.find((n) => n.kind === 'file' && n.path === p)!;
  const snap = () => bundle.graphs.at(-1)!.snapshotId;

  it('serves committed source by snapshot and occurrence ID, not the working tree', async () => {
    writeFileSync(path.join(demo.dir, 'src', 'server', 'router.ts'), '// uncommitted edit\n');
    try {
      const reply = await authed(`/api/source?snapshot=${snap()}&node=${fileNode('src/server/router.ts').id}`);
      expect(reply.status).toBe(200);
      const body = JSON.parse(reply.body);
      expect(body.path).toBe('src/server/router.ts');
      expect(body.text).toContain("import { handleQuote } from './handlers';");
      expect(body.text).not.toContain('uncommitted');
    } finally {
      demo.git(['checkout', '--', 'src/server/router.ts']);
    }
  });

  it('refuses unknown IDs, paths, revisions and opaque files', async () => {
    expect((await authed(`/api/source?snapshot=${snap()}&node=node_${'0'.repeat(64)}`)).status).toBe(404);
    expect((await authed(`/api/source?snapshot=${snap()}&node=src/server/router.ts`)).status).toBe(404);
    expect((await authed(`/api/source?snapshot=HEAD&node=${fileNode('src/server/router.ts').id}`)).status).toBe(404);
    expect((await authed(`/api/source?snapshot=${snap()}&node=${fileNode('src/server/store.json').id}`)).status).toBe(409);
  });

  it('refuses to attach a different repository', async () => {
    const other = createGitFixture([{ date: '2026-01-01T00:00:00Z', message: 'x', files: { 'a.ts': 'export {}' } }]);
    try {
      const attachment = await SourceAttachment.attach(other.dir, bundle);
      expect(attachment.status).toEqual({ attached: false, reason: 'COMMIT_NOT_FOUND' });
      await attachment.dispose();
    } finally {
      other.dispose();
    }
  });

  it('refuses a repository whose committed tree differs (same commit ID is impossible to fake, so rewrite history)', async () => {
    const copy = buildDemoRepository();
    try {
      // Amend HEAD: the commit the artifact names no longer exists in this repository.
      writeFileSync(path.join(copy.dir, 'README.md'), 'changed\n');
      copy.git(['commit', '-q', '-a', '--amend', '--no-edit']);
      copy.git(['reflog', 'expire', '--expire=now', '--all']);
      copy.git(['gc', '-q', '--prune=now']);
      const attachment = await SourceAttachment.attach(copy.dir, bundle);
      expect(attachment.status.attached).toBe(false);
      await attachment.dispose();
    } finally {
      copy.dispose();
    }
  });

  it('reports source as unattached without --repo', async () => {
    const plain = SourceAttachment.none();
    expect(await plain.read(snap(), fileNode('src/server/router.ts').id)).toEqual({ ok: false, status: 403, reason: 'NOT_REQUESTED' });
  });
});
