import { describe, expect, it } from 'vitest';
import { closeSync, mkdtempSync, openSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error Release tooling is plain Node ESM outside runtime packages.
import { evaluateScan, policy, readDescriptor, validateStatements } from '../../../scripts/image-supply-chain.mjs';
const digest = `sha256:${'a'.repeat(64)}`, imageDigest = `sha256:${'b'.repeat(64)}`, configDigest = `sha256:${'c'.repeat(64)}`;
const now = Date.parse('2026-10-18T12:00:00Z');
function scan() {
  return { descriptor: { name: 'grype', version: policy.scannerVersion, db: { status: { valid: true, built: new Date(now).toISOString() } },
    configuration: { 'only-fixed': true, 'fail-on-severity': 'high', exclude: [] as string[], search: { scope: 'squashed' }, db: { 'require-update-check': true, 'validate-age': true } } },
    source: { target: { imageID: configDigest } }, matches: [] as ReturnType<typeof match>[], ignoredMatches: [] as ReturnType<typeof match>[] };
}
function match(severity = 'High', state = 'fixed') { return { vulnerability: { id: 'GHSA-fixture', severity, fix: { state, versions: ['2.0.0'] } }, artifact: { name: 'fixture', version: '1.0.0' } }; }
function statements() {
  const subject = [{ digest: { sha256: imageDigest.slice(7) } }];
  return [{ subject, predicateType: 'https://spdx.dev/Document', predicate: { spdxVersion: 'SPDX-2.3', packages: [{ name: 'fixture' }] } },
    { subject, predicateType: 'https://slsa.dev/provenance/v1', predicate: { buildDefinition: { buildType: 'https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md', internalParameters: { buildConfig: { llbDefinition: [] } } } } }];
}
describe('release image gate', () => {
  it('reads the original report even after its filename is replaced, and bounds bytes', () => {
    const base = realpathSync(os.tmpdir()), directory = realpathSync(mkdtempSync(path.join(base, 'atlas-image-fd-')));
    const report = path.join(directory, 'report.json'), fd = openSync(report, 'wx+', 0o600);
    try {
      writeFileSync(fd, '{"source":"original"}');
      renameSync(report, path.join(directory, 'original.json'));
      writeFileSync(report, '{"source":"replaced"}');
      expect(JSON.parse(readDescriptor(fd).toString())).toEqual({ source: 'original' });
      expect(() => readDescriptor(fd, 1)).toThrow('limit');
    } finally {
      closeSync(fd);
      expect(realpathSync(directory)).toBe(directory); expect(path.dirname(directory)).toBe(base);
      expect(path.basename(directory)).toMatch(/^atlas-image-fd-/); rmSync(directory, { recursive: true });
    }
  });
  it('pins scanner, SBOM generator and publisher by immutable digest', () => {
    for (const name of ['scanner', 'sbomGenerator', 'publisher', 'cacheInitializer', 'registryFixture', 'builder']) expect(policy[name]).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(policy.buildxVersion).toBe('v0.37.1');
    expect(policy.platform).toBe('linux/amd64');
  });
  it('accepts linked SPDX and max BuildKit v1 provenance', () => {
    expect(validateStatements({ digest, imageDigest, configDigest, statements: statements() }).digest).toBe(digest);
  });
  it('also accepts max BuildKit SLSA v0.2 without accepting its minimum form', () => {
    const older = statements();
    Object.assign(older[1]!, { predicateType: 'https://slsa.dev/provenance/v0.2', predicate: { buildType: 'https://mobyproject.org/buildkit@v1', buildConfig: { llbDefinition: [{ id: 'step0' }] } } });
    expect(validateStatements({ digest, imageDigest, configDigest, statements: older }).digest).toBe(digest);
    Reflect.deleteProperty(older[1]!.predicate, 'buildConfig');
    expect(() => validateStatements({ digest, imageDigest, configDigest, statements: older })).toThrow('Max-mode');
  });
  it('rejects unbound statements, missing SBOM and minimum provenance', () => {
    const unbound = statements(); unbound[0]!.subject = [];
    expect(() => validateStatements({ digest, imageDigest, configDigest, statements: unbound })).toThrow('subject');
    expect(() => validateStatements({ digest, imageDigest, configDigest, statements: statements().slice(1) })).toThrow('inventory');
    const minimum = statements(); Reflect.deleteProperty(minimum[1]!.predicate.buildDefinition!, 'internalParameters');
    expect(() => validateStatements({ digest, imageDigest, configDigest, statements: minimum })).toThrow('Max-mode');
  });
  it('blocks fixable high and critical findings even when a scanner incorrectly exits zero', () => {
    for (const severity of ['High', 'Critical']) {
      const report = scan(); report.matches.push(match(severity));
      const result = evaluateScan(report, 0, configDigest, now);
      expect(result.passed).toBe(false); expect(result.blocking).toHaveLength(1);
    }
  });
  it('retains nonblocking findings and does not turn exit 2 into success', () => {
    const report = scan(); report.matches.push(match('Medium')); report.ignoredMatches.push(match('High', 'not-fixed'));
    expect(evaluateScan(report, 0, configDigest, now)).toMatchObject({ passed: true, matches: 1, suppressed: 1 });
    expect(evaluateScan(report, 2, configDigest, now).passed).toBe(false);
    expect(() => evaluateScan(report, 1, configDigest, now)).toThrow('execution');
  });
  it('fails closed for stale/missing databases and a different scanned image', () => {
    const report = scan(); report.descriptor.db.status.built = new Date(now - 121 * 3600_000).toISOString();
    expect(() => evaluateScan(report, 0, configDigest, now)).toThrow('database');
    report.descriptor.db.status.valid = false;
    expect(() => evaluateScan(report, 0, configDigest, now)).toThrow('database');
    expect(() => evaluateScan(scan(), 0, digest, now)).toThrow('differs');
    const unknown = scan(); unknown.descriptor.version = 'unknown'; expect(() => evaluateScan(unknown, 0, configDigest, now)).toThrow();
  });
  it('rejects exclusions, suppressed fixed high findings and disabled database checks', () => {
    const excluded = scan(); excluded.descriptor.configuration.exclude.push('**/node_modules/**');
    expect(() => evaluateScan(excluded, 0, configDigest, now)).toThrow();
    const suppressed = scan(); suppressed.ignoredMatches.push(match()); expect(() => evaluateScan(suppressed, 0, configDigest, now)).toThrow('suppressed');
    const offline = scan(); offline.descriptor.configuration.db['require-update-check'] = false;
    expect(() => evaluateScan(offline, 0, configDigest, now)).toThrow();
  });
});
