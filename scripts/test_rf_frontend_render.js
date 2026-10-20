'use strict';
// Isolated browser fixtures + a real RF service on a private port and a temporary database.
const { chromium } = require('playwright');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), net = require('node:net');
const { spawn } = require('node:child_process'), { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..'), read = file => fs.readFileSync(path.join(root, file), 'utf8');
const out = path.join(root, 'reports/panel-repairs/prediction-browser');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ecotrack-rf-browser-'));
let server, browser;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(test, label) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await test()) return;
    await delay(100);
  }
  throw new Error('Timed out: ' + label);
}
async function privatePort() {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}
function fixtureHtml(file, theme) {
  let html = read(file).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  html = html.replace('<head>', '<head><base href="' + pathToFileURL(path.join(root, 'public/')).href + '">');
  html = html.replace('<html lang="en">', '<html lang="en" class="' + (theme === 'dark' ? 'dark' : '') + '">');
  return html;
}
async function page(file, width, theme, url, requests) {
  const fixture = path.join(sandbox, path.basename(file, '.html') + '-' + width + '-' + theme + '.html');
  fs.writeFileSync(fixture, fixtureHtml(file, theme));
  const context = await browser.newContext({ viewport: { width, height: 1000 } });
  const tab = await context.newPage();
  await tab.route('**/*', route => {
    const request = route.request(), requestUrl = request.url();
    if (!/^https?:/.test(requestUrl)) return route.continue();
    const allowed = requestUrl.startsWith(url + '/api/prediction-') || requestUrl === url + '/api/predict-energy';
    if (allowed) requests.push({ url: requestUrl, method: request.method() });
    return allowed ? route.continue() : route.abort();
  });
  await tab.goto(pathToFileURL(fixture).href);
  const win = { evaluate: code => tab.evaluate(code), script: code => tab.addScriptTag({ content: code }),
    screenshot: options => tab.screenshot(options), destroy: () => context.close() };
  await win.script(read('scratch/step3-qa-tailwind.js') + '\nwindow.tailwind.config={darkMode:"class"};true;');
  await win.script('window.ECOTRACK_CONFIG={backendUrl:' + JSON.stringify(url) + '};true;');
  await win.script(read('public/js/energy-prediction.js'));
  return win;
}
async function snapshot(win, name) {
  await win.evaluate('document.getAnimations().forEach(a=>{if(a.effect.getComputedTiming().iterations!==Infinity)a.finish()});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await win.screenshot({ path: path.join(out, name + '.png') });
}
async function main() {
  fs.mkdirSync(out, { recursive: true });
  browser = await chromium.launch({ executablePath: process.env.ECOTRACK_QA_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const port = await privatePort(), url = 'http://127.0.0.1:' + port;
  const serviceFile = path.join(sandbox, 'service.py');
  fs.writeFileSync(serviceFile, 'import sys\nsys.path.insert(0, ' + JSON.stringify(path.join(root, 'backend')) + ')\nfrom app import app\napp.run(host="127.0.0.1", port=' + port + ', use_reloader=False)\n');
  server = spawn(path.join(root, 'venv/Scripts/python.exe'), [serviceFile], { cwd: root, windowsHide: true,
    env: { ...process.env, ECOTRACK_SQLITE_DB_PATH: path.join(sandbox, 'telemetry.db'), ECOTRACK_TELEMETRY_SYNC: '0' },
    stdio: ['ignore', 'ignore', 'pipe'] });
  let serverErrors = ''; server.stderr.on('data', data => { serverErrors = (serverErrors + data).slice(-1000); });
  await waitFor(async () => { try { return (await fetch(url + '/api/prediction-features')).ok; } catch (_) { return false; } }, 'private RF backend');
  const requests = [], results = [];
  const source = read('public/js/logs.js');
  const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  for (const [width, theme] of [[1460, 'light'], [390, 'dark']]) {
    const win = await page('public/logs.html', width, theme, url, requests);
    await win.script(read('public/js/aircon-state.js'));
    await win.script(`
      let currentPeriod='daily',currentNodeFilter='',selectedDateKey='2026-10-04',startTimeFilter='',endTimeFilter='';
      let currentEvaluatedKwh=null,currentEvaluatedCost=null,currentAnalyticsResult=null;
      const globalNodeRecords=[],controlNameMap={},nodeDataLogs=[];
      const fixtureLogs=[{nodeId:'qa',timestamp:new Date('2026-10-04T06:00:00+08:00'),acOn:true,intervalSeconds:3600,temperature:null,controlSnapshot:{reported_state:{power:true,temp:24,fan:'medium',mode:'cool',eco:false,turbo:false,swing_vertical:true,quiet:false,swing_horizontal:false,display:true},reported_at:'2026-10-04T06:00:00+08:00'}}];
      function getFilteredLogs(){return fixtureLogs;}function calculateStats(){return {totalRecords:fixtureLogs.length};}
      function getPreviousPeriodDateKey(){return '2026-10-03';}function getDefaultDateKey(){return '2026-10-04';}
      function getPeriodDateKey(value){return new Date(value).toISOString().slice(0,10);}
      function getAirconFleetCount(){return {total:1};}function getActiveTariffRate(){return 10;}
      function updateAnalyticsCharts(){}function updateKpiCardsTrends(){}
    ` + section('function calculateEnergyCost(', 'function saveTariffSettings(') +
      section('function getConfirmedAcOnState(', '// Helper: Calculate previous period') +
      section('let currentPredictionSession', '// Convert 24-hour') + '\npredictEnergyConsumption(calculateStats(getFilteredLogs()),getFilteredLogs());true;');
    await waitFor(() => win.evaluate('!energyPredictionPending'), 'unknown environmental inputs finish');
    assert.equal(await win.evaluate('document.getElementById("energyPredictionOptions")'), null);
    assert.equal(await win.evaluate('currentEvaluatedKwh'), null);
    assert((await win.evaluate('document.getElementById("analyticsDataStatus").textContent')).includes('Environmental inputs'));
    // Explicit known scenario in an isolated fixture; never a production default.
    await win.evaluate('selectedEnergyScenario="lab_hot";predictEnergyConsumption(calculateStats(getFilteredLogs()),getFilteredLogs());true;');
    await waitFor(() => win.evaluate('Number.isFinite(currentEvaluatedKwh)'), 'logs real RF estimate');
    const result = await win.evaluate('({kwh:currentEvaluatedKwh,status:document.getElementById("analyticsDataStatus").textContent,label:document.getElementById("kpiEnergyLabel").textContent,estimatedHours:currentAnalyticsResult.estimatedHours})');
    assert(result.kwh > 0); assert.equal(result.estimatedHours, 1); assert(result.status.includes('Estimated')); assert.equal(result.label, 'ESTIMATED ENERGY');
    await snapshot(win, 'logs-' + theme + '-' + width);
    await win.evaluate('delete fixtureLogs[0].controlSnapshot.reported_state.eco;predictEnergyConsumption({},fixtureLogs);true;');
    await waitFor(() => win.evaluate('currentEvaluatedKwh===null'), 'missing Eco is unavailable');
    assert((await win.evaluate('document.getElementById("analyticsDataStatus").textContent')).includes('Eco'));
    results.push({ page: 'logs', width, theme, result, missing_flag_rejected: true });
    await win.destroy();
  }
  assert(requests.some(request => request.url.endsWith('/api/predict-energy')));
  assert(requests.every(request => !request.url.includes('xgboost')));
  fs.writeFileSync(path.join(out, 'browser-results.json'), JSON.stringify({ passed: results.length, results,
    retired_prediction_page: true, requests, live_hardware_tested: false, live_cloud_writes: false }, null, 2));
  console.log('RF frontend browser checks passed: ' + results.length + ' isolated page/theme/viewport scenarios.');
}
main().then(async () => { server?.kill(); await browser?.close(); }).catch(async error => {
  console.error(error); server?.kill(); await browser?.close(); process.exitCode = 1;
});
