/**
 * Vite config for the protracker dashboard.
 *
 * Two jobs beyond the React defaults:
 *  - `base: './'` + relative outDir so the built page works from a file://
 *    context inside the Tauri shell.
 *  - a dev-only middleware that exposes the `pt` CLI as `POST /__pt` and the
 *    graph HTML as `GET /__graph`, so `npm run dev` gives a fully working app
 *    in a plain browser (src/api/bridge.ts falls back to these endpoints when
 *    `window.__TAURI__` is absent). The child process always receives an argv
 *    LIST — never a shell string — so nothing typed in the UI can be
 *    interpreted by a shell.
 *
 * Builds into app/dist (gitignored), which is what the Tauri shell serves
 * (`frontendDist: "../dist"`). Run `npm run build` here before `cargo tauri
 * build` — the conf's beforeBuildCommand does it automatically.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const devDb = path.join(repoRoot, "ui-dev.db");

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(
      "python",
      ["-m", "protracker.cli", "--db", devDb, "--json", ...args],
      { cwd: repoRoot },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => resolve({ code: 1, stdout: "", stderr: String(err) }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function ptDevBridge(): Plugin {
  return {
    name: "pt-dev-bridge",
    configureServer(server) {
      server.middlewares.use("/__pt", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end("POST only");
          return;
        }
        let body = "";
        req.on("data", (d) => (body += d));
        req.on("end", () => {
          void (async () => {
            let args: unknown;
            try {
              args = (JSON.parse(body || "{}") as { args?: unknown }).args;
            } catch {
              args = undefined;
            }
            if (
              !Array.isArray(args) ||
              !args.every((a): a is string => typeof a === "string")
            ) {
              res.statusCode = 400;
              res.end(
                JSON.stringify({
                  error: {
                    code: "bad_request",
                    message: "body must be {args: string[]}",
                    details: {},
                  },
                }),
              );
              return;
            }
            const r = await runCli(args);
            if (r.code === 0) {
              res.setHeader("content-type", "application/json");
              res.end(r.stdout.trim() || "null");
            } else {
              // the CLI prints its structured error JSON on stdout; hand it
              // back verbatim so the client's errText() can parse it
              res.statusCode = 400;
              res.setHeader("content-type", "text/plain; charset=utf-8");
              res.end(r.stdout.trim() || r.stderr.trim() || "the command failed");
            }
          })();
        });
      });

      server.middlewares.use("/__graph", (req, res) => {
        void (async () => {
          if (req.method !== "GET") {
            res.statusCode = 405;
            res.end("GET only");
            return;
          }
          const dir = mkdtempSync(path.join(tmpdir(), "pt-graph-"));
          const out = path.join(dir, "graph.html");
          try {
            const r = await runCli(["graph", out]);
            if (r.code !== 0) {
              res.statusCode = 400;
              res.setHeader("content-type", "text/plain; charset=utf-8");
              res.end(r.stdout.trim() || r.stderr.trim() || "graph failed");
              return;
            }
            res.setHeader("content-type", "text/html; charset=utf-8");
            res.end(readFileSync(out, "utf8"));
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        })();
      });
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), ptDevBridge()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
});
