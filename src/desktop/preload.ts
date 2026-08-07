/**
 * The only bridge between the renderer and the world outside the window.
 *
 * File operations, plus the Google Sheets backup — which is here for the same
 * reason: it needs a private key and a network socket, and neither belongs in
 * a renderer. The renderer still decides *what* to back up; this only carries
 * it. Everything else the app does, it does itself, which is why the same
 * build runs in a browser tab under test.
 */

import { contextBridge, ipcRenderer } from 'electron';

/** What the renderer is told about the stored credentials. Never the key itself. */
export interface SheetsStatus {
  configured: boolean;
  clientEmail?: string;
  spreadsheetId?: string;
  spreadsheetTitle?: string;
  lastPushAt?: string;
  auto: boolean;
  everyMinutes: number;
  /** Fingerprint of the vault as it was when we last pushed. */
  vault?: string;
}

/** What the renderer is told about the vault repository. Never the token. */
export interface GitStatus {
  configured: boolean;
  repo?: string;
  branch?: string;
  lastSyncAt?: string;
  lastCommit?: string;
  auto: boolean;
  everyMinutes: number;
  /** False when this machine had no keychain and the token sits in plain text. */
  encrypted: boolean;
}

export interface SyncOutcome {
  message: string;
  commit?: string;
  /** Where this machine's superseded version was kept, when newest-wins lost one. */
  supersededCommit?: string;
  pushed: number;
  pulled: number;
  collisions: { path: string; winner: 'mine' | 'theirs'; deletion?: boolean }[];
  /** True when files on disk changed, so the board must be rebuilt from them. */
  changed: boolean;
  repo?: string;
}

contextBridge.exposeInMainWorld('protracker', {
  readFile: (path: string): string | null => ipcRenderer.sendSync('pt:read', path),
  writeFile: (path: string, text: string): void => {
    ipcRenderer.sendSync('pt:write', path, text);
  },
  listFiles: (prefix: string): string[] => ipcRenderer.sendSync('pt:list', prefix),
  removeFile: (path: string): void => {
    ipcRenderer.sendSync('pt:remove', path);
  },
  vaultPath: (): string => ipcRenderer.sendSync('pt:vaultPath'),
  /**
   * One sentence about where the vault is, when there is something to say —
   * survives the reload that follows a move, which is exactly when the user
   * wants telling what happened to their files.
   */
  vaultNotice: (): string | null => ipcRenderer.sendSync('pt:vaultNotice'),
  /**
   * Null when the picker was cancelled. Otherwise the path now in use, and
   * `refused` when the folder could not be taken — a refusal comes back as data
   * because a thrown error reaches the renderer wrapped in scaffolding, and
   * these messages are written to be read as they are.
   */
  chooseVault: (): Promise<{ path: string; refused?: string } | null> =>
    ipcRenderer.invoke('pt:chooseVault'),
  revealVault: (): Promise<boolean> => ipcRenderer.invoke('pt:revealVault'),

  /**
   * The vault on GitHub. Same shape and same reason as `sheets`: it needs a
   * token and a socket, and the renderer is given a status, never the token.
   */
  git: {
    status: (): Promise<GitStatus> => ipcRenderer.invoke('pt:git:status'),
    connect: (repo: string, token: string): Promise<GitStatus> =>
      ipcRenderer.invoke('pt:git:connect', repo, token),
    forget: (): Promise<GitStatus> => ipcRenderer.invoke('pt:git:forget'),
    setAuto: (auto: boolean, everyMinutes?: number): Promise<GitStatus> =>
      ipcRenderer.invoke('pt:git:setAuto', auto, everyMinutes),
    sync: (): Promise<SyncOutcome> => ipcRenderer.invoke('pt:git:sync'),
  },

  sheets: {
    status: (): Promise<SheetsStatus> => ipcRenderer.invoke('pt:sheets:status'),
    /** Opens a native file picker for the service account key. */
    chooseKey: (): Promise<SheetsStatus> => ipcRenderer.invoke('pt:sheets:chooseKey'),
    setSpreadsheet: (link: string): Promise<SheetsStatus> =>
      ipcRenderer.invoke('pt:sheets:setSpreadsheet', link),
    forget: (): Promise<SheetsStatus> => ipcRenderer.invoke('pt:sheets:forget'),
    setAuto: (auto: boolean, everyMinutes?: number): Promise<SheetsStatus> =>
      ipcRenderer.invoke('pt:sheets:setAuto', auto, everyMinutes),
    push: (payload: unknown): Promise<unknown> => ipcRenderer.invoke('pt:sheets:push', payload),
    review: (): Promise<unknown> => ipcRenderer.invoke('pt:sheets:review'),
    pull: (): Promise<unknown> => ipcRenderer.invoke('pt:sheets:pull'),
  },
});
