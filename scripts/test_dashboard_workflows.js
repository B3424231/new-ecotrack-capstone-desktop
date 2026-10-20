// Offline regression checks: no live database writes or hardware commands.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/\r\n/g, '\n');
const section = (file, start, end) => {
  const source = read(file);
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert(first >= 0 && last > first, `Missing section in ${file}`);
  return source.slice(first, last);
};
function environment(extra = {}) {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const document = { addEventListener() {}, getElementById() { return null; }, querySelectorAll() { return []; } };
  const window = { addEventListener() {}, dispatchEvent() {}, location: { pathname: '/staff.html', search: '' } };
  return vm.createContext({ window, document, localStorage: storage, sessionStorage: storage, console: { log() {}, warn() {}, error() {} },
    setTimeout() {}, setInterval() {}, clearInterval() {}, Event: class {}, CustomEvent: class {}, URLSearchParams, ...extra });
}
function client(resultFor) {
  const calls = [];
  return { calls, async rpc(name, args) { assert.equal(name, 'ecotrack_device_mutation'); assert.equal(args.p_operation, 'update_node'); calls.push({table:'nodes', operation:'update', payload:args.p_payload}); const result=resultFor({table:'nodes', operation:'update'}); return {error:result.error,data:result.data ? {node:result.data[0]} : null}; }, from(table) {
    let operation = 'select'; let field; let value;
    const query = {
      select() { return query; },
      eq(f, v) { field = f; value = v; return query; },
      update(payload) { operation = 'update'; calls.push({ table, operation, payload }); return query; },
      insert(payload) { operation = 'insert'; calls.push({ table, operation, payload }); return query; },
      maybeSingle() { return query; }, single() { return query; },
      then(resolve, reject) { return Promise.resolve(resultFor({ table, operation, field, value })).then(resolve, reject); }
    };
    return query;
  } };
}
function ipcHandler(name, database) {
  let handler;
  const code = section('src/main.js', `registerDatabaseHandler('${name}'`, '\n});') + '\n});';
  const context = environment({ getSupabaseAdmin: () => database, registerDatabaseHandler(_, callback) { handler = callback; } });
  vm.runInContext(code, context);
  return handler;
}

