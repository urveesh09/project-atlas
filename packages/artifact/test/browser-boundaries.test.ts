import { expect, it } from 'vitest';
import { DecompressionLimitError, gunzipWithStreams, gzipDeterministic, pickedFilesSource } from '@atlas/artifact/node';

it('refuses a huge picked file before asking the browser to allocate its contents', async () => {
  const bytes = new TextEncoder().encode('{}');
  let hugeReads = 0;
  const chunk = `graphs/snap_${'a'.repeat(64)}.json.gz`;
  const source = pickedFilesSource([
    { name: 'manifest.json', webkitRelativePath: 'chosen/manifest.json', size: 2, arrayBuffer: async () => bytes.buffer },
    { name: 'chunk', webkitRelativePath: `chosen/${chunk}`, size: Number.MAX_SAFE_INTEGER, arrayBuffer: async () => { hugeReads++; throw new Error('Must reject metadata before reading'); } },
    { name: 'outside', webkitRelativePath: 'neighbor/private', size: 2, arrayBuffer: async () => { throw new Error('Must not read another folder'); } },
  ]);
  expect(await source.read(chunk, 1024)).toHaveLength(1025);
  expect(hugeReads).toBe(0);
  expect(await source.read('neighbor/private', 1024)).toBeNull();
  expect(await source.read('missing', 1024)).toBeNull();
  expect(await source.read('manifest.json', 2)).toEqual(bytes);
});

it('the real streaming browser decompressor enforces its output cap, including the exact boundary', async () => {
  const payload = new Uint8Array(64 * 1024).fill(97);
  const compressed = gzipDeterministic(payload);
  expect(compressed.length).toBeLessThan(1024);
  await expect(gunzipWithStreams(compressed, 1024)).rejects.toBeInstanceOf(DecompressionLimitError);
  expect(await gunzipWithStreams(compressed, payload.length)).toEqual(payload);
});
