import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildHandcraftedArtifact } from '@atlas/test-fixtures';
import { prepareCity } from '@atlas/layout';
import { QueryClient } from '../src/data/query';

class FakeWorker {
  static latest: FakeWorker;
  sent: { id: number; type: string }[] = [];
  onmessage?: (event: { data: unknown }) => void;
  onerror?: () => void;
  terminated = false;
  constructor() {
    FakeWorker.latest = this;
  }
  postMessage(message: { id: number; type: string }) {
    this.sent.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  respond(id: number, result: unknown) {
    this.onmessage?.({ data: { id, result } });
  }
}
function setup() {
  vi.stubGlobal('Worker', FakeWorker);
  const f = buildHandcraftedArtifact();
  const client = new QueryClient({ graph: f.graph, city: prepareCity(f.graph, f.layout), frame: 0 });
  const worker = FakeWorker.latest;
  worker.respond(worker.sent[0]!.id, true);
  return { client, worker };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('query worker lifecycle', () => {
  it('routes out-of-order responses to their own request and ignores late duplicates', async () => {
    const { client, worker } = setup();
    const first = client.search(0, 'first'),
      second = client.search(0, 'second');
    worker.respond(worker.sent[2]!.id, [{ id: 'second' }]);
    worker.respond(worker.sent[1]!.id, [{ id: 'first' }]);
    worker.respond(worker.sent[2]!.id, []);
    expect(await first).toEqual([{ id: 'first' }]);
    expect(await second).toEqual([{ id: 'second' }]);
    client.dispose();
    expect(worker.terminated).toBe(true);
  });
  it('rejects pending and future work when a dataset is replaced', async () => {
    const { client, worker } = setup();
    const pending = expect(client.search(0, 'old')).rejects.toThrow('dataset was closed');
    client.dispose();
    await pending;
    worker.respond(worker.sent[1]!.id, [{ id: 'old' }]);
    await expect(client.search(0, 'new')).rejects.toThrow('dataset was closed');
  });
  it('terminates a stalled worker at the deadline instead of leaving requests pending', async () => {
    vi.useFakeTimers();
    const { client, worker } = setup();
    const pending = expect(client.search(0, 'never returns')).rejects.toThrow('deadline');
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;
    expect(worker.terminated).toBe(true);
    await expect(client.search(0, 'after timeout')).rejects.toThrow('deadline');
  });
  it('wraps a session worker without owning it: dispose keeps it alive for the next client', () => {
    vi.stubGlobal('Worker', FakeWorker);
    const f = buildHandcraftedArtifact();
    const session = new FakeWorker() as unknown as Worker;
    const first = new QueryClient({ graph: f.graph, city: prepareCity(f.graph, f.layout), frame: 3 }, session);
    expect((session as unknown as FakeWorker).sent).toEqual([]); // no re-initialization
    void first.overlay(3, { selectedId: null, direction: 'outgoing', includeTypes: false, pinnedEdgeId: null, packages: false }).catch(() => {});
    expect((session as unknown as FakeWorker).sent[0]).toMatchObject({ type: 'overlay', frame: 3 });
    first.dispose();
    expect((session as unknown as FakeWorker).terminated).toBe(false);
    const second = new QueryClient({ graph: f.graph, city: prepareCity(f.graph, f.layout), frame: 3 }, session);
    void second.compare(1, 3).catch(() => {});
    expect((session as unknown as FakeWorker).sent[1]).toMatchObject({ type: 'compare', a: 1, b: 3 });
    second.dispose();
  });
  it('does not deliver an old client response to a replacement client on the same worker', async () => {
    const f = buildHandcraftedArtifact();
    const session = new FakeWorker();
    const head = { graph: f.graph, city: prepareCity(f.graph, f.layout), frame: 0 };
    const first = new QueryClient(head, session as unknown as Worker);
    const rejected = expect(first.search(0, 'old')).rejects.toThrow('dataset was closed');
    const oldId = session.sent.at(-1)!.id;
    first.dispose();
    await rejected;
    const second = new QueryClient(head, session as unknown as Worker);
    const result = second.search(0, 'new');
    const newId = session.sent.at(-1)!.id;
    expect(newId).not.toBe(oldId);
    session.respond(oldId, [{ id: 'old' }]);
    session.respond(newId, [{ id: 'new' }]);
    expect(await result).toEqual([{ id: 'new' }]);
    second.dispose();
  });
});
