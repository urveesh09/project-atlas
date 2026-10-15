import { useViewer } from '../app/context';
import { formatDate, formatNumber, shortOid } from '../app/model';
import { AvailabilityNote, Chip, Paged, Section } from './ui';
import type { GraphNode } from '@atlas/schema';

/**
 * File history (plan §12.3 tab 4): the lineage's presence across analyzed snapshots, its
 * rename chain, every mainline change in the window that touched it, co-change partners
 * and a comparison shortcut. Everything comes from the history chunk; nothing is guessed.
 */
const CONTINUITY: Record<string, string> = {
  'exact-path': 'Followed by exact path within the analyzed window.',
  'git-rename': 'Followed through Git rename detection (80% similarity, one-to-one).',
  ambiguous: 'Possible rename evidence was ambiguous (identical candidates), so ATLAS started a new lineage instead of guessing continuity.',
};

export function HistoryTab({ node }: { node: GraphNode }) {
  const { dataset } = useViewer();
  if (dataset.manifest.coverage.history.status === 'unavailable')
    return (
      <div className="empty-state">
        <h3>History was not analyzed</h3>
        <p>This artifact describes one commit only, so change counts, renames and comparisons are unavailable, not zero.</p>
      </div>
    );
  if (node.kind !== 'file' || !node.lineageId) return <ContainerHistory node={node} />;
  return <LineageHistory lineageId={node.lineageId} currentPath={node.path} />;
}

function ContainerHistory({ node }: { node: GraphNode }) {
  const { model } = useViewer();
  const m = model.index.metrics.get(node.id);
  return (
    <Section title="Changes inside" description="Distinct mainline commits that changed any file currently here, up to this snapshot; line totals are sums over those files.">
      {m ? (
        <p>
          <strong>{formatNumber(m.changedCommits)}</strong> commits · +{formatNumber(m.linesAdded)} −{formatNumber(m.linesDeleted)} lines <AvailabilityNote value={m.availability.history} />
        </p>
      ) : (
        <p className="empty">No history measurements.</p>
      )}
    </Section>
  );
}

