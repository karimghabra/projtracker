import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './components.css';
import { AppShell } from './AppShell.tsx';
import { UiStore, initStore } from './state/store.ts';
import { chooseVault } from './state/vault.ts';

const choice = chooseVault();
initStore(new UiStore(choice.vault, choice.location));

// Theme is remembered across launches; the system preference is the default.
const stored = window.localStorage.getItem('protracker:theme');
if (stored === 'light' || stored === 'dark') {
  document.documentElement.dataset['theme'] = stored;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppShell />
  </StrictMode>,
);
