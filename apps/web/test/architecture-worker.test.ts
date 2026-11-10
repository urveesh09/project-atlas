import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildHandcraftedArtifact } from '@atlas/test-fixtures';
import { GraphIndex, createReviewWorkspace, decideReviewWorkspace, parseReviewWorkspace, reviewArchitecture } from '@atlas/graph';
import { prepareCity } from '@atlas/layout';
import { ARCHITECTURE_LIMITS, WORKSPACE_LIMITS, makeId } from '@atlas/schema';
import type * as QueryWorker from '../src/data/query.worker';

const scope = { onmessage: null as ((event: MessageEvent<unknown>) => void) | null, postMessage: vi.fn() };
// These unit events model channel metadata. Native browser journeys separately
// prove that a real creator-port File is accepted and recomputed without uploads.
let worker: typeof QueryWorker;
const fixture = buildHandcraftedArtifact();
const policy = { format: 'atlas.architecture-policy/1' as const, rules: [{ id: 'internal', kind: 'forbidden-dependency' as const, from: { paths: ['src'] }, to: { paths: ['src'] }, edgeKinds: ['imports-value' as const, 'imports-type' as const] }] };
const report = reviewArchitecture(fixture.manifest.analysisId, fixture.graph, policy);
const file = (value: unknown = report) => new File([JSON.stringify(value)], 'architecture.json', { type: 'application/json' });
const channel = { origin: '', source: null, isTrusted: true };
const ERROR = 'Architecture review could not be checked. Existing evidence is unchanged.';

beforeAll(async () => {
  vi.stubGlobal('self', scope);
  worker = await import('../src/data/query.worker');
});
beforeEach(() => {
  scope.postMessage.mockClear();
  const index = new GraphIndex(fixture.graph), city = prepareCity(fixture.graph, fixture.layout);
  worker.initializeQueries(new worker.FrameStore(null, { frame: 0, graph: fixture.graph, index, city }, fixture.manifest));
});
afterAll(() => vi.unstubAllGlobals());

describe('architecture import in the retained worker', () => {
  it('accepts a private-channel native-shaped File and recomputes its report against retained data', async () => {
    await worker.handleQuery({ id: 1, type: 'architecture', input: 'report', file: file() }, channel);
    expect(scope.postMessage).toHaveBeenCalledExactlyOnceWith({ id: 1, result: { report, workspace: null } });
    expect(scope.postMessage.mock.calls[0]![0]).not.toHaveProperty('verified');
  });
  it.each([
    { origin: 'https://foreign.invalid' }, { origin: 'null' }, { source: {} }, { isTrusted: false },
  ])('rejects foreign or synthetic channel metadata before reading: %j', async overrides => {
    const picked = file(), read = vi.spyOn(picked, 'arrayBuffer');
    try {
      await worker.handleQuery({ id: 2, type: 'architecture', input: 'report', file: picked }, { ...channel, ...overrides } as Parameters<typeof worker.handleQuery>[1]);
      expect(read).not.toHaveBeenCalled();
      expect(scope.postMessage).toHaveBeenCalledExactlyOnceWith({ id: 2, error: ERROR });
    } finally { read.mockRestore(); }
  });
  it('rejects missing metadata, non-Files, oversized native Files and invalid request IDs before reads', async () => {
    const fake = { size: 0, arrayBuffer: vi.fn() };
    await worker.handleQuery({ id: 3, type: 'architecture', input: 'report', file: fake as unknown as File }, channel);
    expect(fake.arrayBuffer).not.toHaveBeenCalled();
    const picked = new File([new Uint8Array(ARCHITECTURE_LIMITS.reportBytes + 1)], 'too-large.json');
    const read = vi.spyOn(picked, 'arrayBuffer');
    try {
      await worker.handleQuery({ id: 4, type: 'architecture', input: 'report', file: picked }, channel);
      expect(read).not.toHaveBeenCalled();
      await worker.handleQuery({ id: 5, type: 'architecture', input: 'report', file: file() });
      await worker.handleQuery({ id: 0, type: 'architecture', input: 'report', file: file() }, channel);
      expect(scope.postMessage.mock.calls.every(([value]) => value.error === ERROR && !('result' in value))).toBe(true);
    } finally { read.mockRestore(); }
  });
  it('rejects copied counts, rows, policy edits and unsupported trust claims without echoing text', async () => {
    const count = structuredClone(report); count.rules[0]!.current++;
    const rows = structuredClone(report); rows.rows = [];
    const changedPolicy = structuredClone(report);
    if (changedPolicy.policy.rules[0]?.kind === 'forbidden-dependency') changedPolicy.policy.rules[0].from.paths = ['PRIVATE_SOURCE'];
    for (const [i, value] of [count, rows, changedPolicy, { ...report, verified: true, source: 'PRIVATE_SOURCE' }].entries()) {
      await worker.handleQuery({ id: i + 10, type: 'architecture', input: 'report', file: file(value) }, channel);
      expect(scope.postMessage.mock.calls.at(-1)?.[0]).toEqual({ id: i + 10, error: ERROR });
    }
    expect(JSON.stringify(scope.postMessage.mock.calls)).not.toContain('PRIVATE_SOURCE');
  });
  it('binds analysis, repository, full commit, snapshot and earlier-baseline order before recomputation', async () => {
    const variants = [
      { ...report, analysisId: makeId('analysis', ['wrong']) },
      { ...report, repoId: makeId('repository', ['wrong']) },
      { ...report, current: { ...report.current, commitOid: 'f'.repeat(40) } },
      { ...report, current: { ...report.current, snapshotId: makeId('snapshot', ['wrong']) } },
      { ...report, baseline: report.current },
    ];
    for (const [i, value] of variants.entries()) {
      await worker.handleQuery({ id: i + 20, type: 'architecture', input: 'report', file: file(value) }, channel);
      expect(scope.postMessage.mock.calls.at(-1)?.[0]).toEqual({ id: i + 20, error: ERROR });
    }
  });
  it('rejects malformed JSON and invalid UTF-8 with a fixed error', async () => {
    for (const [i, picked] of [new File(['{"PRIVATE_SOURCE":'], 'bad.json'), new File([new Uint8Array([0xc0, 0x80])], 'bad-utf8.json')].entries()) {
      await worker.handleQuery({ id: i + 30, type: 'architecture', input: 'report', file: picked }, channel);
      expect(scope.postMessage.mock.calls.at(-1)?.[0]).toEqual({ id: i + 30, error: ERROR });
    }
  });
  it('fails closed when the session lacks retained artifact metadata', async () => {
    const index = new GraphIndex(fixture.graph), city = prepareCity(fixture.graph, fixture.layout);
    worker.initializeQueries(new worker.FrameStore(null, { frame: 0, graph: fixture.graph, index, city }));
    await worker.handleQuery({ id: 40, type: 'architecture', input: 'report', file: file() }, channel);
    expect(scope.postMessage).toHaveBeenCalledExactlyOnceWith({ id: 40, error: ERROR });
  });
});

