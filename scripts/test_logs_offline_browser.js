'use strict';
// Actual Daily Logs page + real local model + disposable SQLite. Every external connection is intercepted.
// Set ECOTRACK_PLAYWRIGHT to the installed Playwright module path when it is not on NODE_PATH.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.ECOTRACK_PLAYWRIGHT || 'playwright');
const root = path.resolve(__dirname, '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ecotrack-logs-offline-'));
const out = process.env.ECOTRACK_LOGS_QA_OUT || path.join(root, 'reports/logs-offline');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const state = { power: true, temp: 24, mode: 'cool', fan: 'medium', eco: false, turbo: false,
  quiet: false, swing_vertical: false, swing_horizontal: false, display: true };
const settings = { setpoint_c: 24, operating_mode: 'cool', fan_command: 'medium', eco: false, turbo: false,
  quiet: false, swing: false, horizontal_swing: false, display: true };
let backend, web, browser;
async function port() {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const value = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return value;
}
async function waitFor(test, label) {
  for (let i = 0; i < 250; i++) {
    try { if (await test()) return; } catch (_) {}
    await delay(100);
  }
  throw new Error('Timed out: ' + label);
}
async function main() {
  fs.mkdirSync(out, { recursive: true });
  const apiPort = await port(), api = 'http://127.0.0.1:' + apiPort;
  backend = spawn(path.join(root, 'venv/Scripts/python.exe'), ['-c',
    'import sys;sys.path.insert(0,sys.argv[1]);from backend.app import app;app.run(host="127.0.0.1",port=int(sys.argv[2]),use_reloader=False)', root, String(apiPort)],
  { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, ECOTRACK_SQLITE_DB_PATH: path.join(sandbox, 'telemetry.db'), ECOTRACK_TELEMETRY_SYNC: '0' } });
  let backendError = '';
  backend.stderr.on('data', chunk => { backendError = (backendError + chunk).slice(-1200); });
  await waitFor(async () => {
    if (backend.exitCode !== null) throw new Error(backendError);
    return (await fetch(api + '/api/telemetry?perPage=1')).ok;
  }, 'private Flask backend');
  let expected;
  const records = ['2026-10-18T04:00:00Z', '2026-10-18T07:00:00Z', '2026-10-17T04:00:00Z'].map((created, i) => ({
    id: 'offline-fixture-' + i, node_id: 'fixture-database-id', sensor_name: 'Fixture controller',
    control_name: 'Fixture controller', room_name: 'Fixture room', floor_name: 'Fixture floor', building_name: 'Fixture building',
    created, interval_seconds: 1800, status: 'online', ac_on: null, temperature: null,
    control_snapshot: { observed_remote_state: state, observed_remote_at: created }
  }));
  const inserted = await fetch(api + '/api/telemetry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(records) });
  assert.equal(inserted.status, 201);
  const publicRoot = path.join(root, 'public');
  web = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/baseline.html') {
      const html = fs.readFileSync(path.join(publicRoot, 'logs.html'), 'utf8')
        .replace('./vendor/tailwindcss.js', 'https://cdn.tailwindcss.com');
      res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); return;
    }
    const file = path.resolve(publicRoot, '.' + pathname);
    if (!file.startsWith(publicRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); res.end(); return;
    }
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png' };
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
  const site = 'http://127.0.0.1:' + web.address().port;
  browser = await chromium.launch({ executablePath: process.env.ECOTRACK_QA_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const evidence = { baseline: null, scenarios: [], external_requests_fulfilled: 0, production_database_accessed: false };
  async function contextFor({ width = 1540, theme = 'dark', offline = false, cached = false, unavailable = false } = {}) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, timezoneId: 'Asia/Singapore' });
    const held = [], requests = [], errors = [];
    await context.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith(site + '/') || (!unavailable && url.startsWith(api + '/'))) {
        requests.push({ path: new URL(url).pathname, method: route.request().method() });
        return route.continue();
      }
      if (url.startsWith(api + '/')) return route.abort();
      held.push(new URL(url).origin);
      return new Promise(() => {}); // Blackhole internet traffic; do not depend on immediate failure.
    });
    await context.routeWebSocket(/.*/, socket => socket.close());
    await context.addInitScript(({ api, offline, theme, cached }) => {
      Object.defineProperty(navigator, 'onLine', { get: () => !offline });
      localStorage.setItem('ecoTrackTheme', theme);
      localStorage.setItem('ecoTrack_backend_url', api);
      localStorage.setItem('ecoTrack_supabase_url', 'https://offline.example.invalid');
      localStorage.setItem('ecoTrack_supabase_anon_key', 'sb_publishable_isolated_fixture');
      localStorage.setItem('ecoTrack_tariff_rate', '13.24');
      window.electron = { env: { BACKEND_URL: api }, invoke: channel => {
        if (channel === 'scheduler-fetch-data') {
          window.__cloudMetadataPending = true;
          return new Promise(() => {});
        }
        return Promise.resolve({ success: false });
      }, on() {} };
      if (cached) {
        const key = 'ecoTrack_logs_metadata:' + JSON.stringify(['https://offline.example.invalid', api, '']);
        localStorage.setItem(key, JSON.stringify({ rooms: [], floors: [], buildings: [],
          nodes: [{ id: 'fixture-database-id', name: 'Fixture controller', interval_seconds: 1800 }] }));
      }
      window.__offlineTiming = { start: performance.now(), analyticsMs: null };
      const observer = new MutationObserver(() => {
        const value = document.getElementById('kpiEnergyVal')?.textContent;
        if (value && /^\d/.test(value.trim()) && window.__offlineTiming.analyticsMs === null) {
          window.__offlineTiming.analyticsMs = performance.now() - window.__offlineTiming.start;
        }
      });
      observer.observe(document, { childList: true, subtree: true, characterData: true });
    }, { api, offline, theme, cached });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    return { context, page, held, requests, errors };
  }
  const baseline = await contextFor();
  await baseline.page.goto(site + '/baseline.html', { waitUntil: 'commit' });
  await delay(600);
  evidence.baseline = await baseline.page.evaluate(() => ({ readyState: document.readyState,
    cardsParsed: !!document.getElementById('kpiEnergyVal') }));
  assert.equal(evidence.baseline.readyState, 'loading');
  assert.equal(evidence.baseline.cardsParsed, false);
  assert(baseline.held.includes('https://cdn.tailwindcss.com'));
  await baseline.context.close();
  console.log('PASS reproduced: a stalled CDN script prevents the old page from reaching its local analytics');

  for (const config of [{ name: 'stalled-internet-desktop', width: 1540, theme: 'dark' },
    { name: 'offline-mobile', width: 390, theme: 'light', offline: true },
    { name: 'offline-cached-restart', width: 1540, theme: 'dark', offline: true, cached: true }]) {
    const test = await contextFor(config);
    await test.page.goto(site + '/logs.html', { waitUntil: 'domcontentloaded', timeout: 10000 });
    await test.page.waitForFunction(() => typeof currentEvaluatedKwh === 'number' && !energyPredictionPending, null, { timeout: 10000 });
    const result = await test.page.evaluate(() => ({ kwh: currentEvaluatedKwh, cost: currentEvaluatedCost,
      forecast: currentAnalyticsResult.forecast, estimatedHours: currentAnalyticsResult.estimatedHours,
      measuredRuntime: currentAnalyticsResult.runtime.totalRuntimeSum, rows: nodeDataLogs.length,
      energyPoints: energyTrendChartInstance.data.datasets[0].data.filter(Number.isFinite).length,
      costPoints: estimatedCostChartInstance.data.datasets[0].data.filter(Number.isFinite).length,
      dualPoints: dualAxisChartInstance.data.datasets[0].data.filter(Number.isFinite).length,
      timing: window.__offlineTiming.analyticsMs, chartVersion: Chart.version,
      exportsAvailable: !!(window.jspdf?.jsPDF && window.ExcelJS?.Workbook),
      removedBox: !document.getElementById('analyticsDataStatus'),
      cloudMetadataPending: !!window.__cloudMetadataPending }));
    if (expected === undefined) {
      // Query the expected value after the first render so its timing includes a cold model load.
      const prediction = await fetch(api + '/api/predict-recorded-energy', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'hist_gradient_boosting', settings }) });
      assert(prediction.ok);
      expected = (await prediction.json()).kwh;
    }
    assert(Math.abs(result.kwh - expected) < 1e-10, JSON.stringify(result));
    assert(Math.abs(result.cost - expected * 13.24) < 1e-10);
    assert.equal(result.estimatedHours, 1);
    assert.equal(result.measuredRuntime, 0, 'Forecasts must not create physical AC-on evidence');
    assert.equal(result.rows, 3);
    assert(result.forecast && result.energyPoints > 0 && result.costPoints > 0 && result.dualPoints > 0);
    assert(result.exportsAvailable && result.removedBox);
    assert(Number.isFinite(result.timing));
    if (!config.offline) assert(result.cloudMetadataPending, 'Local analytics must finish while cloud IPC remains unanswered');
    assert.deepEqual(test.errors, []);
    assert(!test.held.some(url => /cdn|fonts\./.test(url)), 'No chart, style or font CDN should be requested');
    await test.page.screenshot({ path: path.join(out, config.name + '.png'), fullPage: true });
    await test.page.selectOption('#nodeFilter', 'Fixture controller');
    await test.page.waitForFunction(() => !energyPredictionPending);
    assert(Math.abs(await test.page.evaluate(() => currentEvaluatedKwh) - expected) < 1e-10);
    await test.page.reload({ waitUntil: 'domcontentloaded' });
    await test.page.waitForFunction(() => Number.isFinite(currentEvaluatedKwh) && !energyPredictionPending);
    assert(Math.abs(await test.page.evaluate(() => currentEvaluatedKwh) - expected) < 1e-10);
    assert.deepEqual(test.errors, []);
    evidence.scenarios.push({ name: config.name, ...result, blockedExternalOrigins: [...new Set(test.held)] });
    console.log('PASS ' + config.name + ': ' + Math.round(result.timing) + 'ms, matching local model values, all three charts, filters and reload');
    await test.context.close();
  }
  const unavailable = await contextFor({ offline: true, unavailable: true });
  await unavailable.page.goto(site + '/logs.html', { waitUntil: 'domcontentloaded' });
  await unavailable.page.waitForFunction(() => document.getElementById('kpiEnergyVal').textContent === 'Unavailable');
  assert.equal(await unavailable.page.evaluate(() => currentEvaluatedKwh), null);
  assert.deepEqual(unavailable.errors, []);
  evidence.backend_unavailable = 'PASS: unavailable remains null; no fabricated or cached energy total';
  await unavailable.context.close();
  const stored = await (await fetch(api + '/api/telemetry?perPage=0')).json();
  assert.equal(stored.items.length, 3);
  assert(stored.items.every(row => row.ac_on == null && row.temperature == null));
  fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log('PASS backend-down state and unchanged isolated telemetry; no external requests were fulfilled');
}
async function close() {
  await browser?.close();
  if (web) await new Promise(resolve => web.close(resolve));
  backend?.kill();
}
main().then(close).catch(async error => { console.error(error); await close(); process.exitCode = 1; });
