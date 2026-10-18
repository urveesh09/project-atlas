import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, realpath, symlink, chmod, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error Operator entrypoints are plain Node scripts, outside the TS build.
import { archiveName, command, digestFile, privateDirectory, privateFile, pruneBackups, validateService, RETENTION_MS } from '../../../deploy/production/backup.mjs';
// @ts-expect-error Operator entrypoints are plain Node scripts, outside the TS build.
import { nativeConnection, verifyArchive } from '../../../deploy/production/restore-drill.mjs';

const directories: string[] = [];
async function temp() { const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'atlas-backup-'))); directories.push(dir); await chmod(dir, 0o700); return dir; }
async function file(dir: string, name: string, content = 'private') { const target = path.join(dir, name); await writeFile(target, content, { mode: 0o600 }); return target; }
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('private backup policy', () => {
  it('names archives in UTC with independent collision-resistant suffixes', () => {
    const stamp = new Date('2026-10-18T12:34:56.789Z');
    expect(archiveName(stamp)).toMatch(/^atlas-20261018T123456Z-[0-9a-f]{16}$/);
    expect(archiveName(stamp)).not.toBe(archiveName(stamp));
  });
  it('expires only owned names at the seven-day boundary, including partial files', async () => {
    const dir = await temp(), now = Date.parse('2026-10-18T12:00:00Z');
    const old = ['atlas-20261011T120000Z-0123456789abcdef.dump', 'atlas-20261011T120000Z-0123456789abcdef.json', 'atlas-20261010T120000Z-0123456789abcdef.dump.partial'];
    const keep = ['atlas-20261011T120001Z-0123456789abcdef.dump', 'atlas-20260230T120000Z-0123456789abcdef.dump', 'operator-notes', 'atlas-20261011T120000Z-wrong.dump'];
    for (const name of [...old, ...keep]) await file(dir, name);
    expect(RETENTION_MS).toBe(604800000);
    expect(await pruneBackups(dir, now)).toBe(3);
    expect((await readdir(dir)).sort()).toEqual(keep.sort());
    await expect(pruneBackups(dir, NaN)).rejects.toThrow('clock');
  });
  it('rejects relative paths and directories in place of private files', async () => {
    await expect(privateDirectory('.')).rejects.toThrow();
    await expect(privateFile(await temp())).rejects.toThrow();
    await expect(privateFile('relative')).rejects.toThrow();
  });
  it.skipIf(process.platform === 'win32')('rejects permissive directories/files and symlinks, without deleting targets', async () => {
    const dir = await temp(), outside = await temp();
    const target = await file(outside, 'target');
    const link = path.join(dir, 'atlas-20260101T000000Z-0123456789abcdef.dump');
    await symlink(target, link);
    await expect(pruneBackups(dir)).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe('private');
    await chmod(target, 0o644); await expect(privateFile(target)).rejects.toThrow();
    await chmod(outside, 0o755); await expect(privateDirectory(outside)).rejects.toThrow();
  });
  it('requires a matching custom archive, hash, size and manifest name', async () => {
    const dir = await temp(), archive = await file(dir, 'fixture.dump', 'PGDMP-test');
    const digest = await digestFile(archive);
    const manifest = { format: 'atlas.pg-backup/1', archive: 'fixture.dump', archiveBytes: digest.bytes, archiveSha256: digest.sha256 };
    const metadata = await file(dir, 'fixture.json', JSON.stringify(manifest));
    expect(await verifyArchive(archive)).toEqual(digest);
    for (const patch of [{ archiveBytes: 1 }, { archive: '../fixture.dump' }, { format: 'unknown' }, { archiveSha256: '0'.repeat(64) }]) {
      await writeFile(metadata, JSON.stringify({ ...manifest, ...patch }));
      await expect(verifyArchive(archive)).rejects.toThrow();
    }
    await writeFile(metadata, JSON.stringify(manifest)); await writeFile(archive, 'PGDMP-changed');
    await expect(verifyArchive(archive)).rejects.toThrow();
  });
  it('rejects non-custom and oversized metadata before restoration', async () => {
    const dir = await temp(), archive = await file(dir, 'fixture.dump', 'plain SQL');
    const digest = await digestFile(archive);
    const metadata = await file(dir, 'fixture.json', JSON.stringify({ format: 'atlas.pg-backup/1', archive: 'fixture.dump', archiveBytes: digest.bytes, archiveSha256: digest.sha256 }));
    await expect(verifyArchive(archive)).rejects.toThrow();
    await writeFile(metadata, ' '.repeat(4097)); await expect(verifyArchive(archive)).rejects.toThrow();
  });
  it('requires a single restricted service with hostname-verified TLS', async () => {
    const dir = await temp(), cert = path.join(dir, 'ca.crt');
    const good = `[atlas_backup]\nhost=db.example.org\ndbname=atlas\nuser=atlas_backup\nsslmode=verify-full\nsslrootcert=${cert}\n`;
    const service = await file(dir, 'service', good); await validateService(service);
    for (const bad of [good.replace('verify-full', 'prefer'), good.replace('db.example.org', '/run/postgresql'), good + 'password=secret\n', good + '[other]\n', good + 'host=other\n', good.replace(cert, 'relative')]) {
      await writeFile(service, bad); await expect(validateService(service)).rejects.toThrow();
    }
  });
});

describe('native client isolation', () => {
  it('requires verified TLS, maintenance database and a small allowlist of options', () => {
    const url = new URL('postgres://backup:p%3Aa%5Css@db.example.org:5433/postgres?sslmode=verify-full&sslrootcert=/etc/root.crt');
    const result = nativeConnection(url, '/private/pass', { PATH: '/bin', PGPASSWORD: 'do-not-inherit', PGOPTIONS: 'do-not-inherit' });
    expect(result.pgpass).toBe('db.example.org:5433:*:backup:p\\:a\\\\ss\n');
    expect(result.env.PGSSLMODE).toBe('verify-full');
    expect(result.env.PGPASSWORD).toBeUndefined(); expect(result.env.PGOPTIONS).toBeUndefined();
    for (const value of ['postgres://x:y@db/atlas?sslmode=verify-full', 'postgres://x:y@db/postgres?sslmode=require', 'postgres://x:y@db/postgres?sslmode=verify-full&sslmode=require', 'postgres://x:y@db/postgres?sslmode=verify-full&options=bad', 'postgres://x:p%0Ass@db/postgres?sslmode=verify-full']) {
      expect(() => nativeConnection(new URL(value), '/private/pass', {})).toThrow();
    }
  });
  it('waits for a timed-out child to exit before rejecting', async () => {
    const dir = await temp(), pidFile = path.join(dir, 'pid');
    await expect(command(process.execPath, ['-e', "require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)", pidFile], { env: process.env, timeoutMs: 1000 })).rejects.toThrow('deadline');
    const pid = Number(await readFile(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });
  it('bounds output and does not disclose diagnostics in thrown errors', async () => {
    await expect(command(process.execPath, ['-e', "process.stdout.write('x'.repeat(100000))"], { env: process.env })).rejects.toThrow('limit');
    await expect(command(process.execPath, ['-e', "process.stderr.write('private-password');process.exitCode=1"], { env: process.env })).rejects.toThrow('PostgreSQL command failed or reported warnings');
    await expect(command(process.execPath, ['-e', "process.stderr.write('warning')"], { env: process.env, strictStderr: true })).rejects.toThrow('warnings');
    expect(await command(process.execPath, ['-e', "console.log('ok')"], { env: process.env })).toBe('ok');
  });
});
