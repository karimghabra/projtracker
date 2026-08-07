/**
 * The Electron shell.
 *
 * It owns exactly two things: a window, and synchronous access to a directory
 * of text files. No domain logic crosses this boundary — the renderer runs the
 * same command layer the tests do, and only raw reads and writes come here.
 * Deleting this file would leave the system working in a browser.
 */

import { BrowserWindow, app, dialog, ipcMain, safeStorage, shell } from 'electron';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { hostname } from 'node:os';
import type { BackupMeta, VaultFiles } from '../store/backup.ts';
import { isBackedUp } from '../store/backup.ts';
import type { Fingerprints, Grid } from '../sync/backupSync.ts';
import { pullBackup, pushBackup, readReadableTabs, untouchedSince } from '../sync/backupSync.ts';
import type { Files } from '../sync/gitVault.ts';
import { syncVault } from '../sync/gitVault.ts';
import { GitHubVault, parseRepo } from '../sync/github.ts';
import type { ServiceAccount } from '../sync/sheets.ts';
import { GoogleSheets, parseServiceAccount, parseSpreadsheetId } from '../sync/sheets.ts';
import {
  copyVaultInto,
  ensureVault,
  judgeTarget,
  readStoredVault,
  startupVault,
  writeStoredVault,
} from './vaultLocation.ts';

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

/**
 * One sentence about where the vault is, when there is something to say: the
 * chosen folder had gone, or it has just been moved. Held in the main process
 * so it survives the renderer reload that follows a move — which is precisely
 * the moment the user most wants to be told what happened to their files.
 */
let vaultNotice: string | null = null;

function defaultVault(): string {
  return join(app.getPath('userData'), 'vault');
}

/**
 * The chosen vault path, beside the app rather than inside the vault — a vault
 * cannot hold the address of where it is.
 */
