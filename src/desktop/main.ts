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
import type { BackupMeta, VaultFiles } from '../store/backup.ts';
import type { Fingerprints, Grid } from '../sync/backupSync.ts';
import { pullBackup, pushBackup, readReadableTabs, untouchedSince } from '../sync/backupSync.ts';
import type { ServiceAccount } from '../sync/sheets.ts';
import { GoogleSheets, parseServiceAccount, parseSpreadsheetId } from '../sync/sheets.ts';

/**
 * The directory this file was loaded from.
 *
 * Deliberately `__dirname` and not `fileURLToPath(import.meta.url)`: the main
 * process is bundled to CommonJS, where import.meta does not exist. esbuild
 * emits it as an empty object, so the URL is undefined and fileURLToPath throws
 * at module load — before any window, any handler, or any log line.
 */
const here = __dirname;
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

// ------------------------------------------------------- Google Sheets backup

interface SheetsSettings {
  account?: ServiceAccount;
  spreadsheetId?: string;
  lastPushAt?: string;
  /** Push by itself, rather than waiting to be asked. */
  auto?: boolean;
  /** Minutes between automatic pushes. */
  everyMinutes?: number;
  /** What the readable tabs looked like when we last wrote them. */
  fingerprints?: Fingerprints;
  /** A fingerprint of the vault at that moment, so "has anything changed since"
   *  survives the app being closed and reopened. */
  vault?: string;
}

/**
 * Credentials live beside the app, never in the vault.
 *
 * If they were in the vault they would be in the backup, and the backup is the
 * thing the user shares with friends — handing out a private key with it. They
 * are also outside anything the renderer can read: the bridge exposes a status,
 * never the key.
 */
function settingsFile(): string {
  return join(app.getPath('userData'), 'google-sheets.json');
}

function readSettings(): SheetsSettings {
  try {
    return JSON.parse(readFileSync(settingsFile(), 'utf8')) as SheetsSettings;
  } catch {
    return {};
  }
}

function writeSettings(settings: SheetsSettings): void {
  writeFileSync(settingsFile(), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

/**
 * The baseline lives in its own file: it is the whole readable board, and
 * putting it in the settings would make the one file a person might open
 * unreadable.
 */
function baselineFile(): string {
  return join(app.getPath('userData'), 'google-sheets-baseline.json');
}

function readBaseline(): Grid[] {
  try {
    const parsed = JSON.parse(readFileSync(baselineFile(), 'utf8')) as Grid[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function statusOf(settings: SheetsSettings): {
  configured: boolean;
  clientEmail?: string;
  spreadsheetId?: string;
  lastPushAt?: string;
  auto: boolean;
  everyMinutes: number;
  vault?: string;
} {
  return {
    configured: Boolean(settings.account && settings.spreadsheetId),
    clientEmail: settings.account?.clientEmail,
    spreadsheetId: settings.spreadsheetId,
    lastPushAt: settings.lastPushAt,
    auto: settings.auto === true,
    everyMinutes: settings.everyMinutes ?? 30,
    vault: settings.vault,
  };
}

function connect(settings: SheetsSettings): GoogleSheets {
  if (!settings.account) throw new Error('No Google service account key has been set up yet.');
  if (!settings.spreadsheetId) throw new Error('No spreadsheet has been chosen yet.');
  return new GoogleSheets(settings.account, settings.spreadsheetId);
}

function registerSheetsHandlers(): void {
  ipcMain.handle('pt:sheets:status', () => statusOf(readSettings()));

  ipcMain.handle('pt:sheets:chooseKey', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose your Google service account key',
      properties: ['openFile'],
      filters: [{ name: 'Service account key', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths[0]) return statusOf(readSettings());

    // parseServiceAccount throws something readable; letting it through to the
    // renderer is the whole point of having written those messages.
    const account = parseServiceAccount(readFileSync(result.filePaths[0], 'utf8'));
    const settings = { ...readSettings(), account };
    writeSettings(settings);
    return statusOf(settings);
  });

  ipcMain.handle('pt:sheets:setSpreadsheet', (_event, link: string) => {
    const id = parseSpreadsheetId(String(link ?? ''));
    if (!id) throw new Error('That is not a Google Sheets link. Copy the URL from the address bar.');
    const settings = { ...readSettings(), spreadsheetId: id };
    writeSettings(settings);
    return statusOf(settings);
  });

  ipcMain.handle('pt:sheets:forget', () => {
    for (const file of [settingsFile(), baselineFile()]) {
      try {
        rmSync(file, { force: true });
      } catch {
        // Already gone is the outcome we wanted.
      }
    }
    return statusOf({});
  });

  ipcMain.handle('pt:sheets:setAuto', (_event, auto: boolean, everyMinutes?: number) => {
    const settings = {
      ...readSettings(),
      auto: auto === true,
      everyMinutes: Number.isFinite(everyMinutes) ? Math.max(5, Number(everyMinutes)) : undefined,
    };
    writeSettings(settings);
    return statusOf(settings);
  });

  ipcMain.handle(
    'pt:sheets:push',
    async (
      _event,
      payload: {
        files: VaultFiles;
        meta: BackupMeta;
        readable: Grid[];
        vault: string;
        /** Overwrite even though somebody edited the spreadsheet. */
        force?: boolean;
      },
    ) => {
      const settings = readSettings();
      const transport = connect(settings);

      // The rule that lets automatic push and editing in Sheets coexist: never
      // overwrite a tab somebody has typed in since we last wrote it. Without
      // this the timer wins every race and the edit is gone with no trace.
      if (!payload.force && settings.fingerprints) {
        const check = await untouchedSince(transport, settings.fingerprints);
        if (!check.ok) return { blocked: true, edited: check.edited };
      }

      const report = await pushBackup(transport, payload);
      writeFileSync(baselineFile(), JSON.stringify(payload.readable), 'utf8');
      writeSettings({
        ...settings,
        lastPushAt: payload.meta.generatedAt,
        fingerprints: report.fingerprints,
        vault: payload.vault,
      });
      return { blocked: false, ...report };
    },
  );

  /**
   * Everything the renderer needs to work out what somebody changed: what we
   * last wrote, and what is there now. The reasoning stays in the renderer,
   * where the board is; this only fetches.
   */
  ipcMain.handle('pt:sheets:review', async () => {
    const settings = readSettings();
    const baseline = readBaseline();
    const titles = Object.keys(settings.fingerprints ?? {});
    const theirs = await readReadableTabs(connect(settings), titles);
    return { baseline, theirs };
  });

  ipcMain.handle('pt:sheets:pull', async () => pullBackup(connect(readSettings())));
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
    registerSheetsHandlers();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
