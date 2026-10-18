#!/usr/bin/env node
/** Never restores over an existing database or points cleanup at production storage. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, open, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { command, digestFile, pgTools, privateDirectory, privateFile } from './backup.mjs';

export async function verifyArchive(archive) {
  await privateDirectory(path.dirname(archive));
  const metadata = archive.replace(/\.dump$/, '.json');
  assert(metadata !== archive, 'Custom archive required');
  const stat = await privateFile(metadata); assert(stat.size <= 4096);
  const manifest = JSON.parse(await readFile(metadata, 'utf8'));
  assert.equal(manifest.format, 'atlas.pg-backup/1');
  assert.equal(manifest.archive, path.basename(archive));
  assert(/^[a-f0-9]{64}$/.test(manifest.archiveSha256));
  const digest = await digestFile(archive);
  assert.equal(digest.bytes, manifest.archiveBytes); assert.equal(digest.sha256, manifest.archiveSha256);
  const handle = await open(archive, 'r');
  try { const header = Buffer.alloc(5); assert.equal((await handle.read(header, 0, 5, 0)).bytesRead, 5); assert.equal(header.toString(), 'PGDMP'); } finally { await handle.close(); }
  return digest;
}

/** Pass authentication through a private pgpass, never a URL in process arguments. */
export function nativeConnection(url, passfile, env) {
  assert(['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname && url.username && url.pathname === '/postgres');
  assert.equal(url.searchParams.get('sslmode'), 'verify-full', 'Verified PostgreSQL TLS is required');
  const allowed = new Map([['sslmode', 'PGSSLMODE'], ['sslrootcert', 'PGSSLROOTCERT'], ['sslcert', 'PGSSLCERT'], ['sslkey', 'PGSSLKEY']]);
  const result = { PATH: env.PATH, ...(env.SystemRoot ? { SystemRoot: env.SystemRoot } : {}),
    PGHOST: url.hostname.replace(/^\[|\]$/g, ''), PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username),
    PGPASSFILE: passfile, PGCONNECT_TIMEOUT: '10', PGAPPNAME: 'atlas-restore-drill', LC_ALL: 'C' };
  const seen = new Set();
  for (const [key, value] of url.searchParams) { assert(allowed.has(key) && !seen.has(key), 'Unsupported connection option'); seen.add(key); result[allowed.get(key)] = value; }
  const escape = (s) => s.replaceAll('\\', '\\\\').replaceAll(':', '\\:');
  assert(![result.PGHOST, result.PGUSER, decodeURIComponent(url.password)].some((s) => /[\r\n\0]/.test(s)), 'Invalid credential characters');
  return { env: result, pgpass: [result.PGHOST, result.PGPORT, '*', result.PGUSER, decodeURIComponent(url.password)].map(escape).join(':') + '\n' };
}

export async function restoreDrill(env, archive) {
  const digest = await verifyArchive(archive);
  const base = await privateDirectory(env.ATLAS_DRILL_ROOT ?? '');
  const runtime = env.ATLAS_WORKER_RUNTIME ?? '/opt/atlas/current';
  assert(path.isAbsolute(runtime));
  const require = createRequire(path.join(runtime, 'package.json'));
  const control = await import(pathToFileURL(require.resolve('@atlas/control')).href);
  const { runOps } = await import(pathToFileURL(path.join(runtime, 'dist/ops.js')).href);
  const adminFile = env.ATLAS_DRILL_ADMIN_URL_FILE;
  await privateFile(adminFile);
  const adminUrl = new URL((await readFile(adminFile, 'utf8')).trim());
  const work = await mkdtemp(path.join(base, 'atlas-restore-'));
  const name = `atlas_restore_${randomBytes(16).toString('hex')}`;
  const nonce = randomBytes(32).toString('hex');
  const report = { format: 'atlas.restore-drill/1', archiveSha256: digest.sha256, archiveBytes: digest.bytes,
    started: new Date().toISOString(), passed: false, cleaned: false, checks: {} };
  const admin = control.databasePool({ ATLAS_DATABASE_URL_FILE: adminFile }, 1);
  let pool, session, created = false, guarded = false, stage = 'connection';
  try {
    const connection = nativeConnection(adminUrl, path.join(work, 'pgpass'), env);
    await writeFile(connection.env.PGPASSFILE, connection.pgpass, { mode: 0o600 });
    const tools = pgTools(env);
    assert(/^pg_restore \(PostgreSQL\) 17\./.test(await command(tools('pg_restore'), ['--version'], { env: connection.env, timeoutMs: 5000 })));
    stage = 'create-scratch';
    await admin.query(`CREATE DATABASE "${name}"`); created = true;
    const scratchUrl = new URL(adminUrl); scratchUrl.pathname = `/${name}`;
    const scratchFile = path.join(work, 'database_url');
    await writeFile(scratchFile, scratchUrl.toString(), { mode: 0o600 });
    pool = control.databasePool({ ATLAS_DATABASE_URL_FILE: scratchFile }, 2);
    await pool.query('CREATE TABLE atlas_restore_guard (nonce text NOT NULL)');
    await pool.query('INSERT INTO atlas_restore_guard VALUES($1)', [nonce]); guarded = true;
    const nativeEnv = { ...connection.env, PGDATABASE: name };
    // Confirm both clients reach the newly-created database before running any archive SQL.
    assert.equal(await command(tools('psql'), ['-X', '-A', '-t', '--no-password', '-c', 'SELECT nonce FROM atlas_restore_guard'], { env: nativeEnv, timeoutMs: 15_000 }), nonce);
    stage = 'restore';
    await command(tools('pg_restore'), ['--no-password', '--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges', '--dbname', name, archive], { env: nativeEnv, stdout: 'ignore', strictStderr: true });
    assert(await control.migrationsCurrent(pool), 'Archive schema is incompatible with this runtime');
    report.checks.schema = true;
    session = await pool.connect();
    await session.query(`CREATE TEMP TABLE lifecycle_before AS
      SELECT p.analysis_id,p.deleted_at,p.revoked_at,p.expires_at,p.purged_at,r.revoked_at AS repository_revoked
      FROM publications p JOIN repositories r ON r.github_id=p.github_id`);
    report.before = (await session.query(`SELECT count(*)::int AS publications,
      count(*) FILTER(WHERE deleted_at IS NOT NULL)::int AS deleted,
      count(*) FILTER(WHERE revoked_at IS NOT NULL OR repository_revoked IS NOT NULL)::int AS revoked,
      count(*) FILTER(WHERE expires_at<=clock_timestamp())::int AS expired FROM lifecycle_before`)).rows[0];
    stage = 'quarantine';
    await session.query('BEGIN');
    // Old archives cannot remember later deletion/cancellation. Never resurrect their
    // active publications or queued jobs. Promotion is a separate operator decision.
    const quarantined = await session.query(`UPDATE publications SET revoked_at=clock_timestamp()
      WHERE deleted_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp() AND purged_at IS NULL`);
    const cancelled = await session.query(`WITH ended AS (
      UPDATE jobs SET state='CANCELLED',generation=generation+1,revision=revision+1,lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
      WHERE state NOT IN ('READY','PARTIAL','FAILED','CANCELLED') RETURNING id,revision,state)
      INSERT INTO job_events SELECT id,revision,'terminal',jsonb_build_object('jobId',id,'revision',revision,'state',state) FROM ended`);
    await session.query('UPDATE artifact_objects SET expires_at=LEAST(expires_at,clock_timestamp()),cache_key=NULL');
    await session.query("UPDATE uploads SET state='purging',updated_at=clock_timestamp() WHERE state<>'purged'");
    await session.query('COMMIT');
    report.quarantined = quarantined.rowCount; report.cancelledJobs = cancelled.rowCount;
    const storageRoot = await mkdtemp(path.join(work, 'storage-'));
    const store = new control.FileObjectStore(storageRoot);
    // Actual bytes for one restored upload and an independent unowned prefix prove
    // cleanup, rather than passing vacuously against an empty directory.
    const upload = (await pool.query('SELECT id FROM uploads ORDER BY id LIMIT 1')).rows[0]?.id;
    if (upload) await store.put(`uploads/${upload}/manifest.json`, Buffer.from('restore-drill-probe'));
    const orphan = `up_${randomBytes(16).toString('hex')}`;
    await store.put(`uploads/${orphan}/manifest.json`, Buffer.from('orphan-drill-probe'));
    const opsEnv = { ATLAS_DATABASE_URL_FILE: scratchFile, ATLAS_STORAGE: `file:${storageRoot}` };
    stage = 'cleanup';
    let sweeps = 0, reconciliations = 0, previousRemaining = Infinity;
    for (;;) {
      assert(++sweeps <= 10_000, 'Sweep did not converge');
      assert.equal(await runOps(opsEnv, ['sweep'], () => {}), 0);
      const remaining = +(await pool.query(`SELECT
        (SELECT count(*) FROM publications WHERE purged_at IS NULL)+
        (SELECT count(*) FROM artifact_objects WHERE purged_at IS NULL)+
        (SELECT count(*) FROM uploads WHERE state<>'purged') AS n`)).rows[0].n;
      if (!remaining) break;
      assert(remaining < previousRemaining, 'Sweep made no progress'); previousRemaining = remaining;
    }
    for (;;) {
      let result;
      assert(++reconciliations <= 10_000, 'Reconciliation did not converge');
      assert.equal(await runOps(opsEnv, ['reconcile-storage'], (line) => { result = JSON.parse(line); }), 0);
      if (result.orphans === 0) break;
    }
    assert.deepEqual(await store.list('uploads/'), []);
    report.checks.storage = { sweeps, reconciliations, ownedProbe: !!upload, orphanRemoved: true };
    stage = 'lifecycle';
    const changed = (await session.query(`SELECT count(*)::int AS n FROM lifecycle_before b
      LEFT JOIN publications p USING(analysis_id) LEFT JOIN repositories r ON r.github_id=p.github_id
      WHERE p.analysis_id IS NULL OR (b.deleted_at IS NOT NULL AND p.deleted_at IS DISTINCT FROM b.deleted_at)
        OR (b.revoked_at IS NOT NULL AND p.revoked_at IS DISTINCT FROM b.revoked_at)
        OR (b.repository_revoked IS NOT NULL AND r.revoked_at IS DISTINCT FROM b.repository_revoked)
        OR p.expires_at IS DISTINCT FROM b.expires_at OR (b.purged_at IS NOT NULL AND p.purged_at IS DISTINCT FROM b.purged_at)`)).rows[0].n;
    assert.equal(changed, 0, 'Restore/cleanup changed original lifecycle evidence');
    const publications = new control.PublicationStore(pool, store, { visibility: async () => { throw new Error('Drill must not contact GitHub'); } });
    let after = '', checked = 0; const codes = {};
    for (;;) {
      const rows = (await pool.query('SELECT analysis_id FROM publications WHERE analysis_id>$1 ORDER BY analysis_id LIMIT 500', [after])).rows;
      if (!rows.length) break;
      for (const { analysis_id: id } of rows) {
        let failure;
        try { await publications.authorize(id); } catch (error) { failure = error; }
        assert(failure?.status === 410, 'A restored publication became readable');
        codes[failure.code] = (codes[failure.code] ?? 0) + 1; checked++; after = id;
      }
    }
    assert.equal(checked, report.before.publications);
    assert.equal(+(await pool.query("SELECT count(*) AS n FROM jobs WHERE state NOT IN ('READY','PARTIAL','FAILED','CANCELLED')")).rows[0].n, 0);
    report.checks.lifecycle = { unchanged: true, deniedPublications: checked, codes, nonterminalJobs: 0 };
    report.passed = true;
  } catch { report.passed = false; report.failedStage = stage; }
  finally {
    if (session) { await session.query('ROLLBACK').catch(() => {}); session.release(); }
    try {
      if (created) {
        if (guarded) assert.equal((await pool.query('SELECT nonce FROM atlas_restore_guard')).rows[0]?.nonce, nonce);
        await pool?.end(); pool = null;
        await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      }
      await admin.end();
      // Only the exact fresh directory created above can be removed recursively.
      assert.equal(await realpath(work), work); assert.equal(path.dirname(work), base);
      assert(path.basename(work).startsWith('atlas-restore-'));
      await rm(work, { recursive: true }); report.cleaned = true;
    } catch { report.cleaned = false; report.passed = false; await pool?.end().catch(() => {}); await admin.end().catch(() => {}); }
    report.finished = new Date().toISOString();
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert(process.argv.length === 6 && process.argv[2] === '--archive' && process.argv[4] === '--out');
    const result = await restoreDrill(process.env, path.resolve(process.argv[3]));
    await writeFile(process.argv[5], `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    console.log(result.passed ? 'atlas.restore-drill.passed' : 'atlas.restore-drill.failed');
    if (!result.passed) process.exitCode = 1;
  } catch { console.error('atlas.restore-drill.failed'); process.exitCode = 1; }
}
