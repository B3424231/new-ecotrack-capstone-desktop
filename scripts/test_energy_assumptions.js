'use strict';
// Real page handlers and model-client contract; all telemetry, DOM and HTTP stay isolated.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
process.env.TZ = 'Asia/Singapore';
const root = process.env.ECOTRACK_DESKTOP_ROOT || path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const source = read('public/js/logs.js'), html = read('public/logs.html');
const section = (begin, end) => {
  const a = source.indexOf(begin), b = source.indexOf(end, a + begin.length);
  assert(a >= 0 && b > a, begin); return source.slice(a, b);
};
const flush = async () => { for (let index = 0; index < 8; index++) await new Promise(setImmediate); };
const base = { power: 'on', temp: 21, mode: 'auto', fan: 'auto', eco: 'off', turbo: 'off',
  swing_vertical: 'off', swing_horizontal: 'off', display: 'on' };
const reading = () => ({ nodeId: 'fixture-controller', controlName: 'Fixture controller', status: 'online',
  timestamp: new Date('2026-10-04T08:00:00+08:00'), acOn: null, temperature: null, intervalSeconds: 3600,
  controlSnapshot: { desired_state: { ...base }, commanded_at: '2026-10-04T08:01:00+08:00',
    observed_remote_state: { ...base, power: false }, observed_remote_at: '2026-10-04T08:00:00+08:00' } });
class Element {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.handlers = {}; this.dataset = {};
    this.style = {}; this.value = ''; this.textContent = ''; this.hidden = false; this.disabled = false;
    this.classList = { contains: () => false }; }
  addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); }
  async dispatch(name) { for (const fn of this.handlers[name] || []) await fn({ target: this }); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
  querySelector(selector) { return selector === 'span' ? this.explanation ||= new Element('span') : null; }
  getContext() { return { createLinearGradient: () => ({ addColorStop() {} }) }; }
}
function fixture() {
  const elements = new Map(), requests = [], deferred = [];
  for (const match of html.matchAll(/<([a-z][\w:-]*)\b[^>]*\bid="([^"]+)"[^>]*>/gi)) {
    const element = new Element(match[1]); element.id = match[2]; elements.set(element.id, element);
  }
  const find = (element, id) => element.id === id ? element : element.children.map(child => find(child, id)).find(Boolean);
  const get = id => elements.get(id) || [...elements.values()].map(element => find(element, id)).find(Boolean) || null;
  const mode = { fail: false, defer: false, featuresFail: false, metadata: {}, prediction: {} };
  const metadata = { model: 'hist_gradient_boosting', output_unit: 'kWh', horizon_hours: 1,
    training_data_type: 'research_informed_estimates', physical_accuracy_validated: false,
    input_scope: 'controls_only', environment_source: 'not_used', n_features: 9,
    features: ['setpoint_c', 'fan_command', 'operating_mode', 'eco', 'turbo', 'swing', 'quiet', 'horizontal_swing', 'display'],
    environment_scenarios: [] };
  const response = (_recorded = false, body = {}) => ({ ok: !mode.fail, json: async () => mode.fail ? { error: 'Isolated prediction failed' }
    : { ...metadata, ...mode.metadata, kwh: body.settings?.setpoint_c === 24 ? 1 : 2, prediction_status: 'research_estimate',
      prediction_basis: 'control_settings_only', reference_range_kwh: { min: 0.5, max: 3 },
      reference_condition_count: 0, reference_variant_count: 2, ...mode.prediction } });
  const fetch = async (url, options = {}) => {
    if (url.includes('/prediction-features?')) return { ok: !mode.featuresFail, json: async () => mode.featuresFail ? { error: 'Features service unavailable' } : { ...metadata, ...mode.metadata } };
    const recorded = url === 'http://fixture/api/predict-recorded-energy';
    assert(recorded || url === 'http://fixture/api/predict-energy');
    const body = JSON.parse(options.body);
    assert.equal(options.method, 'POST'); requests.push(body);
    if (mode.defer) return new Promise(resolve => deferred.push(() => resolve(response(recorded, body))));
    return response(recorded, body);
  };
  const context = vm.createContext({ Date, console, AbortController, setTimeout, clearTimeout, fetch,
    ECOTRACK_CONFIG: { backendUrl: 'http://fixture' }, currentPeriod: 'daily', currentNodeFilter: '',
    selectedDateKey: '2026-10-04', startTimeFilter: '', endTimeFilter: '', controlNameMap: {}, nodeDataLogs: [],
    globalNodeRecords: [{ id: 'fixture-controller', name: 'Fixture controller', wake_time: '08:00', sleep_time: '10:00' }],
    currentAnalyticsResult: null, currentEvaluatedKwh: null, currentEvaluatedCost: null,
    document: { getElementById: get, createElement: tag => new Element(tag), documentElement: { classList: { contains: () => false } } },
    Chart: class { constructor(canvas, config) { this.data = config.data; this.options = config.options; } update() {} },
    getAirconFleetCount: () => ({ total: 1 }), getActiveTariffRate: () => 10,
    getDefaultDateKey: () => '2026-10-04', getPreviousPeriodDateKey: () => '2026-10-03',
    getPeriodDateKey: date => new Date(date).toISOString().slice(0, 10), getDateRangeText: () => 'fixture date',
    getFilteredLogs: () => context.rows, calculateStats: () => ({}), updateKpiCardsTrends() {},
  });
  context.window = context; context.rows = [reading()];
  vm.runInContext(read('public/js/aircon-state.js'), context);
  vm.runInContext(read('public/js/energy-prediction.js'), context);
  vm.runInContext(section('function calculateEnergyCost(', 'function saveTariffSettings('), context);
  vm.runInContext(section('function getConfirmedAcOnState(', '// Helper: Calculate previous period'), context);
  vm.runInContext(section('let energyTrendChartInstance', '// ─── ENERGY CONSUMPTION PREDICTION'), context);
  vm.runInContext(section('let currentPredictionSession', '// Convert 24-hour'), context);
  const predict = context.predictEnergyConsumption;
  context.predictEnergyConsumption = (...args) => context.pending = predict(...args);
  const run = () => context.predictEnergyConsumption({}, context.rows);
  const ready = run;
  return { context, get, run, ready, mode, requests, deferred, elements };
}

