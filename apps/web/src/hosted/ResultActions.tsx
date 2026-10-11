import { useState } from 'react';
import { deleteAnalysis, HostedApiError } from './api';
import { navigate } from './route';

/**
 * Hosted result controls (plan §3.1, §8.6): expiry, a new analysis, and deletion for the
 * browser session that submitted it. Deletion asks once more inline (no modal), and the
 * service decides authority; another visitor's attempt is refused with an explanation.
 */
export function ResultActions({ analysisId, expiresAt }: { analysisId: string; expiresAt: string | null }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const expiry = expiresAt ? new Date(expiresAt) : null;
  const remove = async () => {
    setBusy(true);
    try {
      await deleteAnalysis(analysisId);
      navigate(`/a/${analysisId}`, true);
    } catch (error) {
      const code = error instanceof HostedApiError ? error.detail.code : 'INTERNAL_ERROR';
      setMessage(code === 'FORBIDDEN' ? 'Only the browser session that submitted this analysis can delete it.' : code === 'ARTIFACT_DELETED' ? 'It was already deleted.' : 'Deletion failed; try again later.');
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="hosted-result-actions">
      {expiry && (
        <span className="status status-public" title={expiry.toISOString()}>
          Public until {expiry.toLocaleDateString('en', { month: 'short', day: 'numeric' })}
        </span>
      )}
      <a className="button ghost" href="/" onClick={(e) => { e.preventDefault(); navigate('/'); }}>
        New analysis
      </a>
      {confirming ? (
        <span className="confirm" role="group" aria-label="Confirm deletion">
          <button type="button" className="button danger" onClick={() => void remove()} disabled={busy}>
            {busy ? 'Deleting…' : 'Delete permanently'}
          </button>
          <button type="button" className="button ghost" onClick={() => setConfirming(false)} disabled={busy}>
            Keep
          </button>
        </span>
      ) : (
        <button type="button" className="button ghost" onClick={() => { setMessage(null); setConfirming(true); }}>
          Delete…
        </button>
      )}
      {message && (
        <span className="hosted-inline-note" role="status">
          {message}
        </span>
      )}
    </div>
  );
}
