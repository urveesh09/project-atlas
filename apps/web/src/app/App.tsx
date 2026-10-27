import { useCallback, useEffect, useRef, useState } from 'react';
import type { LoadResult } from '@atlas/artifact';
import { ARTIFACT_VERSION, type Capabilities, type LegalDocument, type LegalNotices } from '@atlas/schema';
import { CityPreview } from '../components/CityPreview';
import { Explorer } from '../components/Explorer';
import { PublicationUnavailableError, detectLocalSession, loadInWorker, type SourceStatus } from '../data/load';
import { entriesFromInput } from '../data/picked';
import { detectHostedService, fetchLegalNotices } from '../hosted/api';
import { HostedLanding } from '../hosted/HostedLanding';
import { JobPage } from '../hosted/JobPage';
import { LegalPage } from '../hosted/LegalPage';
import { Unavailable } from '../hosted/Unavailable';
import { onNavigate, parseRoute } from '../hosted/route';
import { ViewerProvider } from './context';
import { ViewerDataset, ViewerModel } from './model';
import { parseFragment } from './state';

/** Relative folder of a bundled demo artifact, set only by static demo builds (ADR-044). */
const DEMO_BASE: string = import.meta.env.VITE_ATLAS_DEMO_BASE ?? '';

type Phase =
  | { kind: 'starting' }
  | { kind: 'landing' }
  | { kind: 'loading'; label: string; read: string[] }
  | {
      kind: 'failed';
      result:
        | Extract<LoadResult, { ok: false }>
        | { code: 'LOAD_FAILED'; issues: { code: string; path: string; message: string }[] };
    }
  | { kind: 'ready'; head: ViewerModel; source: SourceStatus | null; hosted: { analysisId: string } | null }
  | { kind: 'hosted-landing'; capabilities: Capabilities; notices: LegalNotices }
  | { kind: 'legal'; document: LegalDocument; capabilities: Capabilities; notices: LegalNotices }
  | { kind: 'job'; jobId: string }
  | { kind: 'unavailable'; code: string };

/**
 * Loads one artifact — from `atlas serve`, from a hosted publication, or from files the
 * user picks — through the same validating worker, then hands an immutable model to the
 * explorer. Picked files are read locally and never uploaded (plan §14.3). On a hosted
 * service it also routes the landing page, job progress and lifecycle screens (§3.1).
 */
