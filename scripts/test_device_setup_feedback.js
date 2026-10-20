const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const checks = [];
const html = fs.readFileSync('public/nodes.html', 'utf8');
function section(start, end) {
  const a = html.indexOf(start), b = html.indexOf(end, a);
  assert(a >= 0 && b > a);
  return html.slice(a, b);
}
const diagnosticSource = section('      function setConnectionCheck(', '      function resetConnectionDiagnostics()') + section('      function hasConnectedWifi(', '      function canReuseExistingWifi()');
const ipSource = section('      const autoAssignIpBtn =', '      const togglePassBtn =');
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function element() {
  const classes = new Set(), handlers = new Map();
  return {
    value: '', textContent: '', disabled: false, dataset: {}, attributes: {},
    classList: {
      add: name => classes.add(name), remove: name => classes.delete(name),
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
      contains: name => classes.has(name)
    },
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(name, handler) { handlers.set(name, handler); },
    click: () => handlers.get('click')?.()
  };
}
function ipHarness() {
  const elements = new Map(), messages = [], timers = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const reply = deferred();
  let reads = 0, timerId = 0;
  const context = vm.createContext({
    document: { getElementById: get },
    selectedBleDevice: { nodeId: 'esp32s3-001122334455' },
    window: {
      EcoTrackHardwareCloud: { readInfo: () => { reads++; return reply.promise; } },
      EcoToast: { show: (text, kind) => messages.push({ text, kind }) }
    },
    updateConfigSummary() {},
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); }
  });
  vm.runInContext(diagnosticSource + ipSource, context);
  return { context, get, reply, messages, timers, reads: () => reads, click: () => get('autoAssignIpBtn').click() };
}
const info = (overrides = {}) => ({ device_id: 'esp32s3-001122334455', wifi_status: 'connected', ip_address: '192.168.1.66', ...overrides });
const profileSource = fs.readFileSync('public/js/profile.js', 'utf8').split("document.addEventListener('DOMContentLoaded'")[0];
function profileHarness({ allowed = true, fail = false, cached = false, role = 'Administrator' } = {}) {
  const elements = new Map(), calls = [];
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const window = { supabaseClient: {
    async rpc(name) {
      calls.push(name);
      if (name === 'ecotrack_my_profile') return { data: { id: 'fixture-user', name: 'Fixture admin', role, userType: 'admin' }, error: null };
      if (fail) throw new Error('Network unavailable');
      return { data: allowed, error: null };
    }
  } };
  if (cached) window.EcoDataBus = { query: async () => ({ id: 'fixture-user', username: 'Cached admin', role }) };
  const context = vm.createContext({
    window, console, document: { getElementById: get },
    localStorage: { getItem: name => name === 'ecoTrack_profile_user' ? JSON.stringify({ role: 'admin' }) : null }
  });
  vm.runInContext(profileSource, context);
  return { context, get, calls };
}
async function main() {
  let app = ipHarness();
  const pending = app.click();
  assert.equal(app.get('autoAssignIpBtn').disabled, true);
  assert.equal(app.get('autoAssignIpBtn').attributes['aria-busy'], 'true');
  assert.equal(app.get('autoAssignIpLabel').textContent, 'Reading...');
  assert.equal(app.get('autoAssignIpIcon').classList.contains('is-reading'), true);
  assert.equal(app.get('deviceIpFeedback').dataset.state, 'reading');
  await app.click();
  assert.equal(app.reads(), 1);
  assert(!app.messages.some(message => message.kind === 'success'));
  app.reply.resolve(info());
  await pending;
  assert.equal(app.get('nodeFormIp').value, '192.168.1.66');
  assert.equal(app.get('step3IpBadge').textContent, '192.168.1.66');
  assert.equal(app.get('deviceIpFeedback').dataset.state, 'success');
  assert.match(app.get('deviceIpFeedback').textContent, /ESP32 replied/);
  assert.equal(app.get('autoAssignIpBtn').disabled, false);
  assert.equal(app.get('autoAssignIpBtn').attributes['aria-busy'], 'false');
  assert.equal(app.get('autoAssignIpIcon').classList.contains('is-reading'), false);
  assert.equal(app.timers.size, 0);
  checks.push('A click shows busy feedback, blocks duplicates, and confirms only the actual device reply');

  app = ipHarness();
  app.get('nodeFormIp').value = 'stale address';
  const rejected = app.click();
  app.reply.reject(new Error('Reconnect the nearby ESP32 through Bluetooth.'));
  await rejected;
  assert.equal(app.get('nodeFormIp').value, '');
  assert.equal(app.get('deviceIpFeedback').dataset.state, 'error');
  assert.match(app.get('deviceIpFeedback').textContent, /Reconnect/);
  assert.equal(app.get('autoAssignIpBtn').disabled, false);
  assert(!app.messages.some(message => message.kind === 'success'));
  checks.push('A Bluetooth failure clears the stale address and shows an actionable error');

  for (const overrides of [{ wifi_status: 'disconnected' }, { ip_address: '0.0.0.0' }, { ip_address: '999.1.2.3' }, { ip_address: '' }]) {
    app = ipHarness();
    const result = app.click();
    app.reply.resolve(info(overrides));
    await result;
    assert.equal(app.get('deviceIpFeedback').dataset.state, 'warning');
    assert.equal(app.get('nodeFormIp').value, '');
    assert(!app.messages.some(message => message.kind === 'success'));
  }
  checks.push('Disconnected Wi-Fi, empty, zero, and invalid addresses cannot report success');

  app = ipHarness();
  const wrongDevice = app.click();
  app.reply.resolve(info({ device_id: 'esp32s3-ffeeddccbbaa' }));
  await wrongDevice;
  assert.equal(app.get('deviceIpFeedback').dataset.state, 'error');
  assert.match(app.get('deviceIpFeedback').textContent, /Wrong Bluetooth device/);
  checks.push('A reply from a different controller cannot update this setup');

  app = ipHarness();
  const timed = app.click();
  [...app.timers.values()][0]();
  await timed;
  assert.match(app.get('deviceIpFeedback').textContent, /did not reply/);
  assert.equal(app.get('autoAssignIpBtn').disabled, false);
  checks.push('A missing reply times out visibly and releases the retry button');

  app = ipHarness();
  const stale = app.click();
  vm.runInContext('resetDeviceIpFeedback(); selectedBleDevice = { nodeId: "esp32s3-ffeeddccbbaa" };', app.context);
  app.reply.resolve(info());
  await stale;
  assert.equal(app.get('nodeFormIp').value, '');
  assert.equal(app.get('deviceIpFeedback').dataset.state, 'idle');
  assert.equal(app.messages.length, 0);
  checks.push('Resetting or changing the controller invalidates late replies');

  app = ipHarness();
  app.context.selectedBleDevice = null;
  await app.click();
  assert.equal(app.reads(), 0);
  assert.match(app.get('deviceIpFeedback').textContent, /Bluetooth first/);
  checks.push('Reading without a selected controller gives feedback without contacting hardware');

  for (const role of ['admin', 'Admin', 'Administrator', 'SYSTEM_ADMINISTRATOR', 'Custom administrator title']) {
    const profile = profileHarness({ role });
    await profile.context.loadProfileWithSWR();
    assert.equal(profile.get('profile-permissions').textContent, 'Full Access');
    assert.equal(profile.get('profile-role-text').textContent, 'Administrator');
    assert.equal(profile.get('profile-role-badge').textContent, 'System Administrator');
    assert(profile.calls.includes('ecotrack_is_admin'));
  }
  checks.push('Supabase-verified admins show Full Access regardless of role spelling');

  let profile = profileHarness({ allowed: false, cached: true });
  await profile.context.loadProfileWithSWR();
  assert.equal(profile.get('profile-permissions').textContent, 'Limited Access');
  assert.deepEqual(profile.calls, ['ecotrack_is_admin']);
  checks.push('A cached admin label cannot override an authenticated denial');

  profile = profileHarness({ allowed: true, cached: true });
  await profile.context.loadProfileWithSWR();
  assert.equal(profile.get('profile-permissions').textContent, 'Full Access');
  assert.deepEqual(profile.calls, ['ecotrack_is_admin']);
  checks.push('Cached profile loads still check actual admin access');

  profile = profileHarness({ fail: true });
  await profile.context.loadProfileWithSWR();
  assert.equal(profile.get('profile-permissions').textContent, 'Access unverified');
  checks.push('An unavailable permission check does not falsely claim access');

  const out = path.resolve('reports/device-setup-ui');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'feedback-tests.json'), JSON.stringify({ passed: checks.length, checks, live_hardware_tested: false, live_supabase_permissions_tested: false }, null, 2));
  console.log('Device setup and profile feedback: ' + checks.length + ' checks passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
