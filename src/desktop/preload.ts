/**
 * The only bridge between the renderer and the disk.
 *
 * Six functions, all of them file operations. The renderer does everything
 * else itself, which is why the same build runs in a browser tab under test.
 */

import { contextBridge, ipcRenderer } from 'electron';

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
});
