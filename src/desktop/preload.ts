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
  chooseVault: (): Promise<string | null> => ipcRenderer.invoke('pt:chooseVault'),
  revealVault: (): Promise<boolean> => ipcRenderer.invoke('pt:revealVault'),

  sheets: {
    status: (): Promise<SheetsStatus> => ipcRenderer.invoke('pt:sheets:status'),
    /** Opens a native file picker for the service account key. */
    chooseKey: (): Promise<SheetsStatus> => ipcRenderer.invoke('pt:sheets:chooseKey'),
    setSpreadsheet: (link: string): Promise<SheetsStatus> =>
      ipcRenderer.invoke('pt:sheets:setSpreadsheet', link),
    forget: (): Promise<SheetsStatus> => ipcRenderer.invoke('pt:sheets:forget'),
    push: (payload: unknown): Promise<unknown> => ipcRenderer.invoke('pt:sheets:push', payload),
    pull: (): Promise<unknown> => ipcRenderer.invoke('pt:sheets:pull'),
  },
});
