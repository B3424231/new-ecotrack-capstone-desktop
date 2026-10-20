const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
process.env.TZ = 'Asia/Singapore';
const source = fs.readFileSync(process.env.ECOTRACK_LOGS_SOURCE || path.join(__dirname, '..', 'public/js/logs.js'), 'utf8');
const section = (start, end) => {
  const first = source.indexOf(start); return source.slice(first, source.indexOf(end, first));
};
function engine(nodes = []) {
  const context = vm.createContext({ Date, console, globalNodeRecords: nodes, startTimeFilter: '', endTimeFilter: '' });
  vm.runInContext(section('function getPeriodDateKey(', 'function getPeriodDateLabel('), context);
  vm.runInContext(section('function getConfirmedAcOnState(', '// Helper: Calculate previous period'), context);
  vm.runInContext(section('function getAnalyticsNodeId(', 'function getAnalyticsCoverage('), context);
  vm.runInContext(section('function getAcStateFeatures(', 'function updateKpiCardsTrends('), context);
  return context;
}
const time = value => new Date(`2026-10-01T${value}+08:00`);
const reading = (value, extra = {}) => ({ nodeId: 'n1', timestamp: time(value), status: 'online', acOn: true, temperature: 24, intervalSeconds: 30, ...extra });
const near = (actual, expected, message) => assert(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);

function testCadenceAndEvidence() {
  const context = engine([{ id: 'n1', interval_val: 5, interval_unit: 'Minutes' }]);
  const sixty = Array.from({ length: 60 }, (_, index) => ({ ...reading('06:00:00'), timestamp: new Date(time('06:00:00').getTime() + index * 30000), interval_seconds: 30 }));
  const result = context.calculateRuntimeFromLogs(sixty.reverse());
  near(result.totalRuntimeSum, 0.5, '60 thirty-second readings cover half an hour');
  near(result.runtimeHrs, 0.5, 'Facility span follows observed timestamps and final cadence pulse');
  near(result.perUnitUtil, 0.5, 'Per-unit average is independent of log count assumptions');
  near(context.calculateRuntimeFromLogs([reading('06:00:00', { interval_seconds: 30 })]).totalRuntimeSum, 30 / 3600, 'Recorded cadence takes precedence');
  near(context.calculateRuntimeFromLogs([reading('06:00:00', { intervalSeconds: undefined })]).totalRuntimeSum, 5 / 60, 'Use configured node cadence');
  const fallback = engine();
  near(fallback.calculateRuntimeFromLogs([reading('06:00:00', { intervalSeconds: undefined })]).totalRuntimeSum, 0, 'Missing cadence cannot establish runtime');
  assert.equal(fallback.calculateRuntimeFromLogs([reading('06:00:00', { acOn: undefined })]).activeUnits, 0, 'Online low-temperature readings are unconfirmed');
  assert.equal(fallback.getDisplayAcState(reading('06:00:00', { acOn: undefined, temperature: null })), 'STATE NOT RECORDED');
  assert.equal(fallback.getDisplayAcState(reading('06:00:00', { temperature: 35 })), 'ON', 'Ambient temperature cannot override confirmed power');
  assert.equal(fallback.calculateRuntimeFromLogs([reading('06:00:00', { acOn: false })]).totalRuntimeSum, 0);
  assert.equal(fallback.calculateRuntimeFromLogs([reading('06:00:00', { status: 'offline' })]).totalRuntimeSum, 0);
  near(fallback.calculateRuntimeFromLogs([reading('06:00:00', { temperature: 35 })]).totalRuntimeSum, 30 / 3600, 'Confirmed power overrides ambient temperature');
  assert.equal(fallback.calculateRuntimeFromLogs([reading('06:00:00', { eventType: 'schedule_updated', intervalSeconds: 30 })]).totalRuntimeSum, 0, 'Schedule events are not AC readings');
  assert.equal(fallback.calculateRuntimeFromLogs([reading('06:00:00', { timestamp: 'invalid' })]).runtimeHrs, 0);
  for (const field of ['ac_on', 'power_state', 'powerState', 'ac_state', 'acState']) {
    assert.equal(fallback.getConfirmedAcOnState({ [field]: 'ON', status: 'online' }), true);
    assert.equal(fallback.getConfirmedAcOnState({ [field]: 'OFF', status: 'online' }), false);
  }
}

function testSessionsAndFacilitySpan() {
  const context = engine();
  const result = context.calculateRuntimeFromLogs([reading('06:00:00'), reading('06:10:00')]);
  near(result.nodeRuntimes.n1, 60 / 3600, 'A ten-minute outage contributes two pulses, not the idle gap');
  near(result.facilityActiveHrs, 60 / 3600, 'Facility active time excludes the gap');
  near(result.runtimeHrs, 60 / 3600, 'Facility active time excludes unobserved gaps');
  const stopped = context.calculateRuntimeFromLogs([reading('06:00:00'), reading('06:00:20', { acOn: false }), reading('06:30:00'), reading('06:30:15', { acOn: false })]);
  near(stopped.totalRuntimeSum, 35 / 3600, 'Explicit off readings end on sessions');
  const fleet = context.calculateRuntimeFromLogs([reading('06:00:00'), reading('06:00:30'), reading('06:00:15', { nodeId: 'n2' }), reading('06:00:45', { nodeId: 'n2' })]);
  near(fleet.runtimeHrs, 75 / 3600, 'Facility span uses first and last activity across units');
  near(fleet.totalRuntimeSum, 120 / 3600, 'Sum each unit separately');
  near(fleet.perUnitUtil, 60 / 3600, 'Average confirmed active-unit hours');
  assert.equal(fleet.activeUnits, 2);
  const aliases = engine([{ id: 'db1', name: 'n1' }]);
  const duplicate = reading('06:00:00');
  near(aliases.calculateRuntimeFromLogs([duplicate, duplicate, reading('06:00:00', { nodeId: 'db1' })]).totalRuntimeSum, 30 / 3600, 'Aliases and duplicate samples cannot double-count a unit');
}

