import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './components.css';
import { AppShell } from './AppShell.tsx';
import { UiStore, initStore } from './state/store.ts';
import { chooseVault } from './state/vault.ts';
import { applyTheme, storedTheme } from './themes.ts';

const choice = chooseVault();
const store = new UiStore(choice.vault, choice.location);
initStore(store);

/**
 * A handle on the running app, for tests and for debugging a real vault from
 * the console. It grants nothing the page does not already have — the command
 * layer runs in this window either way — and it saves a test forty clicks when
 * the thing under test is how a big board reads rather than how it was built.
 */
(window as unknown as { __pt: unknown }).__pt = {
  app: store.app,
  run: (fn: (app: typeof store.app) => unknown) => store.run(fn),
};

// Theme is remembered across launches; the system preference is the default.
// Applied before the first render so the app never flashes the wrong palette.
applyTheme(storedTheme());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppShell />
  </StrictMode>,
);
