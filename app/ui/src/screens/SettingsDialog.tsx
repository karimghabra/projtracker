import { useEffect, useState } from "react";

import { hasNativeDialog, invoke, openNativeDialog, type EnvInfo } from "../api/bridge";
import { cleanPath } from "../api/pt";
import { IconFolder } from "../components/icons";
import { Modal } from "../components/Modal";
import { DEFAULT_DB, type Config } from "../state/config";

export function SettingsDialog({
  open,
  cfg,
  onClose,
  onSave,
}: {
  open: boolean;
  cfg: Config;
  onClose: () => void;
  onSave: (c: Config) => void;
}) {
  const [dir, setDir] = useState(cfg.dir);
  const [db, setDb] = useState(cfg.db);
  const [days, setDays] = useState(String(cfg.days));
  const [env, setEnv] = useState<string>("");

  useEffect(() => {
    if (!open) return;
    setDir(cfg.dir);
    setDb(cfg.db);
    setDays(String(cfg.days));
    setEnv("");
    // say plainly what the app is talking to and where it will write
    void invoke("env_info", { projectDir: cfg.dir })
      .then((raw) => {
        const info = raw as EnvInfo;
        setEnv(
          (info.bundled
            ? "Using the bundled CLI — no Python needed. "
            : "Using system Python — this build has no bundled CLI, so it " +
              "needs Python and the protracker package. ") +
            `Data is written to ${info.working_dir}.`,
        );
      })
      .catch(() => {
        /* older build without env_info: leave the hint blank */
      });
  }, [open, cfg]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Settings"
      testid="settings-dialog"
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            data-testid="settings-save"
            onClick={() =>
              onSave({
                dir: cleanPath(dir),
                db: db.trim() || DEFAULT_DB,
                days: Number(days) || 30,
              })
            }
          >
            Save
          </button>
        </>
      }
    >
      <label>
        Working directory (optional)
        <span className="input-row">
          <input
            data-testid="settings-dir"
            placeholder="leave blank to use the default"
            value={dir}
            onChange={(e) => setDir(e.target.value)}
          />
          {hasNativeDialog() && (
            <button
              type="button"
              className="icon"
              title="Browse…"
              onClick={() =>
                void openNativeDialog({
                  directory: true,
                  title: "Choose the working directory",
                }).then((p) => p && setDir(p))
              }
            >
              <IconFolder />
            </button>
          )}
        </span>
      </label>
      <label>
        Database file
        <input
          data-testid="settings-db"
          value={db}
          onChange={(e) => setDb(e.target.value)}
        />
      </label>
      <label>
        Stale after (days)
        <input
          data-testid="settings-days"
          type="number"
          min={1}
          value={days}
          onChange={(e) => setDays(e.target.value)}
        />
      </label>
      {env && <div className="hint">{env}</div>}
    </Modal>
  );
}
