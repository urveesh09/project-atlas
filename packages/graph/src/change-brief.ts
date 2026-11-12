import { escapeForDisplay, type ArtifactManifest, type FrameDescriptor } from '@atlas/schema';
import type { FrameComparison } from './compare.js';
import { escapeMarkdownText } from './markdown.js';

const LABEL_LIMIT = 160;

function label(text: string): string {
  const safe = escapeForDisplay(text).replace(/[\p{Bidi_Control}\u2028\u2029]/gu, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const chars = [...safe];
  const shortened = chars.length <= LABEL_LIMIT ? safe : `${chars.slice(0, 120).join('')}…${chars.slice(-39).join('')}`;
  return `“${escapeMarkdownText(shortened)}”`;
}

function coverage(side: 'A' | 'B', frame: FrameDescriptor): string {
  const c = frame.coverage;
  return `- **${side} (${frame.analysisStatus})** — ${c.includedFiles} of ${c.discoveredFiles} files included, ${c.parsedFiles} of ${c.supportedFiles} supported files parsed, ${c.parseFailedFiles} parse failures, ${c.opaqueFiles} opaque, ${c.excludedFiles} excluded, ${c.omittedFiles} omitted. Of ${c.observedImports} import observations, ${c.unresolved} unresolved, ${c.unsupported} unsupported and ${c.excludedTargets} with excluded targets. Resource limits hit (${c.limitsHit.length}).`;
}

/** A bounded handoff for one ordered pair of validated frames, independent of viewer filters. */
export function changeBriefMarkdown(
  comparison: FrameComparison,
  manifest: Pick<ArtifactManifest, 'analysisId' | 'frames' | 'selectedCommit'>,
): string | null {
  const a = manifest.frames.find((frame) => frame.snapshotId === comparison.fromSnapshotId);
  const b = manifest.frames.find((frame) => frame.snapshotId === comparison.toSnapshotId);
  if (!a || !b || a === b) return null;

  const lines = [
    '# ATLAS change brief',
    '',
    `Analysis \`${manifest.analysisId}\``,
    '',
    `- **A** — snapshot ${a.ordinal + 1}, commit \`${a.commit.oid}\` (${a.commit.committerTime})`,
    `- **B** — snapshot ${b.ordinal + 1}, commit \`${b.commit.oid}\` (${b.commit.committerTime})`,
    '',
    b.ordinal < a.ordinal ? 'Direction A → B, from newer to older.' : 'Direction A → B, from older to newer.',
    '',
    'This brief summarizes static observations from the artifact. Changes in coverage and resolution can affect the differences.',
    '',
    '## Snapshot coverage',
    '',
    coverage('A', a),
    coverage('B', b),
    '',
    '## Included files',
    '',
    `- ${comparison.added.length} in B only and ${comparison.deleted.length} in A only`,
    `- ${comparison.renamed.length} renamed, ${comparison.moved.length} moved between folders, ${comparison.modified.length} with different content, ${comparison.roleChanged.length} with different roles`,
    `- ${comparison.unchangedFiles} with the same path, content and role`,
    '',
    'A file can appear in more than one change count.',
    '',
    '## Observed dependency relationships',
    '',
  ];
  const examples = (heading: string, total: number, rows: string[]) => {
    lines.push(`### ${heading} (${total})`, '', ...rows.map((row) => `- ${row}`));
    if (total > rows.length) lines.push(`- Additional entries omitted from the brief (${total - rows.length}).`);
    lines.push('');
  };

  for (const [heading, edges] of [['B only', comparison.edgesAdded], ['A only', comparison.edgesRemoved]] as const) {
    examples(heading, edges.length, edges.slice(0, 5).map((edge) => `${label(edge.sourcePath)} → ${label(edge.targetLabel)} (${edge.kind})`));
  }
  lines.push('## Recorded static cycle components', '',
    'Membership is matched by file lineage. Paths below identify the members in the snapshot where the component was recorded.', '');
  const { aOnly, bOnly, unidentifiedA, unidentifiedB } = comparison.cycles;
  if (unidentifiedA || unidentifiedB) {
    lines.push(`Components without full lineage identity were excluded from matching (${unidentifiedA} in A, ${unidentifiedB} in B).`, '');
  }
  for (const [heading, group] of [['B only', bOnly], ['A only', aOnly]] as const) {
    examples(heading, group.count, group.examples.map(({ memberCount, paths }) => {
      const omitted = memberCount - paths.length;
      return `${paths.map(label).join(', ')}${omitted ? ` and ${omitted} more` : ''} (${memberCount} ${memberCount === 1 ? 'file' : 'files'})`;
    }));
  }

  const hotspots: { path: string; from: number; to: number; delta: number }[] = [];
  let availabilityChanged = 0;
  for (const row of comparison.metricChanges) {
    const score = row.deltas.find((metric) => metric.metric === 'hotspotScore');
    if (!score) continue;
    if (score.from === null || score.to === null || score.delta === null) availabilityChanged++;
    else hotspots.push({ path: row.path, from: score.from, to: score.to, delta: score.delta });
  }
  // The comparison already orders metric rows by repository path. Stable sort keeps ties in that order.
  hotspots.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  lines.push('## Hotspot movement', '',
    `The 0–100 score uses the fixed HEAD cohort from \`${manifest.selectedCommit.oid}\`. Movement is expressed in score points.`, '',
    `- Shared files with scores in both snapshots (${comparison.hotspotComparable}).`,
    `- Shared files that gained or lost score availability (${availabilityChanged}).`, '');
  examples('Largest movements', hotspots.length, hotspots.slice(0, 8).map(({ path, from, to, delta }) =>
    `${label(path)} · ${from} → ${to} (${delta > 0 ? '+' : ''}${delta})`));
  lines.push('Long paths and dependency labels may be shortened with an ellipsis.', '');
  return lines.join('\n');
}
