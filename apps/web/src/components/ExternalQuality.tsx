import { useMemo, useRef } from 'react';
import { compareQualityReports, qualityRuleLabel } from '@atlas/graph';
import { compareUtf8, type GraphNode, type QualityFinding, type QualityReport } from '@atlas/schema';
import { useExternalQuality, type DeclaredScanSummary } from '../app/quality';
import { useViewer } from '../app/context';
import { shortOid } from '../app/model';
import { Paged, Section } from './ui';

function FindingsList({
  findings,
  empty = 'No retained findings. This does not establish a clean scan.',
}: {
  findings: QualityFinding[];
  empty?: string;
}) {
  const { select, dispatch } = useViewer();
  const ordered = useMemo(
    () =>
      findings.toSorted(
        (a, b) =>
          compareUtf8(a.path, b.path) ||
          a.line - b.line ||
          (a.column ?? 0) - (b.column ?? 0) ||
          compareUtf8(a.ruleId, b.ruleId),
      ),
    [findings],
  );
  return (
    <Paged
      items={ordered}
      pageSize={20}
      empty={empty}
      render={(f) => (
        <li key={f.id}>
          <button
            type="button"
            className="link"
            onClick={() => {
              select(f.nodeId, { focusInspector: true });
              dispatch({ type: 'tab', tab: 'findings' });
            }}
          >
            {f.path}:{f.line}
            {f.column === null ? '' : `:${f.column}`}
          </button>
          <span>
            {f.ruleId} · {qualityRuleLabel(f.ruleId)} · reported {f.level}
          </span>
        </li>
      )}
    />
  );
}

function ReportSummary({ report }: { report: QualityReport }) {
  const dropped = Object.values(report.dropped).reduce((a, n) => a + n, 0);
  return (
    <p>
      Ruff {report.tool.version} · commit {shortOid(report.commitOid)} · {report.findings.length} retained of{' '}
      {report.inputResults} results. {dropped > report.dropped.duplicates ? 'Partial import. ' : ''}
      Dropped: {report.dropped.unmapped} unmapped, {report.dropped.unsupported} unsupported, {report.dropped.suppressed}{' '}
      suppressed, {report.dropped.duplicates} duplicates.
    </p>
  );
}

function DeclaredScope({ scope }: { scope: DeclaredScanSummary | null }) {
  if (!scope) return null;
  return (
    <section aria-label="Producer-declared scan scope">
      <h3>Producer-declared scan scope</h3>
      <p>
        {scope.declaredScannedFiles} of {scope.analyzedPythonFiles} analyzed Python files declared scanned. Missing:{' '}
        {scope.missingFiles}; dropped records: {scope.droppedRecords}.
      </p>
      <p>
        Isolated Ruff · Python {scope.profile.targetVersion.slice(2, 3)}.{scope.profile.targetVersion.slice(3)} ·{' '}
        {scope.profile.rules.slice(0, 8).join(', ')}
        {scope.profile.rules.length > 8 ? ` + ${scope.profile.rules.length - 8} more rules` : ''}.
      </p>
      <p className="section-description">
        Profile SHA-256: <code>{scope.profileSha256}</code>
      </p>
      <p className="quality-caveat">
        This declaration is not authenticated in this browser. Verify the signature with <code>atlas verify-scan</code>.
        A matching file list does not prove execution, complete repository coverage or a clean scan.
      </p>
    </section>
  );
}

