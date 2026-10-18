import { request } from 'node:http';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prefersPrometheusText, ServiceError, startApi, startOperatorServer, type AdmissionStore } from '@atlas/api';
import type { PublicationStore } from '@atlas/control';

// The header Prometheus 3 sends with its default scrape protocols.
const PROMETHEUS_ACCEPT = 'application/openmetrics-text;version=1.0.0;q=0.5,application/openmetrics-text;version=0.0.1;q=0.4,'
  + 'text/plain;version=1.0.0;escaping=allow-utf-8;q=0.3,text/plain;version=0.0.4;q=0.2,*/*;q=0.1';

describe('operator metrics negotiation', () => {
  it('chooses Prometheus text only when text/plain outranks JSON', () => {
    expect(prefersPrometheusText(PROMETHEUS_ACCEPT)).toBe(true);
    expect(prefersPrometheusText('text/plain')).toBe(true);
    expect(prefersPrometheusText('text/plain;version=0.0.4')).toBe(true);
    for (const accept of [undefined, '', '*/*', 'application/json', 'text/html,application/xhtml+xml,*/*;q=0.8',
      'text/plain;q=0.5,application/json', 'text/plain, application/json', 'text/plain;q=0', 'text/plain;q=abc']) {
      expect(prefersPrometheusText(accept), String(accept)).toBe(false);
    }
  });
});

/** Answers each operatorMetrics query by its distinctive SQL, without a database. */
const pool = {
  query: async (sql: string) => {
    if (sql.includes('AS cancel_requested')) return { rows: [{ queued: '2', active: '1', cancel_requested: '0', oldest: 61.6, live: '1', expired: '0' }] };
    if (sql.includes('GROUP BY state')) return { rows: [{ state: 'READY', count: '3' }] };
    if (sql.includes('AS network')) return { rows: [{ network: null, artifact: null }] };
    if (sql.includes('FROM publications')) return { rows: [{ live: '1', expired: '0', deleted: '0', revoked: '0', awaiting: '0' }] };
    if (sql.includes('artifact_objects')) return { rows: [{ live_objects: '4', live_bytes: '2048', pending: '0', purging: '0' }] };
    return { rows: [] };
  },
} as unknown as Pool;

describe('publication read counting', () => {
  const id = (n: number) => `analysis_${String(n).repeat(64)}`;
  // Stub reads that end in each designed way: served, ended, rejected, failed.
  const publications = {
    manifest: async (analysisId: string) => {
      if (analysisId === id(1)) throw new ServiceError('ARTIFACT_EXPIRED', 410, 'Expired.');
      if (analysisId === id(2)) throw new Error('storage failed');
      return { analysisId };
    },
    chunk: async (_analysisId: string, name: string) => {
      if (name === 'refused') throw new ServiceError('VALIDATION_FAILED', 400, 'Refused.');
      return new Uint8Array([1, 2, 3]);
    },
  } as unknown as PublicationStore;
  let api: Awaited<ReturnType<typeof startApi>>;
  beforeAll(async () => {
    // Routes other than publication reads look up the session first.
    api = await startApi({ store: { session: async () => null } as unknown as AdmissionStore, quotaSecret: 'q'.repeat(32), developmentLoopback: true, publications });
  });
  afterAll(() => api.close());
  const call = (method: string, path: string) => new Promise<number>((resolve, reject) => {
    request(`${api.origin}${path}`, { method }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); }).on('error', reject).end();
  });

  it('counts manifest and chunk reads by final status, and no other request', async () => {
    expect(await call('GET', `/api/v1/analyses/${id(0)}`)).toBe(200);
    expect(await call('GET', `/api/v1/analyses/${id(0)}/chunks/summary`)).toBe(200);
    expect(await call('GET', `/api/v1/analyses/${id(1)}`)).toBe(410);
    expect(await call('GET', `/api/v1/analyses/${id(0)}/chunks/refused`)).toBe(400);
    expect(await call('GET', `/api/v1/analyses/${id(2)}`)).toBe(503);
    // Not publication reads: an unknown route and the public health check.
    expect(await call('GET', '/api/v1/analyses/not-an-id')).toBe(404);
    expect(await call('GET', '/api/v1/health/live')).toBe(200);
    await expect.poll(() => ({ ...api.publicationReads })).toEqual({ ok: 2, ended: 1, rejected: 1, unavailable: 1 });

    const operator = await startOperatorServer({ pool, publicationReads: api.publicationReads });
    try {
      const get = (accept?: string) => new Promise<string>((resolve, reject) => {
        request({ host: '127.0.0.1', port: operator.port, path: '/metrics', headers: accept ? { Accept: accept } : {} }, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => resolve(body));
        }).on('error', reject).end();
      });
      expect(await get(PROMETHEUS_ACCEPT)).toContain('\natlas_publication_reads_total{result="ok"} 2\natlas_publication_reads_total{result="rejected"} 1\natlas_publication_reads_total{result="unavailable"} 1\n');
      expect(JSON.parse(await get())).toMatchObject({ publicationReads: { ok: 2, ended: 1, rejected: 1, unavailable: 1 } });
    } finally {
      await operator.close();
    }
  });
});

describe('operator listener', () => {
  let operator: Awaited<ReturnType<typeof startOperatorServer>>;
  beforeAll(async () => {
    operator = await startOperatorServer({ pool });
  });
  afterAll(() => operator.close());
  const get = (path: string, accept?: string) => new Promise<{ status: number; type: string; vary: string; body: string }>((resolve, reject) => {
    request({ host: '127.0.0.1', port: operator.port, path, headers: accept ? { Accept: accept } : {} }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), vary: String(res.headers['vary']), body }));
    }).on('error', reject).end();
  });

  it('listens on loopback only', () => {
    expect(operator.address).toBe('127.0.0.1');
  });

  it('serves Prometheus text to Prometheus and keeps JSON as the default', async () => {
    const text = await get('/metrics', PROMETHEUS_ACCEPT);
    expect(text.status).toBe(200);
    expect(text.type).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(text.vary).toBe('Accept');
    expect(text.body).toContain('\natlas_queue_queued 2\n');
    expect(text.body).toContain('\natlas_queue_oldest_queued_seconds 62\n');
    expect(text.body).toContain('\natlas_outcomes_24h{state="READY"} 3\n');
    expect(text.body).not.toContain('atlas_upstream_blocked_seconds');

    const json = await get('/metrics');
    expect(json.status).toBe(200);
    expect(json.type).toBe('application/json; charset=utf-8');
    expect(JSON.parse(json.body)).toMatchObject({ queue: { queued: 2, oldestQueuedSeconds: 62 }, outcomes24h: { READY: 3 }, upstream: { blockedSeconds: null } });
  });
});
