import type { PickedFile } from '@atlas/artifact';

/**
 * A picked file with its folder-relative path carried beside it. The loader worker
 * receives files through `postMessage`, and WebKit's structured clone drops the
 * non-standard `webkitRelativePath`. In Safari, `history/history.json.gz` then arrived as
 * plain `history.json.gz`, and every artifact failed with CHUNK_MISSING (ADR-069).
 */
export interface PickedEntry {
  path: string;
  file: File;
}

/** On the page, where `webkitRelativePath` is still set. */
export function entriesFromInput(list: ArrayLike<File>): PickedEntry[] {
  return Array.from(list, (file) => ({ path: file.webkitRelativePath || file.name, file }));
}

/** In the worker: the paths come from the entries, never from the cloned files. */
export function pickedFromEntries(entries: readonly PickedEntry[]): PickedFile[] {
  return entries.map(({ path, file }) => ({ name: file.name, size: file.size, webkitRelativePath: path, arrayBuffer: () => file.arrayBuffer() }));
}
