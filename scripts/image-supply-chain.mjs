#!/usr/bin/env node
/** M4.4: verify and scan immutable OCI archives before publication. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const policy = JSON.parse(readFileSync(path.join(root, 'deploy/image-policy.json'), 'utf8'));
const DIGEST = /^sha256:[0-9a-f]{64}$/;
export const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export function fileDigest(file) {
  const fd = openSync(file, 'r'), hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
  try { for (;;) { const size = readSync(fd, buffer); if (!size) break; hash.update(buffer.subarray(0, size)); } } finally { closeSync(fd); }
  return `sha256:${hash.digest('hex')}`;
}
export const run = (exe, args, options = {}) => execFileSync(exe, args, { cwd: root, windowsHide: true, timeout: 20 * 60_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...options });
const docker = (args, options) => run('docker', args, options);
const json = (bytes) => JSON.parse(bytes.toString('utf8'));
export const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

/** Read a named metadata entry, never extract an archive into the host filesystem. */
function entry(archive, name, limit = 32 * 1024 * 1024) {
  assert(name === 'index.json' || /^blobs\/sha256\/[0-9a-f]{64}$/.test(name));
  return run('tar', ['-xOf', archive, name], { maxBuffer: limit });
}
export function inspectArchive(archive, digest, revision) {
  assert(DIGEST.test(digest) && /^[a-f0-9]{40}$/.test(revision));
  const read = (descriptor) => {
    assert(DIGEST.test(descriptor.digest) && descriptor.size <= 32 * 1024 * 1024);
    const bytes = entry(archive, `blobs/sha256/${descriptor.digest.slice(7)}`);
    assert.equal(bytes.length, descriptor.size); assert.equal(sha256(bytes), descriptor.digest);
    return json(bytes);
  };
  const layout = json(entry(archive, 'index.json', 1024 * 1024));
  assert.equal(layout.manifests.length, 1);
  assert.equal(layout.manifests[0].digest, digest);
  const index = read(layout.manifests[0]);
  const images = index.manifests.filter((m) => m.platform?.os === 'linux' && m.platform?.architecture === 'amd64');
  const attestations = index.manifests.filter((m) => m.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest');
  assert.equal(index.manifests.length, 2, 'Only the scanned linux/amd64 platform is released');
  assert.equal(images.length, 1); assert.equal(attestations.length, 1);
  const manifest = read(images[0]), config = read(manifest.config);
  assert.equal(config.config.Labels['org.opencontainers.image.revision'], revision);
  assert.equal(config.os, 'linux'); assert.equal(config.architecture, 'amd64');
  assert.equal(config.config.User, '10001:10001');
  assert.equal(attestations[0].annotations['vnd.docker.reference.digest'], images[0].digest);
  const statements = read(attestations[0]).layers.map(read);
  return validateStatements({ digest, imageDigest: images[0].digest, configDigest: manifest.config.digest, statements });
}
export function validateStatements({ digest, imageDigest, configDigest, statements }) {
  assert(DIGEST.test(digest) && DIGEST.test(imageDigest) && DIGEST.test(configDigest));
  for (const s of statements) assert(s.subject?.some((subject) => subject.digest?.sha256 === imageDigest.slice(7)), 'Attestation subject mismatch');
  const sbom = statements.find((s) => s.predicateType === 'https://spdx.dev/Document')?.predicate;
  const provenance = statements.find((s) => /^https:\/\/slsa.dev\/provenance\/v(0\.2|1)$/.test(s.predicateType))?.predicate;
  assert(sbom?.spdxVersion?.startsWith('SPDX-2.') && sbom.packages?.length > 0, 'SPDX package inventory required');
  // BuildKit max mode includes the build graph; minimum provenance cannot satisfy this.
  const maxV02 = provenance?.buildType === 'https://mobyproject.org/buildkit@v1' && provenance.buildConfig;
  const definition = provenance?.buildDefinition;
  const maxV1 = definition?.buildType === 'https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md' && definition.internalParameters?.buildConfig;
  assert(maxV02 || maxV1, 'Max-mode BuildKit provenance required');
  return { digest, imageDigest, configDigest, sbom, provenance };
}
export function evaluateScan(report, exitCode, configDigest, now = Date.now()) {
  assert([0, 2].includes(exitCode), 'Scanner execution failed');
  assert.equal(report.descriptor?.name, 'grype'); assert.equal(report.descriptor.version, policy.scannerVersion);
  assert.equal(report.source?.target?.imageID, configDigest, 'Scanned image differs from attested image');
  assert(Array.isArray(report.matches) && Array.isArray(report.ignoredMatches));
  const db = report.descriptor.db?.status, built = Date.parse(db?.built);
  assert(db?.valid === true && Number.isFinite(built) && built <= now + 300_000 && now - built <= policy.maximumDatabaseAgeHours * 3600_000, 'Fresh valid database required');
  const configuration = report.descriptor.configuration;
  assert.equal(configuration['only-fixed'], true); assert.equal(configuration['fail-on-severity'], 'high');
  assert.deepEqual(configuration.exclude, []); assert.equal(configuration.search.scope, 'squashed');
  assert.equal(configuration.db['require-update-check'], true); assert.equal(configuration.db['validate-age'], true);
  const blocking = report.matches.filter((m) => ['High', 'Critical'].includes(m.vulnerability?.severity) && m.vulnerability.fix?.state === 'fixed');
  assert(!report.ignoredMatches.some((m) => ['High', 'Critical'].includes(m.vulnerability?.severity) && m.vulnerability.fix?.state === 'fixed'), 'Fixed high findings must not be suppressed');
  return { passed: exitCode === 0 && blocking.length === 0, database: { ...db, path: undefined }, matches: report.matches.length,
    suppressed: report.ignoredMatches.length, blocking: blocking.map((m) => ({ id: m.vulnerability.id, severity: m.vulnerability.severity, package: m.artifact.name, installed: m.artifact.version, fixed: m.vulnerability.fix.versions })) };
}

/** Scanner gets only a read-only image/config and a private throwaway disk cache. */
export function scanArchive(archive, out, configDigest) {
  mkdirSync(out, { recursive: true });
  const id = `atlas-scan-${randomBytes(12).toString('hex')}`, label = `atlas.image-scan=${id}`;
  let created = false, cleaned = false, result = { passed: false };
  const reportFile = path.join(out, 'grype.json'), logFile = path.join(out, 'grype.log');
  try {
    docker(['volume', 'create', '--label', label, id]); created = true;
    docker(['run', '--rm', '--name', `${id}-init`, '--label', label, '--network=none', '--read-only', '--cap-drop=ALL', '--cap-add=CHOWN',
      '--mount', `type=volume,source=${id},target=/cache`, policy.cacheInitializer, 'node', '-e', "require('fs').chmodSync('/cache',0o700);require('fs').chownSync('/cache',65532,65532)"]);
    const args = ['run', '--rm', '--name', id, '--label', label, '--read-only', '--user=65532:65532', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
      '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=1073741824,mode=1777', '--mount', `type=volume,source=${id},target=/cache`,
      '--mount', `type=bind,source=${path.resolve(archive)},target=/scan/image.tar,readonly`,
      '--mount', `type=bind,source=${path.join(root, 'deploy/grype.yaml')},target=/scan/config.yaml,readonly`,
      '--env', 'GRYPE_DB_CACHE_DIR=/cache', policy.scanner, 'oci-archive:/scan/image.tar', '--config', '/scan/config.yaml', '--only-fixed', '--fail-on', 'high', '--output', 'json'];
    const output = openSync(reportFile, 'wx'), diagnostics = openSync(logFile, 'wx'); let code = 0;
    try { docker(args, { stdio: ['ignore', output, diagnostics] }); } catch (error) { code = error.status ?? -1; }
    finally { closeSync(output); closeSync(diagnostics); }
    result = { ...evaluateScan(json(readFileSync(reportFile)), code, configDigest), scanner: policy.scanner, scannerVersion: policy.scannerVersion, exitCode: code };
  } finally {
    try {
      for (const container of docker(['ps', '--all', '--quiet', '--filter', `label=${label}`]).toString().trim().split(/\s+/).filter(Boolean)) {
        assert.equal(json(docker(['inspect', container]))[0].Config.Labels['atlas.image-scan'], id); docker(['rm', '--force', container]);
      }
      if (created) { assert.equal(json(docker(['volume', 'inspect', id]))[0].Labels['atlas.image-scan'], id); docker(['volume', 'rm', id]); }
      cleaned = true;
    } finally { writeJson(path.join(out, 'scan.json'), { format: 'atlas.image-scan/1', ...result, passed: result.passed && cleaned, cleaned }); }
  }
  return { ...result, passed: result.passed && cleaned, cleaned };
}

export function checkImage(archive, digest, revision, out) {
  const evidence = inspectArchive(archive, digest, revision);
  mkdirSync(out, { recursive: true });
  writeJson(path.join(out, 'sbom.spdx.json'), evidence.sbom); writeJson(path.join(out, 'buildkit-provenance.json'), evidence.provenance);
  const result = scanArchive(archive, out, evidence.configDigest);
  const summary = { format: 'atlas.release-image/1', revision, scannedAt: new Date().toISOString(),
    dirty: Boolean(run('git', ['status', '--porcelain']).toString().trim()), platform: policy.platform, digest, imageDigest: evidence.imageDigest, configDigest: evidence.configDigest,
    archiveSha256: fileDigest(archive), ...result };
  writeJson(path.join(out, 'image.json'), summary);
  assert(summary.passed, 'Image scan blocks publication; retained reports explain the findings');
  return summary;
}

export function copyGraph(archive, digest, target, localNetwork) {
  assert(DIGEST.test(digest));
  const copyId = `atlas-publish-${randomBytes(12).toString('hex')}`, copyLabel = `atlas.image-publish=${copyId}`;
  if (localNetwork) {
    assert(/^atlas-image-rehearsal-[a-f0-9]{24}$/.test(localNetwork));
    assert.equal(json(docker(['network', 'inspect', localNetwork]))[0].Labels['atlas.image-rehearsal'], localNetwork);
    assert(/^registry:5000\/atlas-(api|sandbox):candidate$/.test(target));
  } else assert(/^ghcr\.io\/urveesh09\/atlas-(api|sandbox):[0-9][0-9A-Za-z.-]*$/.test(target));
  const args = ['run', '--rm', '--label', copyLabel, '--read-only', `--user=${process.getuid?.() ?? 65532}:${process.getgid?.() ?? 65532}`, '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
    '--env', 'HOME=/tmp', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=67108864,mode=1777',
    '--mount', `type=bind,source=${path.resolve(archive)},target=/input/image.tar,readonly`];
  const connection = localNetwork ? ['--plain-http'] : ['--registry-config', '/auth/config.json'];
  const destination = localNetwork ? ['--to-plain-http'] : ['--to-registry-config', '/auth/config.json'];
  if (localNetwork) args.push('--network', localNetwork, '--label', `atlas.image-rehearsal=${localNetwork}`);
  else args.push('--mount', `type=bind,source=${path.resolve(process.env.DOCKER_CONFIG ?? path.join(os.homedir(), '.docker'), 'config.json')},target=/auth/config.json,readonly`);
  args.push(policy.publisher);
  try {
    docker([...args, 'cp', ...destination, '--from-oci-layout', `/input/image.tar@${digest}`, target]);
    const descriptor = json(docker([...args, 'manifest', 'fetch', ...connection, '--descriptor', target]));
    assert.equal(descriptor.digest, digest, 'Published digest changed');
  } finally {
    for (const container of docker(['ps', '--all', '--quiet', '--filter', `label=${copyLabel}`]).toString().trim().split(/\s+/).filter(Boolean)) {
      assert.equal(json(docker(['inspect', container]))[0].Config.Labels['atlas.image-publish'], copyId); docker(['rm', '--force', container]);
    }
  }
  return digest;
}

/** Publish the verified archive; never build again after scanning. */
export function publishImage(archive, evidenceFile, target, revision) {
  assert(/^ghcr\.io\/urveesh09\/atlas-(api|sandbox):[0-9][0-9A-Za-z.-]*$/.test(target));
  const evidence = json(readFileSync(evidenceFile));
  assert(evidence.passed && evidence.cleaned && evidence.revision === revision);
  assert.equal(fileDigest(archive), evidence.archiveSha256);
  const actual = inspectArchive(archive, evidence.digest, revision);
  assert.equal(actual.configDigest, evidence.configDigest); assert.equal(actual.imageDigest, evidence.imageDigest);
  assert(evaluateScan(json(readFileSync(path.join(path.dirname(evidenceFile), 'grype.json'))), evidence.exitCode, actual.configDigest).passed);
  return copyGraph(archive, evidence.digest, target);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, ...args] = process.argv.slice(2);
    if (mode === 'check' && args.length === 4) checkImage(path.resolve(args[0]), args[1], args[2], path.resolve(args[3]));
    else if (mode === 'publish' && args.length === 4) console.log(publishImage(path.resolve(args[0]), path.resolve(args[1]), args[2], args[3]));
    else throw new Error('Use check ARCHIVE DIGEST REVISION OUTDIR or publish ARCHIVE EVIDENCE TARGET REVISION');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