function vaultLocationFile(): string {
  return join(app.getPath('userData'), 'vault-location.json');
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

// ----------------------------------------------------------- git vault sync

interface GitSettings {
  repo?: string;
  branch?: string;
  /** The token, encrypted by the OS. Base64 of whatever safeStorage produced. */
  token?: string;
  /** Stored in the clear only when the OS has no keychain to offer. */
  tokenPlain?: string;
  /** The commit this machine last agreed with — the base for every merge. */
  lastCommit?: string;
  lastSyncAt?: string;
  auto?: boolean;
  everyMinutes?: number;
}

function gitSettingsFile(): string {
  return join(app.getPath('userData'), 'git-sync.json');
}

function readGitSettings(): GitSettings {
  try {
    return JSON.parse(readFileSync(gitSettingsFile(), 'utf8')) as GitSettings;
  } catch {
    return {};
  }
}

function writeGitSettings(settings: GitSettings): void {
  writeFileSync(gitSettingsFile(), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

/**
 * The token is encrypted by the operating system — DPAPI on Windows, the
 * Keychain on macOS — so the file on disk is useless to anything that is not
 * this user on this machine. Where no keychain exists the token is stored in
 * the clear, and the status says so rather than implying a protection that is
 * not there.
 */
function storeToken(settings: GitSettings, token: string): void {
  if (safeStorage.isEncryptionAvailable()) {
    settings.token = safeStorage.encryptString(token).toString('base64');
    delete settings.tokenPlain;
  } else {
    settings.tokenPlain = token;
    delete settings.token;
  }
}

function loadToken(settings: GitSettings): string | undefined {
  if (settings.token) {
    try {
      return safeStorage.decryptString(Buffer.from(settings.token, 'base64'));
    } catch {
      // Encrypted by a different user or machine: the token is unreadable, and
      // saying so beats failing later with a message about GitHub.
      return undefined;
    }
  }
  return settings.tokenPlain;
}

/** Every vault file that belongs in a sync, and when each was last written. */
function vaultOnDisk(): { files: Files; at: Map<string, string> } {
  const out: Files = new Map();
  const at = new Map<string, string>();
  for (const path of listFiles('').filter(isBackedUp)) {
    const full = safePath(path);
    out.set(path, readFileSync(full, 'utf8'));
    at.set(path, new Date(statSync(full).mtimeMs).toISOString());
  }
  return { files: out, at };
}

function gitStatus(settings: GitSettings): {
  configured: boolean;
  repo?: string;
  branch?: string;
  lastSyncAt?: string;
  lastCommit?: string;
  auto: boolean;
  everyMinutes: number;
  /** False when the OS gave us nowhere safe to keep the token. */
  encrypted: boolean;
} {
  return {
    configured: Boolean(settings.repo && loadToken(settings)),
    repo: settings.repo,
    branch: settings.branch,
    lastSyncAt: settings.lastSyncAt,
    lastCommit: settings.lastCommit,
    auto: settings.auto === true,
    everyMinutes: settings.everyMinutes ?? 10,
    encrypted: Boolean(settings.token),
  };
}

function registerGitHandlers(): void {
  ipcMain.handle('pt:git:status', () => gitStatus(readGitSettings()));

  ipcMain.handle('pt:git:connect', async (_event, repo: string, token: string) => {
    const vault = new GitHubVault(repo, token);
    const info = await vault.info();
    /*
     * A vault is unpublished work. Refusing a public repository is the one
     * check worth making before anything is written, because by the time the
     * mistake is visible the history is already public and rewriting it does
     * not un-publish it.
     */
    if (!info.private) {
      throw new Error(
        `${parseRepo(repo).owner}/${parseRepo(repo).repo} is public. Make it private before syncing a vault into it — everything in your tracker would otherwise be readable by anyone.`,
      );
    }

    const settings = readGitSettings();
    const was = settings.repo;
    settings.repo = repo.trim();
    settings.branch = info.defaultBranch;
    // A different repository is a different history, so the commit we last
    // agreed with means nothing there — keeping it would make the first sync
    // ask for a base that does not exist.
    if (was !== settings.repo) delete settings.lastCommit;
    storeToken(settings, token.trim());
    writeGitSettings(settings);
    return gitStatus(settings);
  });

  ipcMain.handle('pt:git:forget', () => {
    const settings = readGitSettings();
    writeGitSettings({ everyMinutes: settings.everyMinutes });
    return gitStatus(readGitSettings());
  });

  ipcMain.handle('pt:git:setAuto', (_event, auto: boolean, everyMinutes?: number) => {
    const settings = readGitSettings();
    settings.auto = auto;
    if (everyMinutes) settings.everyMinutes = everyMinutes;
    writeGitSettings(settings);
    return gitStatus(settings);
  });

  ipcMain.handle('pt:git:sync', async () => {
    const settings = readGitSettings();
    const token = loadToken(settings);
    if (!settings.repo || !token) throw new Error('No repository has been set up yet.');

    const { files, at } = vaultOnDisk();
    const report = await syncVault(new GitHubVault(settings.repo, token), {
      branch: settings.branch ?? 'main',
      mine: files,
      mineAt: at,
      lastCommit: settings.lastCommit,
      device: hostname(),
    });

    for (const [path, text] of report.write) {
      const full = safePath(path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text, 'utf8');
    }
    for (const path of report.remove) rmSync(safePath(path), { force: true });

    settings.lastCommit = report.commit ?? settings.lastCommit;
    settings.lastSyncAt = new Date().toISOString();
    writeGitSettings(settings);

    return {
      message: report.message,
      commit: report.commit,
      supersededCommit: report.supersededCommit,
      pushed: report.pushed,
      pulled: report.pulled,
      collisions: report.collisions,
      /** The renderer must rebuild from the vault when this is true. */
      changed: report.write.size > 0 || report.remove.length > 0,
      repo: settings.repo,
    };
  });
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

  ipcMain.on('pt:vaultNotice', (event) => {
    event.returnValue = vaultNotice;
  });

  /**
   * Point the app at a different folder.
   *
   * A refusal comes back as data rather than as a thrown error: `ipcMain.handle`
   * wraps a throw in "Error invoking remote method …" before the renderer sees
   * it, and these messages are written to be read by the user as they are.
   */
  ipcMain.handle('pt:chooseVault', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose a folder for your Protracker vault',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: vaultRoot,
    });
    if (result.canceled || !result.filePaths[0]) return null;

    const target = resolve(result.filePaths[0]);
    const verdict = judgeTarget(vaultRoot, target);
    if (verdict.kind === 'refuse') return { path: vaultRoot, refused: verdict.message };

    const from = vaultRoot;
    ensureVault(target);
    const copied = verdict.kind === 'copy' ? copyVaultInto(from, target) : [];

    // Written before the switch: if this throws, the app is still pointing at a
    // folder whose path is the one on disk, rather than at one it will forget.
    writeStoredVault(vaultLocationFile(), target);
    vaultRoot = target;

    vaultNotice =
      verdict.kind === 'copy'
        ? `Your vault is now ${target}. ${copied.length} ${copied.length === 1 ? 'file was' : 'files were'} copied there. Nothing was deleted — the old folder, ${from}, is exactly as it was. Delete it yourself once you are happy everything arrived.`
        : `Your vault is now ${target}, which already held one, so nothing was copied. The folder you were using, ${from}, has not been touched.`;

    return { path: target, refused: undefined };
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
    // The folder the user chose last time, if it is still there. A stored path
    // that has gone — an unplugged drive, a folder renamed from underneath us —
    // falls back to the default and says so, rather than opening an empty vault
    // and looking exactly like it lost two years of work.
    const chosen = startupVault(readStoredVault(vaultLocationFile()), defaultVault());
    vaultRoot = ensureVault(chosen.path);
    if (chosen.missing) {
      vaultNotice =
        `${chosen.missing} is not there any more, so Protracker has opened the default folder, ` +
        `${vaultRoot}. Your work is still in the other folder — reconnect the drive, or point ` +
        'Protracker back at it from Settings.';
    }
    registerHandlers();
    registerSheetsHandlers();
    registerGitHandlers();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
