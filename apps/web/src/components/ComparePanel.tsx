import type { ComparedMetric, MetricDelta } from '@atlas/graph';
import { useViewer } from '../app/context';
import { ROLE_LABEL, formatDate, formatNumber, shortOid } from '../app/model';
import { Chip, Paged, Section } from './ui';

/**
 * A -> B comparison of two analyzed snapshots (plan §7.4, §3.3 "Compare"). Graph
 * differences (what is different between the two snapshots) and mainline activity (which
 * commits happened in between) are shown separately: they answer different questions.
 */
const METRIC_LABEL: Record<ComparedMetric, string> = {
  codeLines: 'Code lines',
  physicalLines: 'Physical lines',
  maxCyclomatic: 'Max complexity',
  sumCyclomatic: 'Total complexity',
  fanIn: 'Direct consumers',
  fanOut: 'Direct dependencies',
  changedCommits: 'Changed commits',
  linesAdded: 'Lines added',
  linesDeleted: 'Lines deleted',
  hotspotScore: 'Hotspot score',
};

function deltaText(d: MetricDelta): string {
  if (d.delta === null) return d.unavailable === 'from' ? 'unavailable in A' : d.unavailable === 'to' ? 'unavailable in B' : 'unavailable';
  return d.delta > 0 ? `+${d.delta.toLocaleString('en-US')}` : d.delta.toLocaleString('en-US');
}

