'use strict';
// Real Electron file renderer and real preload; no production profile or database.
const path = require('node:path'), fs = require('node:fs'), os = require('node:os');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  (async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecotrack-monitor-native-'));
    const net = require('node:net'), listener = net.createServer();
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
    const api = 'http://127.0.0.1:' + port;
    const env = { ...process.env, ECOTRACK_SQLITE_DB_PATH: path.join(temp, 'telemetry.db'),
      ECOTRACK_TELEMETRY_SYNC: '0', ECOTRACK_MONITOR_SYNC: '0', BACKEND_URL: api, ECOTRACK_MONITOR_NATIVE_PROFILE: temp };
    const server = spawn(path.join(root, 'venv/Scripts/python.exe'), ['-c',
      'from backend.app import app;import sys;app.run(host="127.0.0.1",port=int(sys.argv[1]),use_reloader=False)', String(port)],
    { cwd: root, windowsHide: true, env, stdio: 'ignore' });
    try {
      let ready = false;
      for (let i = 0; i < 200; i++) {
        try { ready = (await fetch(api + '/api/monitoring/devices')).ok; } catch (_) {}
        if (ready) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert(ready, 'Temporary monitoring backend did not start');
      const child = spawn(require('electron'), [__filename, '--noerrdialogs'], { cwd: root, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
      const timer = setTimeout(() => child.kill(), 45000);
      const code = await new Promise(resolve => child.once('exit', (code, signal) => resolve(signal ? 1 : code)));
      clearTimeout(timer);
      fs.mkdirSync(path.join(root, 'reports/ac-monitoring'), { recursive: true });
      fs.writeFileSync(path.join(root, 'reports/ac-monitoring/native-startup.log'), output);
      console.log(output.slice(-1800));
      assert.equal(code, 0, 'Native monitoring renderer failed');
    } finally { server.kill(); }
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
} else {
  const { app, BrowserWindow, session, ipcMain } = require('electron');
  app.setPath('userData', process.env.ECOTRACK_MONITOR_NATIVE_PROFILE);
  ipcMain.handle('auth-set-session', () => ({ success: false }));
  ipcMain.handle('monitoring-sync-registry', () => ({ success: false, error: 'Isolated native fixture' }));
  ipcMain.handle('monitoring-fetch-assets', () => ({ success: false, error: 'Sign in as an administrator' }));
  ipcMain.handle('monitoring-admin-request', () => ({ success: false, error: 'Administrator required' }));
  ipcMain.handle('notifications-fetch-all', () => ({ success: true, data: [] }));
  ipcMain.handle('maintenance-fetch-reports', () => ({ success: true, data: [] }));
  ipcMain.handle('scheduler-fetch-data', () => ({ success: true, nodes: [], aircons: [], rooms: [], floors: [], buildings: [] }));
  app.whenReady().then(async () => {
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({
      cancel: /^(https?|wss?):/.test(details.url) && !details.url.startsWith(process.env.BACKEND_URL + '/')
    }));
    const window = new BrowserWindow({ show: false, width: 1460, height: 1000,
      webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(root, 'src/preload.js') } });
    const failures = [];
    window.webContents.on('console-message', event => { if (event.level === 'error' && /Uncaught|TypeError|ReferenceError/.test(event.message)) failures.push(event.message); });
    for (const file of ['analytics.html', 'telemetry.html', 'sensor-scheduler.html', 'sensor-logs.html']) {
      await window.loadFile(path.join(root, 'public', file));
      let state;
      for (let i = 0; i < 100; i++) {
        state = await window.webContents.executeJavaScript(`({ status:document.getElementById('sensorConnection')?.textContent,
          mode:document.body.dataset.sensorPage, error:document.getElementById('sensorError')?.textContent,
          bridge:typeof window.electron?.invoke, isolated:typeof require==='undefined', sidebar:!!document.getElementById('sidebar') })`);
        if (state.status === 'Local backend connected' && state.sidebar) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(state.status, 'Local backend connected', state.error);
      assert(state.mode); assert(state.isolated && state.sidebar);
      assert.equal(state.bridge, 'function');
      console.log('PASS native file renderer: ' + file);
    }
    await window.loadFile(path.join(root, 'public/profile.html'));
    const profile = await window.webContents.executeJavaScript(`(async () => {
      document.getElementById('tabBtnDeviceMode').click();
      await EcoTrackMode.setMode('monitoring');
      return { tab:document.getElementById('tabBtnDeviceMode').getAttribute('aria-selected'),
        panel:!document.getElementById('panelDeviceMode').classList.contains('hidden'),
        mode:EcoTrackMode.mode, settings:!!document.querySelector('a[href="settings.html"]'),
        isolated:typeof require==='undefined', bridge:typeof window.electron?.invoke };
    })()`);
    assert.equal(profile.tab, 'true'); assert(profile.panel && profile.isolated);
    assert.equal(profile.mode, 'monitoring'); assert.equal(profile.settings, false); assert.equal(profile.bridge, 'function');
    console.log('PASS native Admin Profile Device Mode, preparation and isolated preload');
    assert.deepEqual(failures, []);
    window.destroy(); app.exit(0);
  }).catch(error => { console.error(error.message); app.exit(1); });
}
