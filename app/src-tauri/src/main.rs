// Desktop shell for protracker.
//
// This process contains no product logic. Its only job is to run the CLI --
// the same binary surface a terminal user drives -- with `--json`, and hand
// the parsed result to the web view. Every mutation the dashboard performs is
// therefore a command-layer verb, and anything the app can do is reproducible
// by typing the same command yourself.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::Command;

use serde_json::Value;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The bundled CLI, if this is an installed copy.
///
/// `externalBin` drops the sidecar beside the app executable with the target
/// triple stripped. When it is there the app is self-contained: no Python, no
/// checkout. In development it is absent and we fall back to the interpreter,
/// so `cargo run` keeps working against the live source tree.
fn sidecar() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let name = if cfg!(windows) { "protracker-cli.exe" } else { "protracker-cli" };
    let path = exe.parent()?.join(name);
    path.exists().then_some(path)
}

/// Where to run, when the user has not nominated a directory.
///
/// A fresh install has no checkout to sit in, so fall back to a per-user data
/// directory and create it. Without this the process inherits the installer's
/// working directory and writes the database somewhere unpredictable.
fn data_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("XDG_DATA_HOME"))
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let dir = base.join("protracker");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn working_dir(project_dir: &str) -> PathBuf {
    let trimmed = project_dir.trim();
    if trimmed.is_empty() {
        return data_dir();
    }
    let p = PathBuf::from(trimmed);
    if p.is_dir() { p } else { data_dir() }
}

/// Report which CLI is in use and where it will run, so the UI can tell the
/// user what it is actually talking to instead of failing opaquely.
#[tauri::command]
fn env_info(project_dir: String) -> Value {
    serde_json::json!({
        "bundled": sidecar().is_some(),
        "working_dir": working_dir(&project_dir).to_string_lossy(),
    })
}

/// Build the interactive dependency-graph page and return its HTML.
///
/// The graph verb writes a self-contained file; this runs it against a temp
/// path, reads the result back and deletes the file, so the webview can show
/// it in an iframe without the app gaining any general file access.
#[tauri::command]
async fn graph_html(project_dir: String, db: String) -> Result<String, String> {
    let dir = working_dir(&project_dir);
    let tmp = dir.join(".graph_preview.html");
    let mut cmd = match sidecar() {
        Some(path) => Command::new(path),
        None => {
            let mut c = Command::new("python");
            c.arg("-m").arg("protracker.cli");
            c
        }
    };
    cmd.current_dir(&dir)
        .arg("--db")
        .arg(&db)
        .arg("--json")
        .arg("graph")
        .arg(&tmp);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd.output().map_err(|e| format!("could not run the CLI: {e}"))?;
    if !out.status.success() {
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if stdout.is_empty() { stderr } else { stdout });
    }
    let html = std::fs::read_to_string(&tmp)
        .map_err(|e| format!("graph file unreadable: {e}"))?;
    let _ = std::fs::remove_file(&tmp);
    Ok(html)
}

/// Run the CLI with `--json` and return its parsed output.
///
/// Arguments are passed as an argv list, never a shell string, so nothing the
/// user types in a dialog can be interpreted as a command.
#[tauri::command]
async fn pt(project_dir: String, db: String, args: Vec<String>) -> Result<Value, String> {
    let mut cmd = match sidecar() {
        Some(path) => Command::new(path),
        None => {
            let mut c = Command::new("python");
            c.arg("-m").arg("protracker.cli");
            c
        }
    };
    cmd.current_dir(working_dir(&project_dir))
        .arg("--db")
        .arg(&db)
        .arg("--json")
        .args(&args);

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW); // no console flash on every call

    let out = cmd
        .output()
        .map_err(|e| {
            if sidecar().is_some() {
                format!("could not run the bundled CLI: {e}")
            } else {
                format!(
                    "could not run python ({e}). This build has no bundled CLI, \
                     so it needs Python on PATH and the protracker package \
                     importable from the project directory."
                )
            }
        })?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        // the CLI reports structured errors on stdout as JSON; prefer those
        return Err(if stdout.is_empty() { stderr } else { stdout });
    }

    let text = String::from_utf8_lossy(&out.stdout);
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&text).map_err(|e| format!("unparsable CLI output: {e}"))
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![pt, env_info, graph_html])
        .run(tauri::generate_context!())
        .expect("error while running protracker");
}
