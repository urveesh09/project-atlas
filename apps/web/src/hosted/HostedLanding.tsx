import { useEffect, useId, useRef, useState } from 'react';
import type { Capabilities } from '@atlas/schema';
import { CityPreview } from '../components/CityPreview';
import { HostedApiError, submitAnalysis } from './api';
import { errorText } from './messages';
import { navigate } from './route';

/** Accept only what the service accepts (plan §8.2); the service re-validates everything. */
const ROOT_URL = /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/[A-Za-z0-9._-]{1,100}?(?:\.git)?\/?$/;

/**
 * Hosted landing (plan §3.1, §3.3): one repository field, a concrete public-output notice
 * the visitor must accept, the language and limit summary, the demo and the local route.
 */
export function HostedLanding({ capabilities, onOpenFolder }: { capabilities: Capabilities; onOpenFolder: () => void }) {
  const [url, setUrl] = useState('');
  const [history, setHistory] = useState(true);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ title: string; guidance: string; retryAfter?: number } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const urlId = useId();
  const noticeId = useId();
  const errorId = useId();
  useEffect(() => heading.current?.focus(), []);
  const limits = capabilities.limits;
  const valid = ROOT_URL.test(url.trim());

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!valid) {
      setError(errorText('INVALID_REPOSITORY_URL'));
      return;
    }
    if (!consent || busy) return;
    setBusy(true);
    setError(null);
    try {
      const accepted = await submitAnalysis(url.trim(), history);
      navigate(`/jobs/${accepted.jobId}`);
    } catch (failure) {
      const detail = failure instanceof HostedApiError ? failure.detail : null;
      setError(errorText(detail?.code ?? 'INTERNAL_ERROR'));
      setBusy(false);
    }
  };

  return (
    <main className="gate">
      <div className="gate-split">
      <div className="gate-card hosted-card">
        <p className="gate-brand">
          <span className="brand-mark" aria-hidden="true">
            ◆
          </span>{' '}
          ATLAS
        </p>
        <h1 ref={heading} tabIndex={-1}>
          Explore a public GitHub repository as a city
        </h1>
        <form className="hosted-form" onSubmit={(e) => void submit(e)} noValidate>
          <label htmlFor={urlId}>Repository URL</label>
          <input
            id={urlId}
            className="text-input"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://github.com/owner/repository"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            aria-invalid={error !== null && !valid}
            aria-describedby={error ? errorId : undefined}
            required
          />
          <label className="check">
            <input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} /> Include mainline history (up to {limits['historyLookbackDays']} days, {limits['firstParentCommits']} commits, {limits['analyzedFrames']} snapshots)
          </label>
          <div className="notice" id={noticeId}>
            <h2>The result is public</h2>
            <ul>
              <li>Anyone with the link can open it for {limits['publicationTtlDays']} days, or until you delete it.</li>
              <li>It shows file paths, package and declaration names, metrics, dependencies and commit IDs. Source text is never stored.</li>
              <li>It is withdrawn if the repository stops being public; copies already downloaded cannot be recalled.</li>
            </ul>
          </div>
          <label className="check">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} aria-describedby={noticeId} /> I understand the result will be public
          </label>
          {error && (
            <div className="hosted-error" id={errorId} role="alert">
              <strong>{error.title}.</strong> {error.guidance}
            </div>
          )}
          <button type="submit" className="button primary" disabled={!consent || busy} aria-disabled={!consent || busy}>
            {busy ? 'Submitting…' : 'Analyze repository'}
          </button>
        </form>
        <p className="gate-small">
          TypeScript and JavaScript ({capabilities.languages[0]?.extensions.join(' ')}); other files appear as structure. Up to {limits['includedFilesPerSnapshot']?.toLocaleString('en')} files; analysis stops after {Number(limits['workerDeadlineMs']) / 1000} seconds.
        </p>
        <div className="hosted-alternatives">
          {capabilities.demoAnalysisId && (
            <a className="button" href={`/a/${capabilities.demoAnalysisId}`} onClick={(e) => { e.preventDefault(); navigate(`/a/${capabilities.demoAnalysisId}`); }}>
              Explore the demo city
            </a>
          )}
          <button type="button" className="button" onClick={onOpenFolder}>
            Open a local artifact folder…
          </button>
        </div>
        <p className="gate-small">
          Private code: run <code>atlas analyze .</code> then <code>atlas serve ./atlas-output</code>. Local analysis never uploads anything; opened folders stay in this browser.
        </p>
      </div>
      <CityPreview />
      </div>
    </main>
  );
}
