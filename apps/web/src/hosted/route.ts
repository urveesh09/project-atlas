import type { LegalDocument } from '@atlas/schema';

/**
 * Hosted client routes. Paths carry only opaque public IDs; viewer state stays in the
 * fragment and nothing secret ever enters a URL (plan §3.1, §13.1).
 */
export type HostedRoute = { kind: 'home' } | { kind: 'job'; jobId: string } | { kind: 'analysis'; analysisId: string } | { kind: 'legal'; document: LegalDocument } | { kind: 'unknown' };

export function parseRoute(pathname: string): HostedRoute {
  if (pathname === '/' || pathname === '') return { kind: 'home' };
  const job = /^\/jobs\/(job_[0-9a-f]{32})$/.exec(pathname);
  if (job) return { kind: 'job', jobId: job[1]! };
  const analysis = /^\/a\/(analysis_[0-9a-f]{64})$/.exec(pathname);
  if (analysis) return { kind: 'analysis', analysisId: analysis[1]! };
  const legal = /^\/(privacy|terms|takedown)$/.exec(pathname);
  if (legal) return { kind: 'legal', document: legal[1] as LegalDocument };
  return { kind: 'unknown' };
}

/** `explicit` is true for in-app navigation (always re-route), false for browser history. */
const listeners = new Set<(explicit: boolean) => void>();
export function navigate(path: string, replace = false): void {
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  for (const listener of listeners) listener(true);
}
export function onNavigate(listener: (explicit: boolean) => void): () => void {
  const onPop = () => listener(false);
  listeners.add(listener);
  window.addEventListener('popstate', onPop);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', onPop);
  };
}
