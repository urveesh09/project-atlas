#!/usr/bin/env node
/** Private, streaming PostgreSQL custom-format backups. Never reads repository data. */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const RETENTION_MS = 7 * 24 * 3600_000;
const NAME = /^atlas-(\d{8}T\d{6}Z)-[0-9a-f]{16}\.(dump|json)(\.partial)?$/;
export const archiveName = (now = new Date()) => `atlas-${now.toISOString().replaceAll(/[-:]/g, '').replace(/\.\d{3}/, '')}-${randomBytes(8).toString('hex')}`;

export async function privateDirectory(directory) {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== await realpath(directory)) throw new Error('Unsafe directory');
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))) throw new Error('Directory must be private and owned by this user');
  return directory;
}

export async function privateFile(file) {
  if (!path.isAbsolute(file)) throw new Error('Absolute private file required');
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('Private regular file required');
  return stat;
}

export async function digestFile(file) {
  await privateFile(file);
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk); bytes += chunk.length; }
  return { sha256: hash.digest('hex'), bytes };
}

export async function pruneBackups(directory, now = Date.now()) {
  if (!Number.isFinite(now)) throw new Error('Invalid retention clock');
  await privateDirectory(directory);
  let removed = 0;
  for (const name of await readdir(directory)) {
    const match = NAME.exec(name);
    if (!match) continue;
    const stamp = match[1];
    const date = Date.parse(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`);
    if (!Number.isFinite(date) || new Date(date).toISOString().replaceAll(/[-:]/g, '').replace(/\.\d{3}/, '') !== stamp || date > now - RETENTION_MS) continue;
    const file = path.join(directory, name);
    try {
      await privateFile(file); // Never traverse or remove an operator-supplied symlink.
      await unlink(file); removed++;
    } catch (error) { if (error.code !== 'ENOENT') throw error; } // An overlapping prune may win.
  }
  return removed;
}

/** Bounded diagnostics are consumed privately, never echoed with DB names or secrets. */
export function command(executable, args, { env, stdout, timeoutMs = 30 * 60_000, strictStderr = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, stdio: ['ignore', stdout ?? 'pipe', 'pipe'], windowsHide: true });
    let output = '', diagnostics = '', settled = false, failure;
    const finish = (error) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(output.trim()); };
    const stop = (message) => { failure ??= new Error(message); child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop('PostgreSQL command exceeded its deadline'), timeoutMs);
    child.stdout?.on('data', (data) => { if (!failure) output += data; if (output.length > 64 * 1024) stop('Command output exceeded limit'); });
    child.stderr.on('data', (data) => { if (!failure) diagnostics += data; if (diagnostics.length > 64 * 1024) stop('Command diagnostics exceeded limit'); });
    child.on('error', () => finish(new Error('PostgreSQL command could not start')));
    child.on('close', (code) => finish(failure ?? (code !== 0 || (strictStderr && diagnostics.length) ? new Error('PostgreSQL command failed or reported warnings') : null)));
  });
}

export function pgTools(env) {
  const bin = env.ATLAS_PG_BIN ?? '/usr/lib/postgresql/17/bin';
  if (!path.isAbsolute(bin)) throw new Error('Absolute PostgreSQL binary directory required');
  return (name) => path.join(bin, name);
}

/** Deliberately small libpq service-file subset: no includes, options or plaintext. */
export async function validateService(file) {
  const stat = await privateFile(file);
  if (stat.size > 16 * 1024) throw new Error('Service configuration too large');
  const values = new Map(); let section = false;
  const allowed = new Set(['host', 'port', 'dbname', 'user', 'sslmode', 'sslrootcert', 'sslcert', 'sslkey']);
  for (const raw of (await readFile(file, 'utf8')).split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    if (line === '[atlas_backup]' && !section) { section = true; continue; }
    const match = /^([a-z]+)\s*=\s*(\S+)$/.exec(line);
    if (!section || !match || !allowed.has(match[1]) || values.has(match[1])) throw new Error('Unsupported backup service configuration');
    values.set(match[1], match[2]);
  }
  if (values.get('sslmode') !== 'verify-full' || !/^[a-zA-Z0-9:._-]+$/.test(values.get('host') ?? '') ||
      (values.has('port') && !/^[1-9][0-9]{0,4}$/.test(values.get('port'))) || !path.isAbsolute(values.get('sslrootcert') ?? '') ||
      !['host', 'dbname', 'user'].every((key) => values.has(key))) throw new Error('Verified TLS service configuration required');
}

export async function backup(env) {
  const directory = await privateDirectory(env.ATLAS_BACKUP_DIR ?? '');
  const tools = pgTools(env);
  const childEnv = { PATH: env.PATH, ...(env.SystemRoot ? { SystemRoot: env.SystemRoot } : {}),
    PGSERVICE: 'atlas_backup', PGSERVICEFILE: env.PGSERVICEFILE, PGPASSFILE: env.PGPASSFILE,
    PGCONNECT_TIMEOUT: '10', PGAPPNAME: 'atlas-backup', LC_ALL: 'C' };
  await validateService(childEnv.PGSERVICEFILE); await privateFile(childEnv.PGPASSFILE);
  const lock = path.join(directory, '.atlas-backup.lock');
  await mkdir(lock, { mode: 0o700 }); // A stale lock requires explicit operator investigation.
  const base = path.join(directory, archiveName());
  const partial = `${base}.dump.partial`, manifestPartial = `${base}.json.partial`;
  let handle;
  try {
    const pruned = await pruneBackups(directory);
    const client = await command(tools('pg_dump'), ['--version'], { env: childEnv, timeoutMs: 5000 });
    if (!/^pg_dump \(PostgreSQL\) 17\./.test(client)) throw new Error('PostgreSQL 17 client required');
    handle = await open(partial, 'wx', 0o600);
    await command(tools('pg_dump'), ['--format=custom', '--no-password', '--lock-wait-timeout=10s'], { env: childEnv, stdout: handle.fd, strictStderr: true });
    await handle.sync(); await handle.close(); handle = null;
    await command(tools('pg_restore'), ['--list', partial], { env: childEnv, stdout: 'ignore', timeoutMs: 30_000, strictStderr: true });
    const digest = await digestFile(partial);
    const createdAt = new Date(Date.now()).toISOString();
    const manifest = { format: 'atlas.pg-backup/1', completedAt: createdAt, client,
      archive: path.basename(`${base}.dump`), archiveBytes: digest.bytes, archiveSha256: digest.sha256 };
    const metadata = await open(manifestPartial, 'wx', 0o600);
    try { await metadata.writeFile(`${JSON.stringify(manifest)}\n`); await metadata.sync(); } finally { await metadata.close(); }
    await rename(partial, `${base}.dump`);
    await rename(manifestPartial, `${base}.json`); // Only a complete pair is restorable.
    if (process.platform !== 'win32') { const parent = await open(directory, 'r'); try { await parent.sync(); } finally { await parent.close(); } }
    return { event: 'atlas.backup.completed', archiveBytes: digest.bytes, pruned };
  } finally {
    await handle?.close();
    for (const file of [partial, manifestPartial]) await unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(lock);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3 || !['--run', '--prune'].includes(process.argv[2])) throw new Error('Use --run or --prune');
    const result = process.argv[2] === '--run' ? await backup(process.env) : { event: 'atlas.backup.pruned', removed: await pruneBackups(process.env.ATLAS_BACKUP_DIR ?? '') };
    console.log(JSON.stringify(result));
  } catch { console.error('atlas.backup.failed'); process.exitCode = 1; }
}
