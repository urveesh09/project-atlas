import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Standalone operator tooling is plain ESM, outside runtime packages.
import { assertProductionProfile } from '../../../deploy/production/check-profile.mjs';

function profile() {
  const common = { image: `sha256:${'a'.repeat(64)}`, user: '10001:10001', read_only: true,
    cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'], environment: {} };
  // Resolved Compose shape, independently authored rather than parsing the template.
  return {
    services: {
      api: { ...structuredClone(common), environment: { ATLAS_PUBLIC_ORIGIN: 'https://atlas.example.org', ATLAS_STORAGE: 's3',
        ATLAS_S3_ENDPOINT: 'https://storage.example.org', ATLAS_TRUSTED_PROXIES: '172.30.10.2', ATLAS_DATABASE_URL_FILE: '/run/secrets/api_database_url',
        ATLAS_PRIVACY_FILE: '/etc/atlas/legal/privacy.txt', ATLAS_TERMS_FILE: '/etc/atlas/legal/terms.txt', ATLAS_TAKEDOWN_FILE: '/etc/atlas/legal/takedown.txt',
        ATLAS_CONTACT: 'mailto:operator@example.org' } as Record<string, string>,
      configs: ['privacy', 'terms', 'takedown'].map((name) => ({ source: `legal_${name}`, target: `/etc/atlas/legal/${name}.txt` })) },
      migrate: structuredClone(common),
      proxy: { ...structuredClone(common), environment: { ATLAS_DOMAIN: 'atlas.example.org' }, networks: { api: { ipv4_address: '172.30.10.2' } } },
    },
    networks: { api: { ipam: { config: [{ subnet: '172.30.10.0/24', ip_range: '172.30.10.128/25' }] } } },
    secrets: { api_database_url: { file: path.resolve('.atlas-tmp/secrets/api_database_url') } },
    configs: { legal_privacy: { file: path.resolve('.atlas-tmp/legal/privacy.txt') } } as Record<string, { file: string }>,
  };
}
describe('production configuration preflight', () => {
  it('accepts immutable hardened services and a proxy outside the dynamic pool', () => {
    expect(() => assertProductionProfile(profile())).not.toThrow();
  });
  it("requires the owner's texts as mounted configs and a mailto: or https: contact", () => {
    const changes: ((config: ReturnType<typeof profile>) => void)[] = [
      (c) => { delete c.services.api.environment['ATLAS_TERMS_FILE']; },
      (c) => { c.services.api.environment['ATLAS_PRIVACY_FILE'] = '/run/secrets/privacy.txt'; },
      (c) => { c.services.api.configs = []; },
      (c) => { delete c.services.api.environment['ATLAS_CONTACT']; },
      (c) => { c.services.api.environment['ATLAS_CONTACT'] = 'javascript:alert(1)'; },
      (c) => { c.configs['legal_privacy'] = { file: 'legal/privacy.txt' }; },
    ];
    for (const change of changes) {
      const config = profile(); change(config);
      expect(() => assertProductionProfile(config), String(change)).toThrow();
    }
  });
  it('rejects the real allocation collision found in the first full rehearsal', () => {
    const config = profile(); config.networks.api.ipam.config[0]!.ip_range = '172.30.10.0/24';
    expect(() => assertProductionProfile(config)).toThrow('outside dynamic allocation pool');
  });
  it('rejects mutable images', () => {
    const config = profile(); config.services.api.image = 'atlas-api:latest';
    expect(() => assertProductionProfile(config)).toThrow('immutable image');
  });
  it('rejects a proxy address the API does not trust exactly', () => {
    const config = profile(); config.services.api.environment.ATLAS_TRUSTED_PROXIES = '172.30.10.0/24';
    expect(() => assertProductionProfile(config)).toThrow();
  });
  it('rejects origin/certificate hostname mismatch', () => {
    const config = profile(); config.services.proxy.environment.ATLAS_DOMAIN = 'other.example.org';
    expect(() => assertProductionProfile(config)).toThrow();
  });
  it('rejects plaintext storage endpoints', () => {
    const config = profile(); config.services.api.environment.ATLAS_S3_ENDPOINT = 'http://storage.example.org';
    expect(() => assertProductionProfile(config)).toThrow('HTTPS');
  });
  it('rejects privileged or development overrides and plaintext secrets', () => {
    for (const extra of [{ privileged: true }, { cap_add: ['NET_ADMIN'] }, { network_mode: 'host' },
      { environment: { ATLAS_DEVELOPMENT: '1' } }, { environment: { ATLAS_GITHUB_TOKEN: 'fixture-token' } }]) {
      const config = profile(); Object.assign(config.services.api, extra);
      expect(() => assertProductionProfile(config)).toThrow();
    }
  });
  it('accepts the optional Prometheus only inside the API namespace, publishing nothing', () => {
    const prometheus = () => ({ image: `prom/prometheus@sha256:${'b'.repeat(64)}`, network_mode: 'service:api', user: '65534:65534', read_only: true,
      cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'],
      volumes: [{ type: 'bind', source: path.resolve('deploy/production/prometheus.yml'), target: '/etc/prometheus/prometheus.yml', read_only: true },
        { type: 'volume', source: 'prometheus-data', target: '/prometheus' }] });
    expect(() => assertProductionProfile({ ...profile(), services: { ...profile().services, prometheus: prometheus() } })).not.toThrow();
    for (const change of [{ image: 'prom/prometheus:latest' }, { network_mode: undefined }, { network_mode: 'host' },
      { ports: [{ target: 9091, published: '9091' }] }, { networks: { api: {} } }, { user: '0:0' }, { user: undefined }, { read_only: false },
      { cap_add: ['NET_RAW'] }, { secrets: ['quota_secret'] },
      { volumes: [{ type: 'bind', source: path.resolve('prometheus.yml'), target: '/etc/prometheus/prometheus.yml' }] },
      { volumes: [{ type: 'bind', source: '/var/run/docker.sock', target: '/var/run/docker.sock', read_only: true }] }]) {
      const config = profile();
      expect(() => assertProductionProfile({ ...config, services: { ...config.services, prometheus: { ...prometheus(), ...change } } }), JSON.stringify(change)).toThrow();
    }
  });
  it('rejects direct API port publication and Docker socket mounts', () => {
    for (const extra of [{ ports: [{ target: 8080, published: '8080' }] }, { volumes: [{ target: '/var/run/docker.sock' }] },
      { volumes: [{ source: '/var/run/docker.sock', target: '/engine/socket' }] }, { volumes: [{ source: '/tmp/engine.sock', target: '/socket' }] }]) {
      const config = profile(); Object.assign(config.services.api, extra);
      expect(() => assertProductionProfile(config)).toThrow();
    }
  });
});
