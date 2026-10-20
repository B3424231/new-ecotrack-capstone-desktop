'use strict';
// Isolated startup/metadata tests. No live cloud, hardware, or production database access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/js/logs.js'), 'utf8');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, start);
  return source.slice(a, b);
}
const snapshot = { rooms: [{ id: 'room', name: 'Recorded room', floor_id: 'floor' }],
  floors: [{ id: 'floor', name: 'Floor', building_id: 'building' }], buildings: [{ id: 'building', name: 'Building' }],
  nodes: [{ id: 'database-id', name: 'Controller name', room_id: 'room', interval_seconds: 30,
    created: '2026-10-18T00:00:00Z', status: 'online', ac_on: true, wifi_password: 'fixture-must-not-be-cached',
    desired_state: { power: true }, secret: 'fixture-only' }] };
function fixture({ offline = false, ipc = () => new Promise(() => {}) } = {}) {
  const storage = new Map(), handlers = new Map(), timers = new Map();
  let timerId = 0, cloudCalls = 0, renders = 0, polls = 0;
  const context = vm.createContext({ console, AbortController, Date, JSON, Promise,
    navigator: { onLine: !offline },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    document: { getElementById: () => null, addEventListener: (name, fn) => handlers.set(name, fn) },
    CSS: { escape: value => value },
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => { polls++; },
    roomMap: {}, controlNameMap: {}, locationMap: {}, globalAirconMap: {}, globalInstallDateMap: {}, globalNodeRecords: [],
    selectedDateKey: '', nodeDataLogs: [], sb: null,
    setupEventListeners() {}, setupTariffModal() {}, setupTopConsumersModal() {}, updateTariffUI() {},
    populateDateRangeOptions() {}, getDefaultDateKey: () => '2026-10-18',
    render: () => { renders++; }, fetchLogsFromDB: async () => { context.nodeDataLogs = [{ id: 'local-record' }]; },
    pollLatestTelemetry() {}, onTelemetrySavedDebounced() {}, telemetryMetadataPending: false,
    telemetryMetadataRefresh: null,
  });
  context.window = { ECOTRACK_CONFIG: { supabaseUrl: 'https://fixture.invalid', backendUrl: 'http://localhost:5000' },
    electron: { invoke: channel => { assert.equal(channel, 'scheduler-fetch-data'); cloudCalls++; return ipc(); } },
    addEventListener() {} };
  vm.runInContext(section('function refreshLogMetadata()', 'function getTelemetryRevision('), context);
  vm.runInContext(section('// Initialize logs on page load', '// Get room name for a node'), context);
  return { context, storage, handlers, timers, renders: () => renders, polls: () => polls, cloudCalls: () => cloudCalls };
}
async function main() {
  const slow = fixture();
  await slow.handlers.get('DOMContentLoaded')();
  assert.equal(slow.renders(), 1, 'SQLite renders while cloud metadata is still pending');
  assert.equal(slow.context.nodeDataLogs[0].id, 'local-record');
  assert.equal(slow.polls(), 1, 'Local telemetry polling starts without a cloud response');
  assert.equal(slow.cloudCalls(), 1, 'No duplicate startup metadata request');
  const pending = slow.context.refreshLogMetadata();
  assert.equal(slow.cloudCalls(), 1, 'Concurrent refreshes share one request');
  for (const timer of [...slow.timers.values()]) { assert.equal(timer.ms, 4000); timer.fn(); }
  await pending;
  assert.equal(slow.renders(), 1, 'A cloud timeout cannot overwrite local results');
  console.log('PASS initial render and local polling complete while cloud metadata hangs; refresh is deduplicated and bounded');

  const online = fixture({ ipc: async () => ({ success: true, ...snapshot }) });
  assert.equal(await online.context.loadRoomMap(), true);
  const cacheKey = online.context.logMetadataCacheKey(), saved = online.storage.get(cacheKey);
  assert(saved.includes('Controller name'));
  for (const forbidden of ['wifi_password', 'secret', 'desired_state', 'status', 'ac_on']) assert(!saved.includes('"' + forbidden + '"'));
  const offline = fixture({ offline: true });
  offline.storage.set(cacheKey, saved);
  await offline.handlers.get('DOMContentLoaded')();
  assert.equal(offline.cloudCalls(), 0);
  assert.equal(offline.context.controlNameMap['database-id'], 'Controller name');
  assert.equal(offline.context.locationMap['database-id'].roomName, 'Recorded room');
  assert.equal(offline.context.globalNodeRecords[0].id, 'database-id');
  assert.equal(offline.context.globalNodeRecords[0].ac_on, undefined);
  assert.equal(offline.renders(), 1);
  console.log('PASS offline restart restores saved labels and IDs without caching credentials or physical/online state');

  offline.storage.set('ecoTrack_profile_user', JSON.stringify({ id: 'different-user' }));
  assert.notEqual(offline.context.logMetadataCacheKey(), cacheKey);
  const empty = fixture({ offline: true });
  empty.storage.set(empty.context.logMetadataCacheKey(), 'malformed-json');
  await empty.handlers.get('DOMContentLoaded')();
  assert.equal(empty.renders(), 1);
  assert.equal(empty.context.nodeDataLogs.length, 1);
  assert.equal(empty.cloudCalls(), 0);
  console.log('PASS cache is scoped to project/backend/user; absent or malformed metadata cannot block local telemetry');

  const prior = fixture({ ipc: async () => ({ success: true, ...snapshot }) });
  await prior.context.loadRoomMap();
  prior.context.window.electron.invoke = async () => ({ success: true, ...snapshot, nodes: [] });
  await prior.context.loadRoomMap();
  assert.equal(prior.context.globalNodeRecords.length, 0, 'Successful empty metadata removes stale nodes');
  console.log('PASS successful cloud refresh preserves authoritative deletions');

  const browser = fixture();
  delete browser.context.window.electron;
  browser.context.sb = { from: () => ({ select: () => ({ abortSignal: signal => new Promise(resolve => {
    signal.addEventListener('abort', () => resolve({ error: { message: 'aborted' } }), { once: true });
  }) }) }) };
  const refresh = browser.context.loadRoomMap();
  for (const timer of [...browser.timers.values()]) timer.fn();
  await refresh;
  assert.equal(browser.context.globalNodeRecords.length, 0);
  console.log('PASS direct Supabase metadata queries receive an abort signal and cannot stall a refresh indefinitely');

  const html = fs.readFileSync(path.join(root, 'public/logs.html'), 'utf8');
  for (const match of html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"/g)) {
    assert(!/^https?:/.test(match[1]), 'Page assets must be bundled: ' + match[1]);
    assert(fs.existsSync(path.join(root, 'public', match[1].split('?')[0])), match[1]);
  }
  assert(!html.includes('document.write('));
  console.log('PASS Daily Logs scripts, styles, charts and export libraries are local files');
  const assets = JSON.parse(fs.readFileSync(path.join(root, 'public/vendor/assets.json'), 'utf8'));
  for (const asset of assets) {
    const bytes = fs.readFileSync(path.join(root, 'public/vendor', asset.file));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), asset.sha256, asset.file);
  }
  const fontCss = fs.readFileSync(path.join(root, 'public/vendor/manrope.css'), 'utf8');
  assert(!fontCss.includes('https://'));
  for (const match of fontCss.matchAll(/url\(([^)]+)\)/g)) assert(fs.existsSync(path.join(root, 'public/vendor', match[1])));
  console.log('PASS bundled upstream checksums and local font files');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
