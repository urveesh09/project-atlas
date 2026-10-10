import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  gunzipWithStreams,
  gzipDeterministic,
  loadArtifact,
  packArtifact,
  pickedFilesSource,
  readArtifactDirectory,
  recoverInterruptedWrite,
  writeArtifactDirectory,
  type ManifestDraft,
  type PackedArtifact,
} from '@atlas/artifact/node';
import { buildHandcraftedArtifact } from '@atlas/test-fixtures';

function draftFrom(): { manifest: ManifestDraft; graphs: ReturnType<typeof buildHandcraftedArtifact>['graph'][]; history: ReturnType<typeof buildHandcraftedArtifact>['history']; layout: ReturnType<typeof buildHandcraftedArtifact>['layout'] } {
  const a = buildHandcraftedArtifact();
  const { historyChunk: _h, layoutChunk: _l, chunks: _c, frames, ...rest } = a.manifest;
  return {
    manifest: { ...rest, frames: frames.map(({ graphChunk: _g, ...frame }) => frame) },
    graphs: [a.graph],
    history: a.history,
    layout: a.layout,
  };
}

const pack = (): PackedArtifact => packArtifact(draftFrom(), gzipDeterministic);

let work: string;
beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), 'atlas-artifact-'));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const out = () => path.join(work, 'atlas-output');

async function codesFor(dir: string): Promise<string[]> {
  const r = await readArtifactDirectory(dir);
  return r.ok ? [] : r.issues.map((i) => i.code);
}

describe('packing', () => {
  it('fills chunk references and validates the bundle', () => {
    const packed = pack();
    expect([...packed.chunks.keys()].sort()).toEqual([`graphs/${packed.manifest.frames[0]!.snapshotId}.json.gz`, 'history/history.json.gz', 'layout/layout.json.gz'].sort());
    expect(packed.manifest.chunks).toHaveLength(3);
  });

  it('is byte-for-byte reproducible, including the gzip transport', () => {
    const a = pack();
    const b = pack();
    expect(a.manifest).toEqual(b.manifest);
    for (const [p, bytes] of a.chunks) expect(Buffer.from(bytes).equals(Buffer.from(b.chunks.get(p)!))).toBe(true);
  });

  it('writes gzip with fixed metadata (mtime 0, OS unknown)', () => {
    const gz = gzipDeterministic(new TextEncoder().encode('{"a":1}'));
    expect([...gz.subarray(0, 3)]).toEqual([0x1f, 0x8b, 0x08]);
    expect(Buffer.from(gz).readUInt32LE(4)).toBe(0);
    expect(gz[9]).toBe(0xff);
  });
});

describe('round trip', () => {
  it('writes atomically and reads back an identical, valid bundle', async () => {
    const packed = pack();
    await writeArtifactDirectory(packed, out(), { extras: { 'summary.json': { files: 5 } } });
    const loaded = await readArtifactDirectory(out());
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.bundle).toEqual(packed.bundle);
    expect(readdirSync(work)).toEqual(['atlas-output']);
    expect(JSON.parse(readFileSync(path.join(out(), 'summary.json'), 'utf8'))).toEqual({ files: 5 });
  });

  it('reads the same directory through the browser adapters (File list + DecompressionStream)', async () => {
    await writeArtifactDirectory(pack(), out());
    const files: { name: string; size: number; webkitRelativePath: string; arrayBuffer(): Promise<ArrayBuffer> }[] = [];
    const walk = (dir: string, rel: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, `${rel}${entry.name}/`);
        else {
          const bytes = readFileSync(full);
          files.push({ name: entry.name, size: bytes.length, webkitRelativePath: `atlas-output/${rel}${entry.name}`, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) as ArrayBuffer });
        }
      }
    };
    walk(out(), '');
    const loaded = await loadArtifact(pickedFilesSource(files), gunzipWithStreams);
    expect(loaded.ok ? 'ok' : loaded.issues).toBe('ok');
  });
});

