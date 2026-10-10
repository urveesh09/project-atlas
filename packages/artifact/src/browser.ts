import { DecompressionLimitError, type ArtifactSource, type Decompressor } from './load.js';

/**
 * Browser-side adapters (plan §14.3: "Open local artifact" uses file APIs and workers and
 * sends nothing anywhere). Written against the minimal Web APIs so they also run in Node.
 */

/** Streaming gunzip with a hard output cap, via the standard DecompressionStream. */
export const gunzipWithStreams: Decompressor = async (compressed, maxBytes) => {
  const stream = new Blob([compressed as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new DecompressionLimitError(maxBytes);
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/** The subset of `File` used here (directory pickers set `webkitRelativePath`). */
export interface PickedFile {
  name: string;
  size: number;
  webkitRelativePath?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * Serve artifact paths from files chosen with a directory picker or multi-file input.
 * The common leading folder is stripped; only exact relative-path matches are served.
 */
export function pickedFilesSource(files: readonly PickedFile[]): ArtifactSource {
  const byPath = new Map<string, PickedFile>();
  const relative = (f: PickedFile) => (f.webkitRelativePath && f.webkitRelativePath.length > 0 ? f.webkitRelativePath : f.name);
  const manifest = files.find((f) => relative(f).split('/').at(-1) === 'manifest.json');
  const root = manifest ? relative(manifest).slice(0, -'manifest.json'.length) : '';
  for (const file of files) {
    const path = relative(file);
    if (!path.startsWith(root)) continue;
    byPath.set(path.slice(root.length), file);
  }
  return {
    async read(path, maxBytes) {
      const file = byPath.get(path);
      if (!file) return null;
      if (file.size > maxBytes) return new Uint8Array(maxBytes + 1);
      return new Uint8Array(await file.arrayBuffer());
    },
  };
}
