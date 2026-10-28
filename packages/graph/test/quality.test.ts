import { describe, expect, it } from 'vitest';
import { canonicalJson, QUALITY_LIMITS } from '@atlas/schema';
import {
  compareQualityReports,
  importRuffSarif,
  parseQualityReport,
  validateQualityReport,
  type QualityTarget,
} from '@atlas/graph';

const hex = (c: string) => c.repeat(64);
const target: QualityTarget = {
  analysisId: `analysis_${hex('a')}`,
  repoId: `repo_${hex('b')}`,
  snapshotId: `snap_${hex('c')}`,
  commitOid: 'd'.repeat(40),
  files: [
    {
      nodeId: `node_${hex('e')}`,
      lineageId: `lin_${hex('f')}`,
      path: 'pkg/sample.py',
      blobOid: '1'.repeat(40),
      lines: 2,
    },
  ],
};
const result = (ruleId = 'F401', uri = 'pkg/sample.py', line = 1, column = 8) => ({
  ruleId,
  level: 'error',
  message: { text: 'MUST_NOT_PERSIST secret-token source()' },
  locations: [
    {
      physicalLocation: {
        artifactLocation: { uri },
        region: { startLine: line, startColumn: column, snippet: { text: 'SECRET_SOURCE' } },
      },
    },
  ],
  fixes: [{ description: { text: 'SECRET_FIX' } }],
});
const sarif = (results: unknown[], extra = {}) =>
  JSON.stringify({
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: 'ruff', version: '0.17.3', informationUri: 'https://must-not-fetch.invalid/' } },
        results,
        ...extra,
      },
    ],
  });
const load = (rows: unknown[], extra = {}) => importRuffSarif(sarif(rows, extra), target, target.commitOid);

