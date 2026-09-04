// keep this import first: in demo mode it wraps fetch and seeds the token before the session store reads it
import './demo/install';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, HashRouter } from 'react-router-dom';
import { App } from './App';
import { isDemo } from './demo/flag';
import './styles.css';

// the single-file demo is opened from any path (or file://), so routes live in the hash there
const Router = isDemo ? HashRouter : BrowserRouter;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Router>
      <App />
    </Router>
  </StrictMode>,
);