describe('local workspace import in the retained worker', () => {
  it('returns recomputed evidence and only checked decision metadata', async () => {
    const initial = createReviewWorkspace(report);
    const saved = decideReviewWorkspace(initial, 0, report.rows[0]!.id, 'acknowledged', 'maintainers');
    await worker.handleQuery({ id: 41, type: 'architecture', input: 'workspace', file: file(saved) }, channel);
    expect(scope.postMessage).toHaveBeenCalledExactlyOnceWith({
      id: 41, result: { report, workspace: saved },
    });
  });

  it('rejects a rehashed forged report, unrelated analysis, invalid revision and extra ownership fields', async () => {
    const wrongCounts = structuredClone(report);
    wrongCounts.rules[0]!.current++;
    const initial = createReviewWorkspace(report);
    const saved = decideReviewWorkspace(initial, 0, report.rows[0]!.id, 'deferred', 'maintainers');
    const cases = [
      createReviewWorkspace(wrongCounts),
      createReviewWorkspace({ ...report, analysisId: makeId('analysis', ['unrelated']) }),
      { ...saved, revision: 2 },
      { ...saved, decisions: [{ ...saved.decisions[0], author: 'PRIVATE_OWNER' }] },
    ];
    for (const [index, value] of cases.entries()) {
      const id = index + 42;
      await worker.handleQuery({ id, type: 'architecture', input: 'workspace', file: file(value) }, channel);
      expect(scope.postMessage.mock.calls.at(-1)?.[0]).toEqual({ id, error: ERROR });
    }
    expect(JSON.stringify(scope.postMessage.mock.calls)).not.toContain('PRIVATE_OWNER');
  });

  it('enforces the workspace byte cap before reading the file', async () => {
    const picked = new File([new Uint8Array(WORKSPACE_LIMITS.bytes + 1)], 'too-large.json');
    const read = vi.spyOn(picked, 'arrayBuffer');
    await worker.handleQuery({ id: 46, type: 'architecture', input: 'workspace', file: picked }, channel);
    expect(read).not.toHaveBeenCalled();
    expect(scope.postMessage).toHaveBeenCalledExactlyOnceWith({ id: 46, error: ERROR });
  });

  it('prepares a canonical copy and refuses foreign channels or forged evidence', async () => {
    const workspace = createReviewWorkspace(report);
    const edits = [{ issueId: report.rows[0]!.id, state: 'deferred' as const, owner: 'maintainers' as const }];
    await worker.handleQuery({ id: 47, type: 'architecture-copy', workspace, edits }, channel);
    const blob = scope.postMessage.mock.calls[0]![0].result as Blob;
    expect(blob.type).toBe('application/json');
    expect(parseReviewWorkspace(await blob.text())).toMatchObject({ report, revision: 1, decisions: edits });
    const forged = structuredClone(report);
    forged.rules[0]!.current++;
    await worker.handleQuery({ id: 48, type: 'architecture-copy', workspace: createReviewWorkspace(forged), edits }, channel);
    await worker.handleQuery({ id: 49, type: 'architecture-copy', workspace, edits }, { ...channel, isTrusted: false });
    expect(scope.postMessage.mock.calls.slice(1).map(([value]) => value)).toEqual([
      { id: 48, error: 'Workspace copy could not be prepared.' },
      { id: 49, error: 'Workspace copy could not be prepared.' },
    ]);
  });
});
