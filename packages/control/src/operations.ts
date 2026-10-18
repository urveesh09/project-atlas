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

/** Prometheus text exposition format 0.0.4, which every Prometheus release accepts. */
export const PROMETHEUS_TEXT_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

const TERMINAL_STATES = ['READY', 'PARTIAL', 'FAILED', 'CANCELLED'] as const;
type Sample = readonly [labels: Readonly<Record<string, string>> | null, value: number | null];

/**
 * The same fields as {@link operatorMetrics}, for Prometheus (M4.2, ADR-073). Each field is
 * one gauge named `atlas_` plus its JSON path in snake case, with the unit last; keyed maps
 * become labels. Stage durations are converted to seconds, Prometheus's base unit. A null
 * field is omitted rather than reported as 0, so "unknown" never reads as "healthy".
 */
export function operatorMetricsText(m: OperatorMetrics): string {
  const lines: string[] = [];
  const family = (name: string, help: string, samples: readonly Sample[]) => {
    const present = samples.filter((sample): sample is readonly [Sample[0], number] => sample[1] !== null);
    if (present.length === 0) return;
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const [labels, value] of present) lines.push(`${name}${labelText(labels)} ${value}`);
  };
  const one = (name: string, help: string, value: number | null) => family(name, help, [[null, value]]);
  const keyed = (name: string, help: string, label: string, entries: [string, number][]) =>
    family(name, help, entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, value]) => [{ [label]: key }, value]));

  one('atlas_queue_queued', 'Jobs waiting for a worker.', m.queue.queued);
  one('atlas_queue_active', 'Jobs a worker is acquiring, analyzing or publishing.', m.queue.active);
  one('atlas_queue_cancel_requested', 'Jobs whose cancellation is in progress.', m.queue.cancelRequested);
  one('atlas_queue_oldest_queued_seconds', 'Age of the oldest queued job; absent when none is queued.', m.queue.oldestQueuedSeconds);
  one('atlas_leases_live', 'Worker leases that are still valid.', m.leases.live);
  one('atlas_leases_expired', 'Worker leases past expiry that the reaper has not fenced yet.', m.leases.expired);
  keyed('atlas_outcomes_24h', 'Jobs that reached each terminal state in the last 24 hours.', 'state',
    TERMINAL_STATES.map((state) => [state, m.outcomes24h[state] ?? 0]));
  keyed('atlas_failures_24h', 'Failed jobs by error code in the last 24 hours.', 'code', Object.entries(m.failures24h));
  keyed('atlas_stage_p95_24h_seconds', 'Per-stage p95 duration over jobs updated in the last 24 hours.', 'stage',
    Object.entries(m.stageMsP95_24h).map(([stage, ms]) => [stage, ms / 1000]));
  one('atlas_network_p95_24h_bytes', 'p95 network bytes per job in the last 24 hours.', m.networkBytesP95_24h);
  one('atlas_artifact_p95_24h_bytes', 'p95 compressed artifact bytes per job in the last 24 hours.', m.artifactBytesP95_24h);
  one('atlas_publications_live', 'Publications that can be viewed.', m.publications.live);
  one('atlas_publications_expired', 'Publications past their expiry.', m.publications.expired);
  one('atlas_publications_deleted', 'Publications deleted by their owner.', m.publications.deleted);
  one('atlas_publications_revoked', 'Publications revoked by visibility checks or an operator.', m.publications.revoked);
  one('atlas_publications_awaiting_purge', 'Ended publications whose storage is not purged yet.', m.publications.awaitingPurge);
  one('atlas_storage_live_objects', 'Stored artifact objects not purged.', m.storage.liveObjects);
  one('atlas_storage_live_bytes', 'Compressed bytes of stored artifact objects not purged.', m.storage.liveBytes);
  one('atlas_storage_pending_uploads', 'Uploads in progress.', m.storage.pendingUploads);
  one('atlas_storage_purging_uploads', 'Uploads whose storage deletion has not finished.', m.storage.purgingUploads);
  one('atlas_upstream_blocked_seconds', 'Remaining shared GitHub API back-off; absent before the first GitHub call.', m.upstream.blockedSeconds);
  one('atlas_upstream_remaining', 'GitHub API requests remaining in the current window, when known.', m.upstream.remaining === null ? null : Number(m.upstream.remaining));
  return `${lines.join('\n')}\n`;
}

function labelText(labels: Readonly<Record<string, string>> | null): string {
  if (!labels) return '';
  const escape = (value: string) => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
  return `{${Object.entries(labels).map(([key, value]) => `${key}="${escape(value)}"`).join(',')}}`;
}
