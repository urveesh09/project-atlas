import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { WorkspaceDecisionEdit } from '@atlas/graph';
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
  drafts: ReadonlyMap<string, WorkspaceDecisionEdit>;
  copy: { blob: Blob; revision: number } | null;
  load: (file: File, input: ArchitectureInput) => Promise<void>;
  clear: () => void;
  stage: (edit: WorkspaceDecisionEdit) => boolean;
  discard: (issueId?: string) => void;
  prepareCopy: () => Promise<void>;
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
  const [drafts, setDrafts] = useState<ReadonlyMap<string, WorkspaceDecisionEdit>>(() => new Map());
  const [copy, setCopy] = useState<ArchitectureContextValue['copy']>(null);
  const ticket = useRef(0);
  const active = useRef<object | null>(null);
  useEffect(() => {
    ticket.current++;
    active.current = null;
    setLoaded(null);
    setPending(false);
    setError(null);
    setMessage('');
    setDrafts(new Map());
    setCopy(null);
    return () => { ticket.current++; active.current = null; };
  }, [dataset]);

  const clear = () => {
    // A pending worker operation remains bounded by its existing deadline, but its
    // response can no longer restore cleared evidence. Do not enqueue another until it settles.
    ticket.current++;
    setLoaded(null);
    setError(null);
    setDrafts(new Map());
    setCopy(null);
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
      setDrafts(new Map());
      setCopy(null);
      setMessage(checked.workspace
        ? 'Workspace opened. Architecture evidence was recomputed against this artifact. You can draft changes and download a separate copy.'
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

  const discard = (issueId?: string) => {
    if (active.current) return;
    setDrafts(previous => {
      if (issueId === undefined) return new Map();
      const remaining = new Map(previous);
      remaining.delete(issueId);
      return remaining;
    });
    setCopy(null);
    setError(null);
    setMessage(issueId === undefined ? 'Draft decisions discarded.' : 'Draft decision discarded.');
  };

  const stage = (edit: WorkspaceDecisionEdit): boolean => {
    const workspace = evidence?.workspace;
    if (!workspace || active.current || !workspace.report.rows.some(row => row.id === edit.issueId)) return false;
    const saved = workspace.decisions.find(decision => decision.issueId === edit.issueId);
    if (saved?.state === edit.state && saved.owner === edit.owner) {
      if (drafts.has(edit.issueId)) discard(edit.issueId);
      return true;
    }
    const previous = drafts.get(edit.issueId);
    if (previous?.state === edit.state && previous.owner === edit.owner) return true;
    if (!previous && workspace.revision + drafts.size >= WORKSPACE_LIMITS.revisions) {
      setError('This workspace has reached its revision limit. No draft was added.');
      return false;
    }
    setDrafts(edits => new Map(edits).set(edit.issueId, edit));
    setCopy(null);
    setError(null);
    setMessage('Decision added to the draft. The opened export is unchanged.');
    return true;
  };

  const prepareCopy = async () => {
    const workspace = evidence?.workspace;
    if (!workspace || !queries || !drafts.size || active.current) return;
    const request = ++ticket.current, owner = {};
    active.current = owner;
    setPending(true);
    setError(null);
    setMessage('Checking and preparing a new workspace copy…');
    try {
      const blob = await queries.architectureCopy(workspace, [...drafts.values()]);
      if (request !== ticket.current) return;
      if (!(blob instanceof Blob) || blob.size > WORKSPACE_LIMITS.bytes) throw new Error();
      setCopy({ blob, revision: workspace.revision + drafts.size });
      setMessage('Workspace copy ready to download.');
    } catch {
      if (request !== ticket.current) return;
      setError('Could not prepare a workspace copy. Your draft is still open.');
      setMessage('Workspace copy was not prepared.');
    } finally {
      if (active.current === owner) {
        active.current = null;
        setPending(false);
      }
    }
  };

  return <ArchitectureContext.Provider value={{
    open, setOpen, evidence, pending, available: queries !== null, error, message, revision,
    drafts, copy, load, clear, stage, discard, prepareCopy,
  }}>{children}</ArchitectureContext.Provider>;
}
