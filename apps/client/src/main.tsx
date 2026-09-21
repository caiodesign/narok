import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
// The Strategy screen's sheet, ported the same way and equally uneditable; it
// dresses the setup form the Hunt mockup has no place for.
import './strategy.css';
// The laboratory's own additions on top of both. Last, and deliberately small.
import './setup.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('missing #root element');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
