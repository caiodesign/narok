import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LabApp } from './LabApp';
// The client's sheets, imported in the client's own order and never copied or
// moved (ruling R164): the ported Hunt sheet, the ported Strategy sheet that
// dresses the setup form, then the laboratory's own small additions.
import '@narok/client/src/styles.css';
import '@narok/client/src/strategy.css';
import '@narok/client/src/setup.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('missing #root element');
}

createRoot(container).render(
  <StrictMode>
    <LabApp />
  </StrictMode>,
);
