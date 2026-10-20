const fs = require('fs');
const path = require('path');

console.log('━━━ AUDITING SUPABASE MAINTENANCE MANAGEMENT INTEGRATION ━━━\n');

let passed = 0;
let failed = 0;

function test(name, condition, errorMsg) {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.error(`  ❌ ${name}: ${errorMsg}`);
    failed++;
  }
}

// 1. supabase_schema.sql
const schemaPath = path.join(__dirname, '../supabase_schema.sql');
const schemaContent = fs.readFileSync(schemaPath, 'utf8');

test(
  'supabase_schema.sql: defines maintenance_reports table',
  schemaContent.includes('CREATE TABLE IF NOT EXISTS maintenance_reports'),
  'maintenance_reports table definition missing'
);

test(
  'supabase_schema.sql: foreign keys to nodes, rooms, staff, administrators',
  schemaContent.includes('aircon_id TEXT REFERENCES nodes(id)') &&
  schemaContent.includes('room_id TEXT REFERENCES rooms(id)') &&
  schemaContent.includes('staff_id TEXT REFERENCES staff(id)') &&
  schemaContent.includes('admin_id TEXT REFERENCES administrators(id)'),
  'Foreign key constraints missing in maintenance_reports'
);

test(
  'supabase_schema.sql: includes tasks and timeline JSONB columns',
  schemaContent.includes("tasks JSONB DEFAULT '[]'::jsonb") &&
  schemaContent.includes("timeline JSONB DEFAULT '[]'::jsonb"),
  'JSONB columns tasks/timeline missing'
);

test(
  'supabase_schema.sql: performance indexes on maintenance_reports',
  schemaContent.includes('CREATE INDEX IF NOT EXISTS idx_maint_status') &&
  schemaContent.includes('CREATE INDEX IF NOT EXISTS idx_maint_staff_id'),
  'Performance indexes missing'
);

test(
  'supabase_schema.sql: RLS policies cover maintenance_reports',
  schemaContent.includes("'maintenance_reports'"),
  'maintenance_reports not included in RLS policy loop'
);

// 2. maintenance-modal.js
const modalPath = path.join(__dirname, '../public/js/maintenance-modal.js');
const modalContent = fs.readFileSync(modalPath, 'utf8');

test(
  'maintenance-modal.js: queries maintenance_reports table',
  modalContent.includes("sb.from('maintenance_reports')"),
  'Missing Supabase maintenance_reports query'
);

test(
  'maintenance-modal.js: defines fetchReportsFromSupabase',
  modalContent.includes('fetchReportsFromSupabase'),
  'Missing fetchReportsFromSupabase'
);

test(
  'maintenance-modal.js: defines setupMaintenanceRealtime',
  modalContent.includes('setupMaintenanceRealtime'),
  'Missing realtime subscription on maintenance_reports'
);

test(
  'maintenance-modal.js: queries staff table',
  modalContent.includes("sb.from('staff')"),
  'Missing staff query'
);

// 3. staff.js
const staffPath = path.join(__dirname, '../public/js/staff.js');
const staffContent = fs.readFileSync(staffPath, 'utf8');

test(
  'staff.js: does not contain mock staff seeding',
  !staffContent.includes('carlos@ecotrack.local') && !staffContent.includes('// Seed default data if empty'),
  'Mock staff seeding still present in staff.js'
);

// 4. staff.html
const staffHtmlPath = path.join(__dirname, '../public/staff.html');
const staffHtmlContent = fs.readFileSync(staffHtmlPath, 'utf8');

test(
  'staff.html: has updateReportFilters for dynamic Supabase data',
  staffHtmlContent.includes('function updateReportFilters()'),
  'updateReportFilters function missing in staff.html'
);

console.log('\n══════════════════════════════════════════════════');
console.log(`  MAINTENANCE AUDIT: ${passed} passed, ${failed} failed`);
console.log('══════════════════════════════════════════════════\n');

if (failed > 0) process.exit(1);
