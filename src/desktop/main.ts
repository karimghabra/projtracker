/**
 * The Electron shell.
 *
 * It owns exactly two things: a window, and synchronous access to a directory
 * of text files. No domain logic crosses this boundary — the renderer runs the
 * same command layer the tests do, and only raw reads and writes come here.
 * Deleting this file would leave the system working in a browser.
 */

import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

let vaultRoot = '';

function defaultVault(): string {
  return join(app.getPath('userData'), 'vault');
}

function ensureVault(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

/**
 * Resolve a vault-relative path, refusing anything that escapes the vault.
 * The renderer is our own code, but a path traversal bug here would write
 * anywhere on the disk, so it is checked rather than trusted.
 */
function safePath(relativePath: string): string {
  const full = resolve(vaultRoot, relativePath);
  const rel = relative(vaultRoot, full);
  if (rel.startsWith('..') || rel.startsWith(`..${sep}`) || resolve(rel) === rel) {
    throw new Error(`Refusing to touch a path outside the vault: ${relativePath}`);
  }
  return full;
}

function listFiles(prefix: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, base: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else if (rel.startsWith(prefix)) out.push(rel);
    }
  };
  walk(vaultRoot, '');
  return out.sort();
}

function registerHandlers(): void {
  ipcMain.on('pt:read', (event, path: string) => {
    try {
      const full = safePath(path);
      event.returnValue = existsSync(full) && statSync(full).isFile()
        ? readFileSync(full, 'utf8')
        : null;
    } catch {
      event.returnValue = null;
    }
  });

  ipcMain.on('pt:write', (event, path: string, text: string) => {
    const full = safePath(path);
    mkdirSync(dirname(full), { recursive: true });
    // Written as UTF-8 with LF exactly as the serializer produced it; the
    // format's byte-stability is the whole basis of the storage design.
    writeFileSync(full, text, 'utf8');
    event.returnValue = true;
  });

  ipcMain.on('pt:list', (event, prefix: string) => {
    try {
      event.returnValue = listFiles(prefix);
    } catch {
      event.returnValue = [];
    }
  });

  ipcMain.on('pt:remove', (event, path: string) => {
    try {
      rmSync(safePath(path), { force: true });
    } catch {
      // A file that is already gone is the outcome we wanted.
    }
    event.returnValue = true;
  });

  ipcMain.on('pt:vaultPath', (event) => {
    event.returnValue = vaultRoot;
  });

  ipcMain.handle('pt:chooseVault', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose a folder for your Protracker vault',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: vaultRoot,
    });
    if (result.canceled || !result.filePaths[0]) return null;
    vaultRoot = ensureVault(result.filePaths[0]);
    return vaultRoot;
  });

  ipcMain.handle('pt:revealVault', async () => {
    await shell.openPath(vaultRoot);
    return true;
  });
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#101013',
    title: 'Protracker',
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  window.once('ready-to-show', () => window.show());
  window.setMenuBarVisibility(false);

  // Links to protocols and papers open in the real browser, not in the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev && process.env['PT_DEV_SERVER']) {
    void window.loadURL(process.env['PT_DEV_SERVER']);
  } else {
    void window.loadFile(join(here, '..', 'dist-ui', 'index.html'));
  }
}

const single = app.requestSingleInstanceLock();
if (!single) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  void app.whenReady().then(() => {
    vaultRoot = ensureVault(defaultVault());
    registerHandlers();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
