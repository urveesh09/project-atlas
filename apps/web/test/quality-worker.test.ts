import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeId } from '@atlas/schema';
import { createScanEvidence, parseQualityReport, createReviewSide, createFindingReview } from '@atlas/graph';

// Exercise the actual worker handler. These unit events model channel metadata;
// real browser journeys separately prove that native File messages are accepted.
const scope: {
  onmessage: ((event: MessageEvent<unknown>) => Promise<void>) | null;
  postMessage: ReturnType<typeof vi.fn>;
} = { onmessage: null, postMessage: vi.fn() };
beforeAll(async () => {
  vi.stubGlobal('self', scope);
  await import('../src/data/quality.worker');
});
beforeEach(() => scope.postMessage.mockClear());
afterAll(() => vi.unstubAllGlobals());

function input() {
  return new File(
    [
      JSON.stringify({
        format: 'atlas.quality/1',
        analysisId: makeId('analysis', ['worker-test']),
        repoId: makeId('repository', ['worker-test']),
        snapshotId: makeId('snapshot', ['worker-test']),
        commitOid: 'a'.repeat(40),
        binding: 'user-declared',
        scanScope: 'unverified',
        tool: { name: 'ruff', version: '0.17.3' },
        inputResults: 0,
        dropped: { unmapped: 0, unsupported: 0, suppressed: 0, duplicates: 0 },
        findings: [],
      }),
    ],
    'quality.json',
    { type: 'application/json' },
  );
}
function event(overrides: Record<string, unknown> = {}): MessageEvent<unknown> {
  return { origin: '', source: null, isTrusted: true, data: input(), ...overrides } as unknown as MessageEvent<unknown>;
}

describe('quality worker channel boundary', () => {
  it('validates review declarations without authenticating copied verification claims', async () => {
    const current = parseQualityReport(await input().text()), baseline = { ...current, snapshotId: makeId('snapshot', ['baseline']), commitOid: 'b'.repeat(40) };
    const side = (report: typeof current) => {
      const target = { analysisId: report.analysisId, repoId: report.repoId, snapshotId: report.snapshotId, commitOid: report.commitOid, files: [] };
      const scan = createScanEvidence(report, { format: 'atlas.ruff-profile/1', isolated: true, ignoreNoqa: true, respectGitignore: false, forceExclude: false, targetVersion: 'py314', rules: ['F401'] }, { format: 'atlas.scan-scope/1', files: [] }, 0, target);
      return createReviewSide(scan, 'a'.repeat(64), target, [], { format: 'atlas.review-scan-trust/1', scanCommit: report.commitOid,
        producer: { format: 'atlas.scan-trust/1', repository: 'owner/repo', workflow: '.github/workflows/scan.yml', workflowCommit: report.commitOid,
          sourceCommit: report.commitOid, sourceRef: 'refs/heads/main', trustedRootSha256: 'f'.repeat(64) } });
    };
    const review = createFindingReview(side(current), side(baseline), 'same-producer-policy');
    await scope.onmessage!(event({ data: new File([JSON.stringify(review)], 'review.json') }));
    expect(scope.postMessage).toHaveBeenCalledWith({ ok: true, review });
    expect(scope.postMessage.mock.calls[0]![0]).not.toHaveProperty('verified');
    scope.postMessage.mockClear();
    await scope.onmessage!(event({ data: new File([JSON.stringify({ ...review, source: 'SECRET' })], 'invalid.json') }));
    expect(scope.postMessage).toHaveBeenCalledWith({ ok: false });
  });
  it('opens a scan manifest as a declaration without inventing authenticated browser provenance', async () => {
    const report = parseQualityReport(await input().text());
    const evidence = createScanEvidence(report, { format: 'atlas.ruff-profile/1', isolated: true, ignoreNoqa: true, respectGitignore: false, forceExclude: false, targetVersion: 'py314', rules: ['F401'] }, { format: 'atlas.scan-scope/1', files: [] }, 0, { analysisId: report.analysisId, repoId: report.repoId, snapshotId: report.snapshotId, commitOid: report.commitOid, files: [] });
    await scope.onmessage!(event({ data: new File([JSON.stringify(evidence)], 'scan.json') }));
    expect(scope.postMessage).toHaveBeenCalledWith({ ok: true, report, scan: evidence });
    expect(scope.postMessage.mock.calls[0]![0]).not.toHaveProperty('verified');
  });
  it('accepts a native-shaped private-channel File and validates its contents', async () => {
    await scope.onmessage!(event());
    expect(scope.postMessage).toHaveBeenCalledOnce();
    expect(scope.postMessage).toHaveBeenCalledWith({
      ok: true,
      report: expect.objectContaining({ format: 'atlas.quality/1', findings: [] }),
    });
  });
  it.each([
    { origin: 'https://foreign.invalid' },
    { origin: 'null' },
    { source: {} },
    { isTrusted: false },
    {
      data: {
        size: 0,
        arrayBuffer: () => {
          throw new Error('must not read');
        },
      },
    },
  ])('rejects unexpected channel metadata or payload before reading: %j', async (overrides) => {
    const received = event(overrides);
    const read = vi.spyOn(received.data as File, 'arrayBuffer');
    try {
      await scope.onmessage!(received);
      expect(read).not.toHaveBeenCalled();
      expect(scope.postMessage).toHaveBeenCalledOnce();
      expect(scope.postMessage).toHaveBeenCalledWith({ ok: false });
    } finally {
      read.mockRestore();
    }
  });
});
