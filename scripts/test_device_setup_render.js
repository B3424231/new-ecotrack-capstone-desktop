// Isolated production-component rendering: no live app session, network, or hardware.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'reports/device-setup-ui');
app.setPath('userData', path.join(root, 'scratch/device-setup-ui-electron'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const css = fs.readFileSync(path.join(root, 'public/styles.css'), 'utf8');
const hardware = fs.readFileSync(path.join(root, 'public/js/hardware-cloud.js'), 'utf8');
const results = [];
function contrast(a, b) {
  const lum = color => {
    const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(n => {
      n /= 255; return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
async function render(theme, width, height) {
  const win = new BrowserWindow({
    width, height, useContentSize: true, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true, partition: 'device-setup-ui-qa' }
  });
  const errors = [];
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3 && !String(message).includes('Content Security Policy')) errors.push(message); });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
  const fixture = '<!doctype html><html class="' + (theme === 'dark' ? 'dark' : '') + '"><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src &apos;none&apos;; style-src &apos;unsafe-inline&apos;">' +
    '<style>' + css + '</style></head><body class="app-shell"></body></html>';
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(fixture));
  await win.webContents.executeJavaScript(
    'window.__qaHandlers = new Map(); window.__qaResponses = []; window.electron = { on: (name, fn) => window.__qaHandlers.set(name, fn), invoke: async (name, data) => { window.__qaResponses.push({name, data}); return {success:true}; }};\n' + hardware
  );
  await win.webContents.executeJavaScript(`
    window.__qaPending = window.__qaHandlers.get('bluetooth-select-request')({}, {
      request_id: 'fixture-select',
      devices: [{ deviceId: 'fixture-controller', deviceName: 'EcoTrack-esp32s3-9cd20604a7ac' }]
    }); true;
  `);
  const metrics = await win.webContents.executeJavaScript(`
    (() => {
      const dialog = document.querySelector('dialog');
      const title = dialog.querySelector('h2'), choice = dialog.querySelector('.ecotrack-bluetooth-dialog__choice');
      const cancel = dialog.querySelector('.ecotrack-bluetooth-dialog__cancel');
      const box = dialog.getBoundingClientRect();
      const style = getComputedStyle(dialog), titleStyle = getComputedStyle(title), choiceStyle = getComputedStyle(choice);
      return {
        viewport: {width:innerWidth, height:innerHeight},
        box: {x:box.x, y:box.y, width:box.width, height:box.height},
        background:style.backgroundColor, titleColor:titleStyle.color,
        choiceBackground:choiceStyle.backgroundColor, choiceColor:choiceStyle.color,
        title:title.textContent, focus:document.activeElement.textContent,
        choiceFits:choice.scrollWidth <= choice.clientWidth,
        cancelSeparate:cancel.parentElement.classList.contains('ecotrack-bluetooth-dialog__footer'),
        labelled:dialog.getAttribute('aria-labelledby') === title.id
      };
    })();
  `);
  metrics.titleContrast = contrast(metrics.titleColor, metrics.background);
  metrics.choiceContrast = contrast(metrics.choiceColor, metrics.choiceBackground);
  assert(Math.abs(metrics.box.x - (metrics.viewport.width - metrics.box.width) / 2) < 2, 'Dialog must center horizontally');
  assert(Math.abs(metrics.box.y - (metrics.viewport.height - metrics.box.height) / 2) < 2, 'Dialog must center vertically');
  assert(metrics.box.width <= width - 30, 'Dialog must fit the viewport');
  assert(metrics.box.height <= height - 30, 'Dialog must fit vertically');
  assert(metrics.titleContrast >= 4.5, 'Title must remain readable');
  assert(metrics.choiceContrast >= 4.5, 'Device name must remain readable');
  assert(metrics.choiceFits && metrics.cancelSeparate && metrics.labelled);
  assert(metrics.focus.startsWith('EcoTrack-'));
  await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const screenshot = path.join(out, 'picker-' + theme + '-' + width + '.png');
  fs.writeFileSync(screenshot, (await win.webContents.capturePage(undefined, {stayHidden:true, stayAwake:true})).toPNG());
  await win.webContents.executeJavaScript("document.querySelector('.ecotrack-bluetooth-dialog__choice').click();");
  const selected = await win.webContents.executeJavaScript('window.__qaPending.then(() => window.__qaResponses[0])');
  assert.equal(selected.data.device_id, 'fixture-controller');
  assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll("dialog").length'), 0);

  // Escape stays within the picker and still sends one cancellation.
  await win.webContents.executeJavaScript(`
    window.__qaParentEscape = false;
    window.addEventListener('keydown', event => { if (event.key === 'Escape') window.__qaParentEscape = true; });
    window.__qaPending = window.__qaHandlers.get('bluetooth-select-request')({}, {
      request_id: 'fixture-cancel', devices: [{deviceId:'fixture-controller',deviceName:'EcoTrack fixture'}]
    });
    const dialog = document.querySelector('dialog');
    dialog.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
    dialog.dispatchEvent(new Event('cancel', {cancelable:true}));
    true;
  `);
  await win.webContents.executeJavaScript('window.__qaPending');
  assert.equal(await win.webContents.executeJavaScript('window.__qaParentEscape'), false);
  assert.equal(await win.webContents.executeJavaScript('window.__qaResponses.at(-1).data.device_id'), null);
  assert.equal(await win.webContents.executeJavaScript('window.__qaResponses.length'), 2);
  assert.equal(errors.length, 0, errors.join('\n'));
  results.push({theme, ...metrics, screenshot, selection_and_cancel_passed:true, errors});
  win.destroy();
}
app.whenReady().then(async () => {
  fs.mkdirSync(out, {recursive:true});
  try {
    await render('light', 1024, 768);
    await render('dark', 1024, 768);
    await render('light', 390, 844);
    await render('dark', 390, 844);
    fs.writeFileSync(path.join(out, 'render-checks.json'), JSON.stringify({passed:results.length, isolated_production_component:true, live_app_tested:false, results}, null, 2));
    console.log('Bluetooth picker rendering: ' + results.length + ' views passed.');
    app.exit(0);
  } catch (error) {
    fs.writeFileSync(path.join(out, 'render-failure.txt'), String(error.stack || error));
    console.error(error);
    app.exit(1);
  }
});
