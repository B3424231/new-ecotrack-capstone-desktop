// Offline regression tests for maintenance saves and reconciliation; no cloud writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '../public/js/maintenance-modal.js'), 'utf8');
const section = (source, start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `Missing section: ${start}`);
  return source.slice(a, b);
};
function mainSave(response) {
  let handler;
  const calls = [];
  const client = { rpc: async (name, args) => {
    calls.push({ name, args });
    if (response instanceof Error) throw response;
    return response;
  }, from() { throw new Error('A rejected RPC must never write directly to a table'); } };
  const context = vm.createContext({ getSupabaseAdmin: () => client,
    registerDatabaseHandler: (_, fn) => { handler = fn; } });
  vm.runInContext(section(main, "registerDatabaseHandler('maintenance-save-report'", "registerDatabaseHandler('maintenance-fetch-reports'"), context);
  return { save: input => handler({}, input), calls };
}
async function testMainSave() {
  const input = { record: { id: 'report', room_id: 'deleted-room', update_progress: true },
    operationId: 'operation-1', isNew: false, expectedUpdated: 'version-1', parentExpected: 'parent-v1' };
  for (const error of [
    { message: 'Selected room does not exist', code: 'P0001' },
    { message: 'Administrator required', code: '42501' },
    { message: 'Report changed', code: '40001' },
    { message: 'RPC unavailable', code: 'PGRST202' }
  ]) {
    const env = mainSave({ data: null, error });
    const result = await env.save(input);
    assert.equal(result.success, false); assert.equal(result.error, error.message); assert.equal(result.code, error.code);
    assert.equal(env.calls.length, 1);
  }
  const success = mainSave({ data: { report: { id: 'report' }, parent: { id: 'parent' } }, error: null });
  assert.equal((await success.save(input)).success, true);
  assert.equal(success.calls[0].args.p_expected_updated, 'version-1');
  assert.equal(success.calls[0].args.p_parent_expected, 'parent-v1');
  assert.equal(success.calls[0].args.p_operation_id, 'operation-1');
  const malformed = mainSave({ data: { report: { id: 'wrong-report' } }, error: null });
  assert.equal((await malformed.save(input)).success, false);
  const missing = mainSave({ data: null, error: null });
  assert.equal((await missing.save({ record: input.record })).code, 'INVALID_OPERATION');
  assert.equal(missing.calls.length, 0);
  assert.equal((await mainSave(new Error('Network unavailable')).save(input)).success, false);
}

function database({ rooms = [{ id: 'uuid-room', name: 'Server' }], nodes = [{ id: 'uuid-node', name: 'node-real' }], rpcResult } = {}) {
  const calls = [];
  return { calls, rpc: async (name, args) => {
    calls.push({ operation: 'rpc', name, args });
    return rpcResult || { data: { report: { ...args.p_record, updated: 'confirmed-version' } }, error: null };
  }, from(table) {
    let field, value, single = false;
    const query = { select() { return query; }, eq(f, v) { field = f; value = v; return query; },
      maybeSingle() { single = true; return query; }, limit() { return query; },
      upsert() { throw new Error('Direct writes are prohibited after a report validation failure'); },
      then(resolve, reject) {
        calls.push({ operation: 'select', table, field, value });
        const rows = (table === 'rooms' ? rooms : nodes).filter(row => row[field] === value);
        return Promise.resolve({ data: single ? rows[0] || null : rows, error: null }).then(resolve, reject);
      } };
    return query;
  } };
}
function saveEnvironment(client, ipc) {
  const writes = [], notices = [];
  const original = { id: 'report', room_id: 'uuid-room', aircon_id: 'uuid-node', status: 'Pending', updated: 'loaded-version', created: 'created-version' };
  const context = vm.createContext({ console: { warn() {} }, Date, Math, getSb: () => client, getStaffList: () => [],
    window: { electron: ipc ? { invoke: ipc } : null, dispatchEvent() {} }, Event: class {}, CustomEvent: class {},
    localStorage: { setItem: (key, value) => writes.push({ key, value }) },
    _reportsCache: [{ ...original }], reportVersions: new Map(), confirmedReportWrites: new Map(), reportWriteRevision: 0,
    editingReportId: null, editingReportVersion: null, activeEditRepairId: null, activeEditRepairReport: null,
    findActiveUnverifiedReportForAircon: () => null, normalizeReport: row => ({ ...row }),
    syncReportsWithLinkedRepairs: rows => rows, deduplicateReports: rows => rows,
    broadcastMaintenanceChange() {}, refreshPageReportsView() {}, fetchReportsFromSupabase: async () => {},
    showToast: (...args) => notices.push(args)
  });
  vm.runInContext(section(renderer, '  async function resolveMaintenanceReference(', '  let _nodesAirconCache'), context);
  return { context, original, writes, notices };
}
async function testRendererSaves() {
  const client = database();
  const env = saveEnvironment(client);
  await env.context.saveReports([{ ...env.original }], { ...env.original });
  assert.equal(env.context._reportsCache[0].updated, 'confirmed-version');
  assert.equal(env.writes.length, 1);
  assert.equal(client.calls.filter(call => call.operation === 'rpc').length, 1);
  assert.equal(client.calls.at(-1).args.p_record.room_id, 'uuid-room', 'Real IDs do not require the rm_ prefix');
  for (const failure of [{ message: 'Selected room does not exist', code: 'P0001' }, { message: 'Report changed', code: '40001' }]) {
    let ipcCalls = 0;
    const failedClient = database();
    const failed = saveEnvironment(failedClient, async () => { ipcCalls++; return { success: false, error: failure.message, code: failure.code }; });
    await assert.rejects(failed.context.saveReports([failed.original], { ...failed.original }), error => error.code === failure.code);
    assert.equal(ipcCalls, 1); assert.equal(failedClient.calls.filter(call => call.operation === 'rpc').length, 0);
    assert.equal(failed.writes.length, 0); assert.equal(failed.context._reportsCache[0].updated, 'loaded-version');
  }
  const deletedClient = database({ rooms: [] });
  const deleted = saveEnvironment(deletedClient);
  await assert.rejects(deleted.context.saveReports([deleted.original], { ...deleted.original }), /Selected room no longer exists/);
  assert.equal(deletedClient.calls.filter(call => call.operation === 'rpc').length, 0);
  assert.equal(deleted.writes.length, 0);
  await assert.rejects(deleted.context.resolveValidRoomId(null, 'Server Room A'), /Selected room/);
  const ambiguous = saveEnvironment(database({ rooms: [{ id: 'a', name: 'Lab' }, { id: 'b', name: 'Lab' }] }));
  await assert.rejects(ambiguous.context.resolveValidRoomId(null, 'Lab'), /ambiguous/);
  const transportClient = database();
  const transport = saveEnvironment(transportClient, async () => { throw new Error('IPC transport unavailable'); });
  await transport.context.saveReports([transport.original], { ...transport.original });
  assert.equal(transportClient.calls.filter(call => call.operation === 'rpc').length, 1, 'Transport fallback uses the same validating RPC');
}

