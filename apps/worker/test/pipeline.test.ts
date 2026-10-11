import { readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openArtifact } from '@atlas/artifact';
import { gunzipNode } from '@atlas/artifact/node';
import { FileObjectStore, ServiceError, chunkIdOf, deleteUpload, type ObjectStore } from '@atlas/control';
import { IngestError } from '@atlas/ingest';
import { ArtifactManifestSchema, hostedRepositoryId } from '@atlas/schema';
import { DEMO_HEAD_FILES, buildDemoRepository, type GitFixture } from '@atlas/test-fixtures';
import { ScriptedRunners, createHarness, databaseUrl, processRunners, requireBuiltSandbox, submission, untilAborted, type Harness } from './pipeline-harness.js';

const HARBOR = 'https://github.com/atlas-demo/harbor';
const MISSING = 'https://github.com/atlas-demo/missing';

/** Open a publication exactly as the hosted viewer does: manifest, then chunks by ID. */
async function openPublication(h: Harness, analysisId: string) {
  return openArtifact(
    {
      async read(relative) {
        if (relative === 'manifest.json') return new TextEncoder().encode(JSON.stringify(await h.publications.manifest(analysisId)));
        return h.publications.chunk(analysisId, chunkIdOf(relative));
      },
    },
    gunzipNode,
  );
}

