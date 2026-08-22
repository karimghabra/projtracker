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
import { THEMES, applyTheme, isDark, nextTheme, storedTheme } from './themes.ts';
import { Toasts } from './components/ui.tsx';
import {
  IconChevronLeft,
  IconChevronRight,
  IconClock,
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
import { ProtocolsScreen } from './screens/Protocols.tsx';
import { JournalScreen } from './screens/Journal.tsx';
import { SettingsDialog } from './screens/Settings.tsx';
import { BackupDialog } from './components/BackupDialog.tsx';
import { useAutoSync, useVaultSync } from './state/autoSync.ts';
import { SearchModal } from './components/SearchModal.tsx';

export type ViewName = 'home' | 'projects' | 'graph' | 'sheet' | 'protocols' | 'inventory' | 'journal';

const VIEWS: { id: ViewName; label: string; Icon: (p: { size?: number }) => React.ReactElement }[] = [
  { id: 'home', label: 'Today', Icon: IconHome },
  { id: 'projects', label: 'Projects', Icon: IconProjects },
  { id: 'graph', label: 'Graph', Icon: IconGraph },
  { id: 'sheet', label: 'Spreadsheet', Icon: IconSheet },
  { id: 'protocols', label: 'Protocols', Icon: IconClock },
  { id: 'inventory', label: 'Scaffolds', Icon: IconFlask },
  { id: 'journal', label: 'Journal', Icon: IconJournal },
];

const TITLES: Record<ViewName, string> = {
  home: 'Today',
  projects: 'Projects',
  graph: 'Dependency graph',
  sheet: 'Spreadsheet',
  protocols: 'Protocols',
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
  const [theme, setTheme] = useState(storedTheme);
  const [showSettings, setShowSettings] = useState(false);
  const [showBackup, setShowBackup] = useState(false);
  const [collapsed, setCollapsed] = useState(
    () => window.localStorage.getItem('protracker:sidebar') === 'collapsed',
  );

  // Keeps the Google spreadsheet in sync by itself when that is switched on. A
  // no-op in a browser, which is why it can live at the top of the shell.
  useAutoSync();
  useVaultSync();
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
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setShowSearch(true);
        return;
      }
      /*
        Undo and redo work while typing too; that is what people expect — and
        the comment said so for a while above a line that returned early
        instead. Taking the event matters more than convenience: the browser's
        own text undo fires an `input` event, React turns that into an
        `updateNode`, and that would record history and discard the redo stack.
      */
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) run((a) => a.redo(), { undoable: false });
        else run((a) => a.undo(), { undoable: false });
        return;
      }
      // Ctrl+Y is redo on Windows, and costs nothing to honour.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        run((a) => a.redo(), { undoable: false });
        return;
      }
      /*
        Number keys used to switch screens. They are gone: nobody was using
        them, and a bare digit is a keystroke that belongs to whatever is being
        typed. Losing focus for a moment — an inline edit that had not opened
        yet, a click that landed on the row rather than the field — turned
        "-20 freezer, shelf 2" into a jump to another screen halfway through
        the word. A shortcut that costs a navigation when it misfires has to
        earn it, and this one was not being used at all.

        Ctrl+K, Ctrl+Z and Ctrl+Y stay: all three take a modifier, so none of
        them can be typed by accident.
      */
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, run]);

  const cycleTheme = () => {
    const next = nextTheme(theme);
    setTheme(next);
    applyTheme(next);
  };

  const today = app.today;
  const openToday = app.todayList().openCount;

  return (
    <div className="shell">
      <nav className={collapsed ? 'sidebar collapsed' : 'sidebar'} aria-label="Main">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            P
          </span>
          <span className="brand-word">Protracker</span>
        </div>

        {VIEWS.map(({ id, label, Icon }) => (
          <button
            key={id}
            className="nav-item"
            aria-current={view === id ? 'page' : undefined}
            // Collapsed the words are hidden, not removed, so the button keeps
            // the same accessible name either way — and a tooltip stands in for
            // what the eye can no longer read.
            title={collapsed ? label : undefined}
            onClick={() => go(id)}
            data-testid={`nav-${id}`}
          >
            <Icon size={16} />
            <span className="nav-label">{label}</span>
            {id === 'home' && openToday > 0 && <span className="count">{openToday}</span>}
          </button>
        ))}

        <div className="sidebar-spacer" />

        <button
          className="nav-item"
          title={collapsed ? 'Settings' : undefined}
          onClick={() => setShowSettings(true)}
          data-testid="nav-settings"
        >
          <IconSettings size={16} />
          <span className="nav-label">Settings</span>
        </button>

        <button
          className="sidebar-toggle"
          onClick={() => {
            const next = !collapsed;
            setCollapsed(next);
            window.localStorage.setItem('protracker:sidebar', next ? 'collapsed' : 'open');
          }}
          title={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
          aria-label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
          aria-expanded={!collapsed}
          data-testid="sidebar-toggle"
        >
          {collapsed ? <IconChevronRight size={15} /> : <IconChevronLeft size={15} />}
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
          {/*
            `preventDefault` on mousedown keeps focus where it is, so pressing
            these cannot blur an open editor. A blur used to fire a commit in
            the same gesture, which re-wrote history and disabled the very
            button being pressed before the click landed.
          */}
          <button
            className="btn ghost icon"
            disabled={!history.canUndo}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => run((a) => a.undo(), { undoable: false })}
            title={history.canUndo ? `Undo: ${history.past[0]}` : 'Nothing to undo'}
            aria-label="Undo"
            data-testid="undo"
          >
            <IconUndo />
          </button>
          <button
            className="btn ghost icon"
            disabled={!history.canRedo}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => run((a) => a.redo(), { undoable: false })}
            title={history.canRedo ? `Redo: ${history.future[0]}` : 'Nothing to redo'}
            aria-label="Redo"
            data-testid="redo"
          >
            <IconRedo />
          </button>
          <button
            className="btn ghost icon"
            onClick={cycleTheme}
            title={`Theme: ${THEMES.find((t) => t.id === theme)?.name ?? theme}. Click for the next one.`}
            aria-label="Switch theme"
            data-testid="cycle-theme"
          >
            {isDark(theme) ? <IconSun /> : <IconMoon />}
          </button>
        </header>

        <main
          className={
            view === 'graph' || view === 'sheet'
              ? 'screen flush'
              : // Home sizes itself to the window and scrolls per column, so
                // the day's list is never below the fold.
                view === 'home'
                ? 'screen fits'
                : 'screen'
          }
        >
          {view === 'home' && (
            <HomeScreen
              onNavigate={go}
              /* The pool can send you to a goal that has nothing in it yet,
                 which is the one row whose answer lives on another screen. */
              onReveal={(id) => {
                setPendingSelection(id);
                go('projects');
              }}
            />
          )}
          {view === 'projects' && (
            <ProjectsScreen
              selectId={pendingSelection}
              onSelectionUsed={() => setPendingSelection(null)}
            />
          )}
          {view === 'graph' && <GraphScreen />}
          {view === 'sheet' && <SheetScreen />}
          {view === 'protocols' && <ProtocolsScreen />}
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
