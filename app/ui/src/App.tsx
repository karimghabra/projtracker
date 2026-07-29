import { useCallback, useEffect, useState } from "react";

import { AddDialog } from "./components/AddDialog";
import { ConfirmDelete } from "./components/ConfirmDialog";
import { EditDialog } from "./components/EditDialog";
import { FindModal } from "./components/FindModal";
import {
  IconGraph,
  IconImport,
  IconMoon,
  IconPlus,
  IconSun,
} from "./components/icons";
import { Sidebar, type View } from "./components/Sidebar";
import { Toasts } from "./components/Toasts";
import { BoardScreen } from "./screens/Board";
import { GraphModal } from "./screens/GraphModal";
import { ImportWizard } from "./screens/ImportWizard";
import { JournalScreen } from "./screens/Journal";
import { SettingsDialog } from "./screens/SettingsDialog";
import { SetupScreen } from "./screens/Setup";
import { TodayScreen } from "./screens/Today";
import { UpcomingScreen } from "./screens/Upcoming";
import {
  hasStoredDb,
  loadConfig,
  saveConfig,
  type Config,
} from "./state/config";
import { useBoard } from "./state/useBoard";

function currentTheme(): "light" | "dark" {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "dark" || attr === "light") return attr;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export default function App() {
  const [cfg, setCfg] = useState<Config | null>(() =>
    hasStoredDb() ? loadConfig() : null,
  );
  const [view, setView] = useState<View>("board");
  const [theme, setTheme] = useState<"light" | "dark">(currentTheme);

  const board = useBoard(cfg !== null);

  const [addOpen, setAddOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [graphKey, setGraphKey] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setFindOpen((f) => !f);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleTheme = () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    localStorage.setItem("theme", next);
    setTheme(next);
  };

  // one shared "something changed" hook: board refresh + live graph regen
  const onMutated = useCallback(async () => {
    setGraphKey((k) => k + 1);
    await board.refresh();
  }, [board.refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  if (cfg === null) {
    return (
      <>
        <SetupScreen
          onDone={(c, thenImport) => {
            setCfg(saveConfig(c));
            if (thenImport) setImportOpen(true);
          }}
        />
        <ImportWizard
          open={importOpen}
          onClose={() => setImportOpen(false)}
          onImported={onMutated}
        />
        <Toasts />
      </>
    );
  }

  return (
    <div className="app">
      <Sidebar view={view} onNav={setView} />
      <div className="content">
        <header>
          <div className="brand">
            <h1>protracker</h1>
            <span className="ver" data-testid="db-label">
              {cfg.db}
            </span>
          </div>
          <span className="spacer" />
          <button
            type="button"
            className="icon"
            data-testid="theme-toggle"
            title={theme === "dark" ? "Switch to light" : "Switch to dark"}
            aria-label="Toggle light / dark theme"
            onClick={toggleTheme}
          >
            {theme === "dark" ? <IconSun /> : <IconMoon />}
          </button>
          <button
            type="button"
            data-testid="find-open"
            title="Search everything (Ctrl+K)"
            onClick={() => setFindOpen(true)}
          >
            Find
          </button>
          <button
            type="button"
            data-testid="graph-open"
            onClick={() => setGraphOpen(true)}
          >
            <IconGraph /> Graph
          </button>
          <button
            type="button"
            data-testid="import-open"
            onClick={() => setImportOpen(true)}
          >
            <IconImport /> Import…
          </button>
          <button
            type="button"
            data-testid="add-open"
            onClick={() => setAddOpen(true)}
          >
            <IconPlus /> Add…
          </button>
          <button
            type="button"
            data-testid="settings-open"
            onClick={() => setSettingsOpen(true)}
          >
            Settings
          </button>
          <button
            type="button"
            className="primary"
            data-testid="refresh"
            disabled={board.loading}
            onClick={() => void board.refresh()}
          >
            Refresh
          </button>
        </header>

        {view === "board" && (
          <BoardScreen
            board={board}
            onEdit={setEditId}
            onDeleteRequest={setDeleteId}
            onAdd={() => setAddOpen(true)}
            onImport={() => setImportOpen(true)}
          />
        )}
        {view === "today" && <TodayScreen board={board} />}
        {view === "upcoming" && <UpcomingScreen board={board} />}
        {view === "journal" && <JournalScreen board={board} />}
      </div>

      <AddDialog
        open={addOpen}
        nodes={board.nodes}
        onClose={() => setAddOpen(false)}
        onCreated={onMutated}
      />
      <EditDialog
        id={editId}
        nodes={board.nodes}
        onClose={() => setEditId(null)}
        onChanged={onMutated}
        onDeleteRequest={setDeleteId}
      />
      <ConfirmDelete
        nodeId={deleteId}
        onClose={() => setDeleteId(null)}
        onDeleted={async () => {
          setEditId(null);
          await onMutated();
        }}
      />
      <ImportWizard
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={onMutated}
      />
      <GraphModal
        open={graphOpen}
        reloadKey={graphKey}
        onClose={() => setGraphOpen(false)}
        onEditReq={setEditId}
        onMutated={onMutated}
      />
      <FindModal
        open={findOpen}
        onClose={() => setFindOpen(false)}
        onPick={setEditId}
      />
      <SettingsDialog
        open={settingsOpen}
        cfg={cfg}
        onClose={() => setSettingsOpen(false)}
        onSave={(c) => {
          const clean = saveConfig(c);
          setCfg(clean);
          setSettingsOpen(false);
          void board.refresh();
        }}
      />
      <Toasts />
    </div>
  );
}
