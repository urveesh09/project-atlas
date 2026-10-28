import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { qualityTarget, validateQualityReport } from '@atlas/graph';
import { QUALITY_LIMITS, type QualityReport } from '@atlas/schema';
import { useViewer } from './context';

type Slot = 'current' | 'baseline';
interface QualityContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  current: QualityReport | null;
  baseline: QualityReport | null;
  active: QualityReport | null;
  pending: boolean;
  error: string | null;
  message: string;
  load: (file: File, slot: Slot) => Promise<void>;
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
  const [reports, setReports] = useState<Record<Slot, QualityReport | null>>({ current: null, baseline: null });
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
    setReports({ current: null, baseline: null });
    setPending(false);
    setError(null);
    setMessage('External reports cleared from this session.');
  };
  const load = async (file: File, slot: Slot) => {
    const request = ++ticket.current;
    cancel.current?.();
    cancel.current = null;
    setPending(true);
    setError(null);
    setMessage('Checking the local quality report…');
    try {
      if (file.size > QUALITY_LIMITS.bytes) throw new Error('size');
      const report = await new Promise<QualityReport>((resolve, reject) => {
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
        worker.onmessage = (event: MessageEvent<{ ok: boolean; report?: QualityReport }>) => {
          finish();
          if (event.data.ok && event.data.report) resolve(event.data.report);
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
      const index = dataset.frames.findIndex(
        (f) => f.snapshotId === report.snapshotId && f.commit.oid === report.commitOid,
      );
      if (index < 0 || report.analysisId !== dataset.manifest.analysisId || report.repoId !== model.graph.repoId)
        throw new Error('binding');
      const graph = index === model.frame ? model.graph : queries ? (await queries.frame(index)).graph : null;
      if (!graph) throw new Error('frame');
      validateQualityReport(report, qualityTarget(graph, dataset.manifest.analysisId));
      if (request !== ticket.current) return;
      setReports((previous) => ({ ...previous, [slot]: report }));
      setMessage(
        `${slot === 'current' ? 'Current' : 'Baseline'} report opened: ${report.findings.length} Ruff findings. Nothing was uploaded.`,
      );
    } catch {
      if (request !== ticket.current) return;
      setError(
        'Could not open this quality report. Use a valid atlas.quality/1 file of at most 8 MiB, created for a snapshot in this analysis. Existing reports are unchanged.',
      );
      setMessage('Quality report was not opened.');
    } finally {
      if (request === ticket.current) {
        cancel.current = null;
        setPending(false);
      }
    }
  };
  const active = reports.current?.snapshotId === model.graph.snapshotId ? reports.current : null;
  return (
    <QualityContext.Provider value={{ open, setOpen, ...reports, active, pending, error, message, load, clear }}>
      {children}
    </QualityContext.Provider>
  );
}
