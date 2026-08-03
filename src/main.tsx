import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initTheme } from './store/theme';
import { initQueue } from './lib/offlineQueue';
import './index.css';

initTheme();
initQueue();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
}
