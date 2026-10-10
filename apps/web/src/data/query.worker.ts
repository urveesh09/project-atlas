import { GraphIndex, SearchIndex } from '@atlas/graph';
import type { GraphSnapshot } from '@atlas/schema';
import type { CityData } from '@atlas/layout';
import { buildOverlay, prepareOverlayLookup, type OverlayOptions } from '../city/overlay';

export type QueryRequest =
  | { id: number; type: 'init'; graph: GraphSnapshot; city: CityData }
  | { id: number; type: 'search'; query: string }
  | { id: number; type: 'reach'; nodeId: string; direction: 'outgoing' | 'incoming'; depth: number }
  | { id: number; type: 'overlay'; options: OverlayOptions };
const scope = self as unknown as {
  postMessage(message: { id: number; result?: unknown; error?: string }): void;
  onmessage: ((event: MessageEvent<QueryRequest>) => void) | null;
};
let index: GraphIndex, search: SearchIndex, city: CityData;
export function initializeQueries(graph: GraphSnapshot, preparedCity: CityData, preparedIndex?: GraphIndex) {
  index = preparedIndex ?? new GraphIndex(graph);
  search = new SearchIndex(graph);
  city = preparedCity;
  prepareOverlayLookup(city);
}
export function handleQuery(q: QueryRequest) {
  try {
    if (q.type === 'init') {
      initializeQueries(q.graph, q.city);
      scope.postMessage({ id: q.id, result: true });
      return;
    }
    if (!index) throw new Error('The query index is not ready');
    const result =
      q.type === 'search'
        ? search.search(q.query.slice(0, 512), 30)
        : q.type === 'reach'
          ? index.reach(q.nodeId, { direction: q.direction, depth: q.depth })
          : buildOverlay(index, city, q.options);
    scope.postMessage({ id: q.id, result });
  } catch (e) {
    scope.postMessage({ id: q.id, error: e instanceof Error ? e.message : 'Query failed' });
  }
}
scope.onmessage = ({ data }) => handleQuery(data);
