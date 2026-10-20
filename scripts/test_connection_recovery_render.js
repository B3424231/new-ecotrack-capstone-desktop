// Native Chromium form/diagnostic check using production markup, helpers, and CSS.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=path.join(root,'reports/connection-recovery');
app.setPath('userData',path.join(root,'scratch/connection-recovery-electron'));
app.disableHardwareAcceleration();
app.on('window-all-closed',()=>{});
const html=fs.readFileSync(path.join(root,'public/nodes.html'),'utf8');
const css=fs.readFileSync(path.join(root,'public/styles.css'),'utf8');
const slice=(start,end)=>{const a=html.indexOf(start),b=html.indexOf(end,a);assert(a>=0&&b>a);return html.slice(a,b);};
const helpers=slice('      // Connection diagnostics and existing Wi-Fi reuse.','      async function scanForBleDevices()');
const passwordListener=slice("      document.getElementById('registrationWifiPassword')?.addEventListener", '      // Real-time Wi-Fi Password validation listener');
const input=id=>{const match=html.match(new RegExp('<input\\b[^>]*id="'+id+'"[^>]*>'));assert(match);return match[0];};
const panel=slice('          <div id="existingWifiPanel"','          <!-- Hidden Device ID field');
const diagnostics=slice('          <!-- Wi-Fi Verification Checklist Card -->','        <!-- STEP 3: CONTROLLER INFO');
async function check(theme){
 const win=new BrowserWindow({width:900,height:850,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false,partition:'connection-recovery-qa'}});
 win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>callback({cancel:true}));
 const page='<!doctype html><html class="'+(theme==='dark'?'dark':'')+'"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src &apos;none&apos;; style-src &apos;unsafe-inline&apos;"><style>'+css+'</style><style>.hidden{display:none!important}.qa-card{margin:40px auto;padding:24px;max-width:620px;}#existingWifiPanel{padding:20px;border:1px solid #14b8a6;border-radius:12px;}#existingWifiPanel p,#existingWifiPanel label{margin-bottom:12px;display:block;}#registrationWifiPassword{width:100%;padding:10px;}</style></head><body class="app-shell"><div class="qa-card"><form id="qa-form"><div class="hidden">'+input('nodeFormSsid')+input('nodeFormPassword')+'</div>'+panel+'</form>'+diagnostics+'</div></body></html>';
 await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(page));
 await win.webContents.executeJavaScript(`
  let currentModalStep=3,registrationBluetoothLive=true;
  function needsCloudCredentials(){return true;} function updateRegistrationSave(){}
  let selectedBleDevice={nodeId:'esp32s3-001122334455'};
  let wifiConfirmedFor='Fixture network';
  document.getElementById('nodeFormSsid').value='Fixture network';
  ${helpers}
  ${passwordListener}
  existingWifiInfo={device_id:selectedBleDevice.nodeId,wifi_status:'connected',wifi_ssid:'Fixture network',ip_address:'10.0.0.4',cloud_status:'error'};
  refreshExistingWifiPanel();
  setConnectionCheck('chkBle','pending','Bluetooth connection has not been checked');
  true;
 `);
 const before=await win.webContents.executeJavaScript(`({
  valid:document.getElementById('qa-form').checkValidity(),
  invalid:[...document.querySelectorAll('input:invalid')].map(input=>input.id),
  hiddenPasswordRequired:document.getElementById('nodeFormPassword').required,
  recoveryRequired:document.getElementById('registrationWifiPassword').required,
  recoveryVisible:getComputedStyle(document.getElementById('existingWifiPanel')).display!=='none',
  pendingColor:getComputedStyle(document.getElementById('chkBle')).backgroundColor
 })`);
 assert.equal(before.valid,false);
 assert.deepEqual(before.invalid,['registrationWifiPassword']);
 assert.equal(before.hiddenPasswordRequired,false);
 assert.equal(before.recoveryRequired,true);
 assert.equal(before.recoveryVisible,true);
 const after=await win.webContents.executeJavaScript(`
  document.getElementById('registrationWifiPassword').value='fixture-network-password';
  document.getElementById('registrationWifiPassword').dispatchEvent(new Event('input',{bubbles:true}));
  setConnectionCheck('chkBle','success','Bluetooth connection verified with the selected ESP32');
  setConnectionCheck('chkWifi','success','ESP32 confirmed its existing Wi-Fi connection');
  ({
   valid:document.getElementById('qa-form').checkValidity(),
   invalid:[...document.querySelectorAll('input:invalid')].map(input=>input.id),
   passwordCopied:document.getElementById('nodeFormPassword').value===document.getElementById('registrationWifiPassword').value,
   successColor:getComputedStyle(document.getElementById('chkBle')).backgroundColor,
   statusText:document.getElementById('chkWifiText').textContent
  });
 `);
 assert.equal(after.valid,true);
 assert.deepEqual(after.invalid,[]);
 assert.equal(after.passwordCopied,true);
 assert.notEqual(before.pendingColor,after.successColor);
 win.destroy();
 return {theme,before,after};
}
app.whenReady().then(async()=>{
 fs.mkdirSync(out,{recursive:true});
 try{
  const results=[await check('light'),await check('dark')];
  fs.writeFileSync(path.join(out,'native-form-checks.json'),JSON.stringify({passed:results.length,isolated_production_component:true,live_hardware_tested:false,results},null,2));
  console.log('Native form validation: '+results.length+' themes passed.');
  app.exit(0);
 }catch(error){fs.writeFileSync(path.join(out,'native-form-failure.txt'),String(error.stack||error));console.error(error);app.exit(1);}
});
