#!/usr/bin/env node
/** M4.3 physical gate. No host ports, live credentials, live storage or production DB. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), opt = (name) => args[args.indexOf(name) + 1];
assert(args.includes('--tools-image') && args.includes('--out') && args.length === 4);
const image = opt('--tools-image'); assert(/^sha256:[a-f0-9]{64}$/.test(image));
const pg = 'postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24';
const id = `atlas-m43-${randomBytes(8).toString('hex')}`, label = `atlas.backup-drill=${id}`;
const docker = (params, options = {}) => execFileSync('docker', params, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
const report = { task: 'M4.3', started: new Date().toISOString(), sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()), images: { tools: image, postgres: pg },
  sourceSha256: Object.fromEntries(['deploy/production/backup.mjs', 'deploy/production/restore-drill.mjs', 'deploy/production/backup-tools.Dockerfile',
    'deploy/production/atlas-backup.service', 'deploy/production/atlas-backup.timer', 'deploy/production/atlas-backup-prune.service', 'deploy/production/atlas-backup-prune.timer',
    'deploy/production/backup-role.sql', 'deploy/production/pg_service.conf.example', 'deploy/production/pgpass.example',
    'scripts/fixtures/backup-rehearsal.mjs', 'scripts/backup-rehearsal.mjs'].map((name) => [name, createHash('sha256').update(readFileSync(path.join(root, name))).digest('hex')])), passed: false, cleaned: false, steps: [] };
const owned = [];
const fixture = path.join(root, 'scripts/fixtures/backup-rehearsal.mjs').replaceAll('\\', '/');
const mounts = ['--mount', `type=volume,source=${id}-work,target=/work`, '--mount', `type=volume,source=${id}-tls,target=/tls`, '--mount', `type=bind,source=${fixture},target=/rehearsal.mjs,readonly`];
try {
  docker(['network', 'create', '--internal', '--label', label, id]); owned.push(['network', id]);
  for (const suffix of ['work', 'tls']) { docker(['volume', 'create', '--label', label, `${id}-${suffix}`]); owned.push(['volume', `${id}-${suffix}`]); }
  docker(['run', '--rm', '--name', `${id}-prepare`, '--label', label, '--network=none', '--user=0:0', ...mounts, image, 'node', '/rehearsal.mjs', '--prepare']);
  docker(['run', '--detach', '--name', id, '--label', label, '--network', id, '--network-alias', 'postgres', '--network-alias', 'postgres-wrong',
    '--mount', `type=volume,source=${id}-tls,target=/tls,readonly`, '--tmpfs', '/var/lib/postgresql/data',
    '--env', 'POSTGRES_PASSWORD_FILE=/tls/password', pg, '-c', 'ssl=on', '-c', 'ssl_cert_file=/tls/postgres.crt', '-c', 'ssl_key_file=/tls/postgres.key']);
  // Capture JSON even on assertion failure; never print raw database diagnostics/secrets.
  let output;
  try { output = docker(['run', '--rm', '--name', `${id}-tools`, '--label', label, '--network', id, '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', ...mounts, image, 'node', '/rehearsal.mjs']); }
  catch (error) { output = error.stdout?.toString().trim(); }
  const result = JSON.parse(output); report.steps = result.steps; report.passed = result.passed;
} catch (error) { report.failure = error.code ?? error.name; }
finally {
  let cleaned = true;
  // Include an auto-remove helper whose Docker client timed out while it was running.
  // Select only this run's random label, then independently verify ownership before rm.
  try {
    const containers = docker(['ps', '--all', '--quiet', '--filter', `label=${label}`]).split(/\s+/).filter(Boolean);
    for (const container of containers) {
      const info = JSON.parse(docker(['inspect', container]))[0];
      assert.equal(info.Config.Labels['atlas.backup-drill'], id);
      docker(['container', 'rm', '--force', container]);
    }
  } catch { cleaned = false; }
  for (const [type, name] of owned.reverse()) {
    try {
      const info = JSON.parse(docker([type, 'inspect', name]))[0];
      assert.equal(info.Labels['atlas.backup-drill'], id);
      docker([type, 'rm', name]);
    } catch { cleaned = false; }
  }
  report.cleaned = cleaned; report.passed &&= cleaned; report.finished = new Date().toISOString();
  const out = path.resolve(opt('--out')); mkdirSync(path.dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
}
for (const step of report.steps) console.log(`${step.passed ? 'PASS' : 'FAIL'} ${step.name}`);
console.log(report.passed ? 'Backup/restore rehearsal passed; all owned resources removed.' : 'Backup/restore rehearsal failed; inspect the sanitized report.');
if (!report.passed) process.exitCode = 1;
