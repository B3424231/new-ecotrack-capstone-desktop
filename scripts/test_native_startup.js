'use strict';
// Actual Electron, temporary profile, local pages only. No live login or database writes.
const path = require('node:path'), fs = require('node:fs'), os = require('node:os');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
if (!process.versions.electron) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ecotrack-native-'));
  const child = spawn(require('electron'), [__filename, '--noerrdialogs'], {
    env: { ...process.env, ECOTRACK_TEST_PROFILE: profile }, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const output = [];
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => output.push(data.toString()));
  const timer = setTimeout(() => { child.kill(); }, 40000);
  child.on('exit', (code, signal) => {
    clearTimeout(timer);
    const dir = path.join(__dirname, '../reports/panel-repairs'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'native-startup.log'), output.join(''));
    console.log(output.join('').slice(-5000));
    console.log(JSON.stringify({ code, signal, profile })); process.exitCode = code || (signal ? 1 : 0);
  });
} else {
  const { app, BrowserWindow, session } = require('electron');
  app.setPath('userData', process.env.ECOTRACK_TEST_PROFILE);
  app.on('browser-window-created', (_event, window) => window.hide());
  app.once('ready', () => session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: /^https?:|^wss?:/i.test(details.url) });
  }));
  require('../src/main.js');
  if (!process.argv.includes('--second-test-instance')) {
    app.whenReady().then(async () => {
      const window = BrowserWindow.getAllWindows()[0];
      assert.ok(window);
      let loads = 0;
      window.webContents.on('did-finish-load', () => loads++);
      if (window.webContents.isLoading()) await new Promise(resolve => window.webContents.once('did-finish-load', resolve));
      assert.match(window.webContents.getURL(), /login\.html$/);
      const preferences = window.webContents.getLastWebPreferences();
      assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false);
      assert.equal(await window.webContents.executeJavaScript('typeof window.electron'), 'object');
      const before = loads;
      const secondEvent = new Promise(resolve => app.once('second-instance', resolve));
      const second = spawn(process.execPath, [__filename, '--second-test-instance', '--noerrdialogs'], {
        env: process.env, windowsHide: true, stdio: 'ignore'
      });
      const exit = new Promise(resolve => second.once('exit', code => resolve(code)));
      await secondEvent; assert.equal(await exit, 0);
      assert.equal(BrowserWindow.getAllWindows().length, 1); assert.equal(loads, before);
      window.hide();
      console.log('PASS: native login renderer, isolated preload, single-instance focus without reload, temporary profile.');
      app.exit(0);
    }).catch(error => { console.error(error); app.exit(1); });
  }
}
