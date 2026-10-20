const fs = require('fs');
const path = require('path');

console.log('━━━ AUDITING MAINTENANCE RESTRICTIONS & DEDUPLICATION ━━━\n');

let passed = 0;
let failed = 0;

function assert(condition, name, details = '') {
  if (condition) {
    console.log(`  ✅ [PASS] ${name}`);
    passed++;
  } else {
    console.error(`  ❌ [FAIL] ${name} ${details ? '(' + details + ')' : ''}`);
    failed++;
  }
}

// 1. Audit public/js/maintenance-modal.js
const modalJsPath = path.join(__dirname, '../public/js/maintenance-modal.js');
const modalJs = fs.readFileSync(modalJsPath, 'utf8');

assert(
  modalJs.includes('validateCreateReportForm()'),
  'Form validation engine `validateCreateReportForm()` is defined'
);

assert(
  modalJs.includes('modalFormErrorBanner'),
  'Inline error banner `#modalFormErrorBanner` is present in DOM template'
);

assert(
  modalJs.includes('descVal.length < 5'),
  'Description length restriction (minimum 5 chars) is enforced'
);

assert(
  modalJs.includes('dueDateVal < todayStr') && modalJs.includes('min="${new Date().toISOString().split(\'T\')[0]}"'),
  'Past due date restriction and min HTML attribute are enforced'
);

assert(
  modalJs.includes('selectedTasksCount === 0'),
  'Checklist task requirement (at least 1 milestone) is enforced'
);

assert(
  modalJs.includes('_isSubmittingReport'),
  'Submit button debounce guard `_isSubmittingReport` prevents double-click'
);

assert(
  modalJs.includes('isNewReport = false'),
  'saveReports signature includes `isNewReport` parameter'
);

assert(
  modalJs.includes('const notifId = isNeedsRepair ? `mob_repair_${targetReport.id}` : `mob_task_${targetReport.id}`;'),
  'Deterministic notification IDs mapped to report ID in client JS'
);

assert(
  modalJs.includes('existingNotifs && existingNotifs.length > 0'),
  'Client JS pre-checks existing notifications before inserting'
);

assert(
  modalJs.includes(".upsert(notifPayload, { onConflict: 'id' })"),
  'Client JS uses idempotent upsert on notification ID'
);

// 2. Audit supabase_mobile_notifications_setup.sql
const sqlPath = path.join(__dirname, '../supabase_mobile_notifications_setup.sql');
const sql = fs.readFileSync(sqlPath, 'utf8');

assert(
  sql.includes("v_notif_id := 'mob_task_' || NEW.id;"),
  'Postgres trigger generates deterministic notification ID from report ID'
);

assert(
  sql.includes("IF NOT EXISTS") && sql.includes("related_report_id = NEW.id AND type = 'task_assigned'"),
  'Postgres trigger verifies notification does not already exist'
);

assert(
  sql.includes("CREATE UNIQUE INDEX IF NOT EXISTS idx_mobile_notif_unique_report_type"),
  'Database-level unique constraint on (related_report_id, type) exists'
);

// 3. Audit styles.css
const cssPath = path.join(__dirname, '../public/styles.css');
const css = fs.readFileSync(cssPath, 'utf8');

assert(
  css.includes('.form-error-shake') && css.includes('@keyframes modalFieldShake'),
  'Form error shake animation is present in styles.css'
);

// 4. Audit Unverified Duplicate Report Rejection Logic
assert(
  modalJs.includes('findActiveUnverifiedReportForAircon'),
  'Engine implements `findActiveUnverifiedReportForAircon` search'
);

assert(
  modalJs.includes('isReportUnverified(status)'),
  'Engine implements `isReportUnverified` status evaluation'
);

assert(
  modalJs.includes('Duplicate Report Rejected') && modalJs.includes('already has an ongoing maintenance report'),
  'Form validation halts and rejects reporting for aircons with unverified/pending reports'
);

assert(
  modalJs.includes('.in(\'status\', [\'Pending\', \'Assigned\', \'In Progress\', \'For Verification\', \'Needs Repair\'])'),
  'Direct Supabase database-level duplicate check halts concurrent unverified reports'
);

console.log(`\nResults: ${passed} passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