function fetchEnvironment() {
  let response = { data: [], error: null }, signedIn = true, queries = 0;
  const client = { auth: { getSession: async () => ({ data: { session: signedIn ? {} : null }, error: null }), onAuthStateChange() {} },
    from(table) { assert.equal(table, 'maintenance_reports'); queries++;
      const query = { select() { return query; }, order() { return query; }, abortSignal() { return query; },
        then(resolve, reject) { return Promise.resolve(response).then(resolve, reject); } };
      return query;
    }, rpc() { throw new Error('Fetching must not re-upload cached reports'); } };
  const storage = new Map();
  const context = vm.createContext({ console: { warn() {} }, Date, Promise, AbortController, setTimeout, clearTimeout,
    getSb: () => client, document: { getElementById: () => null }, window: { dispatchEvent() {} }, Event: class {}, CustomEvent: class {},
    localStorage: { setItem: (key, value) => storage.set(key, value) }, _reportsCache: [{ id: 'deleted-report' }],
    reportWriteRevision: 0, confirmedReportWrites: new Map(), reportVersions: new Map(),
    normalizeReport: row => ({ ...row }), syncReportsWithLinkedRepairs: rows => rows, deduplicateReports: rows => rows,
    getReportsLocal: () => context._reportsCache, refreshPageReportsView() {},
    currentDetailId: null, activeChecklistReportId: null, activeRepairReportId: null
  });
  vm.runInContext(section(renderer, '  function mergeReportsSafely(', '  let _isRefreshingReportsView'), context);
  vm.runInContext(section(renderer, '  let reportsFetchPromise', '  function isReportUnverified'), context);
  return { context, storage, respond: value => { response = value; }, signIn: value => { signedIn = value; }, queries: () => queries };
}
async function testAuthoritativeFetches() {
  const env = fetchEnvironment();
  await env.context.fetchReportsFromSupabase(true);
  assert.equal(env.context._reportsCache.length, 0, 'Successful empty reads remove deleted cached reports');
  assert.equal(env.storage.get('ecoTrack_maintenance_reports'), '[]');
  env.context._reportsCache = [{ id: 'retained' }];
  env.respond({ data: null, error: { message: 'Network failed' } });
  await env.context.fetchReportsFromSupabase(true);
  assert.equal(env.context._reportsCache[0].id, 'retained');
  env.respond({ data: null, error: null });
  await env.context.fetchReportsFromSupabase(true);
  assert.equal(env.context._reportsCache[0].id, 'retained', 'Malformed data cannot clear the cache');
  env.signIn(false); const before = env.queries();
  env.respond({ data: [], error: null }); await env.context.fetchReportsFromSupabase(true);
  assert.equal(env.queries(), before); assert.equal(env.context._reportsCache[0].id, 'retained');
  env.context.confirmedReportWrites.set('new', { revision: 1, record: { id: 'new' } });
  env.context.reportWriteRevision = 1;
  assert.equal(env.context.mergeReportsSafely([], [], 0)[0].id, 'new', 'A confirmed concurrent save survives an earlier read');
  assert.equal(env.context.mergeReportsSafely([], [{ id: 'new' }], 1).length, 0, 'A later authoritative deletion removes the cached report');
}
(async () => {
  await testMainSave(); await testRendererSaves(); await testAuthoritativeFetches();
  console.log('Maintenance save passed: RPC validation preservation, no direct table fallback, actual room/controller IDs, confirmed writes, transport-only RPC retries, empty/deleted cache reconciliation, authentication and read/save races.');
})().catch(error => { console.error(error); process.exitCode = 1; });