const tests = {};
tests['controls-only page has no environment or manual flag selectors'] = async () => {
  assert.doesNotMatch(html, /id="(?:energyEstimateAssumptions|energyEnvironmentScenario|energyScenarioRetry|energyMissingFlags)"/);
  assert.doesNotMatch(html, /id="(?:energyControlInputs|analyticsDataStatus|analyticsScheduleLink)"/);
  const app = fixture(); await app.run();
  assert.equal(app.requests.length, 1); assert.equal(app.context.currentEvaluatedKwh, 2);
  assert.equal(app.requests[0].settings.quiet, undefined);
  assert.deepEqual(Object.keys(app.requests[0]).sort(), ['model', 'settings']);
};
tests['automatic estimate updates all charts without inventing physical runtime'] = async () => {
  const app = fixture(), before = JSON.stringify(app.context.rows); await app.run();
  const result = app.context.currentAnalyticsResult;
  assert.equal(result.kwh, 2); assert.equal(result.cost, 20); assert.equal(result.forecast, true);
  assert.equal(result.coverage.confirmedSamples, 0); assert.equal(result.coverage.unknownSamples, 1);
  assert.equal(app.context.getConfirmedAcOnState(app.context.rows[0]), null);
  assert.equal(result.runtime.totalRuntimeSum, 0);
  assert.equal(JSON.stringify(app.context.rows), before, 'No source snapshots or telemetry changed');
  assert.match(app.get('aiSuggestion').textContent, /Physical AC power is unconfirmed/);
  assert.match(app.get('aiSuggestion').textContent, /AC controls only/);
  for (const id of ['energyTrendEmpty', 'estimatedCostEmpty', 'dualAxisEmpty']) assert.equal(app.get(id).style.display, 'none');
  for (const [name, dataset, total] of [['energyTrendChartInstance', 0, 2], ['estimatedCostChartInstance', 0, 20],
    ['dualAxisChartInstance', 0, 20], ['dualAxisChartInstance', 1, 2]]) {
    const chart = vm.runInContext(name, app.context);
    assert.equal(chart.data.datasets[dataset].data.filter(Number.isFinite).reduce((sum, value) => sum + value, 0), total);
  }
};
tests['recorded flags are forwarded unchanged and unrecorded flags are omitted'] = async () => {
  const app = fixture(); await app.run(); assert.equal(app.requests.at(-1).settings.quiet, undefined);
  app.context.rows[0].controlSnapshot.observed_remote_state.quiet = true;
  app.context.rows[0].controlSnapshot.observed_remote_state.fan = 'quiet'; await app.run();
  assert.equal(app.requests.at(-1).settings.quiet, true);
  assert.equal(app.requests.at(-1).settings.fan_command, 'quiet');
};
tests['sensor readings in telemetry never enter the model request'] = async () => {
  const app = fixture(); const state = app.context.rows[0].controlSnapshot.observed_remote_state;
  Object.assign(state, { indoor_c: 40, outdoor_c: 50, relative_humidity_percent: 95 });
  Object.assign(app.context.rows[0], { temperature: 40, humidity: 95 }); await app.run();
  assert.equal(app.context.currentEvaluatedKwh, 2);
  for (const key of ['indoor_c', 'outdoor_c', 'relative_humidity_percent']) assert.equal(app.requests[0].settings[key], undefined);
  assert.equal(app.requests[0].scenario_id, undefined);
};
tests['feature metadata requires exactly nine controls and no environment scenarios'] = async () => {
  const app = fixture(); const client = app.context.EcoTrackEnergyPrediction;
  const meta = await client.features(); assert.equal(meta.n_features, 9); assert.equal(meta.environment_scenarios.length, 0);
  app.mode.metadata = { features: [...meta.features, 'indoor_c'], n_features: 10 };
  await assert.rejects(client.features(true), /nine AC control inputs/);
};
tests['client refuses a stale sensor-based model response'] = async () => {
  const app = fixture(); app.mode.metadata = { input_scope: 'controls_and_environment' };
  await app.run(); assert.equal(app.context.currentEvaluatedKwh, null);
  assert.match(app.context.currentAnalyticsResult.reason, /controls-only Histogram Gradient Boosting model/);
};
tests['client refuses the previous Random Forest service response'] = async () => {
  const app = fixture(); app.mode.metadata = { model: 'random_forest' };
  await app.run(); assert.equal(app.context.currentEvaluatedKwh, null);
  assert.match(app.context.currentAnalyticsResult.reason, /Histogram Gradient Boosting model/);
};
tests['client refuses environmental prediction envelopes and preserves missing estimates'] = async () => {
  const app = fixture(); app.mode.prediction = { reference_condition_count: 6 };
  await app.run(); assert.equal(app.context.currentEvaluatedKwh, null);
  assert.match(app.context.currentAnalyticsResult.reason, /AC control settings only/);
};
tests['legacy scenario argument never enters a strict controls-only prediction'] = async () => {
  const app = fixture(), client = app.context.EcoTrackEnergyPrediction;
  const state = { ...base, quiet: false };
  const first = await client.predict(state, 'lab_hot');
  const second = await client.predict(state, 'irrelevant-environment');
  assert.equal(first.kwh, second.kwh);
  for (const request of app.requests) assert.deepEqual(Object.keys(request).sort(), ['model', 'settings']);
};
tests['selection changes cannot retain previous estimates or exports'] = async () => {
  const app = fixture(); await app.run(); app.context.selectedDateKey = '2026-10-05'; app.context.rows = [];
  await app.run(); assert.equal(app.context.currentEvaluatedKwh, null);
  assert.equal(app.context.currentAnalyticsResult.reason, 'No readings match this selection.');
  assert.equal(app.context.getEnergyPredictionForExport()?.kwh, null);
};
tests['stale prediction cannot overwrite a changed date or export'] = async () => {
  const app = fixture(); await app.ready(); app.mode.defer = true;
  const old = app.run(); await flush(); assert(app.deferred.length);
  app.context.selectedDateKey = '2026-10-05'; app.context.rows = []; await app.run();
  app.deferred.forEach(release => release()); await old; await flush();
  assert.equal(app.context.currentEvaluatedKwh, null);
  assert.equal(app.context.currentAnalyticsResult.reason, 'No readings match this selection.');
  assert.equal(app.context.getEnergyPredictionForExport()?.kwh, null);
};
tests['model failures keep exact chart explanations and do not become zero'] = async () => {
  const app = fixture(); await app.ready(); app.mode.fail = true; await app.run();
  assert.equal(app.context.currentEvaluatedKwh, null);
  for (const id of ['energyTrendEmpty', 'estimatedCostEmpty', 'dualAxisEmpty']) assert.equal(app.get(id).querySelector('span').textContent, 'Isolated prediction failed');
};
tests['unsupported setpoints stay rejected by model validation'] = async () => {
  const app = fixture(); await app.ready(); const before = app.requests.length;
  app.context.rows[0].controlSnapshot.observed_remote_state.temp = 21.5; await app.run();
  assert.equal(app.requests.length, before); assert.equal(app.context.currentEvaluatedKwh, null);
  assert.match(app.context.currentAnalyticsResult.reason, /integer setpoints/);
};

