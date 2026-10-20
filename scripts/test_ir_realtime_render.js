'use strict';
// Hidden native Chromium fixture: production engine + dashboard card updater, mocked read-only Supabase.
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=path.join(root,'reports/ir-latency');
const read=f=>fs.readFileSync(path.join(root,f),'utf8'),html=read('public/dashboard.html');
const slice=(a,b)=>html.slice(html.indexOf(a),html.indexOf(b,html.indexOf(a)));
const control=read('public/control.html');
const controls=control.slice(control.indexOf('        // Fan Speed Rendering'),control.indexOf('        // Right Panel Updates'));
const cardLogic=slice('      function updateSingleCardDom(','      function wireCardListeners(')+slice('      function getDashboardPowerState(','      function renderDashboard(');
app.setPath('userData',path.join(root,'scratch/ir-realtime-electron'));app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:920,height:700,show:false,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,partition:'ir-realtime-qa'}});
 win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_d,done)=>done({cancel:true}));
 try{
  fs.mkdirSync(out,{recursive:true});
  const fixturePath=path.join(root,'scratch/ir-realtime-fixture.html');
  fs.writeFileSync(fixturePath,"<!doctype html><html><head><meta charset=\"utf-8\"><link rel=\"stylesheet\" href=\"../public/styles.css\"><style>main{max-width:820px;margin:24px auto;padding:20px}section{padding:22px;margin:18px 0;border-radius:20px}h1{font-size:24px;font-weight:700}h3{font-size:18px;font-weight:700}label{display:block;font-size:13px;font-weight:600;margin:20px 0 10px}#fanButtonsGroup{display:grid;gap:10px}#specialButtonsGroup{display:flex;gap:10px;flex-wrap:wrap}</style></head><body class=\"app-shell bg-[#070b19] text-gray-200\"><main><h1>AC remote controls</h1><p>Current settings received through Supabase</p><section class=\"glass-card\"><h3>TCL112AC</h3><label>BLOWER FAN SPEED</label><div id=\"fanButtonsGroup\"></div><label>SPECIAL FUNCTIONS (SUPPORTED ONLY)</label><div id=\"specialButtonsGroup\"></div></section><section class=\"glass-card\" id=\"card\"><h3>Receiver fixture</h3><p>TCL · Split Type</p><button class=\"power-toggle-btn\" aria-label=\"Power\"></button><p>Target: <b class=\"target-temp-val\"></b> °C · <span class=\"ac-status-badge\"></span></p><p>Mode: <b class=\"ac-mode-val\"></b> · Fan: <b class=\"ac-fan-val\"></b> · Swing: <b class=\"ac-swing-val\"></b></p><p>Protocol: <b class=\"ac-proto-val\"></b></p><span class=\"ac-node-status-dot\"></span><span class=\"ac-node-status-text\"></span></section></main></body></html>");
  await win.loadFile(fixturePath);
  if(fs.existsSync(path.join(root,'scratch/step3-qa-tailwind.js')))await win.webContents.executeJavaScript(read('scratch/step3-qa-tailwind.js')+"\nwindow.tailwind.config={darkMode:'class'};true;");
  await win.webContents.executeJavaScript(`
   const started=Date.now();
   window.capabilityManifest={power:true,temperature:true,min_temp:16,max_temp:31,modes:['cool','dry','fan','auto','heat'],fans:['low','medium','high','auto','quiet'],swing:true,turbo:true,eco:true,sleep:false,timer:false};
   window.requestLog=[];window.fixtureReadCount=0;window.fixtureChannels={};
   window.fixtureDb={
    nodes:[{id:'n1',name:'esp32s3-001122334455',status:'online',room_id:null}],
    aircons:[{id:'ac1',asset_tag:'AC-Fixture',node_id:'n1',controller_node_id:'n1',brand:'TCL',model:'Split Type',protocol:'generic_ac'}],
    rooms:[],floors:[],buildings:[],
    states:[{node_id:'n1',device_id:'esp32s3-001122334455',last_seen:new Date().toISOString(),capabilities:{ir_receiver:true,ir_transmitter:true},
     latest_ir:{protocol:'TCL112AC',raw_count:20,raw_data:'3500,1750,450',sequence:1,received_at:new Date(started-1000).toISOString(),state:{power:true,temp:25,mode:'auto',fan:'high',turbo:false,swing:false,eco:false},ac_capabilities:capabilityManifest}}]
   };
   window.supabaseClient={
    auth:{getSession:async()=>({data:{session:{user:{id:'fixture-admin'}}}})},
    from(table){fixtureReadCount++;const q={select(){return q;},order(){return q;},eq(){return q;},maybeSingle:async()=>({data:structuredClone(fixtureDb[table]?.[0]||null),error:null}),then(resolve,reject){return Promise.resolve({data:structuredClone(fixtureDb[table]||[]),error:null}).then(resolve,reject);}};return q;},
    channel(name,options){const q={handlers:[],on(event,filter,callback){q.handlers.push({event,filter,callback});return q;},subscribe(){fixtureChannels[name]=q;return q;}};return q;}
   };
   window.EcoTrackHardwareCloud={listStatus:async()=>{fixtureReadCount++;return structuredClone(fixtureDb.states).map(s=>({...s,connection_status:'online'}));},describe:()=> 'online',control:async(_node,intent)=>{requestLog.push(structuredClone(intent));return {command_id:'fixture-command',commanded_at:new Date().toISOString(),command_status:'queued'};}};
   true;
  `);
  await win.webContents.executeJavaScript(read('public/js/aircon-system.js'));
  await win.webContents.executeJavaScript(cardLogic+`
   function executeCommand(command,value){window.pendingCommand=EcoTrackAirconSystem.CommandManager.dispatch({device_id:'AC-Fixture',command,value});}
   window.repaintFixture=()=>{
    const ac=EcoTrackAirconSystem.AirconProfileManager.getById('AC-Fixture');
    if(!ac)return;
    const device=ac,CapabilityEngine=EcoTrackAirconSystem.CapabilityEngine,caps=CapabilityEngine.getCapabilities(ac),state=ac.state,isPowerOn=state.power===true;
    const fanButtonsGroup=document.getElementById('fanButtonsGroup'),specialButtonsGroup=document.getElementById('specialButtonsGroup');
    ${controls}
    if(ac)updateSingleCardDom(document.getElementById('card'),ac,EcoTrackAirconSystem.NodeService.getNode(ac.node_id));
   };
   EcoTrackAirconSystem.AirconEvents.on('devices:synced',repaintFixture);EcoTrackAirconSystem.AirconEvents.on('hardware:updated',repaintFixture);
   repaintFixture();
   true;
  `);

  const results=await win.webContents.executeJavaScript(`
   (async()=>{
    const checks=[],timings=[],turbo=()=>[...document.querySelectorAll('#specialButtonsGroup button')].find(b=>b.textContent==='Turbo');
    const end=Date.now()+7000;while(!turbo()){if(Date.now()>end)throw Error('Initial fixture sync did not complete');await new Promise(resolve=>setTimeout(resolve,25));}
    window.fixtureReadCount=0;window.frameSequence=1;
    window.deliverRemote=(state,broadcast=false)=>{
     const captureTime=Date.now()+20*(++frameSequence);
     const row={...structuredClone(fixtureDb.states[0]),last_seen:new Date(captureTime).toISOString(),
      latest_ir:{protocol:'TCL112AC',boot_count:5,sequence:frameSequence,frame_kind:'full_state',raw_count:227,captured_at_epoch_ms:captureTime,
       received_at:new Date(captureTime).toISOString(),state:{source:'ir_receiver',...state},ac_capabilities:capabilityManifest}};
     fixtureDb.states[0]=structuredClone(row);
     const channel=fixtureChannels[broadcast?'ecotrack:hardware':'realtime_aircon_nodes'];
     const handler=channel.handlers.find(h=>broadcast?h.filter.event==='device_state':h.filter.table==='ecotrack_device_state');
     const began=performance.now();
     handler.callback(broadcast?{payload:{version:1,row}}:{eventType:'UPDATE',new:row});
     return performance.now()-began;
    };
    const elapsed=deliverRemote({power:true,temp:22,mode:'dry',fan:'high',turbo:true,swing:true,eco:false});
    if(turbo().getAttribute('aria-pressed')!=='true')throw Error('Turbo was not activated immediately');
    if(document.querySelector('.ac-status-badge').textContent.trim()!=='ON')throw Error('Remote ON was not shown immediately');
    if(document.querySelector('.target-temp-val').textContent!=='22')throw Error('Received temperature did not update');
    if(document.querySelector('.ac-mode-val').textContent!=='DRY'||!document.querySelector('.ac-fan-val').textContent.includes('TURBO'))throw Error('Received mode/fan/Turbo mismatch');
    if(document.querySelector('.ac-swing-val').textContent!=='ON')throw Error('Received swing mismatch');
    if(fixtureReadCount!==0)throw Error('Hardware event caused another database fetch');
    timings.push({event:'Postgres ON',mock_event_to_dom_ms:elapsed});
    checks.push('Production dashboard and controls update received power, temperature, mode, fan, Turbo and Swing synchronously from a compact Postgres event.');
    checks.push('Fast Postgres rendering uses zero additional database queries.');
    return {checks,timings,passed:checks.length};
   })()
  `);
  await win.webContents.executeJavaScript("document.documentElement.classList.add('dark');document.getAnimations().forEach(a=>a.finish());new Promise(resolve=>setTimeout(resolve,300));");
  fs.writeFileSync(path.join(out,'received-on.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
  const off=await win.webContents.executeJavaScript(`
   (()=>{
    const elapsed=deliverRemote({power:false,temp:24,mode:'fan',fan:'low',turbo:false,swing:false,eco:false},true);
    const turbo=[...document.querySelectorAll('#specialButtonsGroup button')].find(b=>b.textContent==='Turbo');
    if(document.querySelector('.ac-status-badge').textContent.trim()!=='OFF')throw Error('Broadcast OFF was not shown immediately');
    if(document.querySelector('.target-temp-val').textContent!=='24'||document.querySelector('.ac-mode-val').textContent!=='FAN'||document.querySelector('.ac-fan-val').textContent!=='LOW')throw Error('Broadcast settings did not update');
    if(turbo.getAttribute('aria-pressed')!=='false')throw Error('Turbo was not cleared');
    if(document.querySelector('.power-toggle-btn').getAttribute('data-current-power')!=='0')throw Error('Power toggle still shows ON');
    if(fixtureReadCount!==0)throw Error('Broadcast caused a database fetch');
    return {elapsed,overflow:document.documentElement.scrollWidth>innerWidth};
   })()
  `);
  assert.equal(off.overflow,false);
  results.timings.push({event:'Broadcast OFF',mock_event_to_dom_ms:off.elapsed});
  results.checks.push('Private Broadcast immediately renders actual Remote OFF, temperature, mode, Low fan and Turbo OFF without a fetch or page reload.');
  results.checks.push('The native Chromium fixture remains free of horizontal overflow.');
  results.passed+=2;
  await win.webContents.executeJavaScript("document.getAnimations().forEach(a=>a.finish());new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));");
  fs.writeFileSync(path.join(out,'received-off.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
  fs.writeFileSync(path.join(out,'native-realtime-tests.json'),JSON.stringify({...results,live_database_modified:false,physical_hardware_tested:false,timing_scope:'Mock Realtime callback to synchronous DOM updates; excludes hardware and network'},null,2)+'\n');
  console.log('Native IR Realtime: '+results.passed+' checks passed; mocked event-to-DOM timings: '+results.timings.map(t=>t.mock_event_to_dom_ms.toFixed(1)+' ms').join(', '));
  win.destroy();app.exit(0);
 }catch(error){fs.writeFileSync(path.join(out,'native-realtime-failure.txt'),error.stack);console.error(error);win.destroy();app.exit(1);}
});
