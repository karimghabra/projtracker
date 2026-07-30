/**
 * Verify the packaged application actually starts.
 *
 * A build can succeed and still ship a blank window: if the main process
 * cannot reach its own index.html, Electron reports nothing useful and the exit
 * code stays zero. So this launches the real executable, waits, and fails if it
 * died or complained. It is the last gate before an installer is published.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const exe = process.argv[2] ?? 'release/win-unpacked/Protracker.exe';
const seconds = Number(process.argv[3] ?? 10);

if (!existsSync(exe)) {
  console.error(`No executable at ${exe}`);
  process.exit(1);
}

const child = spawn(exe, [], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
});

let output = '';
child.stdout.on('data', (chunk) => {
  output += chunk;
});
child.stderr.on('data', (chunk) => {
  output += chunk;
});

let exitCode = null;
child.on('exit', (code) => {
  exitCode = code;
});

await new Promise((resolve) => setTimeout(resolve, seconds * 1000));

const alive = exitCode === null;
child.kill();

const complaints = /Failed to load|ERR_FILE_NOT_FOUND|Uncaught|Cannot find module|MODULE_NOT_FOUND/i;
const complained = complaints.test(output);

console.log(`launched:  ${exe}`);
console.log(`alive after ${seconds}s: ${alive}`);
console.log(`errors in output: ${complained ? 'YES' : 'none'}`);
if (output.trim()) console.log(`--- output ---\n${output.slice(0, 2000)}`);

if (!alive) {
  console.error(`\nThe app exited on its own with code ${exitCode}. It should still be running.`);
  process.exit(1);
}
if (complained) {
  console.error('\nThe app started but reported a loading error.');
  process.exit(1);
}
console.log('\nThe packaged app starts cleanly.');