tests['automatic prediction needs neither a saved schedule nor environmental or Quiet inputs'] = async () => {
  const app = fixture(), before = JSON.stringify(app.context.rows);
  app.context.globalNodeRecords = [{ id: 'fixture-controller', name: 'Fixture controller' }];
  await app.run();
  assert.equal(app.context.currentEvaluatedKwh, 2);
  assert.equal(app.context.currentAnalyticsResult.recordedColumns, true);
  assert.equal(app.context.currentAnalyticsResult.runtime.totalRuntimeSum, 0);
  assert.equal(app.context.getConfirmedAcOnState(app.context.rows[0]), null);
  assert.equal(JSON.stringify(app.context.rows), before);
  assert.equal(app.get('analyticsScheduleLink'), null);
  assert.match(app.get('aiSuggestion').textContent, /recorded columns and timestamps/);
  assert.match(app.get('aiSuggestion').textContent, /Reference range/);
  assert.equal(app.context.getEnergyPredictionForExport().recordedColumns, true);
};
tests['the screenshot six-second timestamps use recorded cadence and never become fixed row-hours'] = async () => {
  const app = fixture();
  app.context.rows = [0, 6, 12].map(seconds => ({ ...reading(), intervalSeconds: 5,
    timestamp: new Date(Date.parse('2026-10-04T08:00:00+08:00') + seconds * 1000) }));
  await app.run();
  assert(Math.abs(app.context.currentEvaluatedKwh - 2 * 17 / 3600) < 1e-12);
  assert(Math.abs(app.context.currentAnalyticsResult.estimatedHours - 17 / 3600) < 1e-12);
  assert.equal(app.requests.length, 1, 'Identical controls share one model request');
  assert.notEqual(Number(app.get('kpiEnergyVal').textContent), 0, 'Small positive intervals must not display as zero');
  assert.notEqual(parseFloat(app.get('trendTotal').textContent), 0, 'Chart totals retain small positive estimates');
};
tests['each historical target changes its own interval instead of using the latest configured target'] = async () => {
  const app = fixture();
  app.context.rows = [0, 6, 12].map(seconds => ({ ...reading(), intervalSeconds: 5,
    timestamp: new Date(Date.parse('2026-10-04T08:00:00+08:00') + seconds * 1000) }));
  for (const row of app.context.rows) row.controlSnapshot.desired_state.temp = 30;
  app.context.rows[1].controlSnapshot.observed_remote_state.temp = 24;
  app.context.rows[2].controlSnapshot.observed_remote_state.temp = 24;
  await app.run();
  assert(Math.abs(app.context.currentEvaluatedKwh - (2 * 6 + 1 * 11) / 3600) < 1e-12);
  assert.deepEqual(app.requests.map(request => request.settings.setpoint_c).sort(), [21, 24]);
};
tests['duplicate rows do not double count and long gaps stop at the recorded cadence'] = async () => {
  const app = fixture();
  app.context.rows = [0, 0, 6, 60].map(seconds => ({ ...reading(), intervalSeconds: 5,
    timestamp: new Date(Date.parse('2026-10-04T08:00:00+08:00') + seconds * 1000) }));
  await app.run();
  assert(Math.abs(app.context.currentEvaluatedKwh - 2 * 16 / 3600) < 1e-12);
};
tests['missing recorded target never borrows a desired target for automatic prediction'] = async () => {
  const app = fixture(); delete app.context.rows[0].controlSnapshot.observed_remote_state.temp;
  await app.run();
  assert.equal(app.requests.length, 0); assert.equal(app.context.currentEvaluatedKwh, null);
  assert.match(app.context.currentAnalyticsResult.reason, /Temperature setpoint is not recorded/);
};
tests['automatic estimates retain confirmed runtime when physical feedback is available'] = async () => {
  const app = fixture(); app.context.rows[0].acOn = true;
  await app.run();
  assert.equal(app.context.currentEvaluatedKwh, 2);
  assert.equal(app.context.currentAnalyticsResult.forecast, false);
  assert.equal(app.context.currentAnalyticsResult.runtime.totalRuntimeSum, 1);
};
tests['automatic mode still rejects a missing cadence and never reports invented zero'] = async () => {
  const app = fixture(); delete app.context.rows[0].intervalSeconds;
  await app.run();
  assert.equal(app.requests.length, 0); assert.equal(app.context.currentEvaluatedKwh, null);
  assert.match(app.context.currentAnalyticsResult.reason, /sampling interval is missing/);
};
tests['automatic time filters clip the recorded intervals'] = async () => {
  const app = fixture(); app.context.endTimeFilter = '08:30'; await app.run();
  assert.equal(app.context.currentEvaluatedKwh, 1);
  assert.equal(app.context.currentAnalyticsResult.estimatedHours, 0.5);
};
(async () => {
  const failures = [];
  for (const [name, test] of Object.entries(tests)) {
    try { await test(); console.log('PASS ' + name); }
    catch (error) { failures.push({ name, error: error.stack }); console.error('FAIL ' + name + ': ' + error.stack); }
  }
  assert.equal(failures.length, 0, JSON.stringify(failures));
  console.log(`PASS ${Object.keys(tests).length} controls-only client and recorded-interval checks; no live writes or hardware calls.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
