import { describe, expect, it } from 'vitest';
import { canonicalJson, makeId, REVIEW_LIMITS, type QualityFinding, type ReviewSide } from '@atlas/schema';
import {
  createFindingAnchors,
  createFindingReview,
  createReviewSide,
  createScanEvidence,
  findingReviewIsPartial,
  importRuffSarif,
  indexFindingContexts,
  parseFindingReview,
  validateFindingReview,
  parseReviewScanTrust,
  type QualityTarget,
} from '@atlas/graph';

const profile = {
  format: 'atlas.ruff-profile/1',
  isolated: true,
  ignoreNoqa: true,
  respectGitignore: false,
  forceExclude: false,
  targetVersion: 'py314',
  rules: ['F821'],
};
const source =
  '# header\nfirst = 1\ndef inspect():\n    before = 1\n    middle = 2\n    print(missing)\n    after = 3\n    return before + middle + after\n# end\n';
function prepared(
  tag: string,
  text: string,
  line: number | null,
  options: {
    path?: string;
    lineage?: string;
    column?: number | null;
    version?: string;
    targetVersion?: string;
    level?: QualityFinding['level'];
    partial?: boolean;
    extraLines?: number[];
  } = {},
) {
  const target: QualityTarget = {
    analysisId: makeId('analysis', ['review']),
    repoId: makeId('repository', ['review']),
    snapshotId: makeId('snapshot', [tag]),
    commitOid: tag.repeat(40),
    files: [
      {
        path: options.path ?? 'sample.py',
        nodeId: makeId('node', [tag]),
        lineageId: makeId('lineage', [options.lineage ?? 'sample']),
        blobOid: tag.repeat(40),
        lines: text.split('\n').length - 1,
      },
      ...(options.partial
        ? [
            {
              path: 'omitted.py',
              nodeId: makeId('node', [tag, 'omitted']),
              lineageId: makeId('lineage', ['omitted']),
              blobOid: 'f'.repeat(40),
              lines: 1,
            },
          ]
        : []),
    ],
  };
  const lines = line === null ? [] : [line, ...(options.extraLines ?? [])];
  const report = importRuffSarif(
    JSON.stringify({
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'ruff', version: options.version ?? '0.17.3' } },
          results: lines.map((at) => ({
            ruleId: 'F821',
            level: options.level ?? 'error',
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: target.files[0]!.path },
                  region: { startLine: at, ...(options.column === null ? {} : { startColumn: options.column ?? 11 }) },
                },
              },
            ],
          })),
        },
      ],
    }),
    target,
    target.commitOid,
  );
  const scan = createScanEvidence(
    report,
    { ...profile, targetVersion: options.targetVersion ?? 'py314' },
    {
      format: 'atlas.scan-scope/1',
      files: target.files.slice(0, 1).map(({ path, blobOid }) => ({ path, blobOid })),
    },
    lines.length ? 1 : 0,
    target,
  );
  return { target, scan, text };
}
function pair(old: ReturnType<typeof prepared>, now: ReturnType<typeof prepared>, unavailable = false) {
  const indexes = new Map(
    [old, now].map((p) => [
      p.target.files[0]!.blobOid,
      unavailable ? null : indexFindingContexts(p.text, REVIEW_LIMITS.contextWindows),
    ]),
  );
  const side = (p: typeof old, other: typeof old): ReviewSide =>
    createReviewSide(
      p.scan,
      p.target.commitOid.padEnd(64, '0'),
      p.target,
      createFindingAnchors(p.scan.report, p.target, other.target, indexes),
    );
  return { baseline: side(old, now), current: side(now, old) };
}
const declared = (side: ReviewSide): ReviewSide => ({
  ...side,
  declaredTrust: {
    format: 'atlas.review-scan-trust/1',
    scanCommit: side.report.commitOid,
    producer: {
      format: 'atlas.scan-trust/1',
      repository: 'owner/repo',
      workflow: '.github/workflows/scan.yml',
      workflowCommit: side.report.commitOid,
      sourceCommit: side.report.commitOid,
      sourceRef: 'refs/heads/main',
      trustedRootSha256: 'f'.repeat(64),
    },
  },
});
// These are producer declarations for pure matching tests, not cryptographic proof.
const review = (p: ReturnType<typeof pair>, verified = false) =>
  createFindingReview(
    verified ? declared(p.current) : p.current,
    verified ? declared(p.baseline) : p.baseline,
    verified ? 'same-producer-policy' : 'unverified',
  );

