import React from 'react';
import { createRoot } from 'react-dom/client';
import { WorkbenchApp } from '@mcvis/ui';
import { webHostBridge } from './web-bridge.js';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Missing #root element');
}

createRoot(rootEl).render(
  <React.StrictMode>
    <WorkbenchApp bridge={webHostBridge} />
  </React.StrictMode>
);
