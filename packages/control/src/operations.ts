import type { Pool } from 'pg';

/**
 * Operator metrics (plan §15.4): queue depth, leases, outcomes, stage durations, bytes
 * fetched, artifact sizes, upstream throttling and storage/purge state. Aggregates only;
 * no repository names, paths, tokens or source text.
 */
export interface OperatorMetrics {
  queue: { queued: number; active: number; cancelRequested: number; oldestQueuedSeconds: number | null };
  leases: { live: number; expired: number };
  outcomes24h: Record<string, number>;
  failures24h: Record<string, number>;
  stageMsP95_24h: Record<string, number>;
  networkBytesP95_24h: number | null;
  artifactBytesP95_24h: number | null;
  publications: { live: number; expired: number; deleted: number; revoked: number; awaitingPurge: number };
  storage: { liveObjects: number; liveBytes: number; pendingUploads: number; purgingUploads: number };
  upstream: { blockedSeconds: number | null; remaining: number | null };
}

export async function operatorMetrics(pool: Pool): Promise<OperatorMetrics> {
  const n = (v: unknown) => Number(v ?? 0);
  const queue = (await pool.query(`SELECT count(*) FILTER (WHERE state='QUEUED') AS queued,
      count(*) FILTER (WHERE state IN ('ACQUIRING','ANALYZING','HISTORY','LAYOUT','VALIDATING')) AS active,
      count(*) FILTER (WHERE state='CANCEL_REQUESTED') AS cancel_requested,
      extract(epoch FROM clock_timestamp()-min(created_at) FILTER (WHERE state='QUEUED'))::float8 AS oldest,
      count(*) FILTER (WHERE lease_owner IS NOT NULL AND lease_expires_at>clock_timestamp()) AS live,
      count(*) FILTER (WHERE lease_owner IS NOT NULL AND lease_expires_at<=clock_timestamp()) AS expired
    FROM jobs`)).rows[0]!;
  const outcomes = (await pool.query<{ state: string; count: string }>(`SELECT state,count(*) FROM jobs WHERE updated_at>clock_timestamp()-interval '24 hours'
    AND state IN ('READY','PARTIAL','FAILED','CANCELLED') GROUP BY state`)).rows;
  const failures = (await pool.query<{ code: string; count: string }>(`SELECT error->>'code' AS code,count(*) FROM jobs WHERE state='FAILED'
    AND updated_at>clock_timestamp()-interval '24 hours' GROUP BY 1`)).rows;
  const stages = (await pool.query<{ stage: string; p95: number }>(`SELECT key AS stage,percentile_cont(0.95) WITHIN GROUP (ORDER BY value::text::float8) AS p95
    FROM jobs,jsonb_each(metrics->'stageMs') WHERE updated_at>clock_timestamp()-interval '24 hours' GROUP BY key`)).rows;
  const sizes = (await pool.query(`SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY (metrics->>'networkBytes')::float8) AS network,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY (metrics->>'artifactBytes')::float8) AS artifact
    FROM jobs WHERE updated_at>clock_timestamp()-interval '24 hours'`)).rows[0]!;
  const publications = (await pool.query(`SELECT
      count(*) FILTER (WHERE purged_at IS NULL AND deleted_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp()) AS live,
      count(*) FILTER (WHERE expires_at<=clock_timestamp()) AS expired,
      count(*) FILTER (WHERE deleted_at IS NOT NULL) AS deleted,
      count(*) FILTER (WHERE revoked_at IS NOT NULL) AS revoked,
      count(*) FILTER (WHERE purged_at IS NULL AND (deleted_at IS NOT NULL OR revoked_at IS NOT NULL OR expires_at<=clock_timestamp())) AS awaiting
    FROM publications`)).rows[0]!;
  const storage = (await pool.query(`SELECT
      (SELECT count(*) FROM artifact_objects WHERE purged_at IS NULL) AS live_objects,
      (SELECT coalesce(sum(compressed_bytes),0) FROM artifact_objects WHERE purged_at IS NULL) AS live_bytes,
      (SELECT count(*) FROM uploads WHERE state='pending') AS pending,
      (SELECT count(*) FROM uploads WHERE state='purging') AS purging`)).rows[0]!;
  const upstream = (await pool.query(`SELECT greatest(extract(epoch FROM blocked_until-clock_timestamp()),0)::float8 AS blocked,remaining FROM upstream_budgets WHERE name='github-api'`)).rows[0];
  return {
    queue: { queued: n(queue['queued']), active: n(queue['active']), cancelRequested: n(queue['cancel_requested']), oldestQueuedSeconds: queue['oldest'] === null ? null : Math.round(n(queue['oldest'])) },
    leases: { live: n(queue['live']), expired: n(queue['expired']) },
    outcomes24h: Object.fromEntries(outcomes.map((r) => [r.state, n(r.count)])),
    failures24h: Object.fromEntries(failures.map((r) => [r.code ?? 'UNKNOWN', n(r.count)])),
    stageMsP95_24h: Object.fromEntries(stages.map((r) => [r.stage, Math.round(n(r.p95))])),
    networkBytesP95_24h: sizes['network'] === null ? null : Math.round(n(sizes['network'])),
    artifactBytesP95_24h: sizes['artifact'] === null ? null : Math.round(n(sizes['artifact'])),
    publications: { live: n(publications['live']), expired: n(publications['expired']), deleted: n(publications['deleted']), revoked: n(publications['revoked']), awaitingPurge: n(publications['awaiting']) },
    storage: { liveObjects: n(storage['live_objects']), liveBytes: n(storage['live_bytes']), pendingUploads: n(storage['pending']), purgingUploads: n(storage['purging']) },
    upstream: { blockedSeconds: upstream ? Math.round(n(upstream['blocked'])) : null, remaining: upstream?.['remaining'] ?? null },
  };
}
