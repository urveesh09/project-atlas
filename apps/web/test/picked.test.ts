import { describe, expect, it } from 'vitest';
import { pickedFilesSource, type PickedFile } from '@atlas/artifact';
import { entriesFromInput, pickedFromEntries } from '../src/data/picked';

/** A picked file as WebKit's structured clone delivers it: the relative path is gone. */
const cloned = (name: string, text: string) => new File([text], name);
const MAX = 1 << 20;

describe('picked folders survive the trip to the loader worker (ADR-069)', () => {
  it('finds nested chunks from the explicit path, not the cloned file', async () => {
    const entries = [
      { path: 'harbor-out/manifest.json', file: cloned('manifest.json', '{}') },
      { path: 'harbor-out/history/history.json.gz', file: cloned('history.json.gz', 'h') },
      { path: 'harbor-out/graphs/snap_a.json.gz', file: cloned('snap_a.json.gz', 'g') },
    ];
    const source = pickedFilesSource(pickedFromEntries(entries));
    expect(new TextDecoder().decode((await source.read('history/history.json.gz', MAX))!)).toBe('h');
    expect(new TextDecoder().decode((await source.read('graphs/snap_a.json.gz', MAX))!)).toBe('g');
    expect(await source.read('manifest.json', MAX)).not.toBeNull();
  });

  it('shows the failure it prevents: cloned files alone lose their folders', async () => {
    const files: PickedFile[] = [cloned('manifest.json', '{}'), cloned('history.json.gz', 'h')];
    expect(await pickedFilesSource(files).read('history/history.json.gz', MAX)).toBeNull();
  });

  it('takes the path from the page, or the name for a plain multi-file pick', () => {
    const nested = Object.defineProperty(new File(['x'], 'layout.json.gz'), 'webkitRelativePath', { value: 'out/layout/layout.json.gz' });
    const plain = new File(['y'], 'summary.json');
    expect(entriesFromInput([nested, plain]).map((e) => e.path)).toEqual(['out/layout/layout.json.gz', 'summary.json']);
  });
});
