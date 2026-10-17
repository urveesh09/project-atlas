import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { FileObjectStore, deleteUpload, newUploadId, objectKey, uploadPrefix } from '@atlas/control';

it('purges multiple bounded pages from the real store without deleting another upload', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'atlas-coverage-purge-'));
  try {
    const store = new FileObjectStore(root);
    const victim = newUploadId(), survivor = newUploadId();
    const retained = objectKey(survivor, 'manifest.json');
    await store.put(retained, new TextEncoder().encode('retain'));
    // Incomplete/abandoned uploads can have more objects than a published manifest.
    for (let i = 0; i < 125; i++) await store.put(objectKey(victim, `graphs/snap_${i.toString(16).padStart(64, '0')}.json.gz`), new Uint8Array([i]));
    const sizes: number[] = [];
    const list = store.list.bind(store);
    store.list = async (prefix, limit) => {
      expect(prefix).toBe(uploadPrefix(victim));
      expect(limit).toBe(100);
      const page = await list(prefix, limit);
      sizes.push(page.length);
      return page;
    };
    expect(await deleteUpload(store, victim)).toBe(125);
    expect(sizes).toEqual([100, 25, 0]);
    expect(new TextDecoder().decode((await store.get(retained, 6))!)).toBe('retain');
    expect(await list(uploadPrefix(victim))).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
