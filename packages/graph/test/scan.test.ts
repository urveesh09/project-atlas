import { describe, expect, it } from 'vitest';
import { makeId, canonicalJson, canonicalJsonSha256, SCAN_LIMITS, type QualityReport } from '@atlas/schema';
import {
  createScanEvidence,
  parseScanEvidence,
  parseScanTrust,
  validateScanEvidence,
  type QualityTarget,
} from '@atlas/graph';

const target: QualityTarget = {
  analysisId: makeId('analysis', ['scan-test']),
  repoId: makeId('repository', ['scan-test']),
  snapshotId: makeId('snapshot', ['scan-test']),
  commitOid: 'a'.repeat(40),
  files: [
    {
      path: 'src/a.py',
      nodeId: makeId('node', ['a']),
      lineageId: makeId('lineage', ['a']),
      blobOid: 'b'.repeat(40),
      lines: 2,
    },
    {
      path: 'src/b.pyi',
      nodeId: makeId('node', ['b']),
      lineageId: makeId('lineage', ['b']),
      blobOid: 'c'.repeat(40),
      lines: 1,
    },
    {
      path: 'ui.ts',
      nodeId: makeId('node', ['ts']),
      lineageId: makeId('lineage', ['ts']),
      blobOid: 'd'.repeat(40),
      lines: 1,
    },
  ],
};
const report: QualityReport = {
  format: 'atlas.quality/1',
  analysisId: target.analysisId,
  repoId: target.repoId,
  snapshotId: target.snapshotId,
  commitOid: target.commitOid,
  binding: 'user-declared',
  scanScope: 'unverified',
  tool: { name: 'ruff', version: '0.17.3' },
  inputResults: 0,
  dropped: { unmapped: 0, unsupported: 0, suppressed: 0, duplicates: 0 },
  findings: [],
};
const profile = {
  format: 'atlas.ruff-profile/1',
  isolated: true,
  ignoreNoqa: true,
  respectGitignore: false,
  forceExclude: false,
  targetVersion: 'py314',
  rules: ['F821', 'F401'],
};
const scope = {
  format: 'atlas.scan-scope/1',
  files: target.files.slice(0, 2).map(({ path, blobOid }) => ({ path, blobOid })),
};
const make = (fileScope: unknown = scope, data = report, exitCode = 0) =>
  createScanEvidence(data, profile, fileScope, exitCode, target);

describe('scan evidence: declaration is separate from proof', () => {
  it('normalizes profile/scope deterministically and measures analyzed Python coverage only', () => {
    const evidence = make();
    expect(evidence.report.scanScope).toBe('unverified');
    expect(evidence.execution.declaration).toBe('producer-asserted');
    expect(evidence.profile.rules).toEqual(['F401', 'F821']);
    expect(evidence.profileSha256).toBe(canonicalJsonSha256(evidence.profile));
    expect(validateScanEvidence(evidence, target)).toEqual({
      analyzedPythonFiles: 2,
      declaredScannedFiles: 2,
      missingFiles: 0,
      droppedRecords: 0,
      scopeMatchesAnalysis: true,
    });
    expect(canonicalJson(make({ ...scope, files: [...scope.files].reverse() }))).toBe(canonicalJson(evidence));
  });
  it('never turns omitted files, empty Python scope or dropped records into complete coverage', () => {
    expect(validateScanEvidence(make({ ...scope, files: scope.files.slice(0, 1) }), target)).toMatchObject({
      missingFiles: 1,
      scopeMatchesAnalysis: false,
    });
    expect(validateScanEvidence(make({ ...scope, files: [] }), target)).toMatchObject({
      missingFiles: 2,
      scopeMatchesAnalysis: false,
    });
    const none = { ...target, files: [] };
    expect(
      validateScanEvidence(createScanEvidence(report, profile, { ...scope, files: [] }, 0, none), none)
        .scopeMatchesAnalysis,
    ).toBe(false);
    const dropped = { ...report, inputResults: 1, dropped: { ...report.dropped, unsupported: 1 } };
    expect(validateScanEvidence(make(scope, dropped, 1), target)).toMatchObject({
      droppedRecords: 1,
      scopeMatchesAnalysis: false,
    });
  });
  it.each([
    [{ path: 'src/a.py', blobOid: 'f'.repeat(40) }],
    [{ path: 'missing.py', blobOid: 'b'.repeat(40) }],
    [{ path: 'ui.ts', blobOid: 'd'.repeat(40) }],
    [scope.files[0], scope.files[0]],
  ])('rejects invalid or duplicate scope %j', (...files) => {
    expect(() => make({ ...scope, files })).toThrow();
  });
  it('rejects tampered profile digests, execution status, order and hidden extra fields', () => {
    const evidence = make();
    expect(() => parseScanEvidence(JSON.stringify({ ...evidence, profileSha256: '0'.repeat(64) }))).toThrow('digest');
    expect(() => make(scope, report, 1)).toThrow('exit code');
    expect(() => make(scope, report, 2)).toThrow('exit code');
    expect(() => parseScanEvidence(JSON.stringify({ ...evidence, source: 'SECRET' }))).toThrow('Invalid');
    expect(() =>
      parseScanEvidence(JSON.stringify({ ...evidence, scope: { ...scope, files: [...scope.files].reverse() } })),
    ).toThrow('sorted');
    expect(() => createScanEvidence(report, { ...profile, isolated: false }, scope, 0, target)).toThrow();
    expect(() => createScanEvidence(report, { ...profile, rules: ['F401', 'F401'] }, scope, 0, target)).toThrow(
      'unique',
    );
    expect(() => parseScanEvidence('x'.repeat(SCAN_LIMITS.bytes + 1))).toThrow('byte limit');
  });
  const trust = {
    format: 'atlas.scan-trust/1',
    repository: 'urveesh09/project-atlas',
    workflow: '.github/workflows/scan.yml',
    workflowCommit: 'e'.repeat(40),
    sourceCommit: 'a'.repeat(40),
    sourceRef: 'refs/heads/main',
    trustedRootSha256: 'f'.repeat(64),
  };
  it('accepts an explicit immutable workflow/source trust policy', () => {
    expect(parseScanTrust(JSON.stringify(trust))).toEqual(trust);
  });
  it.each([
    { repository: '--host/evil' },
    { workflow: '../workflow.yml' },
    { workflowCommit: 'main' },
    { sourceRef: 'refs/pull/52/merge' },
    { sourceRef: 'refs/heads/../main' },
    { sourceRef: 'refs/heads/x//y' },
    { trustedRootSha256: 'trust-any' },
    { issuer: 'https://evil.invalid' },
  ])('rejects unsafe or broad trust %j', (changed) =>
    expect(() => parseScanTrust(JSON.stringify({ ...trust, ...changed }))).toThrow('Invalid'),
  );
});
