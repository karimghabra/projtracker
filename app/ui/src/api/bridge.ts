/**
 * The single seam to the backend.
 *
 * In the Tauri shell the app talks ONLY through the `window.__TAURI__` global
 * (never the @tauri-apps/api npm package — the Playwright e2e suite stubs the
 * global with an init script and that seam must survive).
 *
 * In `npm run dev` without a shell, the Vite middleware endpoints /__pt and
 * /__graph stand in, so a plain browser gets a fully working app.
 */

export interface OpenDialogOptions {
  directory?: boolean;
  multiple?: boolean;
  title?: string;
  filters?: { name: string; extensions: string[] }[];
}

export interface TauriGlobal {
  core: {
    invoke: (cmd: string, payload?: Record<string, unknown>) => Promise<unknown>;
  };
  dialog?: {
    open?: (opts?: OpenDialogOptions) => Promise<string | string[] | null>;
  };
}

declare global {
  interface Window {
    __TAURI__?: TauriGlobal;
  }
}

export interface EnvInfo {
  bundled: boolean;
  working_dir: string;
}

async function devInvoke(
  cmd: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  if (cmd === "pt") {
    const res = await fetch("/__pt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args: payload.args }),
    });
    const text = await res.text();
    // reject with the raw string (usually the CLI's structured error JSON),
    // exactly like the Tauri command does — errText() parses either way
    if (!res.ok) throw text;
    return text ? (JSON.parse(text) as unknown) : null;
  }
  if (cmd === "graph_html") {
    const res = await fetch("/__graph");
    const text = await res.text();
    if (!res.ok) throw text;
    return text;
  }
  if (cmd === "env_info") {
    const info: EnvInfo = {
      bundled: false,
      working_dir: "(vite dev server — ui-dev.db in the repo root)",
    };
    return info;
  }
  throw new Error(`unknown command: ${cmd}`);
}

export async function invoke(
  cmd: string,
  payload: Record<string, unknown> = {},
): Promise<unknown> {
  const t = window.__TAURI__;
  if (t?.core?.invoke) return t.core.invoke(cmd, payload);
  if (import.meta.env.DEV) return devInvoke(cmd, payload);
  throw new Error(
    "No backend available: window.__TAURI__ is missing and this is not a dev build.",
  );
}

/** True when the shell provides a native file dialog. */
export function hasNativeDialog(): boolean {
  return typeof window.__TAURI__?.dialog?.open === "function";
}

/**
 * Open the native file/folder dialog if the shell provides one.
 * Returns null when unavailable, cancelled, or on any dialog error — callers
 * always keep a text-input fallback, so this must never crash.
 */
export async function openNativeDialog(
  opts: OpenDialogOptions,
): Promise<string | null> {
  const open = window.__TAURI__?.dialog?.open;
  if (typeof open !== "function") return null;
  try {
    const picked = await open(opts);
    if (typeof picked === "string") return picked;
    if (Array.isArray(picked) && typeof picked[0] === "string") return picked[0];
    return null;
  } catch {
    return null;
  }
}