export function ExternalQualityPanel() {
  const quality = useExternalQuality();
  const { dataset, model, goToFrame } = useViewer();
  const currentInput = useRef<HTMLInputElement>(null),
    baselineInput = useRef<HTMLInputElement>(null);
  // Selection/frame changes must not re-hash thousands of unchanged report rows.
  const { compared, comparisonError } = useMemo(() => {
    if (!quality.current || !quality.baseline) return { compared: null, comparisonError: false };
    if (
      quality.scopes.current &&
      quality.scopes.baseline &&
      quality.scopes.current.profileSha256 !== quality.scopes.baseline.profileSha256
    )
      return { compared: null, comparisonError: true };
    try {
      return { compared: compareQualityReports(quality.current, quality.baseline), comparisonError: false };
    } catch {
      return { compared: null, comparisonError: true };
    }
  }, [
    quality.current,
    quality.baseline,
    quality.scopes.current?.profileSha256,
    quality.scopes.baseline?.profileSha256,
  ]);
  if (!quality.open) return null;
  return (
    <section id="external-quality-panel" className="external-quality panel" aria-labelledby="external-quality-title">
      <div className="external-quality-heading">
        <h2 id="external-quality-title">External findings</h2>
        <button
          type="button"
          className="button ghost"
          onClick={() => {
            quality.setOpen(false);
            document.getElementById('external-quality-toggle')?.focus();
          }}
        >
          Hide external findings
        </button>
      </div>
      <p>
        Open a local quality or scan-evidence JSON created by <code>atlas findings</code> or{' '}
        <code>atlas scan-evidence</code>. Files stay in this browser session; nothing is uploaded or saved
        automatically.
      </p>
      <p className="quality-caveat">
        These are reported lint findings, separate from ATLAS heuristics. Commit binding is user-declared; scan scope
        and configuration are unverified. Zero findings does not mean clean, secure or fully scanned.
      </p>
      <div className="external-quality-actions">
        {(['current', 'baseline'] as const).map((slot) => (
          <span key={slot}>
            <input
              ref={slot === 'current' ? currentInput : baselineInput}
              type="file"
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              data-quality={slot}
              accept=".json,application/json"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = '';
                if (file) void quality.load(file, slot);
              }}
            />
            <button
              type="button"
              className="button"
              onClick={() => (slot === 'current' ? currentInput : baselineInput).current?.click()}
            >
              Open {slot} quality report…
            </button>{' '}
          </span>
        ))}
        <button
          type="button"
          className="button ghost"
          disabled={!quality.current && !quality.baseline && !quality.pending}
          onClick={quality.clear}
        >
          {quality.pending ? 'Cancel and clear reports' : 'Clear reports'}
        </button>
      </div>
      <p role="status" aria-live="polite">
        {quality.message}
      </p>
      {quality.error && <p role="alert">{quality.error}</p>}
      {quality.current && (
        <>
          <h3>Current report</h3>
          <ReportSummary report={quality.current} />
          <DeclaredScope scope={quality.scopes.current} />
          {quality.active ? (
            <FindingsList findings={quality.active.findings} />
          ) : (
            <p>
              Report findings are hidden on this snapshot to prevent stale evidence.{' '}
              <button
                type="button"
                className="link"
                onClick={() =>
                  void goToFrame(dataset.frames.findIndex((f) => f.snapshotId === quality.current!.snapshotId))
                }
              >
                Show report snapshot
              </button>
            </p>
          )}
        </>
      )}
      {quality.baseline && (
        <>
          <h3>Baseline report</h3>
          <ReportSummary report={quality.baseline} />
          <DeclaredScope scope={quality.scopes.baseline} />
        </>
      )}
      {compared && (
        <section aria-label="External report comparison">
          <h3>Exact-location comparison</h3>
          <p>
            {compared.newlyReported.length} newly reported; {compared.noLongerReported.length} no longer reported;{' '}
            {compared.sameLocation.length} at the same location.
          </p>
          <p>
            Line movement can produce unmatched locations on both sides. Missing findings do not establish resolution:
            scan scope and configuration are unverified. Reported severity may change at the same location.
          </p>
          {quality.active && (
            <Section title="Newly reported locations" count={compared.newlyReported.length}>
              <FindingsList
                findings={compared.newlyReported}
                empty="No newly reported exact locations in these reports."
              />
            </Section>
          )}
        </section>
      )}
      {comparisonError && (
        <p role="alert">
          Comparison is unavailable: use the same analysis and Ruff version; declared profiles must match when both
          reports include them.
        </p>
      )}
      <p className="section-description">
        Viewing snapshot {model.frame + 1} of {dataset.frames.length}. Closing this artifact discards these external
        reports.
      </p>
    </section>
  );
}

export function ExternalFileFindings({ node }: { node: GraphNode }) {
  const quality = useExternalQuality();
  if (!quality.active || node.kind !== 'file') return null;
  const findings = quality.active.findings.filter((f) => f.nodeId === node.id);
  return (
    <Section
      title="External Ruff findings"
      count={findings.length}
      description="Reported lint findings. Commit and scan scope are user-declared/unverified; original source messages are not retained."
    >
      <Paged
        items={findings}
        pageSize={20}
        empty="No retained findings for this file; scan coverage is unverified."
        render={(f) => (
          <li key={f.id}>
            {f.ruleId} · {qualityRuleLabel(f.ruleId)} · line {f.line}
            {f.column === null ? '' : `:${f.column}`} · reported {f.level}
          </li>
        )}
      />
    </Section>
  );
}