export function LineageHistory({ lineageId, currentPath }: { lineageId: string; currentPath: string | null }) {
  const { dataset, model, goToFrame, setCompare, select, state } = useViewer();
  const lineage = dataset.lineages.get(lineageId);
  if (!lineage) return <p className="empty">This file has no recorded lineage.</p>;
  const changes = [...(dataset.changesByLineage.get(lineageId) ?? [])].sort((x, y) => (dataset.chainIndex.get(y.commit.oid) ?? 0) - (dataset.chainIndex.get(x.commit.oid) ?? 0));
  const here = dataset.chainIndex.get(model.commit.oid) ?? 0;
  const upToHere = changes.filter((c) => (dataset.chainIndex.get(c.commit.oid) ?? 0) <= here).length;
  const presence = dataset.frames.map((f, i) => ({ i, f, occurrence: lineage.occurrences.find((o) => o.snapshotId === f.snapshotId) }));
  const paths = [...new Set(lineage.occurrences.map((o) => o.path))];
  const latest = dataset.lineagePath(lineageId);
  const first = presence.find((p) => p.occurrence)?.i;
  const metric = model.fileByLineage.get(lineageId) ? model.index.metrics.get(model.fileByLineage.get(lineageId)!.id) : undefined;
  const partners = dataset.partners.get(lineageId) ?? [];
  return (
    <>
      <Section title="Lineage" description={CONTINUITY[lineage.continuity]}>
        <div className="chips">
          <Chip tone={lineage.continuity === 'ambiguous' ? 'warn' : 'neutral'}>{lineage.continuity}</Chip>
          <Chip tone="muted">first tracked {lineage.anchorPath}</Chip>
        </div>
        {latest && currentPath && latest !== currentPath && (
          <p className="note">
            Its building stands on the plot anchored to its latest path, <code>{latest}</code>; in this snapshot the file was at <code>{currentPath}</code>.
          </p>
        )}
        {paths.length > 1 && (
          <p className="note">
            Paths across snapshots: {paths.map((p, i) => (
              <span key={p}>
                {i > 0 && ' → '}
                <code>{p}</code>
              </span>
            ))}
          </p>
        )}
      </Section>
      <Section title="Present in snapshots" description="Choose a snapshot to see this file as it was then.">
        <ol className="presence" aria-label="Presence by snapshot">
          {presence.map(({ i, f, occurrence }) => (
            <li key={f.snapshotId}>
              <button
                type="button"
                className={`presence-cell${occurrence ? ' is-present' : ''}${i === state.frame ? ' is-active' : ''}`}
                aria-current={i === state.frame ? 'step' : undefined}
                aria-label={`Snapshot ${i + 1}, ${formatDate(f.commit.committerTime)}: ${occurrence ? `present as ${occurrence.path}` : 'absent'}`}
                onClick={() => void goToFrame(i, { lineage: lineageId })}
              >
                <span aria-hidden="true">{occurrence ? '■' : '·'}</span>
              </button>
            </li>
          ))}
        </ol>
      </Section>
      <Section title="Mainline changes" count={changes.length} description={`${upToHere} of these happened up to the snapshot shown. Merges count the change they brought to the mainline.`}>
        {metric && (
          <p>
            Up to this snapshot: <strong>{formatNumber(metric.changedCommits)}</strong> commits, +{formatNumber(metric.linesAdded)} −{formatNumber(metric.linesDeleted)} lines{' '}
            <AvailabilityNote value={metric.availability.history} />
            {metric.linesAdded === null && metric.changedCommits ? ' (binary or unknown line counts)' : ''}
          </p>
        )}
        <Paged
          items={changes}
          pageSize={15}
          empty="No changes inside the analyzed window."
          render={({ commit, change }) => (
            <li key={`${commit.oid}:${change.kind}:${change.newPath ?? change.oldPath}`} className="row">
              <span className="row-main">
                <code>{shortOid(commit.oid)}</code> {formatDate(commit.committerTime)} · {change.kind}
                {change.kind === 'rename' ? ` ${change.oldPath} → ${change.newPath}${change.renameSimilarity !== null ? ` (${change.renameSimilarity}%)` : ''}` : ''}
              </span>
              <span className="row-meta">{change.added === null ? 'lines n/a' : `+${change.added} −${change.deleted}`}</span>
            </li>
          )}
        />
      </Section>
      {partners.length > 0 && (
        <Section title="Often changed together" count={partners.length} description="Mainline commits shared with this file (at least 3; commits touching over 50 files excluded). Co-change is a pattern, not a dependency.">
          <Paged
            items={partners}
            pageSize={10}
            empty="None"
            render={(p) => {
              const other = p.aLineageId === lineageId ? p.bLineageId : p.aLineageId;
              const file = model.fileByLineage.get(other);
              return (
                <li key={other} className="row">
                  {file ? (
                    <button type="button" className="link row-main" onClick={() => select(file.id, { focusInspector: true })}>
                      {file.path}
                    </button>
                  ) : (
                    <span className="row-main">{dataset.lineagePath(other)} (not in this snapshot)</span>
                  )}
                  <span className="row-meta">
                    {p.togetherCommits} together · Jaccard {p.jaccard.toFixed(2)}
                  </span>
                </li>
              );
            }}
          />
        </Section>
      )}
      {first !== undefined && first !== state.frame && dataset.frames.length > 1 && (
        <button type="button" className="button" onClick={() => void setCompare({ a: first, b: state.frame })}>
          Compare its first snapshot with this one
        </button>
      )}
    </>
  );
}

/** The selected lineage is absent from this snapshot (plan §12.1 tombstone). */
export function Tombstone({ lineageId }: { lineageId: string }) {
  const { dataset, state, goToFrame, select } = useViewer();
  const lineage = dataset.lineages.get(lineageId);
  const ordinals = (lineage?.occurrences ?? []).map((o) => ({ o, i: dataset.frameOfSnapshot.get(o.snapshotId)! }));
  const before = [...ordinals].reverse().find((x) => x.i < state.frame);
  const after = ordinals.find((x) => x.i > state.frame);
  const frame = dataset.frames[state.frame]!;
  return (
    <article className="inspector tombstone" aria-labelledby="inspector-title">
      <header className="inspector-header">
        <h2 id="inspector-title" tabIndex={-1}>
          {dataset.lineagePath(lineageId) ?? 'File'}
        </h2>
        <p className="inspector-path">
          Not present in snapshot {state.frame + 1} ({formatDate(frame.commit.committerTime)}). ATLAS never substitutes a similarly named file.
        </p>
      </header>
      <div className="tombstone-actions">
        {before && (
          <button type="button" className="button" onClick={() => void goToFrame(before.i, { lineage: lineageId })}>
            Last seen: snapshot {before.i + 1} as {before.o.path}
          </button>
        )}
        {after && (
          <button type="button" className="button" onClick={() => void goToFrame(after.i, { lineage: lineageId })}>
            Next appears: snapshot {after.i + 1} as {after.o.path}
          </button>
        )}
        {!before && !after && <p className="note">This file appears in no analyzed snapshot; it lived only between sampled commits.</p>}
        <button type="button" className="link" onClick={() => select(null)}>
          Clear selection
        </button>
      </div>
      <LineageHistory lineageId={lineageId} currentPath={null} />
    </article>
  );
}
