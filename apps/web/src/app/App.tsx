import { useCallback, useEffect, useRef, useState } from 'react';
import type { LoadResult } from '@atlas/artifact';
import { ARTIFACT_VERSION } from '@atlas/schema';
import { Explorer } from '../components/Explorer';
import { detectLocalSession, filesFromInput, loadInWorker, type SourceStatus } from '../data/load';
import { ViewerProvider } from './context';
import { ViewerModel } from './model';
import { parseFragment } from './state';

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
  | { kind: 'ready'; model: ViewerModel; source: SourceStatus | null };

/**
 * Loads one artifact — from `atlas serve` or from files the user picks — through the
 * validating worker, then hands an immutable model to the explorer. Picked files are
 * read locally and never uploaded (plan §14.3).
 */
export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  const inputRef = useRef<HTMLInputElement>(null);
  const activeLoad = useRef<AbortController | null>(null);

  const run = useCallback(
    async (label: string, request: Parameters<typeof loadInWorker>[0], source: SourceStatus | null) => {
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
          result.queryWorker?.terminate();
          return;
        }
        if (result.requiredChunksAvailableAt !== undefined)
          window.__atlasChunksAvailableAt = result.requiredChunksAvailableAt;
        if (result.ok)
          setPhase({
            kind: 'ready',
            model: new ViewerModel(result.bundle, result.prepared, result.city, result.queryWorker),
            source,
          });
        else setPhase({ kind: 'failed', result });
      } catch (error) {
        if (controller.signal.aborted) return;
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
    void detectLocalSession().then((session) => {
      if (disposed) return;
      if (session) void run('Loading the served artifact', { kind: 'server', base: '/artifact/' }, session.source);
      else setPhase({ kind: 'landing' });
    });
    return () => {
      disposed = true;
      activeLoad.current?.abort();
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
          void run('Validating the selected artifact', { kind: 'files', files: filesFromInput(e.target.files) }, null);
        e.target.value = '';
      }}
    />
  );

  if (phase.kind === 'ready') {
    return (
      <>
        {picker}
        <ViewerProvider key={phase.model.manifest.analysisId} model={phase.model} source={phase.source}>
          <Explorer onOpenOther={openPicker} />
        </ViewerProvider>
      </>
    );
  }
  return (
    <main className="gate">
      {picker}
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
            <h1>{phase.label}</h1>
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
                setPhase({ kind: 'landing' });
              }}
            >
              Cancel loading
            </button>
          </div>
        )}
        {phase.kind === 'landing' && (
          <>
            <h1>Explore a repository as a city</h1>
            <p className="gate-note">
              Open an artifact folder produced by <code>atlas analyze</code>. It is read and validated entirely in this
              browser; nothing is uploaded.
            </p>
            <button type="button" className="button primary" onClick={openPicker}>
              Open artifact folder…
            </button>
            <p className="gate-small">
              Or run <code>atlas serve ./atlas-output</code> to open it with source viewing. Reads {ARTIFACT_VERSION}.
            </p>
          </>
        )}
        {phase.kind === 'failed' && (
          <div role="alert">
            <h1>
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
                  <code>{issue.code}</code> {issue.path && <span className="issue-path">{issue.path}</span>} —{' '}
                  {issue.message}
                </li>
              ))}
            </ul>
            <button type="button" className="button primary" onClick={openPicker}>
              Open another folder…
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