describe('import rejects corrupt and hostile artifacts', () => {
  beforeEach(async () => {
    await writeArtifactDirectory(pack(), out());
  });
  const manifestPath = () => path.join(out(), 'manifest.json');
  const manifest = () => JSON.parse(readFileSync(manifestPath(), 'utf8'));
  const graphPath = () => path.join(out(), ...manifest().frames[0].graphChunk.path.split('/'));

  it('a flipped byte in a chunk', async () => {
    const bytes = readFileSync(graphPath());
    bytes.writeUInt8(bytes.readUInt8(bytes.length - 12) ^ 0xff, bytes.length - 12);
    writeFileSync(graphPath(), bytes);
    expect(await codesFor(out())).toEqual([expect.stringMatching(/^(CHUNK_HASH|DECOMPRESSION|CHUNK_LENGTH)$/)]);
  });

  it('a truncated chunk', async () => {
    writeFileSync(graphPath(), readFileSync(graphPath()).subarray(0, 20));
    expect(await codesFor(out())).toEqual(['CHUNK_LENGTH']);
  });

  it('a missing chunk', async () => {
    rmSync(path.join(out(), 'layout', 'layout.json.gz'));
    expect(await codesFor(out())).toEqual(['CHUNK_MISSING']);
  });

  it('a missing manifest', async () => {
    rmSync(manifestPath());
    expect(await codesFor(out())).toEqual(['MANIFEST_MISSING']);
  });

  it('a decompression bomb disguised as a small chunk', async () => {
    const m = manifest();
    const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024));
    writeFileSync(path.join(out(), 'layout', 'layout.json.gz'), bomb);
    const ref = m.chunks.find((c: { path: string }) => c.path === 'layout/layout.json.gz');
    ref.compressedBytes = bomb.length;
    m.layoutChunk.compressedBytes = bomb.length;
    writeFileSync(manifestPath(), JSON.stringify(m));
    expect(await codesFor(out())).toEqual(['DECOMPRESSION_LIMIT']);
  });

  it('a chunk path that tries to traverse', async () => {
    const m = manifest();
    m.chunks[0].path = '../../outside.json.gz';
    writeFileSync(manifestPath(), JSON.stringify(m));
    expect(await codesFor(out())).toContain('SCHEMA');
  });

  it('a foreign major version', async () => {
    const m = manifest();
    m.artifactVersion = 'atlas.artifact/2.0.0';
    writeFileSync(manifestPath(), JSON.stringify(m));
    const r = await readArtifactDirectory(out());
    expect(r.ok ? null : r.code).toBe('UNSUPPORTED_SCHEMA');
  });

  it('non-canonical JSON even with a matching hash', async () => {
    const m = manifest();
    const text = Buffer.from(`${JSON.stringify(buildHandcraftedArtifact().layout, null, 1)}`);
    const gz = gzipDeterministic(text);
    writeFileSync(path.join(out(), 'layout', 'layout.json.gz'), gz);
    const { createHash } = await import('node:crypto');
    for (const ref of [m.layoutChunk, m.chunks.find((c: { path: string }) => c.path === 'layout/layout.json.gz')]) {
      ref.compressedBytes = gz.length;
      ref.uncompressedBytes = text.length;
      ref.sha256 = createHash('sha256').update(text).digest('hex');
    }
    writeFileSync(manifestPath(), JSON.stringify(m));
    expect(await codesFor(out())).toEqual(['NOT_CANONICAL']);
  });

  it('a chunk replaced by a symlink', async () => {
    const target = path.join(work, 'elsewhere.json.gz');
    writeFileSync(target, readFileSync(path.join(out(), 'history', 'history.json.gz')));
    rmSync(path.join(out(), 'history', 'history.json.gz'));
    try {
      symlinkSync(target, path.join(out(), 'history', 'history.json.gz'));
    } catch {
      return; // Creating symlinks needs privileges on some Windows setups; covered on Linux CI.
    }
    expect(await codesFor(out())).toEqual(['CHUNK_MISSING']);
  });
});

describe('safe, atomic output', () => {
  it('refuses a non-empty directory unless replacing, and never replaces a non-artifact', async () => {
    mkdirSync(out());
    writeFileSync(path.join(out(), 'notes.txt'), 'mine');
    await expect(writeArtifactDirectory(pack(), out())).rejects.toMatchObject({ code: 'OUTPUT_EXISTS' });
    await expect(writeArtifactDirectory(pack(), out(), { replace: true })).rejects.toMatchObject({ code: 'OUTPUT_NOT_ARTIFACT' });
    expect(readFileSync(path.join(out(), 'notes.txt'), 'utf8')).toBe('mine');
  });

  it('replaces a previous artifact and leaves no staging or backup behind', async () => {
    await writeArtifactDirectory(pack(), out());
    const result = await writeArtifactDirectory(pack(), out(), { replace: true });
    expect(result.replaced).toBe(true);
    expect(readdirSync(work)).toEqual(['atlas-output']);
    expect((await readArtifactDirectory(out())).ok).toBe(true);
  });

  it('refuses to write over the analyzed repository or its parents', async () => {
    const repo = path.join(work, 'repo');
    mkdirSync(repo);
    await expect(writeArtifactDirectory(pack(), repo, { protectedPaths: [repo] })).rejects.toMatchObject({ code: 'OUTPUT_UNSAFE' });
    await expect(writeArtifactDirectory(pack(), work, { protectedPaths: [repo] })).rejects.toMatchObject({ code: 'OUTPUT_UNSAFE' });
  });

  it('recovers from a crash before publication: previous output intact, staging discarded', async () => {
    await writeArtifactDirectory(pack(), out());
    const before = readFileSync(path.join(out(), 'manifest.json'));
    await writeArtifactDirectory(pack(), out(), { replace: true, crashAt: 'after-staging' });
    expect(readdirSync(work).some((e) => e.includes('atlas-staging'))).toBe(true);
    expect(readFileSync(path.join(out(), 'manifest.json')).equals(before)).toBe(true);
    await writeArtifactDirectory(pack(), out(), { replace: true });
    expect(readdirSync(work)).toEqual(['atlas-output']);
  });

  it('recovers from a crash mid-swap by restoring the backup', async () => {
    await writeArtifactDirectory(pack(), out());
    await writeArtifactDirectory(pack(), out(), { replace: true, crashAt: 'after-backup' });
    expect(existsSync(out())).toBe(false);
    const recovery = await recoverInterruptedWrite(out());
    expect(recovery.restored).toBe(true);
    expect((await readArtifactDirectory(out())).ok).toBe(true);
    expect(readdirSync(work)).toEqual(['atlas-output']);
  });
});
