import type { ViewerModel } from '../app/model';
import type { ViewState } from '../app/state';
import type { OverlayResult } from './overlay';

export function exportMetadata(model: ViewerModel, state: ViewState, overlay: OverlayResult, camera: unknown) {
  return {
    exportVersion: 'atlas.image/1',
    analysisId: model.manifest.analysisId,
    analysisKey: model.manifest.analysisKey,
    artifactVersion: model.manifest.artifactVersion,
    schemaVersion: model.manifest.schemaVersion,
    analyzer: model.manifest.analyzer,
    metricDefinitionVersion: model.manifest.metricDefinitionVersion,
    optionsDigest: model.manifest.optionsDigest,
    commit: model.graph.commitOid,
    snapshotId: model.graph.snapshotId,
    frame: { ordinal: model.frame, of: model.dataset.frames.length, committerTime: model.commit.committerTime, selectedCommit: model.isHead },
    compare: state.compare ? { from: model.dataset.frames[state.compare.a]!.snapshotId, to: model.dataset.frames[state.compare.b]!.snapshotId } : null,
    historyWindow: model.manifest.coverage.history,
    layoutVersion: model.dataset.layout.layoutVersion,
    layoutId: model.dataset.layout.layoutId,
    lens: state.lens,
    mode: state.mode,
    selectedPath: state.selectedId ? model.pathOf(state.selectedId) : null,
    filter: state.filter,
    edgePolicy: overlay.policy,
    visibleEdges: overlay.arcs.length,
    omittedEdges: overlay.omitted,
    visibleExternalTerminals: model.city.terminals.length,
    omittedExternalTerminals: model.city.terminalOmitted,
    camera,
    note: 'Static repository structure. Height is code lines; roads are spacing. Use the artifact/table for accessible evidence.',
  };
}
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
export async function addProvenance(blob: Blob, title: string): Promise<Blob> {
  const image = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas export is unavailable');
    ctx.drawImage(image, 0, 0);
    ctx.fillStyle = '#182331';
    ctx.fillRect(0, canvas.height - 32, canvas.width, 32);
    ctx.fillStyle = '#ffffff';
    ctx.font = '12px system-ui';
    ctx.fillText(title.slice(0, 180), 12, canvas.height - 12, canvas.width - 24);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'),
    );
  } finally {
    image.close();
  }
}
