import { useState } from "react";

import { hasNativeDialog, openNativeDialog } from "../api/bridge";
import { cleanPath } from "../api/pt";
import { IconFolder, IconImport } from "../components/icons";
import { DEFAULT_DB, type Config } from "../state/config";

/**
 * First-run screen: shown only when localStorage has no `db` key. Saving
 * either way writes the config, so it never reappears.
 */
export function SetupScreen({
  onDone,
}: {
  onDone: (cfg: Config, thenImport: boolean) => void;
}) {
  const [dir, setDir] = useState("");
  const [db, setDb] = useState(DEFAULT_DB);

  const cfg = (): Config => ({
    dir: cleanPath(dir),
    db: db.trim() || DEFAULT_DB,
    days: 30,
  });

  const browse = async () => {
    const picked = await openNativeDialog({
      directory: true,
      title: "Choose the project directory",
    });
    if (picked) setDir(picked);
  };

  return (
    <div className="setup" data-testid="setup-screen">
      <div className="setup-card">
        <h1>Welcome to protracker</h1>
        <p className="hint">
          One board for everything: the <b>Board</b> shows every project with
          its health and an impact-ranked to-do list, <b>Today</b> is your
          curated daily plan, <b>Upcoming</b> holds date-gated reminders, and
          the <b>Journal</b> keeps notes and completions day by day.
        </p>
        <label>
          Project directory (optional)
          <span className="input-row">
            <input
              data-testid="setup-dir"
              placeholder="leave blank to use the default"
              value={dir}
              onChange={(e) => setDir(e.target.value)}
            />
            {hasNativeDialog() && (
              <button
                type="button"
                className="icon"
                title="Browse…"
                onClick={() => void browse()}
              >
                <IconFolder />
              </button>
            )}
          </span>
        </label>
        <label>
          Database file
          <input
            data-testid="setup-db"
            value={db}
            onChange={(e) => setDb(e.target.value)}
          />
        </label>
        <p className="hint">
          Opening an existing file continues where you left off; a new name
          starts a fresh board — the schema is created on first use.
        </p>
        <div className="setup-choices">
          <button
            type="button"
            className="primary big"
            data-testid="setup-import"
            onClick={() => onDone(cfg(), true)}
          >
            <IconImport /> Import a workbook
          </button>
          <button
            type="button"
            className="big"
            data-testid="setup-start-empty"
            onClick={() => onDone(cfg(), false)}
          >
            Start empty
          </button>
        </div>
      </div>
    </div>
  );
}