export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  const inputRef = useRef<HTMLInputElement>(null);
  const gateHeading = useRef<HTMLHeadingElement>(null);
  // Replacing the picker/cancel/error controls must not strand focus on <body>.
  // Depend on the phase kind, not progress updates, so validation never steals it back.
  useEffect(() => {
    if (phase.kind === 'landing' || phase.kind === 'loading' || phase.kind === 'failed') gateHeading.current?.focus();
  }, [phase.kind]);
  const activeLoad = useRef<AbortController | null>(null);
  // The session owns the dataset's retained worker; replacing or leaving it terminates it.
  const dataset = useRef<ViewerDataset | null>(null);
  const replaceDataset = (next: ViewerDataset | null) => {
    if (dataset.current !== next) dataset.current?.dispose();
    dataset.current = next;
  };

  const run = useCallback(
    async (label: string, request: Parameters<typeof loadInWorker>[0], source: SourceStatus | null, hosted: { analysisId: string } | null = null) => {
      activeLoad.current?.abort();
      const controller = new AbortController();
      activeLoad.current = controller;
      const read: string[] = [];
      setPhase({ kind: 'loading', label, read });
      // Fetch/evaluate our lazy renderer while artifact validation runs. It creates no GPU resources until mounted.
      if ((parseFragment(location.hash).mode ?? '3d') === '3d') void import('../city/ThreeCity').catch(() => {});
      try {
        const result = await loadInWorker(
          request,
          (path) => {
            if (controller.signal.aborted) return;
            read.push(path);
            setPhase({ kind: 'loading', label, read: [...read] });
          },
          controller.signal,
        );
        if (controller.signal.aborted) {
          if (result.ok) result.queryWorker?.terminate();
          return;
        }
        if (result.ok && result.requiredChunksAvailableAt !== undefined) window.__atlasChunksAvailableAt = result.requiredChunksAvailableAt;
        if (result.ok) {
          const next = new ViewerDataset(result.core, result.head, result.queryWorker);
          replaceDataset(next);
          setPhase({ kind: 'ready', head: new ViewerModel(next, next.headIndex, result.head, result.prepared, result.city), source, hosted });
        } else {
          replaceDataset(null);
          setPhase({ kind: 'failed', result });
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof PublicationUnavailableError) {
          replaceDataset(null);
          setPhase({ kind: 'unavailable', code: error.code });
          return;
        }
        setPhase({
          kind: 'failed',
          result: {
            code: 'LOAD_FAILED',
            issues: [{ code: 'LOAD_FAILED', path: '', message: (error as Error).message }],
          },
        });
      }
    },
    [],
  );

  useEffect(() => {
    let disposed = false;
    let routeRevision = 0;
    const route = async () => {
      const revision = ++routeRevision;
      const stale = () => disposed || revision !== routeRevision;
      const current = parseRoute(location.pathname);
      if (current.kind === 'job') {
        activeLoad.current?.abort();
        replaceDataset(null);
        setPhase({ kind: 'job', jobId: current.jobId });
        return;
      }
      if (current.kind === 'analysis') {
        void run('Loading the published analysis', { kind: 'hosted', analysisId: current.analysisId }, null, { analysisId: current.analysisId });
        return;
      }
      activeLoad.current?.abort();
      replaceDataset(null);
      // A static demo build (ADR-044) opens its bundled artifact through the same validation.
      // Neither `atlas serve` nor the hosted service ever serves it, so it does not probe their
      // APIs: on a static host those are two failed requests before the city starts loading.
      // The worker fetches the artifact, so resolve the folder against the page, not the worker script.
      if (DEMO_BASE) return void run('Loading the demo city', { kind: 'server', base: new URL(DEMO_BASE, location.href).pathname }, null);
      const session = await detectLocalSession();
      if (stale()) return;
      if (session) return void run('Loading the served artifact', { kind: 'server', base: '/artifact/' }, session.source);
      const capabilities = await detectHostedService();
      if (stale()) return;
      if (capabilities && (current.kind === 'home' || current.kind === 'legal')) {
        const notices = await fetchLegalNotices();
        if (stale()) return;
        setPhase(current.kind === 'legal' ? { kind: 'legal', document: current.document, capabilities, notices } : { kind: 'hosted-landing', capabilities, notices });
      } else if (capabilities) setPhase({ kind: 'unavailable', code: 'ARTIFACT_NOT_FOUND' });
      else setPhase({ kind: 'landing' });
    };
    void route();
    // Browsers also fire popstate for fragment-only changes; viewer state lives in the
    // fragment and is handled by the viewer, so history moves re-route only on a new path.
    let routedPath = location.pathname;
    const stop = onNavigate((explicit) => {
      if (!explicit && location.pathname === routedPath) return;
      routedPath = location.pathname;
      void route();
    });
    return () => {
      disposed = true;
      stop();
      activeLoad.current?.abort();
      replaceDataset(null);
    };
  }, [run]);

  const openPicker = () => inputRef.current?.click();
  const picker = (
    <input
      ref={inputRef}
      type="file"
      className="sr-only"
      tabIndex={-1}
      aria-hidden="true"
      // Directory selection: the artifact is a folder of chunks.
      {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
      multiple
      onChange={(e) => {
        if (e.target.files && e.target.files.length > 0)
          void run('Validating the selected artifact', { kind: 'files', files: entriesFromInput(e.target.files) }, null);
        e.target.value = '';
      }}
    />
  );

  if (phase.kind === 'ready') {
    return (
      <>
        {picker}
        <ViewerProvider key={phase.head.manifest.analysisId} head={phase.head} source={phase.source}>
          <Explorer onOpenOther={openPicker} hosted={phase.hosted ? { analysisId: phase.hosted.analysisId, expiresAt: phase.head.manifest.expiresAt } : null} />
        </ViewerProvider>
      </>
    );
  }
  if (phase.kind === 'hosted-landing') {
    return (
      <>
        {picker}
        <HostedLanding capabilities={phase.capabilities} notices={phase.notices} onOpenFolder={openPicker} />
      </>
    );
  }
  if (phase.kind === 'legal') return <LegalPage document={phase.document} notices={phase.notices} capabilities={phase.capabilities} />;
  if (phase.kind === 'job') return <JobPage key={phase.jobId} jobId={phase.jobId} />;
  if (phase.kind === 'unavailable') return <Unavailable code={phase.code} />;
  const card = (
      <div className="gate-card">
        <p className="gate-brand">
          <span className="brand-mark" aria-hidden="true">
            ◆
          </span>{' '}
          ATLAS
        </p>
        {phase.kind === 'starting' && <p role="status">Starting…</p>}
        {phase.kind === 'loading' && (
          <div role="status" aria-live="polite">
            <h1 ref={gateHeading} tabIndex={-1}>{phase.label}</h1>
            <p className="gate-note">Checking sizes, hashes and every invariant before anything is shown.</p>
            <ol className="gate-steps">
              {phase.read.map((path) => (
                <li key={path}>
                  <code>{path}</code>
                </li>
              ))}
            </ol>
            <button
              type="button"
              className="button"
              onClick={() => {
                activeLoad.current?.abort();
                replaceDataset(null);
                setPhase({ kind: 'landing' });
              }}
            >
              Cancel loading
            </button>
          </div>
        )}
        {phase.kind === 'landing' && (
          <>
            <h1 ref={gateHeading} tabIndex={-1}>Explore a repository as a city</h1>
            <p className="gate-note">
              Open an artifact folder produced by <code>atlas analyze</code>. It is read and validated entirely in this
              browser; nothing is uploaded.
            </p>
            <button type="button" className="button primary" onClick={openPicker}>
              Open artifact folder…
            </button>
          </>
        )}
        {phase.kind === 'failed' && (
          <div role="alert">
            <h1 ref={gateHeading} tabIndex={-1}>
              {phase.result.code === 'UNSUPPORTED_SCHEMA'
                ? 'This artifact needs a different ATLAS version'
                : 'This artifact could not be opened'}
            </h1>
            <p className="gate-note">
              ATLAS refuses artifacts that fail validation rather than showing partial or tampered data.
            </p>
            <ul className="issues">
              {phase.result.issues.slice(0, 8).map((issue, i) => (
                <li key={i}>
                  <code>{issue.code}</code> {issue.path && <span className="issue-path">{issue.path}</span>}: {issue.message}
                </li>
              ))}
            </ul>
            <button type="button" className="button primary" onClick={openPicker}>
              Open another folder…
            </button>
          </div>
        )}
      </div>
  );
  return (
    <main className="gate">
      {picker}
      {phase.kind === 'landing' ? (
        // The start screen shows what an analysis becomes (ADR-058); loading and errors stay focused.
        <div className="gate-split">
          <div className="gate-column">
            {card}
            <p className="gate-foot">
              Or run <code>atlas serve ./atlas-output</code> to open it with source viewing. Reads {ARTIFACT_VERSION}.
            </p>
          </div>
          <CityPreview />
        </div>
      ) : (
        card
      )}
    </main>
  );
}
