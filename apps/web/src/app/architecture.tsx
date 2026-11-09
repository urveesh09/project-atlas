import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ARCHITECTURE_LIMITS, type ArchitectureReview } from '@atlas/schema';
import { useViewer } from './context';

interface ArchitectureContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  report: ArchitectureReview | null;
  pending: boolean;
  available: boolean;
  error: string | null;
  message: string;
  revision: number;
  load: (file: File) => Promise<void>;
  clear: () => void;
}
const ArchitectureContext = createContext<ArchitectureContextValue | null>(null);
export function useArchitectureReview(): ArchitectureContextValue {
  const value = useContext(ArchitectureContext);
  if (!value) throw new Error('Architecture review outside its provider');
  return value;
}

/** One local import per dataset, validated in its retained worker (ADR-090). */
export function ArchitectureProvider({ children }: { children: ReactNode }) {
  const { dataset, queries } = useViewer();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<{ dataset: typeof dataset; report: ArchitectureReview } | null>(null);
  const report = loaded?.dataset === dataset ? loaded.report : null;
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const ticket = useRef(0);
  const active = useRef<object | null>(null);
  useEffect(() => {
    ticket.current++;
    active.current = null;
    setLoaded(null);
    setPending(false);
    setError(null);
    setMessage('');
    return () => { ticket.current++; active.current = null; };
  }, [dataset]);

  const clear = () => {
    // A pending worker operation remains bounded by its existing deadline, but its
    // response can no longer restore cleared evidence. Do not enqueue another until it settles.
    ticket.current++;
    setLoaded(null);
    setError(null);
    setMessage('Architecture review cleared from this session.');
  };
  const load = async (file: File) => {
    if (active.current) return;
    const request = ++ticket.current, owner = {};
    active.current = owner;
    setPending(true);
    setError(null);
    setMessage('Recomputing the local architecture review against this artifact…');
    try {
      if (!(file instanceof File) || file.size > ARCHITECTURE_LIMITS.reportBytes || !queries) throw new Error();
      const checked = await queries.architecture(file);
      if (request !== ticket.current) return;
      setLoaded({ dataset, report: checked });
      setRevision(value => value + 1);
      setMessage('Architecture review recomputed against this artifact. Producer provenance remains unauthenticated. Nothing was uploaded or saved.');
    } catch {
      if (request !== ticket.current) return;
      setError('Could not open this architecture review. Choose a valid architecture-review JSON of at most 8 MiB for this artifact. Existing evidence is unchanged. Reopen the artifact if its background worker is unavailable.');
      setMessage('Architecture review was not opened.');
    } finally {
      if (active.current === owner) {
        active.current = null;
        setPending(false);
      }
    }
  };
  return <ArchitectureContext.Provider value={{ open, setOpen, report, pending, available: queries !== null, error, message, revision, load, clear }}>{children}</ArchitectureContext.Provider>;
}
