/**
 * Hosted client routes. Paths carry only opaque public IDs; viewer state stays in the
 * fragment and nothing secret ever enters a URL (plan §3.1, §13.1).
 */
export type HostedRoute = { kind: 'home' } | { kind: 'job'; jobId: string } | { kind: 'analysis'; analysisId: string } | { kind: 'unknown' };

export function parseRoute(pathname: string): HostedRoute {
  if (pathname === '/' || pathname === '') return { kind: 'home' };
  const job = /^\/jobs\/(job_[0-9a-f]{32})$/.exec(pathname);
  if (job) return { kind: 'job', jobId: job[1]! };
  const analysis = /^\/a\/(analysis_[0-9a-f]{64})$/.exec(pathname);
  if (analysis) return { kind: 'analysis', analysisId: analysis[1]! };
  return { kind: 'unknown' };
}

const listeners = new Set<() => void>();
export function navigate(path: string, replace = false): void {
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  for (const listener of listeners) listener();
}
export function onNavigate(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
}
