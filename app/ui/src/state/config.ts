/**
 * Config lives in localStorage under EXACTLY the same keys as the previous
 * app — `dir`, `db`, `days`, `theme` — so existing installs keep working.
 */

export interface Config {
  dir: string;
  db: string;
  days: number;
}

export const DEFAULT_DB = "tracker.db";

export function hasStoredDb(): boolean {
  return localStorage.getItem("db") !== null;
}

export function loadConfig(): Config {
  return {
    dir: localStorage.getItem("dir") || "",
    db: localStorage.getItem("db") || DEFAULT_DB,
    days: Number(localStorage.getItem("days") || 30) || 30,
  };
}

export function saveConfig(c: Config): Config {
  const clean: Config = {
    dir: c.dir.trim(),
    db: c.db.trim() || DEFAULT_DB,
    days: Number(c.days) || 30,
  };
  localStorage.setItem("dir", clean.dir);
  localStorage.setItem("db", clean.db);
  localStorage.setItem("days", String(clean.days));
  current = clean;
  return clean;
}

// Module-level current config so the pt() wrapper does not need threading
// through every component. Kept in sync by saveConfig / setCurrentConfig.
let current: Config = loadConfig();

export function getConfig(): Config {
  return current;
}

export function setCurrentConfig(c: Config): void {
  current = c;
}
