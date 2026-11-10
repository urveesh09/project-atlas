import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ARCHITECTURE_LIMITS, WORKSPACE_LIMITS } from '@atlas/schema';
import { useViewer } from './context';
import type { ArchitectureEvidence, ArchitectureInput } from '../data/query.worker';

interface ArchitectureContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  evidence: ArchitectureEvidence | null;
  pending: boolean;
  available: boolean;
  error: string | null;
  message: string;
  revision: number;
  load: (file: File, input: ArchitectureInput) => Promise<void>;
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
  const [loaded, setLoaded] = useState<{ dataset: typeof dataset; evidence: ArchitectureEvidence } | null>(null);
  const evidence = loaded?.dataset === dataset ? loaded.evidence : null;
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
  const load = async (file: File, input: ArchitectureInput) => {
    if (active.current) return;
    const request = ++ticket.current, owner = {};
    active.current = owner;
    setPending(true);
    setError(null);
    setMessage('Recomputing the local architecture review against this artifact…');
    try {
      const limit = input === 'workspace' ? WORKSPACE_LIMITS.bytes : ARCHITECTURE_LIMITS.reportBytes;
      if (!(file instanceof File) || file.size > limit || !queries) throw new Error();
      const checked = await queries.architecture(file, input);
      if (request !== ticket.current) return;
      setLoaded({ dataset, evidence: checked });
      setRevision(value => value + 1);
      setMessage(checked.workspace
        ? 'Workspace opened. Architecture evidence was recomputed against this artifact. Saved decisions are shown read-only. Nothing was uploaded or saved.'
        : 'Architecture review recomputed against this artifact. Producer provenance remains unauthenticated. Nothing was uploaded or saved.');
    } catch {
      if (request !== ticket.current) return;
      const kind = input === 'workspace' ? 'workspace export of at most 10 MiB' : 'architecture report of at most 8 MiB';
      setError(`Could not open this file. Choose a valid ${kind} for this artifact. Existing evidence is unchanged. Reopen the artifact if its background worker is unavailable.`);
      setMessage('Architecture evidence was not opened.');
    } finally {
      if (active.current === owner) {
        active.current = null;
        setPending(false);
      }
    }
  };
  return <ArchitectureContext.Provider value={{ open, setOpen, evidence, pending, available: queries !== null, error, message, revision, load, clear }}>{children}</ArchitectureContext.Provider>;
}
