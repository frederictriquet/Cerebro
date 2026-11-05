import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { redirectToMobile } from './mobile/redirect.ts';
import '@xterm/xterm/css/xterm.css';
import './styles.css';

const el = document.getElementById('root');
if (!el) throw new Error('Élément #root manquant');

// La redirection d'un téléphone vers /mobile précède tout rendu : rien du desktop ne doit monter.
if (!redirectToMobile()) {
  createRoot(el).render(
    <StrictMode>
      <ErrorBoundary zone="Cerebro" className="error-boundary-root">
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
}