export function ComparePanel() {
  const { dataset, model, state, setCompare, comparison, goToFrame, select } = useViewer();
  if (!state.compare) return null;
  const { a, b } = state.compare;
  const frames = dataset.frames;
  const fa = frames[a]!;
  const fb = frames[b]!;
  const activity = dataset.commitsBetween(a, b);
  const result = comparison && comparison.a === a && comparison.b === b ? comparison.result : null;
  const error = comparison && comparison.a === a && comparison.b === b ? comparison.error : null;
  const backwards = b < a;
  const pick = (next: { a: number; b: number }) => {
    if (next.a !== next.b) void setCompare(next);
  };
  const selectInB = (lineageId: string) => {
    const file = model.fileByLineage.get(lineageId);
    if (file) select(file.id, { focusInspector: true });
  };

  return (
    <section className="compare" aria-labelledby="compare-title">
      <div className="compare-head">
        <h2 id="compare-title">Compare snapshots</h2>
        <button type="button" className="button ghost" onClick={() => void setCompare(null)}>
          Close comparison
        </button>
      </div>
      <div className="compare-pick">
        <label>
          From (A)
          <select value={a} onChange={(e) => pick({ a: Number(e.target.value), b })}>
            {frames.map((f, i) => (
              <option key={f.snapshotId} value={i} disabled={i === b}>
                {i + 1}. {formatDate(f.commit.committerTime)} · {shortOid(f.commit.oid)}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="button" aria-label="Swap A and B" onClick={() => pick({ a: b, b: a })}>
          ⇄ Swap
        </button>
        <label>
          To (B)
          <select value={b} onChange={(e) => pick({ a, b: Number(e.target.value) })}>
            {frames.map((f, i) => (
              <option key={f.snapshotId} value={i} disabled={i === a}>
                {i + 1}. {formatDate(f.commit.committerTime)} · {shortOid(f.commit.oid)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="compare-direction">
        <strong>A → B</strong>: what differs going from snapshot {a + 1} ({formatDate(fa.commit.committerTime)}) to snapshot {b + 1} ({formatDate(fb.commit.committerTime)})
        {backwards ? ' (B is older, so this reads backwards in time)' : ''}. The city shows B on the same fixed plots: outlined ghosts mark files deleted since A and raised
        diamonds mark files added.
      </p>
      {error && (
        <p className="compare-error" role="alert">
          The comparison could not be computed ({error}). Both snapshots remain viewable on their own.
        </p>
      )}
      {!result && !error && (
        <p className="compare-loading" role="status">
          Comparing snapshots…
        </p>
      )}
      {result && (
        <>
          <ul className="compare-summary" aria-label="Comparison summary">
            <li>
              <Chip tone="accent">+ {result.added.length} added</Chip>
            </li>
            <li>
              <Chip tone="warn">− {result.deleted.length} deleted</Chip>
            </li>
            <li>
              <Chip>↪ {result.renamed.length} renamed</Chip>
            </li>
            <li>
              <Chip>✎ {result.modified.length} content changed</Chip>
            </li>
            <li>
              <Chip>{result.moved.length} moved folders</Chip>
            </li>
            <li>
              <Chip>
                dependencies +{result.edgesAdded.length} / −{result.edgesRemoved.length}
              </Chip>
            </li>
            <li>
              <Chip tone="muted">{result.unchangedFiles} unchanged</Chip>
            </li>
          </ul>
          <Section title="Added in B" count={result.added.length}>
            <Paged
              items={result.added}
              pageSize={20}
              empty="No files were added."
              render={(f) => (
                <li key={f.lineageId} className="row">
                  <button type="button" className="link row-main" onClick={() => selectInB(f.lineageId)}>
                    {f.path}
                  </button>
                  <span className="row-meta">{ROLE_LABEL[f.role]}</span>
                </li>
              )}
            />
          </Section>
          <Section title="Deleted since A" count={result.deleted.length} description="These files exist in A only. Open A to inspect them where they were.">
            <Paged
              items={result.deleted}
              pageSize={20}
              empty="No files were deleted."
              render={(f) => (
                <li key={f.lineageId} className="row">
                  <span className="row-main">{f.path}</span>
                  <button type="button" className="link row-meta" onClick={() => void goToFrame(a, { lineage: f.lineageId })}>
                    show in A
                  </button>
                </li>
              )}
            />
          </Section>
          <Section title="Renamed or moved" count={result.renamed.length + result.moved.filter((m) => !result.renamed.some((r) => r.lineageId === m.lineageId)).length}>
            <Paged
              items={[
                ...result.renamed.map((r) => ({ key: r.lineageId, text: `${r.fromPath} → ${r.toPath}`, lineageId: r.lineageId, meta: 'renamed (same lineage, same plot)' })),
                ...result.moved
                  .filter((m) => !result.renamed.some((r) => r.lineageId === m.lineageId))
                  .map((m) => ({ key: `${m.lineageId}:moved`, text: m.path, lineageId: m.lineageId, meta: `container ${m.fromParent || 'repository root'} → ${m.toParent || 'repository root'}` })),
              ]}
              pageSize={20}
              empty="No renames or moves."
              render={(r) => (
                <li key={r.key} className="row">
                  <button type="button" className="link row-main" onClick={() => selectInB(r.lineageId)}>
                    {r.text}
                  </button>
                  <span className="row-meta">{r.meta}</span>
                </li>
              )}
            />
          </Section>
          <Section title="Content changed" count={result.modified.length} description="Different committed content (blob) for the same lineage. A file can change and change back; that is mainline activity, not a difference.">
            <Paged
              items={result.modified}
              pageSize={20}
              empty="No content differences."
              render={(m) => (
                <li key={m.lineageId} className="row">
                  <button type="button" className="link row-main" onClick={() => selectInB(m.lineageId)}>
                    {m.path}
                  </button>
                  <span className="row-meta">
                    <code>{m.fromBlobOid.slice(0, 7)}</code> → <code>{m.toBlobOid.slice(0, 7)}</code>
                  </span>
                </li>
              )}
            />
            {result.roleChanged.length > 0 && (
              <p className="note">
                Role changes: {result.roleChanged.map((r) => `${r.path} (${ROLE_LABEL[r.from]} → ${ROLE_LABEL[r.to]})`).join('; ')}.
              </p>
            )}
          </Section>
          <Section title="Metric changes" count={result.metricChanges.length} description="Raw values in A and B. An unavailable value stays unavailable: no delta is invented.">
            {result.metricChanges.length === 0 ? (
              <p className="empty">No metric differences for files present in both snapshots.</p>
            ) : (
              <MetricTable rows={result.metricChanges} onSelect={selectInB} />
            )}
          </Section>
          <Section title="Dependency changes" count={result.edgesAdded.length + result.edgesRemoved.length} description="Static file relationships projected onto lineages and package names.">
            <Paged
              items={[...result.edgesAdded.map((e) => ({ e, sign: '+' as const })), ...result.edgesRemoved.map((e) => ({ e, sign: '−' as const }))]}
              pageSize={20}
              empty="No dependency differences."
              render={({ e, sign }) => (
                <li key={`${sign}${e.sourceLineageId}${e.target}${e.kind}`} className="row">
                  <span className="row-main">
                    <span className={sign === '+' ? 'delta-up' : 'delta-down'}>{sign === '+' ? 'added' : 'removed'}</span> {e.sourcePath} → {e.targetLabel}
                  </span>
                  <span className="row-meta">{e.kind}</span>
                </li>
              )}
            />
          </Section>
        </>
      )}
      <Section
        title="Mainline activity in this interval"
        count={activity.length}
        description="Every first-parent commit after the older snapshot up to the newer one, including commits that were not sampled as snapshots."
      >
        <Paged
          items={activity}
          pageSize={15}
          empty="No commits between these snapshots."
          render={(c) => {
            const lines = c.changes.reduce((sum, ch) => sum + (ch.added ?? 0) + (ch.deleted ?? 0), 0);
            return (
              <li key={c.oid} className="row">
                <span className="row-main">
                  <code>{shortOid(c.oid)}</code> {formatDate(c.committerTime)}
                </span>
                <span className="row-meta">
                  {c.changesAvailability === 'unavailable' ? 'changes unknown' : `${c.changes.length} file change${c.changes.length === 1 ? '' : 's'} · ${formatNumber(lines)} lines`}
                  {c.changesAvailability === 'partial' ? ' · partial' : ''}
                </span>
              </li>
            );
          }}
        />
      </Section>
    </section>
  );
}

function MetricTable({ rows, onSelect }: { rows: { lineageId: string; path: string; deltas: MetricDelta[] }[]; onSelect(lineageId: string): void }) {
  const flat = rows.flatMap((r) => r.deltas.map((d) => ({ ...d, path: r.path, lineageId: r.lineageId })));
  return (
    <Paged
      items={flat}
      pageSize={25}
      empty="None"
      render={(d) => (
        <li key={`${d.lineageId}:${d.metric}`} className="row">
          <button type="button" className="link row-main" onClick={() => onSelect(d.lineageId)}>
            {d.path}
          </button>
          <span className="row-meta">
            {METRIC_LABEL[d.metric]}: {formatNumber(d.from)} → {formatNumber(d.to)} ({deltaText(d)})
          </span>
        </li>
      )}
    />
  );
}
