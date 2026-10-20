const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync('public/nodes.html', 'utf8');
const checks = [];
function section(start, end) {
  const a = html.indexOf(start), b = html.indexOf(end, a);
  assert(a >= 0 && b > a, 'Missing source section: ' + start);
  return html.slice(a, b);
}
const source = [
  section('      // Connection diagnostics and existing Wi-Fi reuse.', '      async function scanForBleDevices()'),
  section('      function selectBleDevice(device)', '      // Wire BLE Discovery'),
  section('      const autoAssignIpBtn =', '      const togglePassBtn ='),
  section('      // Test the real connection before writing credentials', '      // Real-time Wi-Fi Password validation listener'),
  section('      function updateNextButtonState() {', '      // Step navigation event listeners')
].join('\n');
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
const info = overrides => ({
  device_id:'esp32s3-001122334455', cloud_protocol:1, wifi_status:'connected',
  cloud_status:'error', wifi_ssid:'Fixture network', ip_address:'10.0.0.4',
  firmware_version:'fixture-receiver', ...overrides
});
function harness() {
  const elements = new Map(), messages = [], writes = [], timers = new Map();
  let timerId = 0, reads = 0;
  const reply = deferred(), provisioning = deferred();
  function get(id) {
    if (!elements.has(id)) {
      const classes = new Set(), handlers = new Map();
      elements.set(id, {
        value:'', textContent:'', innerHTML:'', className:'', dataset:{}, attributes:{}, disabled:false, required:false,
        classList:{
          contains:name=>classes.has(name),
          add:(...names)=>names.forEach(name=>classes.add(name)),
          remove:(...names)=>names.forEach(name=>classes.delete(name)),
          toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }
        },
        addEventListener(name, callback) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(callback); },
        setAttribute(name, value) { this.attributes[name] = value; },
        focus() { this.focused = true; },
        async fire(name) { for (const callback of handlers.get(name) || []) await callback({target:this}); }
      });
    }
    return elements.get(id);
  }
  get('nodeFormPassword').required = true;
  const window = {
    EcoTrackHardwareCloud:{
      readInfo:() => { reads++; return reply.promise; },
      provision:async payload => { writes.push(payload); return provisioning.promise; },
      resume:async () => null
    },
    EcoToast:{ show:(text, kind)=>messages.push({text, kind}) }
  };
  const context = vm.createContext({
    window, document:{getElementById:get}, console,
    currentModalStep:1, selectedBleDevice:null, wifiConfirmedFor:null,
    discoveredBleDevices:[], scannedWifiNetworks:[], isWifiScanning:true, registrationSaving:false,
    registrationBluetoothLive:false,registrationCheck:null,needsCloudCredentials:()=>true,updateRegistrationSave(){},refreshRegistrationStatus:async()=>{},
    registrationCloudState:'pending', remoteCapture:{register:{busy:false}},
    modal:get('nodeModal'), stepTab1:get('nodeStepTab1'), stepTab2:get('nodeStepTab2'), stepTab3:get('nodeStepTab3'), resetRemoteDetection(){}, updateConfigSummary(){}, renderDiscoveredBleNodes(){}, renderScannedWifiNetworks(){},
    scanWifiNetworks:async()=>{},
    setTimeout(callback, ms) { timers.set(++timerId, {callback, ms}); return timerId; },
    clearTimeout(id) { timers.delete(id); }
  });
  vm.runInContext(source, context);
  const select = supplied => context.selectBleDevice({
    id:'EcoTrack-'+supplied.device_id, nodeId:supplied.device_id, ip:supplied.ip_address||'', info:supplied
  });
  return {context, get, window, reply, provisioning, writes, messages, timers, select, reads:()=>reads};
}
async function main() {
  let app = harness();
  app.context.resetConnectionDiagnostics();
  for (const id of ['chkBle','chkWifi','chkIp']) assert.equal(app.get(id).dataset.state,'pending');
  app.get('nodeFormId').value = 'esp32s3-001122334455';
  app.context.setNodeModalStep(3);
  assert.equal(app.context.currentModalStep,1);
  checks.push('Initial checks are pending and a typed ID cannot bypass actual Bluetooth discovery');

  app = harness();
  app.select(info());
  assert.equal(app.context.currentModalStep,3);
  assert.equal(app.get('nodeFormSsid').value,'Fixture network');
  assert.equal(app.get('nodeFormIp').value,'10.0.0.4');
  assert.equal(app.get('nodeStep3').classList.contains('hidden'),false);
  assert.equal(app.get('nodeFormPassword').required,false);
  assert.equal(app.get('registrationWifiPassword').required,true);
  assert.equal(app.get('existingWifiPanel').classList.contains('hidden'),false);
  assert.match(app.get('existingWifiMessage').textContent,/ESP32 Connected/);
  assert.equal(app.get('existingCloudMessage').textContent,'');
  assert.equal(app.context.registrationCloudState,'pending');
  checks.push('A real connected ESP32 skips to Controller Info while cloud access remains unverified');

  app.get('registrationWifiPassword').value = 'fixture-network-password';
  await app.get('registrationWifiPassword').fire('input');
  assert.equal(app.get('nodeFormPassword').value,'fixture-network-password');
  assert.equal(app.context.registrationCredentials().pass,'fixture-network-password');
  assert.equal(app.context.confirmedWifiReady(),true);
  assert.equal(app.writes.length,0);
  checks.push('Legacy cloud repair collects the password in Controller Info without repeating Wi-Fi setup');

  app = harness();
  app.select(info());
  app.context.setNodeModalStep(2);
  const checking = app.get('verifyWifiBtn').fire('click');
  assert.equal(app.get('verifyWifiBtn').disabled,true);
  assert.equal(app.get('verifyWifiBtn').attributes['aria-busy'],'true');
  assert.equal(app.get('chkBle').dataset.state,'checking');
  assert.equal(app.get('verifyWifiLabel').textContent,'Checking ESP32...');
  assert.equal(app.get('autoAssignIpBtn').disabled,true);
  app.reply.resolve(info());
  await checking;
  assert.equal(app.writes.length,0);
  assert.equal(app.context.currentModalStep,3);
  assert.equal(app.get('verifyWifiLabel').textContent,'Wi-Fi Connected');
  assert.equal(app.get('verifyWifiBtn').disabled,false);
  assert.equal(app.get('autoAssignIpBtn').disabled,false);
  assert.equal(app.get('chkBle').dataset.state,'success');
  assert.equal(app.get('chkWifi').dataset.state,'success');
  checks.push('Test Connection reads an existing connection without rewriting credentials and replaces Connecting with Wi-Fi Connected');

  app = harness();
  const unconfigured = info({wifi_status:'unconfigured',wifi_ssid:'',ip_address:''});
  app.select(unconfigured);
  assert.equal(app.context.currentModalStep,2);
  assert.equal(app.get('nodeNextStepBtn').disabled,true);
  app.get('nodeFormSsid').value='Fixture network';
  app.get('nodeFormPassword').value='fixture-network-password';
  const provisioning = app.get('verifyWifiBtn').fire('click');
  app.reply.resolve(unconfigured);
  for(let n=0;n<8;n++)await Promise.resolve();
  assert.equal(app.writes.length,1);
  assert.equal(app.get('chkWifi').dataset.state,'checking');
  assert.equal(app.get('verifyWifiLabel').textContent,'Connecting Wi-Fi...');
  assert.equal(app.context.currentModalStep,2);
  app.provisioning.resolve(info({cloud_status:'unconfigured'}));
  await provisioning;
  assert.equal(app.context.currentModalStep,3);
  assert.equal(app.get('registrationWifiPassword').value,'fixture-network-password');
  assert.equal(app.context.registrationCloudState,'pending');
  checks.push('Fresh setup still waits for the actual provisioning reply before advancing');

  app = harness();
  app.select(info());
  app.context.setNodeModalStep(2);
  const failed = app.get('verifyWifiBtn').fire('click');
  app.reply.reject(Object.assign(new Error('GATT Error Unknown. Reconnect Bluetooth.'),{code:'BLE_CONNECTION_FAILED'}));
  await failed;
  assert.equal(app.get('verifyWifiLabel').textContent,'Retry Connection');
  assert.equal(app.get('verifyWifiBtn').disabled,false);
  assert.equal(app.get('chkBle').dataset.state,'error');
  assert.equal(app.get('chkWifi').dataset.state,'error');
  assert.equal(app.get('chkIp').dataset.state,'error');
  assert.equal(app.get('nodeFormIp').value,'');
  assert.equal(app.context.confirmedWifiReady(),false);
  assert.match(app.get('chkIpText').textContent,/Reconnect/);
  checks.push('GATT errors show failed checks and Retry instead of green success or a stuck connecting label');

  app = harness();
  app.select(info());
  app.context.setNodeModalStep(2);
  const stale = app.get('verifyWifiBtn').fire('click');
  app.select(info({device_id:'esp32s3-ffeeddccbbaa',wifi_ssid:'Other fixture network',ip_address:'10.0.0.5'}));
  app.reply.resolve(info());
  await stale;
  assert.equal(app.get('nodeFormIp').value,'10.0.0.5');
  assert.equal(app.get('nodeFormSsid').value,'Other fixture network');
  assert.equal(app.get('verifyWifiLabel').textContent,'Test Connection');
  checks.push('An old connection test cannot overwrite the newly selected controller');

  app = harness();
  app.select(info({wifi_status:'unconfigured',wifi_ssid:'',ip_address:''}));
  const readingIp=app.get('autoAssignIpBtn').fire('click');
  app.reply.resolve(info());
  await readingIp;
  assert.equal(app.context.currentModalStep,3);
  assert.equal(app.context.confirmedWifiReady(),true);
  assert.equal(app.context.registrationCloudState,'pending');
  checks.push('A fresh IP read can also recognize completed Wi-Fi and skip to Controller Info');

  app = harness();
  app.window.EcoTrackHardwareCloud.resume=async()=>info();
  await app.context.resumeControllerSetup(0);
  assert.equal(app.context.currentModalStep,3);
  assert.equal(app.context.selectedBleDevice.nodeId,'esp32s3-001122334455');
  assert.equal(app.get('scanBleBtn').disabled,false);
  checks.push('Resuming a previously authorized device skips both completed setup pages');

  app = harness();
  const resumed=deferred();
  app.window.EcoTrackHardwareCloud.resume=()=>resumed.promise;
  const late = app.context.resumeControllerSetup(0);
  vm.runInContext('registrationSessionVersion++;',app.context);
  app.get('nodeModal').classList.add('hidden');
  resumed.resolve(info());
  await late;
  assert.equal(app.context.selectedBleDevice,null);
  assert.equal(app.context.currentModalStep,1);
  checks.push('A resume reply cannot reopen or repopulate a closed registration wizard');

  app = harness();
  app.window.EcoTrackHardwareCloud.resume=()=>new Promise(()=>{});
  const timed = app.context.resumeControllerSetup(0);
  [...app.timers.values()].find(timer=>timer.ms===8000).callback();
  await timed;
  assert.equal(app.context.selectedBleDevice,null);
  assert.equal(app.get('scanBleBtn').disabled,false);
  assert.equal(app.get('scanBleLabel').textContent,'Connect Nearby ESP32');
  checks.push('An unavailable previous device releases the normal Bluetooth picker after a bounded check');

  app = harness();
  app.select(info());
  app.get('nodeFormSsid').value='New fixture network';
  await app.get('nodeFormSsid').fire('input');
  assert.equal(app.context.confirmedWifiReady(),false);
  assert.equal(app.get('nodeFormPassword').required,false);
  assert.equal(app.get('existingWifiPanel').classList.contains('hidden'),true);
  checks.push('Editing the target network invalidates previous Wi-Fi confirmation');

  const out=path.resolve('reports/connection-recovery');
  fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(out,'wizard-tests.json'),JSON.stringify({passed:checks.length,checks,physical_hardware_tested:false,live_supabase_tested:false},null,2));
  console.log('Connection recovery wizard: '+checks.length+' checks passed.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
