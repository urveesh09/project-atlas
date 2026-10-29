import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { qualityTarget, validateQualityReport, validateScanEvidence, validateFindingReview } from '@atlas/graph';
import { QUALITY_LIMITS, type QualityReport, type ScanEvidence, type RuffProfile, type FindingReview } from '@atlas/schema';
import { useViewer } from './context';

type Slot = 'current' | 'baseline';
export type DeclaredScanSummary = ReturnType<typeof validateScanEvidence> & {
  profile: RuffProfile;
  profileSha256: string;
};
interface QualityContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  current: QualityReport | null;
  baseline: QualityReport | null;
  active: QualityReport | null;
  review: FindingReview | null;
  scopes: Record<Slot, DeclaredScanSummary | null>;
  pending: boolean;
  error: string | null;
  message: string;
  load: (file: File, slot: Slot | 'review') => Promise<void>;
  clear: () => void;
}
const QualityContext = createContext<QualityContextValue | null>(null);
export function useExternalQuality(): QualityContextValue {
  const context = useContext(QualityContext);
  if (!context) throw new Error('External quality outside its provider');
  return context;
}

export function QualityProvider({ children }: { children: ReactNode }) {
  const { dataset, model, queries } = useViewer();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<
    Record<Slot, { report: QualityReport; scope: DeclaredScanSummary | null } | null> & { review: FindingReview | null }
  >({ current: null, baseline: null, review: null });
  const reports = { current: loaded.current?.report ?? null, baseline: loaded.baseline?.report ?? null };
  const scopes = { current: loaded.current?.scope ?? null, baseline: loaded.baseline?.scope ?? null };
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const ticket = useRef(0);
  const cancel = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      ticket.current++;
      cancel.current?.();
    },
    [],
  );

  const clear = () => {
    ticket.current++;
    cancel.current?.();
    cancel.current = null;
    setLoaded({ current: null, baseline: null, review: null });
    setPending(false);
    setError(null);
    setMessage('External reports cleared from this session.');
  };
  const load = async (file: File, slot: Slot | 'review') => {
    const request = ++ticket.current;
    cancel.current?.();
    cancel.current = null;
    setPending(true);
    setError(null);
    setMessage('Checking the local quality report…');
    try {
      if (file.size > QUALITY_LIMITS.bytes) throw new Error('size');
      const imported = await new Promise<{ report: QualityReport | null; scan: ScanEvidence | null; review: FindingReview | null }>((resolve, reject) => {
        const worker = new Worker(new URL('../data/quality.worker.ts', import.meta.url), {
          type: 'module',
          name: 'atlas-quality-import',
        });
        const finish = () => {
          clearTimeout(deadline);
          worker.terminate();
        };
        const deadline = setTimeout(() => {
          finish();
          reject(new Error('deadline'));
        }, 7_000);
        cancel.current = () => {
          finish();
          reject(new Error('cancelled'));
        };
        worker.onerror = () => {
          finish();
          reject(new Error('worker'));
        };
        worker.onmessage = (event: MessageEvent<{ ok: boolean; report?: QualityReport; scan?: ScanEvidence; review?: FindingReview }>) => {
          finish();
          if (event.data.ok && (event.data.report || event.data.review)) resolve({ report: event.data.report ?? null, scan: event.data.scan ?? null, review: event.data.review ?? null });
          else reject(new Error('invalid'));
        };
        try {
          worker.postMessage(file);
        } catch {
          finish();
          reject(new Error('worker'));
        }
      });
      if (request !== ticket.current) return;
      const targetFor = async (report: QualityReport) => {
        const index = dataset.frames.findIndex((f) => f.snapshotId === report.snapshotId && f.commit.oid === report.commitOid);
        if (index < 0 || report.analysisId !== dataset.manifest.analysisId || report.repoId !== model.graph.repoId) throw new Error('binding');
        const graph = index === model.frame ? model.graph : queries ? (await queries.frame(index)).graph : null;
        if (!graph) throw new Error('frame');
        return qualityTarget(graph, dataset.manifest.analysisId);
      };
      const { report, scan, review } = imported;
      if (review) {
        if (slot !== 'review') throw new Error('choose review input');
        const at = (report: QualityReport) => dataset.frames.findIndex((f) => f.snapshotId === report.snapshotId);
        if (at(review.baseline.report) < 0 || at(review.current.report) <= at(review.baseline.report)) throw new Error('order');
        const oldTarget = await targetFor(review.baseline.report), nowTarget = await targetFor(review.current.report);
        validateFindingReview(review, nowTarget, oldTarget);
        if (request !== ticket.current) return;
        const loadedSide = (side: FindingReview['current']) => ({ report: side.report,
          scope: { ...side.coverage, profile: side.profile, profileSha256: side.profileSha256 } });
        setLoaded({ current: loadedSide(review.current), baseline: loadedSide(review.baseline), review });
        setMessage('Finding review opened: current and baseline reports checked. This review is not authenticated in this browser. Nothing was uploaded.');
        return;
      }
      if (!report || slot === 'review') throw new Error('report type');
      const target = await targetFor(report);
      validateQualityReport(report, target);
      const scope = scan
        ? { ...validateScanEvidence(scan, target), profile: scan.profile, profileSha256: scan.profileSha256 }
        : null;
      if (request !== ticket.current) return;
      setLoaded((previous) => ({ ...previous, [slot]: { report, scope }, review: null }));
      setMessage(
        `${slot === 'current' ? 'Current' : 'Baseline'} report opened: ${report.findings.length} Ruff findings. Nothing was uploaded.`,
      );
    } catch {
      if (request !== ticket.current) return;
      setError(
        'Could not open this quality report or finding review. Choose the matching report button and a valid quality, scan or finding-review JSON of at most 8 MiB for this analysis. Existing reports are unchanged.',
      );
      setMessage('Quality report was not opened.');
    } finally {
      if (request === ticket.current) {
        cancel.current = null;
        setPending(false);
      }
    }
  };
  const active = reports.current?.snapshotId === model.graph.snapshotId ? reports.current
    : loaded.review && reports.baseline?.snapshotId === model.graph.snapshotId ? reports.baseline : null;
  return (
    <QualityContext.Provider
      value={{ open, setOpen, ...reports, scopes, active, review: loaded.review, pending, error, message, load, clear }}
    >
      {children}
    </QualityContext.Provider>
  );
}
