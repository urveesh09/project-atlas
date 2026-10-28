import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeId } from '@atlas/schema';

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