function testSchedulesAndPeriods() {
  const hourly = Array.from({ length: 24 }, (_, hour) => reading(`${String(hour).padStart(2, '0')}:00:00`, { intervalSeconds: 3600 }));
  const daytime = engine([{ id: 'n1', wake_time: '08:00', sleep_time: '18:00' }]);
  const result = daytime.calculateRuntimeFromLogs(hourly);
  near(result.totalRuntimeSum, 10, 'Daily runtime cannot exceed a ten-hour scheduled window');
  near(result.runtimeHrs, 10, 'Facility span respects operating windows');
  near(daytime.calculateRuntimeFromLogs([reading('17:59:50')]).totalRuntimeSum, 10 / 3600, 'Clip pulses at sleep time');
  assert.equal(daytime.calculateRuntimeFromLogs([reading('18:30:00')]).totalRuntimeSum, 0);
  const overnight = engine([{ id: 'n1', wake_time: '22:00', sleep_time: '06:00' }]);
  near(overnight.calculateRuntimeFromLogs(hourly).totalRuntimeSum, 8, 'Overnight schedules count only their two calendar-day portions');
  near(overnight.calculateRuntimeFromLogs(hourly).runtimeHrs, 8, 'Operational span excludes scheduled daytime closure');
  daytime.startTimeFilter = '09:00'; daytime.endTimeFilter = '11:00';
  const twoDays = hourly.concat(hourly.map(log => ({ ...log, timestamp: new Date(log.timestamp.getTime() + 86400000) })));
  near(daytime.calculateRuntimeFromLogs(twoDays).totalRuntimeSum, 4, 'Apply time filters per day across monthly or weekly selections');
  near(daytime.calculateRuntimeFromLogs(twoDays).runtimeHrs, 4, 'Do not cap an entire multi-day period to one daily filter');
  const change = engine([{ id: 'n1', interval_val: 15, interval_unit: 'Minutes' }]);
  const withSchedule = [reading('06:00:00', { status: 'schedule', eventType: 'schedule_updated', intervalSeconds: 30, wakeTime: '06:00', sleepTime: '06:01' }), reading('06:00:30')];
  near(change.calculateRuntimeFromLogs(withSchedule).totalRuntimeSum, 30 / 3600, 'Recorded schedule event supplies historical cadence and bounds');
}

async function testUnknownRuntimePrediction() {
  const context = engine(); let requests = 0;
  Object.assign(context, { AbortController, currentPeriod: 'daily', currentNodeFilter: '', BACKEND_URL: 'http://backend',
    selectedDateKey: '2026-10-01', nodeDataLogs: [], controlNameMap: {},
    getPreviousPeriodDateKey: () => '2026-09-30', getDefaultDateKey: () => '2026-10-01',
    formatTariffRate: () => '₱10/kWh', currentEvaluatedKwh: null, currentEvaluatedCost: null, currentAnalyticsResult: null, getActiveTariffRate: () => 10,
    getAirconFleetCount: () => ({ total: 1, online: 1 }), updateKpiCardsTrends() {}, updateAnalyticsCharts() {},
    document: { getElementById: () => null }, fetch: async () => { requests++; throw new Error('No prediction expected'); } });
  vm.runInContext(section('let currentPredictionSession', '// Convert 24-hour'), context);
  const unconfirmed = [reading('06:00:00', { acOn: undefined }), reading('06:00:30', { acOn: undefined })];
  await context.predictEnergyConsumption({ totalRecords: 2, onlineNodes: '1/1' }, unconfirmed);
  assert.equal(requests, 0, 'Unknown AC state must not trigger guessed energy predictions');
  assert.equal(context.currentEvaluatedKwh, null, "Unknown feedback is unavailable, not confirmed zero consumption");
  assert.equal(context.getAcStateFeatures(unconfirmed).acOnRatio, 0);
}

async function testFetchedStateMapping() {
  const context = engine([{ id: 'n1', interval_val: 15, interval_unit: 'Minutes' }]);
  const records = [{ id: 'on', node_id: 'n1', created: time('06:00:00').toISOString(), status: 'online',
    ac_on: 1, interval_seconds: 30, wake_time: '06:00', sleep_time: '18:00' }];
  Object.assign(context, { window: {}, document: { getElementById: () => null }, pb: null,
    nodeDataLogs: [], controlNameMap: {}, locationMap: {}, globalAirconMap: {}, lastTelemetryTotalItems: null,
    getTelemetryRevision: data => JSON.stringify(data),
    fetch: async () => ({ ok: true, json: async () => ({ items: records, totalItems: 1 }) }) });
  vm.runInContext(section('function locationLabel(', '// Get room name for a node'), context);
  vm.runInContext(section('async function fetchLogsFromDB(', '// Get filtered logs'), context);
  await context.fetchLogsFromDB(true);
  near(context.calculateRuntimeFromLogs(context.nodeDataLogs).totalRuntimeSum, 30 / 3600, 'Fetched state and cadence survive mapping into the runtime engine');
}

async function main() {
  testCadenceAndEvidence(); testSessionsAndFacilitySpan(); testSchedulesAndPeriods(); await testUnknownRuntimePrediction(); await testFetchedStateMapping();
  console.log('Runtime engine passed: confirmed AC state, real timestamps, cadence precedence, gap splitting, off transitions, facility span, unit-hours, schedule clipping, overnight windows, multi-day filters, aliases, and unknown-state predictions.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
