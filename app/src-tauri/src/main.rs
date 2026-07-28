// Desktop shell for protracker.
//
// This process contains no product logic. Its only job is to run the CLI --
// the same binary surface a terminal user drives -- with `--json`, and hand
// the parsed result to the web view. Every mutation the dashboard performs is
// therefore a command-layer verb, and anything the app can do is reproducible
// by typing the same command yourself.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::Command;

use serde_json::Value;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Run `python -m protracker.cli --db <db> --json <args...>` inside the
/// project directory and return its parsed JSON.
///
/// Arguments are passed as an argv list, never a shell string, so nothing the
/// user types in a dialog can be interpreted as a command.
#[tauri::command]
fn pt(project_dir: String, db: String, args: Vec<String>) -> Result<Value, String> {
    let mut cmd = Command::new("python");
    cmd.current_dir(&project_dir)
        .arg("-m")
        .arg("protracker.cli")
        .arg("--db")
        .arg(&db)
        .arg("--json")
        .args(&args);

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW); // no console flash on every call

    let out = cmd
        .output()
        .map_err(|e| format!("could not run python: {e}"))?;

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
        .invoke_handler(tauri::generate_handler![pt])
        .run(tauri::generate_context!())
        .expect("error while running protracker");
}
