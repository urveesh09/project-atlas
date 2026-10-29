import { emptySnapshotCoverage, makeId, type FileRole, type GraphSnapshot, type GraphEdge, type GraphNode, type ImportObservation } from '@atlas/schema';
export const architectureAnalysis = makeId('analysis', ['architecture-test']);
export function architectureFixture(tag: string, paths: string[], imports: [
  number,
  number,
  GraphEdge['kind']?,
  GraphEdge['confidence']?
][], options: {
  roles?: FileRole[];
  packages?: string[];
  lineages?: string[];
} = {}): GraphSnapshot {
  const repoId = makeId('repository', ['architecture-test']), snapshotId = makeId('snapshot', [tag]);
  const packagePaths = [...new Set(options.packages ?? [''])];
  const packages: GraphNode[] = packagePaths.map(p => ({ id: makeId('node', [tag, 'package', p]), kind: 'package', label: p || 'root', parentId: null, lineageId: null, path: p, manifestPath: null, packageName: null, workspace: true }));
  const files: GraphNode[] = paths.map((p, i) => ({ id: makeId('node', [tag, p]), kind: 'file', label: p, parentId: makeId('node', [tag, 'package', options.packages?.[i] ?? '']), lineageId: makeId('lineage', [options.lineages?.[i] ?? String(i)]), path: p, role: options.roles?.[i] ?? 'source', language: 'typescript', parseStatus: 'parsed', blobOid: 'a'.repeat(40), blobSha256: null, byteSize: 12, declarations: [], declarationsOmitted: 0 }));
  const importObservations: ImportObservation[] = imports.map(([s, t, kind = 'imports-value', confidence = 'exact'], i) => ({ id: makeId('observation', [tag, i]), sourceId: files[s]!.id, targetId: files[t]!.id, kind, confidence, specifier: 'PRIVATE_SOURCE_SENTINEL', range: { startOffset: i, endOffset: i, startLine: i + 1, endLine: i + 1, startColumn: 1, endColumn: 1 }, status: 'resolved-internal', reasonCode: null, resolverMode: 'test' }));
  const groups = new Map<string, GraphEdge>();
  for (const o of importObservations) {
    const key = `${o.sourceId}:${o.targetId}:${o.kind}:${o.confidence}`;
    const previous = groups.get(key);
    if (previous) {
      previous.observationCount++;
      previous.evidenceIds.push(o.id);
    }
    else
      groups.set(key, { id: makeId('edge', [tag, key]), sourceId: o.sourceId, targetId: o.targetId!, kind: o.kind, confidence: o.confidence!, observationCount: 1, evidenceIds: [o.id], evidenceOmitted: 0 });
  }
  return { repoId, snapshotId, commitOid: tag.repeat(40).slice(0, 40), nodes: [...packages, ...files], edges: [...groups.values()], importObservations, diagnostics: [], metrics: [], coverage: { ...emptySnapshotCoverage(), discoveredFiles: paths.length, includedFiles: paths.length, supportedFiles: paths.length, parsedFiles: paths.length, observedImports: imports.length, internalResolved: imports.length } };
}
