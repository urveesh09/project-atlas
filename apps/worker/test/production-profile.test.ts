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
        ATLAS_S3_ENDPOINT: 'https://storage.example.org', ATLAS_TRUSTED_PROXIES: '172.30.10.2', ATLAS_DATABASE_URL_FILE: '/run/secrets/api_database_url' } },
      migrate: structuredClone(common),
      proxy: { ...structuredClone(common), environment: { ATLAS_DOMAIN: 'atlas.example.org' }, networks: { api: { ipv4_address: '172.30.10.2' } } },
    },
    networks: { api: { ipam: { config: [{ subnet: '172.30.10.0/24', ip_range: '172.30.10.128/25' }] } } },
    secrets: { api_database_url: { file: path.resolve('.atlas-tmp/secrets/api_database_url') } },
  };
}
describe('production configuration preflight', () => {
  it('accepts immutable hardened services and a proxy outside the dynamic pool', () => {
    expect(() => assertProductionProfile(profile())).not.toThrow();
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
  it('rejects direct API port publication and Docker socket mounts', () => {
    for (const extra of [{ ports: [{ target: 8080, published: '8080' }] }, { volumes: [{ target: '/var/run/docker.sock' }] },
      { volumes: [{ source: '/var/run/docker.sock', target: '/engine/socket' }] }, { volumes: [{ source: '/tmp/engine.sock', target: '/socket' }] }]) {
      const config = profile(); Object.assign(config.services.api, extra);
      expect(() => assertProductionProfile(config)).toThrow();
    }
  });
});
