// ===================================================================
// ECOTRACK CONTROL LOGS TRANSFER: Supabase -> Native SQLite3
// Runs the SQLite3 transfer service to copy Supabase control logs to backend/telemetry.db
//
// Usage: node scripts/transfer_supabase_to_sqlite.js
// ===================================================================

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const pyScript = path.resolve(__dirname, 'transfer_supabase_to_sqlite.py');
const venvPy = path.resolve(__dirname, '../venv/Scripts/python.exe');
const pyCmd = fs.existsSync(venvPy) ? venvPy : 'python';

console.log(`[*] Executing SQLite3 transfer script using: ${pyCmd}`);

const proc = spawn(pyCmd, [pyScript], { stdio: 'inherit' });

proc.on('close', (code) => {
  if (code === 0) {
    console.log('[*] Transfer process completed successfully.');
  } else {
    console.error(`[*] Transfer process exited with code ${code}`);
    process.exit(code);
  }
});
