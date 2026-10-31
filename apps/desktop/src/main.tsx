import React from 'react';
import { createRoot } from 'react-dom/client';
import { WorkbenchApp } from '@mcvis/ui';
import { tauriHostBridge } from './tauri-bridge.js';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Missing #root element');
}

createRoot(rootEl).render(
  <React.StrictMode>
    <WorkbenchApp bridge={tauriHostBridge} />
  </React.StrictMode>
);