describe('local Ruff evidence, authored F401/F821 expectations', () => {
  it('keeps only two rule locations; never messages, source, fixes, links or arbitrary properties', () => {
    const report = load([result(), result('F821', 'pkg/sample.py', 2, 7)]);
    expect(report.findings.map((f) => [f.ruleId, f.line, f.column]).sort()).toEqual([
      ['F401', 1, 8],
      ['F821', 2, 7],
    ]);
    expect(report.binding).toBe('user-declared');
    expect(report.scanScope).toBe('unverified');
    expect(canonicalJson(report)).not.toMatch(/SECRET|MUST_NOT|source\(\)|https:/);
    expect(parseQualityReport(canonicalJson(report))).toEqual(report);
    expect(() => validateQualityReport(report, target)).not.toThrow();
  });
  it('deduplicates deterministically, retaining the strongest reported level', () => {
    const weak = { ...result(), level: 'note' };
    const a = load([weak, result()]),
      b = load([result(), weak]);
    expect(a).toEqual(b);
    expect(a.dropped.duplicates).toBe(1);
    expect(a.findings[0]!.level).toBe('error');
  });
  it('counts malformed, unsupported, suppressed and unmapped results without exposing their content', () => {
    const report = load([
      null,
      result('F821', 'missing.py'),
      { ...result(), suppressions: [{ status: 'accepted' }] },
      result('SECRET_RULE'),
      result('F821', 'pkg/sample.py', 3),
    ]);
    expect(report.findings).toEqual([]);
    expect(report.dropped).toEqual({ unsupported: 3, unmapped: 1, suppressed: 1, duplicates: 0 });
  });
  it('accepts the real Ruff file-URI shape only under an explicit source root', () => {
    const report = importRuffSarif(
      sarif([result('F401', 'file:///C:/work/project/pkg/sample.py')]),
      target,
      target.commitOid,
      'file:///C:/work/project/',
    );
    expect(report.findings[0]!.path).toBe('pkg/sample.py');
    expect(canonicalJson(report)).not.toContain('C:');
    expect(load([result('F401', 'file:///C:/work/project/pkg/sample.py')]).dropped.unmapped).toBe(1);
  });
  it.each([
    '../pkg/sample.py',
    '%2e%2e/pkg/sample.py',
    '/pkg/sample.py',
    'C:/pkg/sample.py',
    '//host/pkg/sample.py',
    'https://host/pkg/sample.py',
    'pkg%2fsample.py',
    'pkg%5csample.py',
    'pkg\\sample.py',
    'pkg/sample.py?secret',
    'pkg/sample.py#secret',
    'file:///C:/work/project-other/pkg/sample.py',
    'file:///C:/work/project/../pkg/sample.py',
    'file:///C:/work/project/%2e%2e/pkg/sample.py',
    'file://host/C:/work/project/pkg/sample.py',
    'pkg/%ZZ.py',
  ])('does not resolve unsafe or escaping URI %s', (uri) => {
    const report = importRuffSarif(sarif([result('F401', uri)]), target, target.commitOid, 'file:///C:/work/project/');
    expect(report.findings).toEqual([]);
    expect(report.dropped.unmapped).toBe(1);
  });
  it('decodes a valid UTF-8 path, but never guesses an unresolved base or a basename', () => {
    const unicode = { ...target, files: [{ ...target.files[0]!, path: 'pkg/café.py' }] };
    expect(
      importRuffSarif(sarif([result('F401', 'pkg/caf%C3%A9.py')]), unicode, target.commitOid).findings[0]!.path,
    ).toBe('pkg/café.py');
    const based = result();
    based.locations[0]!.physicalLocation.artifactLocation = { uri: 'sample.py', uriBaseId: '%SRCROOT%' } as {
      uri: string;
    };
    expect(load([based]).dropped.unmapped).toBe(1);
  });
  it('rejects a wrong declared commit, conflicting producer revision and failed producer', () => {
    expect(() => importRuffSarif(sarif([]), target, '0'.repeat(40))).toThrow('full commit');
    expect(() => load([], { versionControlProvenance: [{ revisionId: '0'.repeat(40) }] })).toThrow('conflicts');
    expect(() => load([], { invocations: [{ executionSuccessful: false }] })).toThrow('successful');
    expect(() => load([], { invocations: [{ executionSuccessful: true }] })).not.toThrow();
  });
  it.each([0, -1, 1.5, QUALITY_LIMITS.position + 1])('drops invalid line %s', (line) => {
    expect(load([result('F401', 'pkg/sample.py', line)]).dropped.unsupported).toBe(1);
  });
  it('bounds bytes and records, and does not trust reported zero findings as scan coverage', () => {
    expect(() => importRuffSarif('é'.repeat(QUALITY_LIMITS.bytes / 2 + 1), target, target.commitOid)).toThrow('8 MiB');
    expect(() => load(Array.from({ length: QUALITY_LIMITS.results + 1 }, () => null))).toThrow('20,000');
    expect(load([]).scanScope).toBe('unverified');
    expect(() => importRuffSarif('{"secret":"unterminated', target, target.commitOid)).toThrow('not valid JSON');
  });
  it('rejects unknown producers, formats, versions and unsupported source roots', () => {
    expect(() => importRuffSarif('{"version":"2.2","runs":[]}', target, target.commitOid)).toThrow('2.1.0');
    expect(() => load([], { tool: { driver: { name: 'other', version: '1.0.0' } } })).toThrow('Ruff');
    expect(() => importRuffSarif(sarif([]), target, target.commitOid, 'https://host/')).toThrow('local file');
    expect(() => load([], { tool: { driver: { name: 'ruff', version: '0.17.3-SECRET' } } })).toThrow('Ruff');
    expect(() => load([], { invocations: [] })).toThrow('successful');
    expect(load([{ ...result(), suppressions: {} }]).dropped.unsupported).toBe(1);
  });
  it('fails rather than sampling more than 4,096 distinct findings', () => {
    const large = { ...target, files: [{ ...target.files[0]!, lines: 5_000 }] };
    const rows = Array.from({ length: QUALITY_LIMITS.findings + 1 }, (_, i) => result('F401', 'pkg/sample.py', i + 1));
    expect(() => importRuffSarif(sarif(rows), large, target.commitOid)).toThrow('4,096');
  });
  it('rechecks all binding fields and file references, positions, counts and extra fields', () => {
    const report = load([result()]);
    for (const key of ['analysisId', 'repoId', 'snapshotId', 'commitOid'] as const)
      expect(() => validateQualityReport(report, { ...target, [key]: 'wrong' })).toThrow('different');
    for (const key of ['path', 'lineageId', 'blobOid'] as const)
      expect(() =>
        validateQualityReport(report, { ...target, files: [{ ...target.files[0]!, [key]: 'wrong' }] }),
      ).toThrow('does not match');
    expect(() => validateQualityReport(report, { ...target, files: [{ ...target.files[0]!, lines: 0 }] })).toThrow(
      'does not match',
    );
    expect(() => parseQualityReport(JSON.stringify({ ...report, inputResults: 2 }))).toThrow('reconcile');
    expect(() => parseQualityReport(JSON.stringify({ ...report, source: 'SECRET' }))).toThrow('Invalid');
    const tampered = structuredClone(report);
    tampered.findings[0]!.line = 2;
    expect(() => parseQualityReport(JSON.stringify(tampered))).toThrow('identity');
  });
  it('compares locations conservatively: line movement is not resolution and severity is not identity', () => {
    const old = load([result(), result('F821', 'pkg/sample.py', 2, 7)]);
    const next = load([{ ...result(), level: 'warning' }, result('F821', 'pkg/sample.py', 1, 7)]);
    const compared = compareQualityReports(next, old);
    expect(compared.sameLocation.map((f) => f.ruleId)).toEqual(['F401']);
    expect(compared.newlyReported.map((f) => f.ruleId)).toEqual(['F821']);
    expect(compared.noLongerReported.map((f) => f.ruleId)).toEqual(['F821']);
    expect(() => compareQualityReports(next, { ...old, tool: { name: 'ruff', version: '0.18.0' } })).toThrow(
      'same analysis',
    );
  });
});
