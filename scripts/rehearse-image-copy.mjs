#!/usr/bin/env node
/** Exercise publication without a public registry, credential or listening host port. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { copyGraph, fileDigest, inspectArchive, policy, run, writeJson } from './image-supply-chain.mjs';
const [archive, evidenceFile, revision] = process.argv.slice(2);
assert(process.argv.length === 5);
const evidence = JSON.parse(readFileSync(evidenceFile, 'utf8'));
assert(evidence.passed && evidence.revision === revision);
assert.equal(fileDigest(archive), evidence.archiveSha256);
inspectArchive(archive, evidence.digest, revision);
const id = `atlas-image-rehearsal-${randomBytes(12).toString('hex')}`, label = `atlas.image-rehearsal=${id}`;
const docker = (args) => run('docker', args);
let network = false, passed = false, cleaned = false;
try {
  docker(['network', 'create', '--internal', '--label', label, id]); network = true;
  docker(['run', '--detach', '--name', id, '--label', label, '--network', id, '--network-alias', 'registry',
    '--read-only', '--user=65532:65532', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
    '--tmpfs', '/var/lib/registry:rw,nosuid,nodev,noexec,size=1073741824,mode=1777', '--env', 'REGISTRY_LOG_LEVEL=error', policy.registryFixture]);
  // Registry startup is local; retry just its readiness, never retry the scan or publication.
  for (let i = 0; ; i++) {
    try { docker(['run', '--rm', '--label', label, '--network', id, policy.cacheInitializer, 'node', '-e', "fetch('http://registry:5000/v2/',{signal:AbortSignal.timeout(2000)}).then(r=>{if(r.status!==200)process.exit(1)}).catch(()=>process.exit(1))"]); break; }
    catch { if (i === 20) throw new Error('Registry readiness deadline'); }
  }
  assert.equal(copyGraph(archive, evidence.digest, 'registry:5000/atlas-api:candidate', id), evidence.digest);
  passed = true;
} finally {
  try {
    for (const container of docker(['ps', '--all', '--quiet', '--filter', `label=${label}`]).toString().trim().split(/\s+/).filter(Boolean)) {
      assert.equal(JSON.parse(docker(['inspect', container]))[0].Config.Labels['atlas.image-rehearsal'], id); docker(['rm', '--force', container]);
    }
    if (network) { assert.equal(JSON.parse(docker(['network', 'inspect', id]))[0].Labels['atlas.image-rehearsal'], id); docker(['network', 'rm', id]); }
    cleaned = true;
  } finally { writeJson(path.join(path.dirname(evidenceFile), 'copy.json'), { passed: passed && cleaned, cleaned, digest: evidence.digest, portsPublished: 0, publicRegistry: false }); }
}
assert(passed && cleaned); console.log('Exact scanned OCI graph copied and verified; all owned resources removed.');
