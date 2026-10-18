import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { operatorMetricsText } from '@atlas/control';

const read = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
const alerts = read('deploy/production/alerts.yml');
const prometheus = read('deploy/production/prometheus.yml');
const dashboard = JSON.parse(read('deploy/production/grafana-dashboard.json')) as { panels: { targets: { expr: string }[] }[] };
const runbook = read('docs/hosted-operations.md');
const slo = read('deploy/production/slo.yml');
const objectives = read('docs/hosted-slo.md');
const compose = read('deploy/production/compose.yaml');

// Every field present, so every family is written.
const emitted = new Set([...operatorMetricsText({
  queue: { queued: 1, active: 1, cancelRequested: 1, oldestQueuedSeconds: 1, waitSecondsP95_24h: 1 },
  leases: { live: 1, expired: 1 },
  outcomes24h: { READY: 1 },
  failures24h: { UPSTREAM_UNAVAILABLE: 1 },
  stageMsP95_24h: { verify: 1 },
  networkBytesP95_24h: 1,
  artifactBytesP95_24h: 1,
  publications: { live: 1, expired: 1, deleted: 1, revoked: 1, awaitingPurge: 1 },
  storage: { liveObjects: 1, liveBytes: 1, pendingUploads: 1, purgingUploads: 1 },
  upstream: { blockedSeconds: 1, remaining: 1 },
}, { ok: 1, ended: 1, rejected: 1, unavailable: 1 }).matchAll(/^# TYPE (\S+) (?:gauge|counter)$/gm)].map((match) => match[1]!));
const names = (text: string) => new Set(text.match(/\batlas_[a-z0-9_]+/g) ?? []);
const slug = (heading: string) => heading.trim().toLowerCase().replace(/[^a-z0-9 -]/g, '').replaceAll(' ', '-');

describe('monitoring configuration', () => {
  it('alerts on metrics the listener actually writes, for the job Prometheus scrapes', () => {
    const exprs = [...alerts.matchAll(/^\s+expr: (.+)$/gm)].map((match) => match[1]!);
    expect(exprs).toHaveLength(5);
    for (const name of names(exprs.join('\n'))) expect(emitted, name).toContain(name);
    const job = /job_name: (\S+)/.exec(prometheus)?.[1];
    expect(job).toBe('atlas-operator');
    expect(alerts).toContain(`up{job="${job}"}`);
    expect(prometheus).toContain("targets: ['127.0.0.1:9090']");
  });

  it("covers the runbook's four alerts and links runbook sections that exist", () => {
    for (const expr of ['atlas_leases_expired > 0', 'atlas_queue_oldest_queued_seconds > 600', 'atlas_storage_purging_uploads > 0', 'atlas_upstream_blocked_seconds > 0']) {
      expect(alerts).toContain(`expr: ${expr}`);
    }
    const anchors = new Set([...runbook.matchAll(/^#{2,4} (.+)$/gm)].map((match) => slug(match[1]!)));
    const links = [...alerts.matchAll(/runbook: docs\/hosted-operations\.md#(\S+)/g)].map((match) => match[1]!);
    expect(links).toHaveLength(5);
    for (const anchor of links) expect(anchors, anchor).toContain(anchor);
  });

  it('charts every metric, and only metrics that exist', () => {
    const charted = names(dashboard.panels.flatMap((panel) => panel.targets.map((target) => target.expr)).join('\n'));
    expect([...charted].sort()).toEqual([...emitted].sort());
  });

  it('documents every metric name in the runbook', () => {
    for (const name of emitted) expect(runbook, name).toMatch(new RegExp(`\`${name}[\`{]`));
  });

  it('builds the service levels only from written metrics and recorded series', () => {
    expect(prometheus).toContain('/etc/prometheus/slo.yml');
    expect(compose).toContain('./slo.yml:/etc/prometheus/slo.yml:ro');
    for (const name of names(slo)) expect(emitted, name).toContain(name);
    const recorded = new Set([...slo.matchAll(/^\s+- record: (\S+)$/gm)].map((match) => match[1]!));
    const used = (text: string) => new Set(text.match(/\batlas:[a-z0-9_:]+/g) ?? []);
    const dashboardText = JSON.stringify(dashboard);
    expect(used(dashboardText).size).toBeGreaterThan(0);
    for (const name of [...used(slo), ...used(dashboardText)]) expect(recorded, name).toContain(name);
  });

  it('states the same objectives as the rules, and links sections that exist', () => {
    for (const [doc, rule] of [['99.5%', '0.005'], ['98%', '< 0.98'], ['10 minutes', '> 600']] as const) {
      expect(objectives, doc).toContain(doc);
      expect(slo, rule).toContain(rule);
    }
    const anchors = new Set([...objectives.matchAll(/^#{2,4} (.+)$/gm)].map((match) => slug(match[1]!)));
    const links = [...slo.matchAll(/runbook: docs\/hosted-slo\.md#(\S+)/g)].map((match) => match[1]!);
    expect(links).toHaveLength(4);
    for (const anchor of links) expect(anchors, anchor).toContain(anchor);
  });
});