describe.runIf(!!databaseUrl)('hosted pipeline on real PostgreSQL and storage (sandboxed analyzer processes)', () => {
  let demo: GitFixture;
  let h: Harness;
  beforeAll(async () => {
    requireBuiltSandbox();
    demo = buildDemoRepository();
    h = await createHarness([
      { numericId: '424242', owner: 'atlas-demo', name: 'harbor', defaultBranch: 'main', headOid: demo.commits.at(-1)!, remotePath: demo.dir, visibility: 'public' },
    ]);
  });
  beforeEach(async () => h.reset());
  afterAll(async () => {
    await h?.close();
    demo?.dispose();
  });

  const runners = () => new ScriptedRunners(processRunners(demo.dir));

  it('publishes a verified history artifact through HEAD checkpoint, history, layout and validation', async () => {
    const job = await h.submit(submission(HARBOR));
    const scripted = runners();
    expect(await h.coordinator(scripted).runOnce()).toBe(true);
    const row = await h.job(job.jobId);
    expect(row.state).toBe('READY');
    expect(row.analysis_id).toMatch(/^analysis_[0-9a-f]{64}$/);
    // HEAD first (depth 1, checkpoint), then the bounded window and the full analysis.
    expect(scripted.acquisitions).toEqual([1, 201]);
    expect(scripted.analyses).toEqual([{ history: true, checkpoint: true }, { history: true, checkpoint: false }]);
    const states = (await h.events(job.jobId)).map((e) => e.state);
    const order = ['QUEUED', 'ACQUIRING', 'ANALYZING', 'HISTORY', 'LAYOUT', 'VALIDATING', 'READY'];
    expect([...new Set(states)]).toEqual(order);
    expect(row.counts).toMatchObject({ filesIncluded: 26, framesCompleted: 12, framesRequested: 12 });
    expect(row.warnings).toEqual([{ code: 'PROCESS_ISOLATION_ONLY', count: 1 }]);
    expect(Object.keys(row.metrics.stageMs).sort()).toEqual(['acquireHead', 'acquireHistory', 'analyzeHead', 'analyzeHistory', 'upload', 'uploadHead', 'validate', 'verify', 'verifyHead'].sort());

    const manifest = await h.publications.manifest(row.analysis_id);
    expect(ArtifactManifestSchema.parse(manifest).analysisId).toBe(row.analysis_id);
    expect(Date.parse(manifest.expiresAt!) - Date.now()).toBeGreaterThan(6.9 * 24 * 3600 * 1000);
    expect(manifest.repo).toMatchObject({ sourceKind: 'public-github', repoId: hostedRepositoryId('424242'), remote: { host: 'github.com', owner: 'atlas-demo', name: 'harbor', numericId: '424242' } });
    expect(manifest.selectedCommit.oid).toBe(demo.commits.at(-1));
    const opened = await openPublication(h, row.analysis_id);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const files = opened.artifact.head.nodes.flatMap((n) => (n.kind === 'file' ? [n.path] : [])).sort();
    expect(files).toEqual([...DEMO_HEAD_FILES].sort());
    for (let i = 0; i < manifest.frames.length; i++) expect((await opened.artifact.frame(i)).ok).toBe(true);

    // The checkpoint is collectable once the job published its full artifact.
    const uploads = (await h.pool.query('SELECT purpose,state FROM uploads ORDER BY purpose')).rows;
    expect(uploads).toEqual([{ purpose: 'artifact', state: 'live' }, { purpose: 'checkpoint', state: 'pending' }]);
    await h.pool.query("UPDATE uploads SET created_at=clock_timestamp()-interval '2 minutes'");
    await h.publications.collectUploads();
    expect((await h.pool.query("SELECT state FROM uploads WHERE purpose='checkpoint'")).rows[0].state).toBe('purged');
    expect(readdirSync(h.workRoot)).toEqual([]);
  });

  it('publishes and logs no author identity, absolute or sandbox path, token or repository name (§16.3)', async () => {
    const job = await h.submit(submission(HARBOR));
    const logs: string[] = [];
    await h.coordinator(runners(), { log: (event, fields) => logs.push(JSON.stringify({ event, ...fields })) }).runOnce();
    const row = await h.job(job.jobId);
    expect(row.state).toBe('READY');
    const manifest = await h.publications.manifest(row.analysis_id);
    const texts = [JSON.stringify(manifest)];
    for (const chunk of manifest.chunks) texts.push(gunzipSync(Buffer.from(await h.publications.chunk(row.analysis_id, chunkIdOf(chunk.path)))).toString('utf8'));
    const published = texts.join('\n');
    const forbidden = ['fixture@atlas.invalid', 'ATLAS Fixture', h.workRoot, h.storageRoot, demo.dir, demo.dir.replaceAll('\\', '/'), '/acquired', '/scratch', '/input/', job.token, 'C:\\', '/home/', '/tmp/'];
    for (const value of forbidden) expect(published.includes(value), value).toBe(false);
    const logged = logs.join('\n');
    expect(logs.length).toBeGreaterThan(3);
    for (const value of [...forbidden, 'atlas-demo', 'harbor', 'github.com']) expect(logged.includes(value), `log: ${value}`).toBe(false);
    // Job state shown to the client carries only codes and counts.
    const visible = JSON.stringify(await h.admission.status(job.jobId, { sessionHash: null, bearer: job.token }));
    for (const value of forbidden.filter((v) => v !== job.token)) expect(visible.includes(value), value).toBe(false);
  });

  it('reuses a complete cached artifact as a new publication with its own identity and expiry', async () => {
    const first = await h.submit(submission(HARBOR));
    await h.coordinator(runners()).runOnce();
    const firstRow = await h.job(first.jobId);
    const second = await h.submit(submission(HARBOR));
    const scripted = runners();
    await h.coordinator(scripted).runOnce();
    const row = await h.job(second.jobId);
    expect(row.state).toBe('READY');
    expect(row.counts).toEqual({ cached: 1 });
    expect(scripted.acquisitions).toEqual([]);
    expect(row.analysis_id).not.toBe(firstRow.analysis_id);
    const keys = (await h.pool.query('SELECT content_key FROM publications')).rows.map((r) => r.content_key);
    expect(new Set(keys).size).toBe(1);
    expect((await h.publications.manifest(row.analysis_id)).analysisId).toBe(row.analysis_id);
    // A HEAD-only request is a different cache identity.
    const head = await h.submit(submission(HARBOR, false));
    const headRunners = runners();
    await h.coordinator(headRunners).runOnce();
    expect((await h.job(head.jobId)).state).toBe('READY');
    expect(headRunners.acquisitions).toEqual([1]);
    const headManifest = await h.publications.manifest((await h.job(head.jobId)).analysis_id);
    expect(headManifest.coverage.history).toMatchObject({ status: 'unavailable', requestedCommitCap: 0, boundary: 'none' });
    expect(headManifest.frames).toHaveLength(1);
  });

  it('publishes the verified HEAD checkpoint as PARTIAL when history acquisition exceeds the transfer limit', async () => {
    const job = await h.submit(submission(HARBOR));
    const scripted = new ScriptedRunners(processRunners(demo.dir), {
      acquire: (request, run) => (request.depth > 1 ? Promise.reject(new IngestError('REPOSITORY_TOO_LARGE', 'over budget')) : run()),
    });
    await h.coordinator(scripted).runOnce();
    const row = await h.job(job.jobId);
    expect(row.state).toBe('PARTIAL');
    expect(row.warnings).toEqual(expect.arrayContaining([{ code: 'HISTORY_NOT_ACQUIRED', count: 1 }, { code: 'ACQUISITION_NETWORK_LIMIT', count: 1 }]));
    const manifest = await h.publications.manifest(row.analysis_id);
    expect(manifest.coverage.history).toMatchObject({ status: 'unavailable', boundary: 'resource-cap', requestedCommitCap: 200 });
    expect(manifest.frames).toHaveLength(1);
    expect(row.counts.commitsTraversed).toBeUndefined();
    // A partial result is never cached for later submissions.
    expect((await h.pool.query('SELECT cache_key,status FROM artifact_objects')).rows).toEqual([{ cache_key: null, status: 'partial' }]);
  });

  it('fails without a result when acquisition fails before the HEAD checkpoint', async () => {
    const missing = await h.submit(submission(MISSING));
    await h.coordinator(runners()).runOnce();
    expect(await h.job(missing.jobId)).toMatchObject({ state: 'FAILED', analysis_id: null, error: expect.objectContaining({ code: 'REPOSITORY_NOT_FOUND', retryable: false }) });
    const outage = await h.submit(submission(HARBOR));
    h.resolver.outage = true;
    await h.coordinator(runners()).runOnce();
    expect((await h.job(outage.jobId)).error).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', retryable: true });
    expect((await h.pool.query('SELECT count(*)::int AS n FROM publications')).rows[0].n).toBe(0);
    expect((await h.pool.query('SELECT count(*)::int AS n FROM uploads')).rows[0].n).toBe(0);
  });

  it.each([
    ['acquiring HEAD', (r: { depth?: number; spec?: { checkpoint: boolean } }) => r.depth === 1],
    ['analyzing HEAD', (r: { depth?: number; spec?: { checkpoint: boolean } }) => r.spec?.checkpoint === true],
    ['acquiring history', (r: { depth?: number; spec?: { checkpoint: boolean } }) => (r.depth ?? 0) > 1],
    ['analyzing history', (r: { depth?: number; spec?: { checkpoint: boolean } }) => r.spec?.checkpoint === false],
  ])('cancels while %s: stops the stage, publishes nothing and cleans scratch', async (_label, matches) => {
    const job = await h.submit(submission(HARBOR));
    let stopped = false;
    const block = async <T>(request: { signal: AbortSignal }, run: () => Promise<T>, hit: boolean): Promise<T> => {
      if (!hit) return run();
      await h.admission.cancel(job.jobId, { sessionHash: null, bearer: job.token });
      try {
        return await untilAborted(request.signal);
      } finally {
        stopped = true;
      }
    };
    const scripted = new ScriptedRunners(processRunners(demo.dir), {
      acquire: (request, run) => block(request, run, matches(request)),
      analyze: (request, run) => block(request, run, matches(request)),
    });
    await h.coordinator(scripted).runOnce();
    expect(stopped).toBe(true);
    expect(await h.job(job.jobId)).toMatchObject({ state: 'CANCELLED', analysis_id: null, lease_owner: null });
    expect((await h.pool.query('SELECT count(*)::int AS n FROM publications')).rows[0].n).toBe(0);
    expect(readdirSync(h.workRoot)).toEqual([]);
    await h.pool.query("UPDATE uploads SET created_at=clock_timestamp()-interval '2 minutes'");
    await h.publications.collectUploads();
    expect((await h.pool.query("SELECT count(*)::int AS n FROM uploads WHERE state<>'purged'")).rows[0].n).toBe(0);
  });

  it('kills a running sandbox process on cancellation instead of waiting for it', async () => {
    const job = await h.submit(submission(HARBOR, false));
    const scripted = new ScriptedRunners(processRunners(demo.dir), {
      analyze: async (request, run) => {
        const running = run();
        await h.admission.cancel(job.jobId, { sessionHash: null, bearer: job.token });
        return running;
      },
    });
    const started = Date.now();
    await h.coordinator(scripted).runOnce();
    expect((await h.job(job.jobId)).state).toBe('CANCELLED');
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it('recovers from a coordinator crash after the HEAD checkpoint with one fenced retry and fresh scratch', async () => {
    const job = await h.submit(submission(HARBOR));
    // Attempt 1 "crashes" during history: its lease lapses and the monitor stops the stage.
    const crashing = new ScriptedRunners(processRunners(demo.dir), {
      acquire: async (request, run) => {
        if (request.depth === 1) return run();
        await h.pool.query("UPDATE jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job.jobId]);
        return untilAborted(request.signal);
      },
    });
    await h.coordinator(crashing).runOnce();
    const crashed = await h.job(job.jobId);
    expect(crashed.state).toBe('HISTORY');
    expect((await h.pool.query('SELECT count(*)::int AS n FROM job_checkpoints')).rows[0].n).toBe(1);
    expect(await h.queue.reap()).toBe(1);
    const retry = runners();
    await h.coordinator(retry).runOnce();
    const row = await h.job(job.jobId);
    expect(row).toMatchObject({ state: 'READY', attempt: 2 });
    expect(row.warnings).toEqual(expect.arrayContaining([{ code: 'CHECKPOINT_RECOVERED', count: 1 }]));
    // The retry skipped the HEAD stage and acquired the whole window into fresh scratch.
    expect(retry.acquisitions).toEqual([201]);
    expect(retry.analyses).toEqual([{ history: true, checkpoint: false }]);
  });

  it('sweeps scratch left by a crashed process after an hour, never a running attempt', async () => {
    const { mkdirSync, utimesSync, existsSync } = await import('node:fs');
    const coordinator = h.coordinator(runners());
    const stale = `${h.workRoot}/job_${'1'.repeat(32)}-crashed`;
    const fresh = `${h.workRoot}/job_${'2'.repeat(32)}-recent`;
    const running = `${h.workRoot}/job_${'3'.repeat(32)}-running`;
    const other = `${h.workRoot}/not-a-job`;
    for (const dir of [stale, fresh, running, other]) mkdirSync(`${dir}/acquired/git`, { recursive: true });
    const old = new Date(Date.now() - 2 * 3_600_000);
    for (const dir of [stale, running, other]) utimesSync(dir, old, old);
    coordinator.activeScratch.add(running);
    expect(await coordinator.sweepScratch()).toBe(1);
    expect([stale, fresh, running, other].map((d) => existsSync(d))).toEqual([false, true, true, true]);
    const { rmSync } = await import('node:fs');
    for (const dir of [fresh, running, other]) rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to the checkpoint before the hard deadline when history cannot finish', async () => {
    const job = await h.submit(submission(HARBOR));
    await h.pool.query("UPDATE jobs SET deadline=clock_timestamp()+interval '22 seconds' WHERE id=$1", [job.jobId]);
    const slow = new ScriptedRunners(processRunners(demo.dir), {
      acquire: (request, run) => (request.depth > 1 ? untilAborted(request.signal) : run()),
    });
    await h.coordinator(slow, { publishReserveMs: 2000 }).runOnce();
    const row = await h.job(job.jobId);
    expect(row.state).toBe('PARTIAL');
    expect(row.warnings).toEqual(expect.arrayContaining([{ code: 'HISTORY_DEADLINE', count: 1 }]));
  }, 60_000);

  it('cancellation that lands before the publication transaction wins: nothing is published', async () => {
    const job = await h.submit(submission(HARBOR, false));
    const scripted = new ScriptedRunners(processRunners(demo.dir), {
      analyze: async (_request, run) => {
        const result = await run();
        await h.admission.cancel(job.jobId, { sessionHash: null, bearer: job.token });
        return result;
      },
    });
    await h.coordinator(scripted).runOnce();
    expect((await h.job(job.jobId)).state).toBe('CANCELLED');
    expect((await h.pool.query('SELECT count(*)::int AS n FROM publications')).rows[0].n).toBe(0);
    expect((await h.pool.query('SELECT count(*)::int AS n FROM artifact_objects')).rows[0].n).toBe(0);
  });

  it('never publishes sandbox output that claims another repository or commit', async () => {
    const job = await h.submit(submission(HARBOR, false));
    const forged = new ScriptedRunners(processRunners(demo.dir), {
      analyze: (request, run) => {
        request.spec.repository = { ...request.spec.repository, numericId: '999' };
        return run();
      },
    });
    await h.coordinator(forged).runOnce();
    expect(await h.job(job.jobId)).toMatchObject({ state: 'FAILED', error: expect.objectContaining({ code: 'ARTIFACT_INVALID' }) });
    expect((await h.pool.query('SELECT count(*)::int AS n FROM publications')).rows[0].n).toBe(0);
  });
});

describe.runIf(!!databaseUrl)('publication lifecycle: access, visibility, expiry, deletion and purge', () => {
  let demo: GitFixture;
  let h: Harness;
  let failGets = false;
  beforeAll(async () => {
    requireBuiltSandbox();
    demo = buildDemoRepository();
    h = await createHarness(
      [{ numericId: '515151', owner: 'atlas-demo', name: 'harbor', defaultBranch: 'main', headOid: demo.commits.at(-1)!, remotePath: demo.dir, visibility: 'public' }],
      {
        store: (root) => {
          // Storage wrapper for outage tests: reads can be failed on demand.
          const inner = new FileObjectStore(root);
          const wrapped: ObjectStore = {
            put: (k, b) => inner.put(k, b),
            get: (k, m) => (failGets ? Promise.reject(new Error('storage down')) : inner.get(k, m)),
            delete: (k) => inner.delete(k),
            list: (p, l) => inner.list(p, l),
            ready: () => inner.ready(),
          };
          return wrapped;
        },
      },
    );
  });
  beforeEach(async () => {
    failGets = false;
    await h.reset();
  });
  afterAll(async () => {
    await h?.close();
    demo?.dispose();
  });
  const publish = async (history = false) => {
    const job = await h.submit(submission(HARBOR, history));
    await h.coordinator(new ScriptedRunners(processRunners(demo.dir))).runOnce();
    const row = await h.job(job.jobId);
    expect(row.state).toBe('READY');
    return { ...job, analysisId: row.analysis_id as string };
  };
  const status = async (work: Promise<unknown>) => work.then(() => 200, (error: unknown) => (error instanceof ServiceError ? `${error.status} ${error.code}` : 'thrown'));

  it('serves only listed chunks with exact lengths and rejects unknown IDs', async () => {
    const a = await publish();
    const manifest = await h.publications.manifest(a.analysisId);
    for (const chunk of manifest.chunks) expect((await h.publications.chunk(a.analysisId, chunkIdOf(chunk.path))).length).toBe(chunk.compressedBytes);
    expect(await status(h.publications.chunk(a.analysisId, `snap_${'0'.repeat(64)}`))).toBe('404 ARTIFACT_NOT_FOUND');
    expect(await status(h.publications.chunk(a.analysisId, '../manifest'))).toBe('404 ARTIFACT_NOT_FOUND');
    expect(await status(h.publications.manifest(`analysis_${'0'.repeat(64)}`))).toBe('404 ARTIFACT_NOT_FOUND');
    expect(await status(h.publications.manifest('not-an-id'))).toBe('404 ARTIFACT_NOT_FOUND');
  });

  it('revalidates visibility after five minutes, revokes private repositories and purges their content', async () => {
    const a = await publish();
    h.resolver.repositories.get('atlas-demo/harbor')!.visibility = 'unavailable';
    // Within the five-minute visibility window the cached answer stands.
    expect(await status(h.publications.manifest(a.analysisId))).toBe(200);
    await h.pool.query("UPDATE repositories SET visibility_checked_at=clock_timestamp()-interval '6 minutes'");
    expect(await status(h.publications.manifest(a.analysisId))).toBe('410 ARTIFACT_REVOKED');
    expect(await status(h.publications.chunk(a.analysisId, 'layout'))).toBe('410 ARTIFACT_REVOKED');
    const purged = await h.publications.purge();
    expect(purged).toMatchObject({ publications: 1, objects: 1 });
    expect(await h.store.list('uploads/')).toEqual([]);
    // Public again later: a new analysis works; the revoked publication stays revoked.
    h.resolver.repositories.get('atlas-demo/harbor')!.visibility = 'public';
    const b = await publish();
    expect(await status(h.publications.manifest(b.analysisId))).toBe(200);
    expect(await status(h.publications.manifest(a.analysisId))).toBe('410 ARTIFACT_REVOKED');
  });

  it('fails closed with 503 when visibility cannot be verified, without revoking', async () => {
    const a = await publish();
    h.resolver.outage = true;
    await h.pool.query("UPDATE repositories SET visibility_checked_at=clock_timestamp()-interval '6 minutes'");
    expect(await status(h.publications.manifest(a.analysisId))).toBe('503 UPSTREAM_UNAVAILABLE');
    expect((await h.pool.query('SELECT revoked_at FROM repositories')).rows[0].revoked_at).toBeNull();
    h.resolver.outage = false;
    expect(await status(h.publications.manifest(a.analysisId))).toBe(200);
  });

  it('expires publications after seven days (simulated clock) and purges unreferenced content', async () => {
    const a = await publish();
    await h.pool.query("UPDATE publications SET expires_at=clock_timestamp()-interval '1 second'");
    expect(await status(h.publications.manifest(a.analysisId))).toBe('410 ARTIFACT_EXPIRED');
    await h.pool.query("UPDATE artifact_objects SET expires_at=clock_timestamp()-interval '1 second'");
    expect(await h.publications.purge()).toMatchObject({ publications: 1, objects: 1 });
    expect(await h.store.list('uploads/')).toEqual([]);
    expect(await status(h.publications.manifest(a.analysisId))).toBe('410 ARTIFACT_EXPIRED');
  });

  it('deletes one publication with its own capability only; shared content survives for the other', async () => {
    const a = await publish();
    const b = await publish();
    expect((await h.pool.query('SELECT count(DISTINCT content_key)::int AS n FROM publications')).rows[0].n).toBe(1);
    const authorize = (token: string) => (jobId: string) => h.admission.authorize(jobId, { sessionHash: null, bearer: token });
    await expect(h.publications.remove(a.analysisId, authorize(b.token))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await h.publications.remove(a.analysisId, authorize(a.token));
    expect(await status(h.publications.manifest(a.analysisId))).toBe('410 ARTIFACT_DELETED');
    await expect(h.publications.remove(a.analysisId, authorize(a.token))).rejects.toMatchObject({ code: 'ARTIFACT_DELETED' });
    expect(await status(h.publications.manifest(b.analysisId))).toBe(200);
    expect((await h.store.list('uploads/')).length).toBeGreaterThan(0);
    // The job remains READY: publication state never resurrects or rewrites the job.
    expect((await h.job(a.jobId)).state).toBe('READY');
  });

  it('reports storage read failures as 503 and reconciles orphaned prefixes', async () => {
    const a = await publish();
    failGets = true;
    expect(await status(h.publications.chunk(a.analysisId, 'layout'))).toBe('503 INTERNAL_ERROR');
    expect(await status(h.publications.manifest(`analysis_${'f'.repeat(64)}`))).toBe('404 ARTIFACT_NOT_FOUND');
    failGets = false;
    const { objectKey, newUploadId } = await import('@atlas/control');
    const orphan = newUploadId();
    await h.store.put(objectKey(orphan, 'manifest.json'), new TextEncoder().encode('{}'));
    expect(await h.publications.reconcileStorage()).toEqual({ scanned: 2, orphans: 1 });
    expect((await h.store.list(`uploads/${orphan}/`))).toEqual([]);
    expect(await status(h.publications.manifest(a.analysisId))).toBe(200);
    await deleteUpload(h.store, orphan);
  });

  it('fails a job whose upload cannot be stored, leaving nothing published', async () => {
    const job = await h.submit(submission(HARBOR, false));
    failGets = true;
    await h.coordinator(new ScriptedRunners(processRunners(demo.dir))).runOnce();
    failGets = false;
    expect(await h.job(job.jobId)).toMatchObject({ state: 'FAILED', analysis_id: null });
    expect((await h.pool.query('SELECT count(*)::int AS n FROM publications')).rows[0].n).toBe(0);
    await h.pool.query("UPDATE uploads SET created_at=clock_timestamp()-interval '2 minutes'");
    await h.publications.collectUploads();
    expect(await h.store.list('uploads/')).toEqual([]);
  });
});
