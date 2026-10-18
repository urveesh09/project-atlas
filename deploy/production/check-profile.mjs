#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { BlockList, isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const immutable = (image) => typeof image === 'string' && /^(?:sha256:[a-f0-9]{64}|[^\s]+@sha256:[a-f0-9]{64})$/.test(image);
const httpsOrigin = (value) => { const u = new URL(value); assert(u.protocol === 'https:' && u.origin === value && !u.username && !u.password, 'exact HTTPS origin required'); return u; };
const subnet = (cidr) => {
  const [address, prefix] = cidr.split('/');
  assert(isIP(address) === 4 && /^\d+$/.test(prefix) && +prefix >= 8 && +prefix <= 30, 'IPv4 subnet required');
  const list = new BlockList(); list.addSubnet(address, +prefix, 'ipv4'); return list;
};

/** Check the resolved Compose model, not string matches against a YAML template. */
export function assertProductionProfile(config) {
  for (const name of ['api', 'migrate', 'proxy']) {
    const service = config.services[name];
    assert(service && immutable(service.image), `${name}: immutable image required`);
    assert(service.read_only === true && service.user === '10001:10001', `${name}: non-root read-only service required`);
    assert.deepEqual(service.cap_drop, ['ALL']);
    assert(!service.cap_add?.length && service.security_opt.includes('no-new-privileges:true'));
    assert(!service.privileged && service.network_mode !== 'host' && service.pid !== 'host' && service.ipc !== 'host');
    assert(service.environment.ATLAS_DEVELOPMENT === undefined && service.environment.ATLAS_ACQUISITION !== 'fixture' && service.environment.ATLAS_SANDBOX !== 'process');
    assert(!service.volumes?.some((v) => /docker\.sock|\/var\/run/.test(`${v.source ?? ''} ${v.target ?? ''}`)), `${name}: host control socket forbidden`);
    for (const [key, value] of Object.entries(service.environment)) {
      if (/PASSWORD|SECRET|TOKEN|DATABASE_URL|ACCESS_KEY_ID/.test(key)) assert(key.endsWith('_FILE') && String(value).startsWith('/run/secrets/'), `${name}: secret file required`);
    }
    if (name !== 'proxy') {
      assert(!service.ports?.length && service.network_mode !== 'host', 'only proxy may publish ports');
      assert(!service.volumes?.length, 'API/migration receive only named file secrets, no host volumes');
    }
  }
  const api = config.services.api, proxy = config.services.proxy;
  const origin = httpsOrigin(api.environment.ATLAS_PUBLIC_ORIGIN);
  httpsOrigin(api.environment.ATLAS_S3_ENDPOINT);
  assert.equal(proxy.environment.ATLAS_DOMAIN, origin.hostname);
  assert.equal(api.environment.ATLAS_STORAGE, 's3');
  const address = proxy.networks.api.ipv4_address;
  assert.equal(api.environment.ATLAS_TRUSTED_PROXIES, address);
  const pool = config.networks.api.ipam.config[0];
  assert(subnet(pool.subnet).check(address, 'ipv4'), 'proxy must be inside API subnet');
  assert(!subnet(pool.ip_range).check(address, 'ipv4'), 'proxy must be outside dynamic allocation pool');
  for (const s of Object.values(config.secrets)) assert(path.isAbsolute(s.file), 'absolute secret file paths required');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert(process.argv.length === 4 && process.argv[2] === '--env-file' && path.isAbsolute(process.argv[3]), 'absolute --env-file required');
    const yaml = fileURLToPath(new URL('./compose.yaml', import.meta.url));
    const model = execFileSync('docker', ['compose', '-f', yaml, '--env-file', process.argv[3], '--profile', 'api-host', 'config', '--format', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, maxBuffer: 1024 * 1024 });
    assertProductionProfile(JSON.parse(model));
    console.log('atlas.production.profile-valid');
  } catch {
    // Resolved config and environment must never be copied into operator logs.
    console.error('atlas.production.profile-invalid');
    process.exitCode = 1;
  }
}
