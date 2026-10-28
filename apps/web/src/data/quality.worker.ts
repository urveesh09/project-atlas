import { parseQualityReport } from '@atlas/graph';
import { QUALITY_LIMITS } from '@atlas/schema';

/** File bytes/JSON/schema work stay off the UI thread. This worker never fetches URLs. */
self.onmessage = async (event: MessageEvent<File>) => {
  try {
    if (event.data.size > QUALITY_LIMITS.bytes) throw new Error();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await event.data.arrayBuffer());
    self.postMessage({ ok: true, report: parseQualityReport(text) });
  } catch {
    self.postMessage({ ok: false }); // Never echo parser errors containing report text.
  }
};
