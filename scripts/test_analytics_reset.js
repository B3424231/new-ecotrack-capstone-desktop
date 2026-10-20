const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/logs.js'), 'utf8');
const slice = (text, start, end) => {
  const a = text.indexOf(start), b = text.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `Missing function boundary: ${start}`);
  return text.slice(a, b);
};

async function testAuthoritativeEmptyAndFailure() {
  let response = { ok: true, json: async () => ({ items: [], totalItems: 0, reset_at: 'reset' }) };
  let cleared = 0, fallbackCalls = 0;
  const context = vm.createContext({ console: { error() {} }, Date,
    window: { sb: { from() { fallbackCalls++; throw new Error('No cloud fallback'); } } },
    pb: { collection() { fallbackCalls++; throw new Error('No retry on empty'); } },
    document: { getElementById: () => null }, fetch: async () => response,
    nodeDataLogs: [{ id: 'old' }], controlNameMap: {}, locationMap: {}, globalAirconMap: {},
    lastTelemetryTotalItems: 1, lastTelemetryRevision: null, lastTelemetryResetAt: null,
    getTelemetryRevision: data => JSON.stringify([data.totalItems, data.reset_at]),
    predictEnergyConsumption: (_, records) => { assert.equal(records.length, 0); cleared++; }
  });
  vm.runInContext(slice(source, 'function locationLabel(', '// Get room name for a node'), context);
  vm.runInContext(slice(source, 'async function fetchLogsFromDB(', '// Get filtered logs'), context);
  await context.fetchLogsFromDB(true);
  assert.equal(context.nodeDataLogs.length, 0, 'Empty database clears previously loaded analytics');
  assert.equal(cleared, 1, 'Empty history invalidates pending predictions immediately');
  assert.equal(fallbackCalls, 0, 'Successful empty results cannot restore data from another source');
  assert.equal(context.lastTelemetryResetAt, 'reset');
  context.nodeDataLogs = [{ id: 'retained' }];
  response = { ok: false, status: 503 };
  await context.fetchLogsFromDB(true);
  assert.equal(context.nodeDataLogs[0].id, 'retained', 'Network failures preserve the last successful snapshot');
  response = { ok: true, json: async () => ({ items: null }) };
  await context.fetchLogsFromDB(true);
  assert.equal(context.nodeDataLogs[0].id, 'retained', 'Malformed responses cannot masquerade as empty history');
}

async function testResetRefreshesHistoricalSelection() {
  let pending, fetches = 0, renders = 0;
  const context = vm.createContext({ console, Date, currentPeriod: 'daily', selectedDateKey: 'historical',
    window: { addEventListener() {} }, getPeriodDateKey: () => 'today',
    setTimeout: handler => { pending = handler; return 1; }, clearTimeout() {},
    fetch: async () => ({ ok: true, json: async () => ({ items: [], totalItems: 0, reset_at: 'new-reset' }) }),
    fetchLogsFromDB: async () => { fetches++; }, loadRoomMap: async () => {},
    render: () => { renders++; }
  });
  vm.runInContext(slice(source, 'let telemetryRefreshPending', '// Helper to get actual aircon fleet count'), context);
  vm.runInContext('followLatestLogPeriod = false', context);
  await context.pollLatestTelemetry();
  assert.equal(typeof pending, 'function', 'Deletion is detected while viewing historical dates');
  pending(); await new Promise(setImmediate);
  assert.equal(fetches, 1); assert.equal(renders, 1);
  assert.equal(context.selectedDateKey, 'historical', 'Reset preserves the selected date while showing no records');
}

function testTariffAndRealRankings() {
  const values = new Map();
  const context = vm.createContext({ localStorage: { getItem: key => values.get(key) ?? null },
    currentPeriod: 'daily', controlNameMap: {}, globalAirconMap: {}, currentAnalyticsResult: null });
  vm.runInContext(slice(source, 'function getActiveTariffRate(', 'function saveTariffSettings('), context);
  vm.runInContext(slice(source, 'function computeConsumptionRankings(', 'function updateTopConsumersModal('), context);
  assert.equal(context.getActiveTariffRate(), null); assert.equal(context.getTargetBudget(), null);
  assert.equal(context.getUtilityProvider(), 'Not configured');
  assert.equal(context.calculateEnergyCost(10), null, 'An unset tariff is not free electricity');
  assert.equal(context.formatTariffRate(), 'Not configured');
  assert.equal(context.computeConsumptionRankings().buildings.length, 0);
  context.currentAnalyticsResult = { nodes: [
    { id: 'a', kwh: 2, logs: [{ buildingName: 'North', airconType: 'Window Type' }] },
    { id: 'b', kwh: 8, logs: [{ buildingName: 'South', airconType: 'Split Type' }] },
    { id: 'failed', kwh: null, logs: [{ buildingName: 'Other' }] }
  ] };
  const rankings = context.computeConsumptionRankings();
  assert.equal(rankings.buildings[0].name, 'South'); assert.equal(rankings.buildings[0].share, 80);
  assert.equal(rankings.totalCost, null);
  values.set('ecoTrack_tariff_rate', '12.50');
  assert.equal(context.calculateEnergyCost(10), 125); assert.equal(context.calculateEnergyCost(null), null);
  assert.equal(context.calculateEnergyCost(0), 0, 'A valid zero energy estimate stays zero');
}

function testNoSampleTelemetryPersists() {
  const telemetry = fs.readFileSync(path.join(__dirname, '../public/js/telemetry-new.js'), 'utf8');
  const writes = [], existing = { id: 'controller', name: 'controller', temp: 25, pressure: 0.5, rssi: -55, battery: 4 };
  const context = vm.createContext({ console, Date, rooms: {}, activeNodesData: [existing], sb: null,
    window: {}, document: { querySelectorAll: () => [] }, _updateLiveBadge() {},
    saveNodeTelemetryToSqlite: async packet => { writes.push(packet); } });
  vm.runInContext(slice(telemetry, 'function telemetryNumber(', 'function _appendAvailableNode('), context);
  context._ingestPacket({ id: 'controller', ac_on: false });
  assert.equal(writes.length, 1); assert.equal(writes[0].temp, undefined, 'Old cached temperatures cannot become a new reading');
  assert.equal(writes[0].ac_on, false, 'Raw physical power feedback is preserved');
  for (const field of ['temp', 'pressure', 'battery', 'rssi']) assert.equal(context.activeNodesData[0][field], null);
  assert.equal(context.telemetryNumber(''), null); assert.equal(context.telemetryNumber('bad'), null);
  assert.equal(context.telemetryNumber(0), 0); assert.equal(context.telemetryDisplay(null), 'Unavailable');
}

(async () => {
  await testAuthoritativeEmptyAndFailure(); await testResetRefreshesHistoricalSelection();
  testTariffAndRealRankings(); testNoSampleTelemetryPersists();
  console.log('Analytics reset passed: authoritative empty state, failure preservation, historical deletion refresh, unset tariffs, real estimate rankings and raw telemetry persistence.');
})().catch(error => { console.error(error); process.exitCode = 1; });
