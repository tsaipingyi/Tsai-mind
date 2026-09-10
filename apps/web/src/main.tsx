// keep this import first: in demo / cloud mode it wraps fetch and seeds the token before the session store reads it
import './demo/install';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, HashRouter } from 'react-router-dom';
import { App } from './App';
import { isDemo } from './demo/flag';
import { isCloud } from './cloud/mode';
import { CloudStatusFallback } from './cloud/StatusPill';
import './styles.css';

// the single-file demo / cloud page is opened from any path (or file://), so routes live in the hash there
const Router = isDemo ? HashRouter : BrowserRouter;

if (isCloud) {
  // cloud mode: no demo banner (the status pill replaces it); the layout decides where the pill lives
  const style = document.createElement('style');
  style.textContent = '.demo-banner{display:none}';
  document.head.appendChild(style);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Router>
      <App />
    </Router>
    {isCloud && <CloudStatusFallback />}
  </StrictMode>,
);
