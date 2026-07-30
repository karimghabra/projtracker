/**
 * The shell: navigation, the top bar, and which screen is on.
 *
 * Routing is the URL hash so a test (or a bug report) can point at a screen
 * directly. There is no router library; six views do not need one.
 */

import { useCallback, useEffect, useState } from 'react';
import type React from 'react';
import { formatRelativeDay, MONTH_NAMES, WEEKDAY_NAMES, weekdayIndex } from '../core/dates.ts';
import { useApp } from './state/store.ts';
import { Toasts } from './components/ui.tsx';
import {
  IconFlask,
  IconGraph,
  IconHome,
  IconJournal,
  IconMoon,
  IconProjects,
  IconRedo,
  IconSearch,
  IconSettings,
  IconSheet,
  IconSun,
  IconUndo,
} from './components/icons.tsx';
import { HomeScreen } from './screens/Home.tsx';
import { ProjectsScreen } from './screens/Projects.tsx';
import { GraphScreen } from './screens/Graph.tsx';
import { SheetScreen } from './screens/Sheet.tsx';
import { InventoryScreen } from './screens/Inventory.tsx';
import { JournalScreen } from './screens/Journal.tsx';
import { SettingsDialog } from './screens/Settings.tsx';
import { BackupDialog } from './components/BackupDialog.tsx';
import { SearchModal } from './components/SearchModal.tsx';

export type ViewName = 'home' | 'projects' | 'graph' | 'sheet' | 'inventory' | 'journal';

const VIEWS: { id: ViewName; label: string; Icon: (p: { size?: number }) => React.ReactElement }[] = [
  { id: 'home', label: 'Today', Icon: IconHome },
  { id: 'projects', label: 'Projects', Icon: IconProjects },
  { id: 'graph', label: 'Graph', Icon: IconGraph },
  { id: 'sheet', label: 'Spreadsheet', Icon: IconSheet },
  { id: 'inventory', label: 'Scaffolds', Icon: IconFlask },
  { id: 'journal', label: 'Journal', Icon: IconJournal },
];

const TITLES: Record<ViewName, string> = {
  home: 'Today',
  projects: 'Projects',
  graph: 'Dependency graph',
  sheet: 'Spreadsheet',
  inventory: 'Scaffold inventory',
  journal: 'Journal',
};

function readHash(): ViewName {
  const raw = window.location.hash.replace(/^#\/?/, '');
  return (VIEWS.find((v) => v.id === raw)?.id ?? 'home') as ViewName;
}

export function AppShell() {
  const { app, run } = useApp();
  const [view, setView] = useState<ViewName>(readHash);
  const [theme, setTheme] = useState(() => document.documentElement.dataset['theme'] ?? 'system');
  const [showSettings, setShowSettings] = useState(false);
  const [showBackup, setShowBackup] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  /** A node chosen from search, handed to whichever screen opens next. */
  const [pendingSelection, setPendingSelection] = useState<string | null>(null);

  useEffect(() => {
    const onHash = () => setView(readHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = useCallback((next: ViewName) => {
    window.location.hash = `/${next}`;
    setView(next);
  }, []);

  const history = app.history();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setShowSearch(true);
        return;
      }
      // Undo and redo work while typing too; that is what people expect.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        if (typing) return;
        event.preventDefault();
        if (event.shiftKey) run((a) => a.redo());
        else run((a) => a.undo());
        return;
      }
      if (typing) return;
      const index = Number(event.key);
      if (index >= 1 && index <= VIEWS.length && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        go(VIEWS[index - 1]!.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, run]);

  const cycleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.dataset['theme'] = next;
    window.localStorage.setItem('protracker:theme', next);
  };

  const today = app.today;
  const openToday = app.todayList().openCount;

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            P
          </span>
          <span>Protracker</span>
        </div>

        {VIEWS.map(({ id, label, Icon }) => (
          <button
            key={id}
            className="nav-item"
            aria-current={view === id ? 'page' : undefined}
            onClick={() => go(id)}
            data-testid={`nav-${id}`}
          >
            <Icon size={16} />
            <span>{label}</span>
            {id === 'home' && openToday > 0 && <span className="count">{openToday}</span>}
          </button>
        ))}

        <div className="sidebar-spacer" />

        <button className="nav-item" onClick={() => setShowSettings(true)} data-testid="nav-settings">
          <IconSettings size={16} />
          <span>Settings</span>
        </button>
      </nav>

      <div className="main">
        <header className="topbar">
          <h1>{TITLES[view]}</h1>
          <span className="today-date">
            {WEEKDAY_NAMES[weekdayIndex(today)]} {Number(today.slice(8, 10))}{' '}
            {MONTH_NAMES[Number(today.slice(5, 7)) - 1]} {today.slice(0, 4)}
          </span>
          <span className="spacer" />

          <button
            className="btn ghost icon"
            onClick={() => setShowSearch(true)}
            title="Search (Ctrl+K)"
            aria-label="Search"
          >
            <IconSearch />
          </button>
          <button
            className="btn ghost icon"
            disabled={!history.canUndo}
            onClick={() => run((a) => a.undo())}
            title={history.canUndo ? `Undo: ${history.past[0]}` : 'Nothing to undo'}
            aria-label="Undo"
            data-testid="undo"
          >
            <IconUndo />
          </button>
          <button
            className="btn ghost icon"
            disabled={!history.canRedo}
            onClick={() => run((a) => a.redo())}
            title={history.canRedo ? `Redo: ${history.future[0]}` : 'Nothing to redo'}
            aria-label="Redo"
            data-testid="redo"
          >
            <IconRedo />
          </button>
          <button
            className="btn ghost icon"
            onClick={cycleTheme}
            title="Switch theme"
            aria-label="Switch theme"
          >
            {theme === 'dark' ? <IconSun /> : <IconMoon />}
          </button>
        </header>

        <main className={view === 'graph' || view === 'sheet' ? 'screen flush' : 'screen'}>
          {view === 'home' && <HomeScreen onNavigate={go} />}
          {view === 'projects' && (
            <ProjectsScreen
              selectId={pendingSelection}
              onSelectionUsed={() => setPendingSelection(null)}
            />
          )}
          {view === 'graph' && <GraphScreen />}
          {view === 'sheet' && <SheetScreen />}
          {view === 'inventory' && <InventoryScreen />}
          {view === 'journal' && <JournalScreen />}
        </main>
      </div>

      {showSettings && (
        <SettingsDialog onClose={() => setShowSettings(false)} onBackup={() => setShowBackup(true)} />
      )}
      {showBackup && <BackupDialog onClose={() => setShowBackup(false)} />}
      {showSearch && (
        <SearchModal
          onClose={() => setShowSearch(false)}
          onNavigate={go}
          onSelectNode={setPendingSelection}
        />
      )}
      <Toasts />
      <span className="sr-only" data-testid="today-date">
        {formatRelativeDay(today, today)}
      </span>
    </div>
  );
}
