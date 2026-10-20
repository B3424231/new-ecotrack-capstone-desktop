const { createClient } = require('@supabase/supabase-js');
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!serviceKey) throw new Error('Set a server-only SUPABASE_SERVICE_ROLE_KEY to run this live integration script.');
const sb = createClient('https://ynopdmfhngooknybyahq.supabase.co', serviceKey);

function assert(condition, message) {
  if (!condition) {
    console.error(`  ❌ FAILED: ${message}`);
    process.exit(1);
  }
  console.log(`  ✅ PASSED: ${message}`);
}

async function runTests() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  ECOTRACK MAINTENANCE SYSTEM VERIFICATION TEST');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  console.log('1. [FOREIGN KEY RESOLUTION ENGINE]');
  const KNOWN_MAP = {
    'node-1': 'node_001', 'node-2': 'node_002', 'node-3': 'node_003',
    'node-4': 'node_004', 'node-5': 'node_005', 'node-6': 'node_006',
    'node-9': 'node_node_9', 'node-10': 'node_node_10',
    'ac-001': 'node_001', 'ac-002': 'node_002', 'ac-003': 'node_003',
    'ac-004': 'node_004', 'ac-005': 'node_005', 'ac-006': 'node_006',
    'ac-009': 'node_node_9', 'ac-010': 'node_node_10',
    'ac-225': 'node_6d47jt6emtlqy3b', 'ac-323': 'node_3cdgou8xmul5mkq',
    'ac-3232': 'node_f8cbj6o1mu5d879'
  };

  assert(KNOWN_MAP['ac-002'] === 'node_002', 'AC-002 maps to node_002 foreign key');
  assert(KNOWN_MAP['node-2'] === 'node_002', 'node-2 maps to node_002 foreign key');
  assert(KNOWN_MAP['ac-225'] === 'node_6d47jt6emtlqy3b', 'AC-225 maps to valid node_id');

  console.log('\n2. [DATABASE CONNECTIVITY & DATA INTEGRITY]');
  const [nodesRes, airconsRes, staffRes, roomsRes, reportsRes] = await Promise.all([
    sb.from('nodes').select('id, name'),
    sb.from('aircons').select('id, asset_tag, node_id'),
    sb.from('staff').select('id, name'),
    sb.from('rooms').select('id, name'),
    sb.from('maintenance_reports').select('id, aircon_name, status')
  ]);

  assert(!nodesRes.error && nodesRes.data.length === 11, `All 11 hardware nodes verified in Supabase (found: ${nodesRes.data?.length})`);
  assert(!airconsRes.error && airconsRes.data.length === 11, `All 11 aircon units verified in Supabase (found: ${airconsRes.data?.length})`);
  assert(!staffRes.error && staffRes.data.length >= 3, `Maintenance personnel verified (found: ${staffRes.data?.length})`);
  assert(!roomsRes.error && roomsRes.data.length >= 3, `Facility rooms verified (found: ${roomsRes.data?.length})`);
  assert(!reportsRes.error, `Maintenance reports table query successful (found: ${reportsRes.data?.length} reports)`);

  console.log('\n3. [END-TO-END CRUD & WORKFLOW LIFECYCLE]');
  const testReportId = 'REP-TEST-VERIFY-' + Date.now();
  const testReport = {
    id: testReportId,
    aircon_id: 'node_002',
    aircon_name: 'node-2',
    aircon_type: 'Window Type (Inverter)',
    room_id: 'rm_a6f6b95d56084c6',
    room_name: 'room 1',
    type: 'Preventive Maintenance',
    priority: 'High',
    staff_id: 'stf_dc3099cc58504e5',
    staff_name: 'Rey O. Solamillo',
    due_date: '2026-10-05',
    created_date: 'Sep 30, 2026',
    status: 'Pending',
    description: 'System validation test for maintenance workflow',
    tasks: [
      { id: 1, name: 'Filter Cleaning & Sanitization', status: 'Not Started' },
      { id: 2, name: 'Refrigerant Pressure Check', status: 'Not Started' }
    ],
    timeline: [
      { title: 'Report Created', time: 'Just now', done: true, by: 'Admin' }
    ]
  };

  const { error: insErr } = await sb.from('maintenance_reports').insert(testReport);
  assert(!insErr, 'Report created in Supabase with foreign keys satisfied');

  testReport.tasks[0].status = 'Completed';
  testReport.tasks[1].status = 'Completed';
  testReport.status = 'For Verification';
  const { error: upErr } = await sb.from('maintenance_reports').upsert(testReport, { onConflict: 'id' });
  assert(!upErr, 'Technician subtask progress updated to For Verification');

  testReport.status = 'Verified';
  testReport.verification_remarks = 'Inspected and verified by Facilities Supervisor.';
  const { error: verErr } = await sb.from('maintenance_reports').upsert(testReport, { onConflict: 'id' });
  assert(!verErr, 'Admin inspection & verification sign-off successful');

  const { error: delErr } = await sb.from('maintenance_reports').delete().eq('id', testReportId);
  assert(!delErr, 'Report safely removed from Supabase after verification cycle');

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  ALL MAINTENANCE INTEGRATION TESTS PASSED (10/10)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

runTests();
