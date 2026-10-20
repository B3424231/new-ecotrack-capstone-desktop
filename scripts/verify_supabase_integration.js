// ===================================================================
// ECOTRACK SUPABASE & SQLITE3 INTEGRATION VERIFICATION
// ===================================================================

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.error(`  ❌ ${label} ${detail ? '— ' + detail : ''}`);
  }
}

console.log('━━━ 1. VERIFY DEPENDENCIES & FILES ━━━');
assert('package.json exists', fs.existsSync('package.json'));
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
assert('@supabase/supabase-js in dependencies', !!pkg.dependencies['@supabase/supabase-js']);
assert('supabase.umd.js exists in public/js', fs.existsSync('public/js/supabase.umd.js'));
assert('supabase-client.js exists in public/js', fs.existsSync('public/js/supabase-client.js'));
assert('supabase_schema.sql exists in root', fs.existsSync('supabase_schema.sql'));
assert('.env exists in root', fs.existsSync('.env'));
assert('.env exists in backend', fs.existsSync('backend/.env'));
assert('scripts/transfer_supabase_to_sqlite.js exists', fs.existsSync('scripts/transfer_supabase_to_sqlite.js'));
assert('scripts/transfer_supabase_to_sqlite.py exists', fs.existsSync('scripts/transfer_supabase_to_sqlite.py'));

console.log('\n━━━ 2. VERIFY HTML SCRIPT TAG INTEGRATION ━━━');
const htmlFiles = [
  'login.html',
  'telemetry.html',
  'analytics.html',
  'rules.html',
  'scheduler.html',
  'staff.html',
  'profile.html',
  'Notification.html',
  'logs.html'
];

for (const hf of htmlFiles) {
  const content = fs.readFileSync(path.join('public', hf), 'utf8');
  assert(`${hf} includes supabase-client.js`, content.includes('supabase-client.js'));
}

console.log('\n━━━ 3. VERIFY PYTHON BACKEND SQLITE3 & ML ━━━');
const appPy = fs.readFileSync('backend/app.py', 'utf8');
assert('backend/app.py has sqlite3 database init', appPy.includes('init_sqlite_db') && appPy.includes('telemetry.db'));
assert('backend/app.py has /api/telemetry endpoint', appPy.includes('/api/telemetry'));
assert('backend/app.py has /api/telemetry/transfer endpoint', appPy.includes('/api/telemetry/transfer'));
assert('backend/app.py has predict-energy endpoint', appPy.includes('/api/predict-energy'));
assert('backend/app.py has prediction-features endpoint', appPy.includes('/api/prediction-features'));
assert('backend/app.py has prediction-metrics endpoint', appPy.includes('/api/prediction-metrics'));
assert('backend/app.py has health check endpoint', appPy.includes('/api/health'));
assert('backend/app.py has all 3 ML models configured', appPy.includes("'random_forest'") && appPy.includes("'decision_tree'") && appPy.includes("'xgboost'"));

console.log('\n━━━ 4. VERIFY CONTROL LOGS SQLITE3 ROUTING ━━━');
const clientJs = fs.readFileSync('public/js/supabase-client.js', 'utf8');
assert('supabase-client.js defines Sqlite3TelemetryCollection', clientJs.includes('Sqlite3TelemetryCollection'));
assert('supabase-client.js routes telemetry to SQLite3', clientJs.includes("name === 'telemetry'") && clientJs.includes('Sqlite3TelemetryCollection'));
assert('supabase-client.js exposes direct cloud client', clientJs.includes('window.supabaseClient = sbClient'));
assert('unused cloud collection wrapper removed', !clientJs.includes('class SupabaseTableCollection'));

console.log('\n━━━ 5. VERIFY NODE & CONTROL LOGS SYNC SERVICE ━━━');
assert('public/js/node-sync.js exists', fs.existsSync('public/js/node-sync.js'));
const nodeSyncContent = fs.readFileSync('public/js/node-sync.js', 'utf8');
assert('node-sync.js defines saveNodeTelemetryToSqlite', nodeSyncContent.includes('saveNodeTelemetryToSqlite'));
const logsJsContent = fs.readFileSync('public/js/logs.js', 'utf8');
assert('logs.js has fetchLogsFromDB querying SQLite3', logsJsContent.includes('fetchLogsFromDB') && logsJsContent.includes('/api/telemetry'));

console.log('\n══════════════════════════════════════════════════');
console.log(`  VERIFICATION RESULTS: ${passed} passed, ${failed} failed`);
console.log('══════════════════════════════════════════════════\n');

if (failed > 0) process.exit(1);
