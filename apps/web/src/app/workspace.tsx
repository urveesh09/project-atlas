import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react';

/**
 * The expanded workspace (ADR-047): the whole explorer goes full screen, not the canvas
 * alone, so search, lens controls and the evidence inspector stay at hand. Where full
 * screen is refused, the explorer becomes a fixed overlay instead.
 */
export type WorkspaceMode = 'no' | 'fullscreen' | 'overlay';
interface WorkspaceValue {
  mode: WorkspaceMode;
  toggle(): void;
  leave(): void;
  /** The evidence drawer beside the expanded city. */
  drawer: boolean;
  setDrawer(open: boolean): void;
}

const WorkspaceContext = createContext<WorkspaceValue>({ mode: 'no', toggle() {}, leave() {}, drawer: true, setDrawer() {} });
export const useWorkspace = () => useContext(WorkspaceContext);

export function WorkspaceProvider({ target, children }: { target: RefObject<HTMLElement | null>; children: ReactNode }) {
  const [mode, setMode] = useState<WorkspaceMode>('no');
  const [drawer, setDrawer] = useState(true);
  const leave = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    setMode('no');
  }, []);
  const toggle = useCallback(() => {
    const element = target.current;
    if (!element) return;
    if (document.fullscreenElement || mode !== 'no') return leave();
    if (typeof element.requestFullscreen === 'function') element.requestFullscreen().then(() => setMode('fullscreen'), () => setMode('overlay'));
    else setMode('overlay');
  }, [leave, mode, target]);
  useEffect(() => {
    // The browser can leave full screen on its own (its Esc, a tab switch).
    const changed = () => setMode((now) => (document.fullscreenElement && document.fullscreenElement === target.current ? 'fullscreen' : now === 'fullscreen' ? 'no' : now));
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, [target]);
  const value = useMemo(() => ({ mode, toggle, leave, drawer, setDrawer }), [mode, toggle, leave, drawer]);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}
