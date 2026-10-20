'use strict';
// Isolated UI/transport fixtures; never accesses a real account, AC, database or hardware.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require(process.env.ECOTRACK_PLAYWRIGHT || 'playwright');
const root = path.resolve(__dirname, '..'), out = path.resolve(process.env.ECOTRACK_SCHEDULER_REPORT_DIR || path.join(root, 'reports/workspace-modes'));
fs.mkdirSync(out, { recursive: true });
let server, browser;
(async () => {
  server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname), base = name.startsWith('/assets/') ? root : path.join(root, 'public'), file = path.resolve(base, '.' + name);
    if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream'); fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const site = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const errors = [], checks = [];
  for (const mode of ['monitoring', 'both', 'controller']) for (const width of [1460, 390]) for (const theme of ['dark', 'light']) {
    const writes = []; let reads = 0, failRead = false, empty = false;
    const node = { id: 'fixture-controller', name: 'Fixture Controller', monitoring_id: 'fixture-sensor', device_mode: 'both', room_id: 'room', wake_time: '22:00', sleep_time: '06:00', interval_val: 15, interval_unit: 'Seconds' };
    const asset = { id: 'fixture-ac', name: 'Matrix Fixture AC', asset_tag: 'FIXTURE-AC', controller_node_id: node.id, aircon_type: 'Window Type' };
    const sensor = { id: 'fixture-sensor', active: true, name: 'Fixture Sensor', aircon_id: asset.id, aircon_name: asset.name, aircon_type: asset.aircon_type, location: 'Fixture Building · Floor 1 · Room 1', fresh: false, latest: null, sensor_schedule: { wake_time: '22:00', sleep_time: '06:00', interval_seconds: 15 } };
    const registry = { success: true, nodes: [node], aircons: [asset], buildings: [{ id: 'building', name: 'Fixture Building' }], floors: [{ id: 'floor', name: 'Floor 1', building_id: 'building' }], rooms: [{ id: 'room', name: 'Room 1', floor_id: 'floor' }] };
    const ctx = await browser.newContext({ viewport: { width, height: 1000 } });
    await ctx.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith(site + '/api/monitoring/devices')) { reads++; return new Promise(resolve => setTimeout(resolve, 350)).then(() => failRead ? route.fulfill({ status:503, json:{error:'Fixture storage unavailable'} }) : route.fulfill({ json: { items: empty ? [] : [sensor], sync: { enabled: false } } })); }
      if (url.startsWith(site + '/')) return route.continue();
      return route.abort();
    });
    await ctx.routeWebSocket(/.*/, socket => socket.close());
    await ctx.exposeBinding('fixtureInvoke', async (_, channel, input) => {
      if (channel === 'scheduler-fetch-data') { await new Promise(resolve => setTimeout(resolve, 350)); return registry; }
      if (channel === 'monitoring-admin-request') { assert.equal(input.action, 'schedule'); writes.push(input); sensor.sensor_schedule = input.data; return { success: true, data: input.data }; }
      return { success: false, error: 'Isolated fixture' };
    });
    await ctx.addInitScript(({ site, mode, theme, width }) => {
      localStorage.setItem('ecoTrack_workspace_mode', mode); localStorage.setItem('ecoTrackTheme', theme); localStorage.setItem('sidebarCollapsed', String(width < 760));
      localStorage.setItem('ecoTrack_backend_url', site); localStorage.setItem('ecoTrack_supabase_url', 'https://offline-fixture.invalid'); localStorage.setItem('ecoTrack_supabase_anon_key', 'sb_publishable_isolated_fixture');
      window.electron = { env: { BACKEND_URL: site }, invoke: (channel, input) => window.fixtureInvoke(channel, input), on() {} };
      let hardware; window.fixtureState = { node_id: 'fixture-controller', last_seen: new Date().toISOString() }; window.fixtureRequests = [];
      Object.defineProperty(window, 'EcoTrackHardwareCloud', { configurable: true, get: () => hardware, set: api => { hardware = { ...api, listStatus: async () => window.fixtureState ? [window.fixtureState] : [], request: async (id, kind, payload) => { window.fixtureRequests.push({ id, kind, payload }); return { id: 'fixture-command', node_id: id, kind }; }, waitForResult: undefined }; } });
    }, { site, mode, theme, width });
    const page = await ctx.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(site + '/scheduler.html'); await page.locator('#schedulerTableBody .eco-skeleton').first().waitFor(); assert.equal(await page.locator('#schedulerTableBody').getAttribute('aria-busy'),'true'); assert.equal(await page.locator('#schedulerTableBody tr').first().locator('td').count(), mode === 'controller' ? 11 : 8); await page.locator('#schedulerTableBody .apply-schedule-btn').waitFor();
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('main')).opacity) > .99);
    assert.equal(await page.locator('#schedulerTableBody tr').count(), 1, 'One row per AC including Both mode');
    assert((await page.locator('.eco-location-room').first().innerText()).includes('1 AC device node'));
    if (mode === 'both') {
      assert.equal((await page.locator('.sched-device-name').innerText()).trim(), node.name);
      assert.equal(await page.locator('#schedulerTableBody').getByText('Monitoring & Controlling', {exact: true}).count(), 1);
      assert(!/Sensor:/.test(await page.locator('#schedulerTableBody').innerText()), 'One registered ESP32 has one name and one device connection status');
    }
    assert((await page.locator('#schedulerTableBody').innerText()).includes(asset.name));
    assert.equal(await page.locator('a.nav-link[href="scheduler.html"]').count(), 1); assert.equal(await page.locator('a.nav-link[href="sensor-scheduler.html"]').count(), 0);
    const groups = await page.locator('.sidebar-section-header').allTextContents(); assert(groups.indexOf('Sensor Monitoring') < groups.indexOf('Control Center'));
    assert.equal(await page.getByRole('columnheader', { name: 'Target Temp', exact: true }).count(), mode === 'controller' ? 1 : 0);
    assert.equal(await page.locator('select[id^="interval-unit-"] option[value="Seconds"]').count(), mode === 'controller' ? 1 : 0);
    assert.equal(await page.locator('select[id^="interval-unit-"] option[value="Hours"]').count(),1);
    assert.equal(await page.getByRole('columnheader', { name:'AC Device Name', exact:true }).count(),1);
    assert.equal(await page.locator('[id^="sleep-note-"]').count(),0);
    assert.equal(await page.locator('input[id^="interval-val-"]').inputValue(), mode === 'controller' ? '15' : '0.25');
    assert(await page.getByText('Fixture Building', { exact: true }).isVisible()); assert(await page.getByText('Floor 1', { exact: true }).isVisible()); assert(await page.getByText('Room 1', { exact: true }).isVisible());
    const refresh = page.locator('#schedulerRefresh'); assert.equal((await refresh.innerText()).trim(), ''); assert(await refresh.locator('svg').count());
    if (mode !== 'controller') { const before = reads; await refresh.click(); await page.waitForFunction(() => !document.getElementById('schedulerRefresh').disabled); assert(reads > before); }
    if (width === 1460) {
      {
        await page.waitForFunction(() => document.querySelector('[id^="status-"]')?.textContent.trim() === 'Online');
        for (const [state, expected, key] of [[{ last_seen: new Date(Date.now() - 3600000).toISOString() }, 'Offline', 'offline'], [{ sleeping_until: new Date(Date.now() + 3600000).toISOString() }, 'Sleeping', 'sleeping'], [null, 'Not reported', 'unknown']]) {
          await page.evaluate(state => { window.fixtureState = state && { node_id: 'fixture-controller', ...state }; }, state);
          await refresh.click(); await page.waitForFunction(() => !document.getElementById('schedulerRefresh').disabled);
          await page.waitForFunction(expected => document.querySelector('[id^="status-"]')?.textContent.trim() === expected, expected);
          assert.equal(await page.locator('.scheduler-device-state').getAttribute('data-device-state'),key);
          const colors=await page.locator('.scheduler-device-state').evaluate((badge,key)=>{
            const role={offline:'danger',sleeping:'warning',unknown:'muted'}[key],probe=document.createElement('span');probe.style.color='var(--eco-'+role+')';document.body.appendChild(probe);
            const expected=getComputedStyle(probe).color;probe.remove();
            return {expected,text:getComputedStyle(badge.lastElementChild).color,dot:getComputedStyle(badge.firstElementChild).backgroundColor};
          },key);assert.equal(colors.text,colors.expected);assert.equal(colors.dot,colors.expected);
          await page.locator('.scheduler-device-state').screenshot({path:path.join(out,`status-${mode}-${key}-${theme}.png`)});
        }
      }
      await page.locator('select[id^="interval-unit-"]').selectOption('Hours'); await page.locator('input[id^="interval-val-"]').fill('2');
      await refresh.click(); await page.locator('#schedulerTableBody .eco-skeleton').first().waitFor(); await page.locator('#schedulerTableBody .apply-schedule-btn').waitFor(); await page.waitForFunction(() => !document.getElementById('schedulerRefresh').disabled);
      assert.equal(await page.locator('select[id^="interval-unit-"]').inputValue(),'Hours'); assert.equal(await page.locator('input[id^="interval-val-"]').inputValue(),'2');
      await page.locator('.apply-schedule-btn').click(); await page.waitForFunction(() => !!document.querySelector('.apply-schedule-btn') && !document.querySelector('.apply-schedule-btn').disabled);
      if (mode !== 'controller') assert.equal(writes.at(-1).data.interval_seconds,7200);
      const commands = await page.evaluate(() => window.fixtureRequests);
      if (mode !== 'monitoring') { assert.equal(commands.at(-1).kind,'configure'); assert.equal(commands.at(-1).payload.interval_seconds,7200); assert.equal(commands.at(-1).payload.interval_unit,'Hours'); } else assert.equal(commands.length,0);
      assert((await page.locator('.sched-device-name').innerText()).includes(mode === 'monitoring' ? 'Fixture Sensor' : 'Fixture Controller'));
      if (mode === 'both') {
        // A legacy cached display location must never become a building containing placeholder floors.
        registry.rooms=[]; registry.floors=[]; registry.buildings=[]; sensor.location='Room 1 (Fixture Building • Floor 1)'; node.location=sensor.location;
        await refresh.click(); await page.waitForFunction(() => !document.getElementById('schedulerRefresh').disabled);
        const locationText=await page.locator('#roomsList').innerText(); assert(locationText.includes('Fixture Building')&&locationText.includes('Floor 1')&&locationText.includes('Room 1')); assert(!locationText.includes('not recorded')); assert(!locationText.includes('(Fixture Building'));
        const room=page.locator('.eco-location-room').first(); await room.click(); assert.equal(await room.getAttribute('aria-selected'),'true');
        await page.screenshot({path:path.join(out,'location-cabinet-scheduler.png')});
      }
      if (mode === 'monitoring') {
        failRead=true; await refresh.click(); await page.getByText('Failed to Load Schedules',{exact:true}).waitFor(); assert.equal(await page.locator('.eco-skeleton').count(),0);
        failRead=false; await page.getByRole('button',{name:'Retry Loading',exact:true}).click(); await page.locator('#schedulerTableBody .apply-schedule-btn').waitFor();
        assert.equal(await page.locator('select[id^="interval-unit-"]').inputValue(),'Hours');
      }
    }
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) {
      console.log(await page.evaluate(() => ({ root: document.documentElement.scrollWidth, innerWidth, outliers: [...document.querySelectorAll('*')].map(element => ({ tag: element.tagName, id: element.id, classes: String(element.className).slice(0, 90), right: element.getBoundingClientRect().right, width: element.getBoundingClientRect().width })).filter(box => box.right > innerWidth + 1).slice(-15) })));
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${mode} ${width} ${theme} overflow`);
    await page.screenshot({ path: path.join(out, `device-scheduler-${mode}-${width}-${theme}.png`) });
    if(width===1460){
      empty=true;registry.nodes=[];registry.aircons=[];registry.rooms=[];registry.floors=[];registry.buildings=[];
      await page.locator('#schedulerRefresh').click();await page.getByText('No AC Device Schedules Found',{exact:true}).waitFor();
      const name=mode==='monitoring'?'Manage AC Sensor Devices':mode==='both'?'Manage AC Devices':'Manage AC Controllers';
      assert(await page.getByRole('link',{name:name+' →',exact:true}).isVisible());
      if(mode==='monitoring')assert(!/controller/i.test(await page.locator('#schedulerTableBody').innerText()));
      await page.screenshot({path:path.join(out,`scheduler-empty-${mode}-${theme}.png`)});
    }
    checks.push(`${mode} ${width}px ${theme}: single AC, hierarchy, device names, Minutes/Hours, preserved drafts, skeletons/retry, status, canonical/legacy locations and layout`); await ctx.close();
  }
  assert.deepEqual(errors, []); fs.writeFileSync(path.join(out, 'device-scheduler-verification.json'), JSON.stringify({ status: 'PASS', checks, runtime_errors: errors, live_external_requests: 0 }, null, 2)); checks.forEach(check => console.log('PASS ' + check));
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => { await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve()); });
