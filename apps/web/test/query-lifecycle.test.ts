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
  const client = new QueryClient(f.graph, prepareCity(f.graph, f.layout));
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
    const first = client.search('first'),
      second = client.search('second');
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
    const pending = expect(client.search('old')).rejects.toThrow('dataset was closed');
    client.dispose();
    await pending;
    worker.respond(worker.sent[1]!.id, [{ id: 'old' }]);
    await expect(client.search('new')).rejects.toThrow('dataset was closed');
  });
  it('terminates a stalled worker at the deadline instead of leaving requests pending', async () => {
    vi.useFakeTimers();
    const { client, worker } = setup();
    const pending = expect(client.search('never returns')).rejects.toThrow('deadline');
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;
    expect(worker.terminated).toBe(true);
    await expect(client.search('after timeout')).rejects.toThrow('deadline');
  });
});
