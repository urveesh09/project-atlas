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
  // The owner's public-service texts (M4.6, ADR-077) arrive as mounted configs, never volumes.
  const legalTargets = (api.configs ?? []).map((c) => c.target);
  for (const name of ['ATLAS_PRIVACY_FILE', 'ATLAS_TERMS_FILE', 'ATLAS_TAKEDOWN_FILE']) {
    assert(legalTargets.includes(api.environment[name]), `${name} must name a mounted config`);
  }
  assert(/^(?:mailto:|https:\/\/)/.test(api.environment.ATLAS_CONTACT ?? ''), 'ATLAS_CONTACT must be a mailto: address or an https: page');
  assert(/^https:\/\//.test(api.environment.ATLAS_STATUS_URL ?? ''), 'ATLAS_STATUS_URL must be an https: page');
  for (const c of Object.values(config.configs ?? {})) assert(path.isAbsolute(c.file), 'absolute legal text paths required');
  // Optional monitoring (M4.2, ADR-073): inside the API's namespace, publishing nothing.
  const prometheus = config.services.prometheus;
  if (prometheus) {
    assert(immutable(prometheus.image), 'prometheus: immutable image required');
    assert.equal(prometheus.network_mode, 'service:api', 'prometheus must share the API network namespace');
    assert(!prometheus.ports?.length && !prometheus.networks, 'prometheus must not publish ports or join networks');
    assert(prometheus.read_only === true && typeof prometheus.user === 'string' && !/^(0|root)(:|$)/.test(prometheus.user), 'prometheus: non-root read-only service required');
    assert.deepEqual(prometheus.cap_drop, ['ALL']);
    assert(!prometheus.cap_add?.length && !prometheus.privileged && prometheus.security_opt?.includes('no-new-privileges:true'), 'prometheus: no added privileges');
    assert(!prometheus.secrets?.length, 'prometheus receives no secrets');
    for (const v of prometheus.volumes ?? []) {
      assert(v.type === 'volume' || (v.type === 'bind' && v.read_only === true), 'prometheus: configuration mounts must be read-only');
      assert(!/docker\.sock|\/var\/run/.test(`${v.source ?? ''} ${v.target ?? ''}`), 'prometheus: host control socket forbidden');
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert(process.argv.length === 4 && process.argv[2] === '--env-file' && path.isAbsolute(process.argv[3]), 'absolute --env-file required');
    const yaml = fileURLToPath(new URL('./compose.yaml', import.meta.url));
    const model = execFileSync('docker', ['compose', '-f', yaml, '--env-file', process.argv[3], '--profile', 'api-host', '--profile', 'monitoring', 'config', '--format', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, maxBuffer: 1024 * 1024 });
    assertProductionProfile(JSON.parse(model));
    console.log('atlas.production.profile-valid');
  } catch {
    // Resolved config and environment must never be copied into operator logs.
    console.error('atlas.production.profile-invalid');
    process.exitCode = 1;
  }
}