async function main() {
  const shared = environment();
  vm.runInContext(read('public/js/shared.js').slice(read('public/js/shared.js').indexOf("const ECOTRACK_VIOLATION_AUDIT_KEY")), shared);
  const buildings = { b1: { id: 'b1', name: 'Campus' }, empty: { id: 'empty' } };
  const floors = { f1: { id: 'f1', building_id: 'missing' } };
  const rooms = { assigned: { id: 'assigned', floor_id: 'f1' }, orphan: { id: 'orphan', building_id: 'b1', floor_id: 'gone' } };
  shared.window.ensureLocationHierarchy(buildings, floors, rooms);
  assert.equal(Object.keys(rooms).length, 2);
  for (const room of Object.values(rooms)) assert(buildings[floors[room.floor_id].building_id]);
  assert(buildings.empty);
  assert.equal(floors[rooms.orphan.floor_id].building_id, 'b1');
  const violation = { id: 'v1', room_id: 'r1', rule_id: 'rule1', content: 'Temperature threshold breached', date: '2026-10-02', triggered: true };
  shared.saveViolationToAuditHistory(violation);
  assert.equal(shared.getStoredViolationAuditHistory()[0].is_dismissed_from_inbox, false);
  shared.saveViolationToAuditHistory({ ...violation, is_dismissed_from_inbox: true });
  shared.saveViolationToAuditHistory(violation); // A stale database refresh must not undo a dismissal.
  const audit = shared.getStoredViolationAuditHistory();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].is_dismissed_from_inbox, true);
  assert.equal(audit[0].content, violation.content);
  assert.equal(audit[0].rule_id, 'rule1');
  shared.saveViolationToAuditHistory({ ...violation, id: 'v2', content: '__INBOX_DISMISSED__|||Temperature went above 30°C' });
  assert.equal(shared.getStoredViolationAuditHistory()[0].is_dismissed_from_inbox, true);

  const logs = environment({ globalNodeRecords: [{ id: 'n1', interval_val: 30, interval_unit: 'Seconds' }, { name: 'n2', interval_val: 5, interval_unit: 'Minutes' }] });
  vm.runInContext(section('public/js/logs.js', 'function getConfirmedAcOnState(', '// Helper: Calculate previous period'), logs);
  const heartbeat = id => ({ nodeId: id, status: 'online', acOn: true, temperature: 24, created: '2026-10-02T10:00:00Z' });
  const runtime = logs.calculateRuntimeFromLogs([heartbeat('n1'), heartbeat('n2'), heartbeat('unknown')]);
  assert.equal(runtime.nodeRuntimes.n1, 30 / 3600);
  assert.equal(runtime.nodeRuntimes.n2, 5 / 60);
  assert.equal(runtime.nodeRuntimes.unknown, 0);

  let database = client(q => q.operation === 'update' ? { data: [{ id: 'canonical' }] } : { data: q.field === 'id' ? null : { id: 'canonical' } });
  let result = await ipcHandler('node-update-schedule', database)(null, { id: 'stale', name: 'node-4', wakeTime: '08:00', sleepTime: '18:00', intervalVal: 30, intervalUnit: 'Seconds' });
  assert(result.success);
  assert.equal(database.calls.filter(c => c.operation === 'update').length, 1);
  database = client(q => q.operation === 'update' ? { error: { message: 'Permission denied' } } : { data: { id: 'canonical' } });
  result = await ipcHandler('node-update-schedule', database)(null, { id: 'canonical' });
  assert.equal(result.success, false);

  database = client(q => q.operation === 'insert' ? { data: { id: 'alert' } } : { data: q.field === 'id' ? null : { id: `${q.table}-canonical` } });
  result = await ipcHandler('notification-create', database)(null, { room_id: 'Room A', rule_id: 'Hot room', content: 'Threshold exceeded' });
  assert(result.success);
  assert.equal(database.calls[0].payload[0].room_id, 'rooms-canonical');
  assert.equal(database.calls[0].payload[0].rule_id, 'rules-canonical');
  database = client(() => ({ data: null }));
  result = await ipcHandler('notification-create', database)(null, { room_id: 'missing' });
  assert.equal(result.success, false);
  assert.equal(database.calls.length, 0);

  const toasts = []; let refreshes = 0; let hardwareCalls = 0;
  const scheduler = environment({ fetch: async () => { hardwareCalls++; return { json: async () => ({}) }; } });
  scheduler.window.EcoToast = { success: text => toasts.push(['success', text]), error: text => toasts.push(['error', text]) };
  scheduler.window.EcoDataBus = { invalidate() { refreshes++; } };
  scheduler.window.EcoTrackHardwareCloud = { describe: () => 'offline', listStatus: async () => [], request: async () => { throw Error('Permission denied'); } };
  scheduler.document.getElementById = id => ({ classList: {toggle(){}}, value: id.startsWith('wake-') ? '08:00' : id.startsWith('sleep-') ? '18:00' : id.startsWith('interval-val-') ? '30' : 'Seconds' });
  vm.runInContext(read('public/js/scheduler.js'), scheduler);
  vm.runInContext("savedRooms = { r1: { name: 'Room A', nodes: [{ id: 'node-4', pb_id: 'canonical' }] } };", scheduler);
  await scheduler.applyNodeSchedule('node-4');
  assert.equal(toasts[0][0], 'error');
  assert.equal(refreshes, 0);
  assert.equal(hardwareCalls, 0);
  scheduler.window.EcoTrackHardwareCloud.request = async () => ({ id: 'command-1', node_id: 'canonical' });
  await scheduler.applyNodeSchedule('node-4');
  assert.equal(toasts.at(-1)[0], 'success');
  assert(refreshes > 0);
  assert.equal(hardwareCalls, 0, 'Schedules use cloud commands without direct LAN writes');
  let schedulerData = { buildingRecords: [{ id: 'b1', name: 'Campus' }], floorRecords: [], roomRecords: [{ id: 'r1', name: 'Room A', building_id: 'b1' }], nodeRecords: [{ id: 'canonical', name: 'node-4', room_id: 'r1', wake_time: '06:00', sleep_time: '22:00', interval_val: 15, interval_unit: 'Minutes' }] };
  scheduler.window.ensureLocationHierarchy = shared.window.ensureLocationHierarchy;
  scheduler.window.EcoDataBus.getCached = () => schedulerData;
  scheduler.window.EcoDataBus.query = async () => schedulerData;
  scheduler.document.getElementById = () => null;
  await scheduler.loadSchedulerWithSWR(true);
  assert.equal(vm.runInContext("savedRooms.r1.nodes[0].wakeTime", scheduler), '06:00');
  assert.equal(vm.runInContext("savedRooms.r1.nodes[0].intervalVal", scheduler), 15);
  schedulerData = { buildingRecords: [], floorRecords: [], roomRecords: [], nodeRecords: [] };
  await scheduler.loadSchedulerWithSWR(true);
  assert.equal(vm.runInContext('Object.keys(savedRooms).length', scheduler), 0);
  assert.equal(vm.runInContext('Object.keys(buildings).length', scheduler), 0);

  const form = environment({ createFormState: { airconId: 'original', staffName: 'Tech' }, editingReportId: 'report1',
    getStaffList: () => [{ name: 'Tech' }], getAirconsDatabase: () => [{ id: 'original' }, { id: 'other' }],
    getAirconsForStaff: () => [{ id: 'other' }], getReports: () => [{ id: 'report1', airconId: 'original' }],
    getStaffBuilding() {}, resolveStaffLocation: () => 'Area', formatAcLocation() {}, findActiveUnverifiedReportForAircon: () => null });
  vm.runInContext(section('public/js/maintenance-modal.js', '    const staffList = getStaffList();\n    const allAircons = getAirconsDatabase();', "    const modalTitle = document.getElementById('ecoCreateModalTitle');"), form);
  assert.equal(form.createFormState.airconId, 'original');
  assert.equal(vm.runInContext('selectedAc.id', form), 'original');
  assert.equal(vm.runInContext('aircons.length', form), 2);

  const staff = { id: 's1', name: 'Tech', status: 'Archived', isArchived: true };
  const restore = environment({ staffList: [staff], pendingRestoreId: null, sb: null,
    saveStaff() {}, closeArchivedDetailModal() {}, renderTable() {}, renderArchivedTable() {}, updateStats() {}, showEcoTrackToast() {} });
  restore.window.electron = { invoke: async () => ({ success: false, error: 'Denied' }) };
  vm.runInContext(section('public/js/staff.js', 'async function restoreStaff(', '// Supabase Realtime Staff Synchronization'), restore);
  assert.equal(await restore.restoreStaff('s1'), false);
  assert.equal(staff.status, 'Archived');
  restore.window.electron.invoke = async () => ({ success: true, data: [{ id: 's1' }] });
  assert.equal(await restore.restoreStaff('s1'), true);
  assert.equal(staff.status, 'Offline');
  assert.equal(staff.is_archived, false);

  const reportList = [{ id: 'parent' }, { id: 'child', parent_report_id: 'parent' }, { id: 'unrelated' }];
  const deletion = environment({ _reportsCache: reportList, getReports: () => deletion._reportsCache,
    getSb: () => null, refreshPageReportsView() {}, broadcastMaintenanceChange() {}, showToast() {} });
  let requestedIds;
  deletion.window.electron = { invoke: async (_, ids) => { requestedIds = ids; return { success: false, error: 'Foreign key constraint' }; } };
  vm.runInContext(section('public/js/maintenance-modal.js', '  async function deleteReports(', '  // Delete Single Report'), deletion);
  assert.equal(await deletion.deleteReports(['parent']), false);
  assert.equal(deletion._reportsCache.length, 3);
  assert(requestedIds.includes('child'));
  deletion.window.electron.invoke = async () => ({ success: true, data: [{ id: 'parent' }, { id: 'child' }] });
  assert.equal(await deletion.deleteReports(['parent']), true);
  assert.equal(deletion._reportsCache.length, 1);
  assert.equal(deletion._reportsCache[0].id, 'unrelated');

  const inbox = environment();
  vm.runInContext(section('public/js/notifications.js', 'function isInboxDismissedNotification(', 'function isRuleViolationNotification('), inbox);
  assert(inbox.isInboxDismissedNotification({ content: 'Threshold alert', is_dismissed_from_inbox: true }));
  assert(inbox.isInboxDismissedNotification('__INBOX_DISMISSED__|||Threshold alert'));
  assert.equal(inbox.isInboxDismissedNotification({ content: 'Threshold alert' }), false);

  const poll = environment();
  let reports = [{ id: 'm1', status: 'Pending Verification', staff_name: 'Tech', room_name: 'Room A', aircon_name: 'AC-1' }];
  const alerts = [];
  poll.window.electron = { invoke: async () => ({ success: true, data: reports }) };
  vm.runInContext(read('public/js/global-notifications.js'), poll);
  poll.window.createSystemNotification = async payload => { alerts.push(payload); return null; };
  await poll.checkMaintenanceVerificationSubmissions();
  await poll.checkMaintenanceVerificationSubmissions();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].report_id, 'm1');
  reports = [{ id: 'm2', status: 'Completed', timeline: [{ title: 'submitted for admin verification', time: '2026-10-02T10:00Z' }] }];
  await poll.checkMaintenanceVerificationSubmissions();
  assert.equal(alerts.length, 2);
  reports = [{ id: 'm3', status: 'Completed', timeline: [{ title: 'submitted for admin verification' }, { title: 'Report verified by Admin' }] }];
  await poll.checkMaintenanceVerificationSubmissions();
  assert.equal(alerts.length, 2);
  console.log('Dashboard workflow regressions passed: hierarchy, audit retention, reporting intervals, schedule writes, reference linkage, report editing, restoration, and verification polling.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