describe('contextual finding review: authored matches, no resolution inference', () => {
  it('separates an explicit historical target from immutable producer source/workflow pins', () => {
    const side = declared(pair(prepared('a', source, 6), prepared('b', source, 6)).baseline);
    const trust = {
      ...side.declaredTrust!,
      producer: { ...side.declaredTrust!.producer, sourceCommit: 'b'.repeat(40), workflowCommit: 'b'.repeat(40) },
    };
    expect(parseReviewScanTrust(canonicalJson(trust))).toEqual(trust);
    for (const invalid of [
      { ...trust, scanCommit: 'main' },
      { ...trust, producer: { ...trust.producer, workflowCommit: 'main' } },
      { ...trust, gh: 'untrusted-executable' },
    ])
      expect(() => parseReviewScanTrust(canonicalJson(invalid))).toThrow('historical scan trust');
    const p = pair(prepared('a', source, 6), prepared('b', source, 6));
    expect(() => createFindingReview(p.current, p.baseline, 'same-producer-policy')).toThrow('compatibility');
  });
  it('keeps an ID across two line shifts, a rename and severity changes within bounded lineage', () => {
    const a = prepared('a', source, 6),
      b = prepared('b', '# added\n# another\n' + source, 8, { path: 'renamed.py', level: 'warning' }),
      c = prepared('c', '# later\n# added\n# another\n' + source, 9, { path: 'renamed.py' });
    const ab = review(pair(a, b)),
      bc = review(pair(b, c));
    expect(ab.issues).toHaveLength(1);
    expect(ab.issues[0]).toMatchObject({ state: 'continuing', basis: 'unique-context' });
    expect(bc.issues[0]!.id).toBe(ab.issues[0]!.id);
    expect(ab.current.report.findings[0]!.line).toBe(8);
    expect(ab.current.report.findings[0]!.level).toBe('warning');
    expect(findingReviewIsPartial(ab)).toBe(true); // unsigned, even with an exact match
    expect(canonicalJson(ab)).not.toContain('print(missing)');
    validateFindingReview(ab, b.target, a.target);
  });
  it('never gives copied or deleted/recreated files another lineage’s identity', () => {
    const a = prepared('a', source, 6),
      b = prepared('b', source, 6, { lineage: 'copy', path: 'copy.py' });
    const r = review(pair(a, b), true);
    expect(r.issues.map((f) => f.state).sort()).toEqual(['unmatched-baseline', 'unmatched-current']);
    expect(r.issues.every((f) => f.basis === 'file-not-in-scope')).toBe(true);
  });
  it('does not choose between duplicate contexts after an edit; unchanged blobs retain exact locations', () => {
    const repeated = 'a = 1\nb = 2\nprint(missing)\nc = 3\nd = 4\n'.repeat(2);
    const a = prepared('a', repeated, 3),
      b = prepared('b', '# prefix\n' + repeated, 4);
    const r = review(pair(a, b), true);
    expect(r.issues.map((f) => f.state).sort()).toEqual(['unmatched-baseline', 'unmatched-current']);
    expect(r.issues.every((f) => f.basis === 'repeated-context')).toBe(true);
    const same = prepared('b', repeated, 3);
    same.target.files[0]!.blobOid = a.target.files[0]!.blobOid;
    same.scan.report.findings[0]!.blobOid = a.target.files[0]!.blobOid;
    // Re-import so the authored identical blob has a valid occurrence identity.
    const raw = JSON.stringify({
      version: '2.1.0',
      runs: [
        {
          tool: { driver: same.scan.report.tool },
          results: [
            {
              ruleId: 'F821',
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: 'sample.py' },
                    region: { startLine: 3, startColumn: 11 },
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    same.scan.report = importRuffSarif(raw, same.target, same.target.commitOid);
    same.scan.scope.files[0]!.blobOid = a.target.files[0]!.blobOid;
    expect(review(pair(a, same)).issues[0]).toMatchObject({ state: 'continuing', basis: 'exact-blob-location' });
  });
  it('keeps changed neighborhoods, unknown columns and unavailable source explicit', () => {
    const a = prepared('a', source, 6),
      b = prepared('b', source.replace('middle = 2', 'middle = 20'), 6);
    expect(
      review(pair(a, b), true).issues.every((f) => f.state.startsWith('unmatched-') && f.basis === 'changed-context'),
    ).toBe(true);
    const noColumn = pair(
      prepared('a', source, 6, { column: null }),
      prepared('b', '# shift\n' + source, 7, { column: null }),
    );
    expect(review(noColumn, true).issues.every((f) => f.basis === 'unknown-column')).toBe(true);
    expect(review(pair(a, b, true), true).issues.every((f) => f.basis === 'source-unavailable')).toBe(true);
  });
  it('accounts for reported appearance/absence only with comparable authenticated declarations and unchanged context', () => {
    const a = prepared('a', source, null),
      b = prepared('b', source, 6);
    expect(review(pair(a, b)).issues[0]!.state).toBe('unmatched-current');
    const appeared = review(pair(a, b), true);
    expect(appeared.issues[0]!.state).toBe('newly-reported');
    expect(findingReviewIsPartial(appeared)).toBe(false); // a finding remains; not lint-clean
    const disappeared = review(pair(prepared('a', source, 6), prepared('b', source, null)), true);
    expect(disappeared.issues[0]!.state).toBe('no-longer-reported');
    expect(canonicalJson(disappeared)).not.toContain('resolved');
  });
  it.each([
    { partial: true, reason: 'partial-current-scope' },
    { version: '0.17.4', reason: 'ruff-version-differs' },
    { targetVersion: 'py315', reason: 'profile-differs' },
  ])('blocks absence accounting for changed semantics/coverage: $reason', ({ reason, ...options }) => {
    const r = review(pair(prepared('a', source, 6), prepared('b', source, null, options)), true);
    expect(r.reasons).toContain(reason);
    expect(r.issues[0]!.state).toBe('unmatched-baseline');
    expect(findingReviewIsPartial(r)).toBe(true);
  });
  it('rejects forged rows, IDs, source fields, counts and invalid bindings', () => {
    const p = pair(prepared('a', source, 6), prepared('b', '# shifted\n' + source, 7)),
      r = review(p);
    expect(parseFindingReview(canonicalJson(r))).toEqual(r);
    for (const changed of [
      { ...r, source: 'SECRET' },
      { ...r, issues: [] },
      { ...r, issues: [{ ...r.issues[0], state: 'newly-reported' }] },
      { ...r, issues: [{ ...r.issues[0], id: 'qi_' + '0'.repeat(64) }] },
      { ...r, current: { ...r.current, coverage: { ...r.current.coverage, missingFiles: 1 } } },
      { ...r, current: { ...r.current, anchors: [] } },
    ])
      expect(() => parseFindingReview(canonicalJson(changed))).toThrow();
    expect(() => createFindingReview(p.current, p.current)).toThrow('different snapshots');
    expect(() => validateFindingReview(r, prepared('c', source, 6).target, prepared('a', source, 6).target)).toThrow();
    expect(() => parseFindingReview('x'.repeat(REVIEW_LIMITS.bytes + 1))).toThrow('byte limit');
  });
  it('preserves Unicode/indentation, normalizes only CRLF, and never samples an over-budget index', () => {
    const a = indexFindingContexts(source, 100)!;
    expect(indexFindingContexts(source.replaceAll('\n', '\r\n'), 100)!.contexts).toEqual(a.contexts);
    expect(indexFindingContexts(source.replace('    print', '\tprint'), 100)!.contexts[5]).not.toBe(a.contexts[5]);
    expect(indexFindingContexts('é\n', 1)!.contexts).not.toEqual(indexFindingContexts('e\u0301\n', 1)!.contexts);
    expect(indexFindingContexts(source, 2)).toBeNull();
    expect(indexFindingContexts('x'.repeat(REVIEW_LIMITS.blobBytes + 1), 100)).toBeNull();
    expect(indexFindingContexts('x'.repeat(REVIEW_LIMITS.contextBytes + 1), 100)!.contexts).toEqual([null]);
    expect(() => pair(prepared('a', source, 6, { column: 9999 }), prepared('b', source, 6))).toThrow(
      'committed source line',
    );
  });
  it('handles the full 4,096 findings per side with unique deterministic matches', () => {
    const body =
      '# padding one\n# padding two\n' +
      Array.from({ length: 4096 }, (_, i) => `print(missing${i})\n`).join('') +
      '# tail one\n# tail two\n';
    const a = prepared('a', body, 3, { column: 7, extraLines: Array.from({ length: 4095 }, (_, i) => i + 4) });
    const b = prepared('b', '# shifted\n' + body, 4, {
      column: 7,
      extraLines: Array.from({ length: 4095 }, (_, i) => i + 5),
    });
    const r = review(pair(a, b));
    expect(r.issues).toHaveLength(4096);
    expect(r.issues.every((f) => f.state === 'continuing')).toBe(true);
    expect(new Set(r.issues.map((f) => f.id)).size).toBe(4096);
    expect(Buffer.byteLength(canonicalJson(r))).toBeLessThan(REVIEW_LIMITS.bytes);
  });
});
