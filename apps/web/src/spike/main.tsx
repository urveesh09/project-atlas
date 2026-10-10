import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SpikeApp } from './SpikeApp';
import './spike.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SpikeApp />
  </StrictMode>,
);
