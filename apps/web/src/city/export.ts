import type { ViewerModel } from '../app/model';
import type { ViewState } from '../app/state';
import type { OverlayResult } from './overlay';

export function exportMetadata(model: ViewerModel, state: ViewState, overlay: OverlayResult, camera: unknown, cityStyle: string | null = null) {
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
    cityStyle,
    note: 'Static repository structure. Height is code lines; roads are spacing; building styles and greenery are decorative. Use the artifact/table for accessible evidence.',
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

/** The PNG text keyword under which an export carries its provenance JSON (ADR-047). */
export const PROVENANCE_KEYWORD = 'atlas.provenance';

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Inserts an uncompressed international text chunk (`iTXt`, PNG specification §11.3.4.5)
 * before `IEND`. Image viewers ignore it; `exiftool`, `pngcheck` and ATLAS can read it.
 */
export function embedPngText(png: Uint8Array, keyword: string, text: string): Uint8Array {
  const encoder = new TextEncoder();
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (png.length < 20 || signature.some((b, i) => png[i] !== b)) throw new Error('Not a PNG image');
  if (!/^[\x20-\x7e]{1,79}$/.test(keyword)) throw new Error('Invalid PNG text keyword');
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let end = 8;
  for (;;) {
    if (end + 12 > png.length) throw new Error('PNG has no IEND chunk');
    const length = view.getUint32(end);
    if (String.fromCharCode(...png.subarray(end + 4, end + 8)) === 'IEND') break;
    end += 12 + length;
  }
  // keyword NUL, compression flag 0, method 0, empty language tag NUL, empty translated keyword NUL, UTF-8 text.
  const data = new Uint8Array([...encoder.encode(keyword), 0, 0, 0, 0, 0, ...encoder.encode(text)]);
  const chunk = new Uint8Array(12 + data.length);
  const chunkView = new DataView(chunk.buffer);
  chunkView.setUint32(0, data.length);
  chunk.set(encoder.encode('iTXt'), 4);
  chunk.set(data, 8);
  chunkView.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, end));
  out.set(chunk, end);
  out.set(png.subarray(end), end + chunk.length);
  return out;
}

/** Reads back an `iTXt` chunk written by {@link embedPngText}; null when absent. */
export function readPngText(png: Uint8Array, keyword: string): string | null {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const decoder = new TextDecoder();
  for (let at = 8; at + 12 <= png.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    if (type === 'IEND') break;
    if (type === 'iTXt') {
      const data = png.subarray(at + 8, at + 8 + length);
      const nul = data.indexOf(0);
      if (decoder.decode(data.subarray(0, nul)) === keyword && data[nul + 1] === 0) {
        let i = nul + 3;
        i = data.indexOf(0, i) + 1; // language tag
        i = data.indexOf(0, i) + 1; // translated keyword
        return decoder.decode(data.subarray(i));
      }
    }
    at += 12 + length;
  }
  return null;
}
