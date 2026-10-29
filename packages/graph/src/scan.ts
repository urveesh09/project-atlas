import {
  ScanEvidenceSchema,
  ScanScopeSchema,
  RuffProfileSchema,
  ScanTrustPolicySchema,
  SCAN_LIMITS,
  canonicalJson,
  canonicalJsonSha256,
  compareUtf8,
  utf8ByteLength,
  type QualityReport,
  type ScanEvidence,
  type ScanTrustPolicy,
} from '@atlas/schema';
import { parseQualityReport, validateQualityReport, QualityImportError, type QualityTarget } from './quality.js';

function fail(message: string): never {
  throw new QualityImportError(message);
}
export function parseScanJson(text: string, maxBytes: number = SCAN_LIMITS.bytes): unknown {
  if (!text.isWellFormed() || utf8ByteLength(text) > maxBytes)
    fail('Scan input exceeds its byte limit or is invalid Unicode.');
  try {
    return JSON.parse(text);
  } catch {
    return fail('Scan input is not valid JSON.');
  }
}
function checkProfile(evidence: ScanEvidence): void {
  const rules = evidence.profile.rules;
  if (rules.some((r, i) => i > 0 && compareUtf8(rules[i - 1]!, r) >= 0))
    fail('Profile rules must be unique and sorted.');
  if (evidence.profileSha256 !== canonicalJsonSha256(evidence.profile)) fail('Scan profile digest does not match.');
  if (evidence.report.findings.some((f) => !rules.includes(f.ruleId)))
    fail('A reported rule is outside the declared profile.');
  if ((evidence.execution.exitCode === 0) !== (evidence.report.inputResults === 0))
    fail('Ruff exit code conflicts with the report result count.');
}
export function parseScanEvidence(text: string): ScanEvidence {
  const parsed = ScanEvidenceSchema.safeParse(parseScanJson(text));
  if (!parsed.success) fail('Invalid or unsupported scan evidence.');
  const evidence = parsed.data;
  parseQualityReport(canonicalJson(evidence.report));
  checkProfile(evidence);
  const files = evidence.scope.files;
  if (files.some((f, i) => i > 0 && compareUtf8(files[i - 1]!.path, f.path) >= 0))
    fail('Scanned paths must be unique and sorted.');
  return evidence;
}
export function parseScanTrust(text: string): ScanTrustPolicy {
  const parsed = ScanTrustPolicySchema.safeParse(parseScanJson(text, SCAN_LIMITS.policyBytes));
  if (!parsed.success) fail('Invalid or unsupported scan trust policy.');
  return parsed.data;
}
export function validateScanEvidence(evidence: ScanEvidence, target: QualityTarget) {
  validateQualityReport(evidence.report, target);
  const expected = new Map(target.files.filter((f) => /\.pyi?$/.test(f.path)).map((f) => [f.path, f.blobOid]));
  const scanned = new Map(evidence.scope.files.map((f) => [f.path, f.blobOid]));
  for (const [file, blob] of scanned)
    if (expected.get(file) !== blob) fail('Scanned file or blob does not match the analyzed Python scope.');
  for (const f of evidence.report.findings)
    if (scanned.get(f.path) !== f.blobOid) fail('A finding is outside the declared scanned scope.');
  const missingFiles = expected.size - scanned.size;
  const dropped =
    evidence.report.dropped.unmapped + evidence.report.dropped.unsupported + evidence.report.dropped.suppressed;
  return {
    analyzedPythonFiles: expected.size,
    declaredScannedFiles: scanned.size,
    missingFiles,
    droppedRecords: dropped,
    scopeMatchesAnalysis: expected.size > 0 && missingFiles === 0 && dropped === 0,
  };
}
export function createScanEvidence(
  report: QualityReport,
  profileInput: unknown,
  scopeInput: unknown,
  exitCode: number,
  target: QualityTarget,
): ScanEvidence {
  const profile = RuffProfileSchema.safeParse(profileInput),
    scope = ScanScopeSchema.safeParse(scopeInput);
  if (!profile.success || !scope.success || (exitCode !== 0 && exitCode !== 1))
    fail('Use a valid isolated Ruff profile, scanned-file declaration and exit code 0 or 1.');
  profile.data.rules.sort(compareUtf8);
  scope.data.files.sort((a, b) => compareUtf8(a.path, b.path));
  const evidence = parseScanEvidence(
    canonicalJson({
      format: 'atlas.scan/1',
      report,
      profile: profile.data,
      profileSha256: canonicalJsonSha256(profile.data),
      scope: scope.data,
      execution: { declaration: 'producer-asserted', completed: true, exitCode },
    }),
  );
  validateScanEvidence(evidence, target);
  return evidence;
}
