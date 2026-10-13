import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { embedPngText, PROVENANCE_KEYWORD, readPngText } from '../src/city/export';

/** A valid 1×1 RGBA PNG built here, so the test does not depend on a canvas. */
function tinyPng(): Uint8Array {
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of bytes) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    Buffer.from(data).copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 10, 20, 30, 255]))),
    chunk('IEND', new Uint8Array()),
  ]);
}

describe('PNG provenance text', () => {
  it('round-trips UTF-8 JSON and keeps IEND last', () => {
    const json = JSON.stringify({ selectedPath: 'src/ünïcode/file.ts', lens: 'fan-in' });
    const out = embedPngText(tinyPng(), PROVENANCE_KEYWORD, json);
    expect(readPngText(out, PROVENANCE_KEYWORD)).toBe(json);
    expect(Buffer.from(out.subarray(out.length - 8, out.length - 4)).toString('latin1')).toBe('IEND');
    expect(readPngText(tinyPng(), PROVENANCE_KEYWORD)).toBeNull();
  });

  it('writes every chunk with a valid CRC, in order', () => {
    const out = embedPngText(tinyPng(), PROVENANCE_KEYWORD, '{"ok":true}');
    // Every chunk's CRC must verify, or a decoder rejects the image.
    let at = 8;
    const view = Buffer.from(out);
    const crc = (bytes: Uint8Array) => {
      let c = 0xffffffff;
      for (const b of bytes) {
        c ^= b;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      return (c ^ 0xffffffff) >>> 0;
    };
    const types: string[] = [];
    while (at < view.length) {
      const length = view.readUInt32BE(at);
      types.push(view.subarray(at + 4, at + 8).toString('latin1'));
      expect(view.readUInt32BE(at + 8 + length)).toBe(crc(view.subarray(at + 4, at + 8 + length)));
      at += 12 + length;
    }
    expect(types).toEqual(['IHDR', 'IDAT', 'iTXt', 'IEND']);
  });

  it('refuses input that is not a PNG', () => {
    expect(() => embedPngText(new Uint8Array(32), PROVENANCE_KEYWORD, '{}')).toThrow('Not a PNG');
  });
});
