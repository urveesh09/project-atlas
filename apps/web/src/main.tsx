import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ARTIFACT_VERSION, GRAPH_SCHEMA_VERSION, LAYOUT_VERSION } from '@atlas/schema';

/**
 * Viewer shell. The functional viewer (tree, search, inspector) arrives in P2.6 and the
 * city renderer in P3.2; until then this page states exactly what exists.
 */
function Shell() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 680, margin: '3rem auto', padding: '0 16px', lineHeight: 1.5 }}>
      <h1>ATLAS</h1>
      <p>Phase 0 skeleton. The viewer reads artifacts with these contract versions:</p>
      <ul>
        <li>{GRAPH_SCHEMA_VERSION}</li>
        <li>{LAYOUT_VERSION}</li>
        <li>{ARTIFACT_VERSION}</li>
      </ul>
      <p>
        <a href="./spike.html">Open the instancing spike (synthetic data)</a>
      </p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
