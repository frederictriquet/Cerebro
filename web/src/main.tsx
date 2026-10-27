import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import '@xterm/xterm/css/xterm.css';
import './styles.css';

const el = document.getElementById('root');
if (!el) throw new Error('Élément #root manquant');

createRoot(el).render(
  <StrictMode>
    <ErrorBoundary zone="Cerebro" className="error-boundary-root">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
