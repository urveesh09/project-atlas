import { describe, expect, it } from 'vitest';
import { operatorMetricsText, publicationReadResult, type OperatorMetrics } from '@atlas/control';

const busy: OperatorMetrics = {
  queue: { queued: 3, active: 1, cancelRequested: 0, oldestQueuedSeconds: 42, waitSecondsP95_24h: 95 },
  leases: { live: 1, expired: 2 },
  outcomes24h: { READY: 5, FAILED: 1 },
  failures24h: { UPSTREAM_RATE_LIMITED: 1, ANALYSIS_RESOURCE_LIMIT: 2 },
  stageMsP95_24h: { verify: 250, acquireHead: 1500 },
  networkBytesP95_24h: 1048576,
  artifactBytesP95_24h: 20480,
  publications: { live: 4, expired: 1, deleted: 0, revoked: 1, awaitingPurge: 2 },
  storage: { liveObjects: 9, liveBytes: 123456, pendingUploads: 0, purgingUploads: 1 },
  upstream: { blockedSeconds: 30, remaining: 57 },
};

describe('operator metrics as Prometheus text', () => {
  it('writes one documented gauge per field, keyed maps as sorted labels, durations in seconds', () => {
    expect(operatorMetricsText(busy)).toBe(`# HELP atlas_queue_queued Jobs waiting for a worker.
# TYPE atlas_queue_queued gauge
atlas_queue_queued 3
# HELP atlas_queue_active Jobs a worker is acquiring, analyzing or publishing.
# TYPE atlas_queue_active gauge
atlas_queue_active 1
# HELP atlas_queue_cancel_requested Jobs whose cancellation is in progress.
# TYPE atlas_queue_cancel_requested gauge
atlas_queue_cancel_requested 0
# HELP atlas_queue_oldest_queued_seconds Age of the oldest queued job; absent when none is queued.
# TYPE atlas_queue_oldest_queued_seconds gauge
atlas_queue_oldest_queued_seconds 42
# HELP atlas_queue_wait_p95_24h_seconds p95 queue wait of jobs that reached a worker in the last 24 hours; absent when none did.
# TYPE atlas_queue_wait_p95_24h_seconds gauge
atlas_queue_wait_p95_24h_seconds 95
# HELP atlas_leases_live Worker leases that are still valid.
# TYPE atlas_leases_live gauge
atlas_leases_live 1
# HELP atlas_leases_expired Worker leases past expiry that the reaper has not fenced yet.
# TYPE atlas_leases_expired gauge
atlas_leases_expired 2
# HELP atlas_outcomes_24h Jobs that reached each terminal state in the last 24 hours.
# TYPE atlas_outcomes_24h gauge
atlas_outcomes_24h{state="CANCELLED"} 0
atlas_outcomes_24h{state="FAILED"} 1
atlas_outcomes_24h{state="PARTIAL"} 0
atlas_outcomes_24h{state="READY"} 5
# HELP atlas_failures_24h Failed jobs by error code in the last 24 hours.
# TYPE atlas_failures_24h gauge
atlas_failures_24h{code="ANALYSIS_RESOURCE_LIMIT"} 2
atlas_failures_24h{code="UPSTREAM_RATE_LIMITED"} 1
# HELP atlas_stage_p95_24h_seconds Per-stage p95 duration over jobs updated in the last 24 hours.
# TYPE atlas_stage_p95_24h_seconds gauge
atlas_stage_p95_24h_seconds{stage="acquireHead"} 1.5
atlas_stage_p95_24h_seconds{stage="verify"} 0.25
# HELP atlas_network_p95_24h_bytes p95 network bytes per job in the last 24 hours.
# TYPE atlas_network_p95_24h_bytes gauge
atlas_network_p95_24h_bytes 1048576
# HELP atlas_artifact_p95_24h_bytes p95 compressed artifact bytes per job in the last 24 hours.
# TYPE atlas_artifact_p95_24h_bytes gauge
atlas_artifact_p95_24h_bytes 20480
# HELP atlas_publications_live Publications that can be viewed.
# TYPE atlas_publications_live gauge
atlas_publications_live 4
# HELP atlas_publications_expired Publications past their expiry.
# TYPE atlas_publications_expired gauge
atlas_publications_expired 1
# HELP atlas_publications_deleted Publications deleted by their owner.
# TYPE atlas_publications_deleted gauge
atlas_publications_deleted 0
# HELP atlas_publications_revoked Publications revoked by visibility checks or an operator.
# TYPE atlas_publications_revoked gauge
atlas_publications_revoked 1
# HELP atlas_publications_awaiting_purge Ended publications whose storage is not purged yet.
# TYPE atlas_publications_awaiting_purge gauge
atlas_publications_awaiting_purge 2
# HELP atlas_storage_live_objects Stored artifact objects not purged.
# TYPE atlas_storage_live_objects gauge
atlas_storage_live_objects 9
# HELP atlas_storage_live_bytes Compressed bytes of stored artifact objects not purged.
# TYPE atlas_storage_live_bytes gauge
atlas_storage_live_bytes 123456
# HELP atlas_storage_pending_uploads Uploads in progress.
# TYPE atlas_storage_pending_uploads gauge
atlas_storage_pending_uploads 0
# HELP atlas_storage_purging_uploads Uploads whose storage deletion has not finished.
# TYPE atlas_storage_purging_uploads gauge
atlas_storage_purging_uploads 1
# HELP atlas_upstream_blocked_seconds Remaining shared GitHub API back-off; absent before the first GitHub call.
# TYPE atlas_upstream_blocked_seconds gauge
atlas_upstream_blocked_seconds 30
# HELP atlas_upstream_remaining GitHub API requests remaining in the current window, when known.
# TYPE atlas_upstream_remaining gauge
atlas_upstream_remaining 57
`);
  });

  it('omits unknown fields instead of reporting them as zero', () => {
    const idle: OperatorMetrics = {
      ...busy,
      queue: { ...busy.queue, oldestQueuedSeconds: null, waitSecondsP95_24h: null },
      failures24h: {},
      stageMsP95_24h: {},
      networkBytesP95_24h: null,
      artifactBytesP95_24h: null,
      upstream: { blockedSeconds: null, remaining: null },
    };
    const text = operatorMetricsText(idle);
    for (const name of ['atlas_queue_oldest_queued_seconds', 'atlas_queue_wait_p95_24h_seconds', 'atlas_publication_reads_total', 'atlas_failures_24h', 'atlas_stage_p95_24h_seconds', 'atlas_network_p95_24h_bytes',
      'atlas_artifact_p95_24h_bytes', 'atlas_upstream_blocked_seconds', 'atlas_upstream_remaining']) {
      expect(text).not.toContain(name);
    }
    // Terminal states are always present, so a dashboard shows 0 rather than no data.
    expect(text).toContain('atlas_outcomes_24h{state="READY"} 5');
    expect(text).toContain('atlas_outcomes_24h{state="PARTIAL"} 0');
  });

  it('writes publication reads as a counter with every result, when the API supplies them', () => {
    expect(operatorMetricsText(busy, { ok: 40, ended: 2, rejected: 0, unavailable: 1 })).toContain(`
# HELP atlas_publication_reads_total Publication manifest and chunk reads this API process answered since it started, by result.
# TYPE atlas_publication_reads_total counter
atlas_publication_reads_total{result="ended"} 2
atlas_publication_reads_total{result="ok"} 40
atlas_publication_reads_total{result="rejected"} 0
atlas_publication_reads_total{result="unavailable"} 1
`);
  });

  it('classifies publication read statuses for availability', () => {
    expect([200, 304, 404, 410, 400, 403, 429, 500, 503].map(publicationReadResult))
      .toEqual(['ok', 'ok', 'ended', 'ended', 'rejected', 'rejected', 'rejected', 'unavailable', 'unavailable']);
  });

  it('escapes label values', () => {
    const text = operatorMetricsText({ ...busy, failures24h: { 'a"b\\c\nd': 1 } });
    expect(text).toContain('atlas_failures_24h{code="a\\"b\\\\c\\nd"} 1');
  });
});
