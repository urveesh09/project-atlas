/** Authored test data only. Runs inside the throwaway M4.3 tooling container. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmod, chown, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { backup, archiveName, digestFile, pruneBackups, RETENTION_MS } from '/operator/backup.mjs';
import { restoreDrill, verifyArchive } from '/operator/restore-drill.mjs';
const require = createRequire('/atlas/package.json');
const control = await import(require.resolve('@atlas/control'));
const privateWrite = (file, data) => writeFile(file, data, { mode: 0o600 });
if (process.argv[2] === '--prepare') {
  await mkdir('/work/backups', { mode: 0o700 }); await mkdir('/work/drills', { mode: 0o700 });
  const password = randomBytes(32).toString('hex');
  await privateWrite('/tls/password', password);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', '/tls/postgres.key', '-out', '/tls/postgres.crt', '-subj', '/CN=postgres', '-addext', 'subjectAltName=DNS:postgres', '-addext', 'basicConstraints=critical,CA:TRUE'], { stdio: 'ignore' });
  await privateWrite('/work/ca.crt', await readFile('/tls/postgres.crt'));
  await privateWrite('/work/admin', `postgres://postgres:${password}@postgres:5432/postgres?sslmode=verify-full&sslrootcert=/work/ca.crt`);
  await privateWrite('/work/backup-password', randomBytes(32).toString('hex'));
  for (const name of await readdir('/tls')) { await chown(`/tls/${name}`, 70, 70); await chmod(`/tls/${name}`, 0o600); }
  await chown('/tls', 70, 70); await chmod('/tls', 0o700);
  for (const name of await readdir('/work')) await chown(`/work/${name}`, 10002, 10002);
  await chown('/work', 10002, 10002); await chmod('/work', 0o700);
  process.exit(0);
}
const steps = [];
const step = async (name, fn) => {
  const start = performance.now();
  try { const detail = await fn(); steps.push({ name, passed: true, ms: Math.round(performance.now() - start), ...(detail ? { detail } : {}) }); }
  catch { steps.push({ name, passed: false, ms: Math.round(performance.now() - start), ...(report ? { drill: report } : {}) }); throw new Error('Rehearsal step failed'); }
};
const admin = control.databasePool({ ATLAS_DATABASE_URL_FILE: '/work/admin' }, 1);
let source, report, passed = false;
const backupEnv = { PATH: process.env.PATH, ATLAS_BACKUP_DIR: '/work/backups', PGSERVICEFILE: '/work/service', PGPASSFILE: '/work/pgpass' };
const drillEnv = { PATH: process.env.PATH, ATLAS_WORKER_RUNTIME: '/atlas', ATLAS_DRILL_ROOT: '/work/drills', ATLAS_DRILL_ADMIN_URL_FILE: '/work/admin',
  // Poison inherited production configuration. Neither cleanup command may use this.
  ATLAS_STORAGE: 'file:/work/live-storage', ATLAS_S3_ENDPOINT: 'https://must-never-contact.invalid', ATLAS_S3_SECRET_ACCESS_KEY: 'never-use' };
let archive;
try {
  await step('verified TLS, current schema and authored lifecycle fixture', async () => {
    for (let i = 0; ; i++) {
      try { await admin.query('SELECT 1'); break; } catch { if (i >= 60) throw new Error('Database deadline'); await new Promise((r) => setTimeout(r, 500)); }
    }
    await admin.query('CREATE DATABASE atlas_source');
    const url = new URL((await readFile('/work/admin', 'utf8')).trim()); url.pathname = '/atlas_source';
    await privateWrite('/work/source', url.toString());
    source = control.databasePool({ ATLAS_DATABASE_URL_FILE: '/work/source' }, 2); await control.migrate(source);
    const backupPassword = await readFile('/work/backup-password', 'utf8');
    assert(/^[a-f0-9]{64}$/.test(backupPassword));
    await source.query(`CREATE ROLE atlas_backup LOGIN PASSWORD '${backupPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
    await source.query('GRANT CONNECT ON DATABASE atlas_source TO atlas_backup; GRANT USAGE ON SCHEMA public TO atlas_backup; GRANT SELECT ON ALL TABLES IN SCHEMA public TO atlas_backup');
    await privateWrite('/work/service', '[atlas_backup]\nhost=postgres\nport=5432\ndbname=atlas_source\nuser=atlas_backup\nsslmode=verify-full\nsslrootcert=/work/ca.crt\n');
    await privateWrite('/work/pgpass', `postgres:5432:atlas_source:atlas_backup:${backupPassword}\n`);
    await mkdir('/work/live-storage', { mode: 0o700 }); await privateWrite('/work/live-storage/must-survive', 'live-storage-marker');
    for (let n = 1; n <= 7; n++) {
      const hex = n.toString(16).padStart(32, '0'), id = `job_${hex}`, upload = `up_${hex}`, key = hex.repeat(2);
      await source.query('INSERT INTO repositories(github_id,canonical_name,visibility_checked_at,revoked_at) VALUES($1,$2,clock_timestamp(),CASE WHEN $1=$3 THEN clock_timestamp() END)', [String(n), `fixture/repository-${n}`, '7']);
      await source.query("INSERT INTO jobs(id,input_hash,input,capability_hash,state,github_id,commit_oid) VALUES($1,$2,'{}',$2,'READY',$3,$4)", [id, key, String(n), 'a'.repeat(40)]);
      await source.query("INSERT INTO uploads(id,job_id,generation,purpose,state,bytes) VALUES($1,$2,0,'artifact','live',1)", [upload, id]);
      await source.query(`INSERT INTO artifact_objects(content_key,manifest_key,version,options_digest,boundary_digest,compressed_bytes,verified,expires_at,upload_id,github_id,commit_oid,status,cache_key)
        VALUES($1,$2,'1.4.0',$1,$1,1,true,clock_timestamp()+interval '1 day',$3,$4,$5,'complete',$1)`, [key, `uploads/${upload}/manifest.json`, upload, String(n), 'a'.repeat(40)]);
      await source.query(`INSERT INTO publications(analysis_id,job_id,github_id,commit_oid,content_key,expires_at,deleted_at,revoked_at)
        VALUES($1,$2,$3,$4,$5,CASE WHEN $3='3' THEN clock_timestamp()-interval '1 day' ELSE clock_timestamp()+interval '1 day' END,
          CASE WHEN $3='1' THEN clock_timestamp() END,CASE WHEN $3='2' THEN clock_timestamp() END)`, [`analysis_${key}`, id, String(n), 'a'.repeat(40), key]);
    }
    await source.query("INSERT INTO jobs(id,input_hash,input,capability_hash,state) VALUES($1,$2,'{}',$2,'QUEUED')", [`job_${'f'.repeat(32)}`, 'f'.repeat(64)]);
    return { publications: 7, deleted: 1, revoked: 2, expiredAtSnapshot: 1, queuedJobs: 1 };
  });
  await step('read-only backup role cannot modify data', async () => {
    const url = new URL((await readFile('/work/source', 'utf8')).trim()); url.username = 'atlas_backup'; url.password = await readFile('/work/backup-password', 'utf8');
    await privateWrite('/work/readonly', url.toString());
    const pool = control.databasePool({ ATLAS_DATABASE_URL_FILE: '/work/readonly' }, 1);
    try { await assert.rejects(pool.query('DELETE FROM publications'), { code: '42501' }); await assert.rejects(pool.query('CREATE TABLE forbidden(id int)'), { code: '42501' }); } finally { await pool.end(); }
  });
  await step('streamed custom archive, private permissions and SHA-256 manifest', async () => {
    // pg_dump starts a consistent transaction after this update; the snapshot's expiry is
    // demonstrably in the future, and the restore is delayed until after that DB timestamp.
    await source.query("UPDATE publications SET expires_at=clock_timestamp()+interval '15 seconds' WHERE github_id='4'");
    const result = await backup(backupEnv); assert(result.archiveBytes > 0);
    const names = await readdir('/work/backups'); assert.equal(names.length, 2);
    archive = `/work/backups/${names.find((n) => n.endsWith('.dump'))}`;
    await verifyArchive(archive); assert.equal((await stat(archive)).mode & 0o777, 0o600);
    assert.equal((await stat('/work/backups')).mode & 0o777, 0o700);
    return result;
  });
  await step('bad credentials, TLS hostname and concurrent lock cannot publish a ready backup', async () => {
    const names = (await readdir('/work/backups')).sort();
    await privateWrite('/work/bad-pass', 'postgres:5432:atlas_source:atlas_backup:incorrect\n');
    await assert.rejects(backup({ ...backupEnv, PGPASSFILE: '/work/bad-pass' }));
    assert.deepEqual((await readdir('/work/backups')).sort(), names);
    await privateWrite('/work/wrong-host-service', (await readFile('/work/service', 'utf8')).replace('host=postgres\n', 'host=postgres-wrong\n'));
    // The alias reaches the same server; only certificate hostname verification fails.
    await privateWrite('/work/wrong-host-pass', (await readFile('/work/pgpass', 'utf8')).replace('postgres:', 'postgres-wrong:'));
    await assert.rejects(backup({ ...backupEnv, PGSERVICEFILE: '/work/wrong-host-service', PGPASSFILE: '/work/wrong-host-pass' }));
    assert.deepEqual((await readdir('/work/backups')).sort(), names);
    await mkdir('/work/backups/.atlas-backup.lock', { mode: 0o700 });
    await assert.rejects(backup(backupEnv)); await rm('/work/backups/.atlas-backup.lock', { recursive: true });
    assert.deepEqual((await readdir('/work/backups')).sort(), names);
  });
  await step('later deletion/cancellation and wall-clock expiry precede restore', async () => {
    await source.query("UPDATE publications SET deleted_at=clock_timestamp() WHERE github_id='6'");
    await source.query("UPDATE jobs SET state='CANCELLED' WHERE state='QUEUED'");
    const wait = +(await source.query("SELECT GREATEST(0,EXTRACT(EPOCH FROM (expires_at-clock_timestamp()))) AS seconds FROM publications WHERE github_id='4'")).rows[0].seconds;
    assert(wait < 20); if (wait > 0) await new Promise((r) => setTimeout(r, Math.ceil(wait * 1000) + 100));
  });
  await step('restore, quarantine, real sweep/reconcile and lifecycle denial', async () => {
    report = await restoreDrill(drillEnv, archive);
    assert.equal(report.passed, true, `Failed stage: ${report.failedStage}`); assert.equal(report.cleaned, true);
    assert.deepEqual(report.before, { publications: 7, deleted: 1, revoked: 2, expired: 2 });
    assert.equal(report.quarantined, 3); assert.equal(report.cancelledJobs, 1);
    assert.equal(report.checks.lifecycle.deniedPublications, 7);
    assert.equal(report.checks.storage.ownedProbe, true); assert.equal(report.checks.storage.orphanRemoved, true);
    assert.equal(report.checks.lifecycle.codes.ARTIFACT_DELETED, 1);
    assert.equal(report.checks.lifecycle.codes.ARTIFACT_EXPIRED, 2);
    assert.equal(report.checks.lifecycle.codes.ARTIFACT_REVOKED, 4);
    return report;
  });
  await step('source database and live storage unchanged; scratch databases removed', async () => {
    assert.equal(await readFile('/work/live-storage/must-survive', 'utf8'), 'live-storage-marker');
    assert.equal(+(await source.query('SELECT count(*) AS n FROM publications WHERE purged_at IS NOT NULL')).rows[0].n, 0);
    assert.equal(+(await source.query('SELECT count(*) AS n FROM publications WHERE deleted_at IS NOT NULL')).rows[0].n, 2);
    const job = (await source.query('SELECT state,generation,revision FROM jobs WHERE id=$1', [`job_${'f'.repeat(32)}`])).rows[0];
    assert.deepEqual(job, { state: 'CANCELLED', generation: 0, revision: 1 });
    assert.equal(+(await admin.query("SELECT count(*) AS n FROM pg_database WHERE datname LIKE 'atlas_restore_%'")).rows[0].n, 0);
    assert.deepEqual(await readdir('/work/drills'), []);
  });
  await step('corruption rejected before creating scratch database', async () => {
    const original = await readFile(archive); const corrupt = Buffer.from(original); corrupt[corrupt.length - 1] ^= 1;
    await privateWrite(archive, corrupt); await assert.rejects(restoreDrill(drillEnv, archive)); await privateWrite(archive, original);
    assert.equal(+(await admin.query("SELECT count(*) AS n FROM pg_database WHERE datname LIKE 'atlas_restore_%'")).rows[0].n, 0);
  });
  await step('native restore failure removes its scratch database and credentials', async () => {
    const original = await readFile(archive), metadata = archive.replace(/\.dump$/, '.json');
    const originalMetadata = await readFile(metadata);
    await privateWrite(archive, 'PGDMP-broken-archive');
    const digest = await digestFile(archive);
    await privateWrite(metadata, JSON.stringify({ format: 'atlas.pg-backup/1', archive: archive.split('/').at(-1), archiveBytes: digest.bytes, archiveSha256: digest.sha256 }));
    const failed = await restoreDrill(drillEnv, archive);
    assert.equal(failed.passed, false); assert.equal(failed.failedStage, 'restore'); assert.equal(failed.cleaned, true);
    assert.deepEqual(await readdir('/work/drills'), []);
    assert.equal(+(await admin.query("SELECT count(*) AS n FROM pg_database WHERE datname LIKE 'atlas_restore_%'")).rows[0].n, 0);
    await privateWrite(archive, original); await privateWrite(metadata, originalMetadata);
  });
  await step('seven-day retention prunes pairs and partials, preserving operator files', async () => {
    const old = archiveName(new Date(Date.now() - RETENTION_MS - 1000));
    for (const suffix of ['.dump', '.json', '.dump.partial']) await privateWrite(`/work/backups/${old}${suffix}`, 'expired');
    await privateWrite('/work/backups/operator-note', 'retain');
    assert.equal(await pruneBackups('/work/backups'), 3); await verifyArchive(archive);
    assert.equal(await readFile('/work/backups/operator-note', 'utf8'), 'retain');
  });
  passed = true;
} catch { passed = false; }
finally { await source?.end(); await admin.end(); }
console.log(JSON.stringify({ passed, steps }));
if (!passed) process.exitCode = 1;
