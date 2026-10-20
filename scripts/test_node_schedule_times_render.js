// Production schedule component, isolated from hardware and accounts.
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=path.join(root,'reports/node-schedule-times');
app.setPath('userData',path.join(root,'scratch/node-schedule-times-electron'));app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
const read=file=>fs.readFileSync(path.join(root,file),'utf8'),source=read('public/js/scheduler.js');
const slice=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
const logic=slice('function normalizeScheduleTime(','async function loadSchedulerWithSWR(')+slice('function createTableRow(','// Custom Warning Modal');
async function check(theme){
 const win=new BrowserWindow({width:1000,height:590,show:false,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,partition:'node-schedule-times-qa'}});
 win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_d,done)=>done({cancel:true}));
 const page='<!doctype html><html class="'+(theme==='dark'?'dark':'')+'"><head><meta charset="utf-8"><style>'+read('public/styles.css')+'</style><style>.qa{padding:28px;margin:24px;animation:none!important}.qa tr>td:not(:nth-last-child(-n+4)){display:none}table{width:100%;border-collapse:collapse}th{text-align:left;padding:16px;background:#18392b;color:white!important;font-size:12px}#qa-error{padding:12px;color:#b91c1c;font-weight:600}.dark #qa-error{color:#fda4af}h1{font-size:20px;margin-bottom:20px;color:#059669}</style></head><body class="app-shell"><main class="qa"><h1>Controller wake, sleep &amp; reporting schedule</h1><table><thead class="sched-table-header"><tr><th>WAKE TIME</th><th>SLEEP TIME</th><th>SEND INTERVAL</th><th>ACTIONS</th></tr></thead><tbody id="qa-rows"></tbody></table><p id="qa-error" role="alert"></p></main></body></html>';
 await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(page));
 if(fs.existsSync(path.join(root,'scratch/step3-qa-tailwind.js')))await win.webContents.executeJavaScript(read('scratch/step3-qa-tailwind.js')+"\nwindow.tailwind.config={darkMode:'class'};true;");
 await win.webContents.executeJavaScript("let activeTimePickerTargetId=null,activeTimePickerTrigger=null;const savedRooms={},currentRoomNodes=[],scheduleDrafts=new Map(),scheduleDeliveries=new Map();let requests=[];window.EcoToast={error:message=>document.getElementById('qa-error').textContent=message,success(){}};window.EcoTrackHardwareCloud={request:async(...args)=>{requests.push(args);return {id:'fixture-command',node_id:'db-node',status:'queued'};}};function getSchedulerTargetTemperature(){return 'No target set'}function getSchedulerControlMode(){return 'No IR mode'}function getSchedulerPowerMode(){return 'Not recorded'}\n"+logic+"\nconst fixture={id:'test',name:'Fixture controller',ac_name:'Matrix',ac_tag:'AC-test',status:'online',intervalVal:5,intervalUnit:'Seconds',wakeTime:null,sleepTime:null};document.getElementById('qa-rows').innerHTML=createTableRow(fixture);true;");
 const results=await win.webContents.executeJavaScript(`(async()=>{
  const checks=[];function check(ok,message){if(!ok)throw Error(message);checks.push(message);}const get=id=>document.getElementById(id);
  check(get('qa-rows').querySelector('.sched-controller-name').textContent==='Fixture controller','Schedule control name uses the device display name instead of the AC profile');
  get('qa-rows').innerHTML=createTableRow({...fixture,name:'Office <AC>'});
  check(get('qa-rows').querySelector('.sched-controller-name').textContent==='Office <AC>'&&!get('qa-rows').textContent.includes('Matrix'),'Changed controller names render safely without showing the AC profile name');
  get('qa-rows').innerHTML=createTableRow(fixture);
  check(get('wake-display-test').textContent==='Not set'&&get('sleep-display-test').textContent==='Not set','Fresh controllers display unset times accurately');
  check(get('wake-test').value===''&&get('interval-val-test').value==='5','Displayed times agree with the stored input values');
  await applyNodeSchedule('test',get('apply-test'));
  check(requests.length===0&&get('qa-error').textContent.includes('wake time'),'Apply identifies the missing wake field and performs no write');
  ensureTimePickerModal();get('wake-test').value='22:00:00';openTimePicker('wake-test');
  check(get('timePickerHour').value==='10'&&get('timePickerPeriod').value==='PM','Picker preserves a stored 10 PM time instead of proposing 5 AM');
  closeTimePicker();
  get('qa-rows').innerHTML=createTableRow({...fixture,wakeTime:'05:00:00',sleepTime:'22:00:00'});get('qa-error').textContent='';
  check(get('wake-display-test').textContent==='05:00 AM'&&get('sleep-display-test').textContent==='10:00 PM','Stored times including seconds display correctly');
  await applyNodeSchedule('test',get('apply-test'));
  check(requests.length===1&&requests[0][2].wake_time==='05:00'&&requests[0][2].sleep_time==='22:00'&&requests[0][2].interval_seconds===5,'Apply queues the shown 5-second schedule using the hardware time format');
  check(get('apply-test').textContent==='Queued'&&!get('apply-test').disabled,'Queue success keeps delivery status honest and releases the button');
  get('sleep-test').value='05:00';updateNodeSleepNote('test');
  check(get('sleep-note-test').textContent.includes('keep this controller awake'),'Equal times explain the device will stay awake');
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const wakeTop=get('wake-test').previousElementSibling.getBoundingClientRect().top,sleepTop=get('sleep-test').previousElementSibling.getBoundingClientRect().top;
  check(Math.abs(wakeTop-sleepTop)<1,'Wake and sleep controls stay aligned when the sleep explanation is visible');
  scheduleDeliveries.clear();
  get('qa-rows').innerHTML=createTableRow({...fixture,wakeTime:null,sleepTime:null});get('qa-error').textContent='Choose a valid wake time before applying this controller schedule.';
  return checks;
 })()`);
 await win.webContents.executeJavaScript("getElement=document.getElementById.bind(document);getElement('qa-rows').innerHTML=createTableRow({...fixture,wakeTime:'05:00',sleepTime:'05:00'});getElement('qa-error').textContent='';document.getAnimations().forEach(animation=>animation.finish());new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));");
 fs.writeFileSync(path.join(out,'equal-times-'+theme+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
 await win.webContents.executeJavaScript("getElement('qa-rows').innerHTML=createTableRow({...fixture,wakeTime:null,sleepTime:null});getElement('qa-error').textContent='Choose a valid wake time before applying this controller schedule.';document.getAnimations().forEach(animation=>animation.finish());new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));");
 fs.writeFileSync(path.join(out,'unset-times-'+theme+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());win.destroy();return {theme,checks:results};
}
app.whenReady().then(async()=>{fs.mkdirSync(out,{recursive:true});try{const results=[await check('light'),await check('dark')];fs.writeFileSync(path.join(out,'native-ui-tests.json'),JSON.stringify({passed:results.reduce((n,r)=>n+r.checks.length,0),results,live_hardware_tested:false,live_database_tested:false},null,2));app.exit(0);}catch(error){fs.writeFileSync(path.join(out,'native-ui-failure.txt'),error.stack);app.exit(1);}});
