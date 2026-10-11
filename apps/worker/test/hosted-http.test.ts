import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startApi } from '@atlas/api';
import { AnalysisAcceptedSchema, ArtifactManifestSchema, ErrorEnvelopeSchema, JobStatusSchema } from '@atlas/schema';
import { buildDemoRepository, type GitFixture } from '@atlas/test-fixtures';
import { ScriptedRunners, createHarness, databaseUrl, processRunners, requireBuiltSandbox, submission, type Harness } from './pipeline-harness.js';

const HARBOR = 'https://github.com/atlas-demo/harbor';

describe.runIf(!!databaseUrl)('hosted HTTP journey: admission, progress, publication and deletion', () => {
  let demo: GitFixture;
  let h: Harness;
  let api: Awaited<ReturnType<typeof startApi>>;
  let webRoot: string;
  let roles: Awaited<ReturnType<Harness['restrictedRoles']>>;
  beforeAll(async () => {
    requireBuiltSandbox();
    demo = buildDemoRepository();
    h = await createHarness([{ numericId: '626262', owner: 'atlas-demo', name: 'harbor', defaultBranch: 'main', headOid: demo.commits.at(-1)!, remotePath: demo.dir, visibility: 'public' }]);
    webRoot = mkdtempSync(path.join(tmpdir(), 'atlas-web-'));
    mkdirSync(path.join(webRoot, 'assets'));
    writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>ATLAS</title>');
    writeFileSync(path.join(webRoot, 'assets', 'index-abc.js'), 'export {};');
    writeFileSync(path.join(webRoot, '.secret'), 'no');
    // Deployment shape: the API and the worker each run under their own least-privilege role.
    roles = await h.restrictedRoles();
    api = await startApi({ store: roles.api.admission, quotaSecret: 'q'.repeat(32), developmentLoopback: true, publications: roles.api.publications, storage: h.store, webRoot });
  });
  beforeEach(async () => h.reset());
  afterAll(async () => {
    await api?.close();
    await h?.close();
    demo?.dispose();
    rmSync(webRoot, { recursive: true, force: true });
  });

  const session = async () => {
    const response = await fetch(`${api.origin}/api/v1/session`, { method: 'POST', headers: { Origin: api.origin } });
    return response.headers.get('set-cookie')!.split(';')[0]!;
  };
  const submit = async (cookie: string, history = true, key = randomUUID()) =>
    fetch(`${api.origin}/api/v1/analyses`, {
      method: 'POST',
      headers: { Origin: api.origin, Cookie: cookie, 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(submission(HARBOR, history)),
    });

  it('runs a submission to an immutable public result and replays the completed request with 200', async () => {
    const cookie = await session();
    const key = randomUUID();
    const response = await submit(cookie, true, key);
    expect(response.status).toBe(202);
    const accepted = AnalysisAcceptedSchema.parse(await response.json());
    const queued = JobStatusSchema.parse(await (await fetch(`${api.origin}${accepted.statusUrl}`, { headers: { Cookie: cookie } })).json());
    expect(queued).toMatchObject({ state: 'QUEUED', queuePosition: 1 });
    await roles.worker.coordinator(new ScriptedRunners(processRunners(demo.dir))).runOnce();
    const status = JobStatusSchema.parse(await (await fetch(`${api.origin}${accepted.statusUrl}`, { headers: { Cookie: cookie } })).json());
    expect(status).toMatchObject({ state: 'READY', queuePosition: null, error: null });
    expect(status.analysisId).toMatch(/^analysis_[0-9a-f]{64}$/);

    // SSE replays the whole journey to terminal and then closes.
    const events = await (await fetch(`${api.origin}${accepted.eventsUrl}`, { headers: { Cookie: cookie, 'Last-Event-ID': '0' } })).text();
    for (const state of ['ACQUIRING', 'ANALYZING', 'HISTORY', 'LAYOUT', 'VALIDATING', 'READY']) expect(events).toContain(`"state":"${state}"`);
    expect(events).toContain('event: terminal');

    // Public, cookie-less reads of the manifest and every chunk; nothing cacheable.
    const manifestResponse = await fetch(`${api.origin}/api/v1/analyses/${status.analysisId}`);
    expect(manifestResponse.status).toBe(200);
    expect(manifestResponse.headers.get('cache-control')).toBe('no-store');
    const manifest = ArtifactManifestSchema.parse(await manifestResponse.json());
    expect(manifest.analysisId).toBe(status.analysisId);
    for (const chunk of manifest.chunks) {
      const id = chunk.path === 'history/history.json.gz' ? 'history' : chunk.path === 'layout/layout.json.gz' ? 'layout' : chunk.path.slice(7, -8);
      const bytes = await fetch(`${api.origin}/api/v1/analyses/${status.analysisId}/chunks/${id}`);
      expect(bytes.status).toBe(200);
      expect(bytes.headers.get('content-type')).toBe('application/gzip');
      expect(bytes.headers.get('cache-control')).toBe('no-store');
      expect((await bytes.arrayBuffer()).byteLength).toBe(chunk.compressedBytes);
    }

    // Replaying the same idempotent request after completion returns the result (200), no token.
    const replay = await submit(cookie, true, key);
    expect(replay.status).toBe(200);
    expect(AnalysisAcceptedSchema.parse(await replay.json())).toMatchObject({ jobId: accepted.jobId, managementToken: null, analysisId: status.analysisId });
  });

  it('deletes with the management capability only, then answers 410 with no graph body', async () => {
    const cookie = await session();
    const accepted = AnalysisAcceptedSchema.parse(await (await submit(cookie, false)).json());
    await roles.worker.coordinator(new ScriptedRunners(processRunners(demo.dir))).runOnce();
    const { analysisId } = JobStatusSchema.parse(await (await fetch(`${api.origin}${accepted.statusUrl}`, { headers: { Cookie: cookie } })).json());
    const url = `${api.origin}/api/v1/analyses/${analysisId}`;
    const anonymous = await fetch(url, { method: 'DELETE', headers: { Origin: api.origin } });
    expect(anonymous.status).toBe(403);
    const crossSite = await fetch(url, { method: 'DELETE', headers: { Origin: 'https://evil.invalid', Authorization: `Bearer ${accepted.managementToken}` } });
    expect(crossSite.status).toBe(403);
    const deleted = await fetch(url, { method: 'DELETE', headers: { Origin: api.origin, Authorization: `Bearer ${accepted.managementToken}` } });
    expect(deleted.status).toBe(204);
    const gone = await fetch(url);
    expect(gone.status).toBe(410);
    const envelope = ErrorEnvelopeSchema.parse(await gone.json());
    expect(envelope.error.code).toBe('ARTIFACT_DELETED');
    expect(JSON.stringify(envelope)).not.toContain('nodes');
    expect((await fetch(`${url}/chunks/layout`)).status).toBe(410);
  });

  it('serves the viewer shell for client routes with a strict CSP, and nothing else from disk', async () => {
    for (const route of ['/', `/a/analysis_${'1'.repeat(64)}`, `/jobs/job_${'2'.repeat(32)}`]) {
      const response = await fetch(`${api.origin}${route}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).toContain('<title>ATLAS</title>');
    }
    const asset = await fetch(`${api.origin}/assets/index-abc.js`);
    expect(asset.headers.get('cache-control')).toContain('immutable');
    for (const route of ['/.secret', '/assets/../.secret', '/index.html/../.secret', '/a/not-an-id', '/assets/', '/jobs/job_x']) {
      expect((await fetch(`${api.origin}${route}`)).status, route).not.toBe(200);
    }
  });

  it('reports readiness from migrations and storage, and never places tokens in URLs', async () => {
    expect((await fetch(`${api.origin}/api/v1/health/ready`)).status).toBe(200);
    const cookie = await session();
    const accepted = AnalysisAcceptedSchema.parse(await (await submit(cookie)).json());
    expect(accepted.statusUrl).not.toContain(accepted.managementToken!);
    expect(accepted.eventsUrl).not.toContain(accepted.managementToken!);
    expect((await fetch(`${api.origin}${accepted.statusUrl}?token=${accepted.managementToken}`)).status).toBe(400);
  });
});
