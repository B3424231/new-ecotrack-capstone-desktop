'use strict';
// Hidden native Chromium fixture: production engine + dashboard card updater, mocked read-only Supabase.
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=path.join(root,'reports/remote-power');
const read=f=>fs.readFileSync(path.join(root,f),'utf8'),html=read('public/dashboard.html');
const slice=(a,b)=>html.slice(html.indexOf(a),html.indexOf(b,html.indexOf(a)));
const cardLogic=slice('      function updateSingleCardDom(','      function wireCardListeners(')+slice('      function getDashboardPowerState(','      function renderDashboard(');
app.setPath('userData',path.join(root,'scratch/live-power-electron'));app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:760,height:560,show:false,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,partition:'live-power-qa'}});
 win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_d,done)=>done({cancel:true}));
 try{
  fs.mkdirSync(out,{recursive:true});
  const fixturePath=path.join(root,'scratch/live-power-fixture.html');
  fs.writeFileSync(fixturePath,'<!doctype html><html><head><meta charset="utf-8"><style>'+read('public/styles.css')+'</style><style>body{padding:42px!important}#card{width:100%;min-height:260px}h1{font-size:24px!important;margin-bottom:12px!important}h3{font-size:22px!important}p{margin-top:8px!important}.qa-note{font-size:12px;color:#64748b;margin:12px 0 24px}.target-temp-val{font-size:42px!important}button{padding:10px}main{animation:none!important}</style></head><body class="app-shell bg-gray-50 dark:bg-[#0a0f1d] text-slate-800 dark:text-slate-100"><main><h1>Live remote monitoring</h1><div class="qa-note">Isolated UI verification • Supabase responses are fixtures</div><section id="card"><div style="display:flex;justify-content:space-between"><h3></h3><button class="power-toggle-btn" aria-label="Power">Power</button></div><p></p><div style="display:flex;align-items:center;justify-content:space-between;margin:24px 0"><span><b class="target-temp-val"></b> °C target</span><span class="ac-status-badge"></span></div><p>Mode: <b class="ac-mode-val"></b> · Fan: <b class="ac-fan-val"></b> · Swing: <b class="ac-swing-val"></b></p><p>Protocol: <b class="ac-proto-val"></b></p><span class="ac-node-status-dot"></span><span class="ac-node-status-text"></span></section></main></body></html>');
  await win.loadFile(fixturePath);
  if(fs.existsSync(path.join(root,'scratch/step3-qa-tailwind.js')))await win.webContents.executeJavaScript(read('scratch/step3-qa-tailwind.js')+"\nwindow.tailwind.config={darkMode:'class'};true;");
  await win.webContents.executeJavaScript(`
   const started=Date.now();
   window.fixtureDb={
    nodes:[{id:'n1',name:'esp32s3-001122334455',status:'online',room_id:null}],
    aircons:[{id:'ac1',asset_tag:'AC-Fixture',node_id:'n1',controller_node_id:'n1',brand:'TCL',model:'Split Type',protocol:'TCL112AC'}],
    rooms:[],floors:[],buildings:[],
    states:[{node_id:'n1',device_id:'esp32s3-001122334455',last_seen:new Date().toISOString(),capabilities:{ir_receiver:true,ir_transmitter:true},
     latest_ir:{protocol:'TCL112AC',raw_count:20,raw_data:'3500,1750,450',sequence:1,received_at:new Date(started-1000).toISOString(),state:{power:true,temp:24,mode:'cool',fan:'auto'}}}]
   };
   window.supabaseClient={
    auth:{getSession:async()=>({data:{session:{user:{id:'fixture-admin'}}}})},
    from(table){const q={select(){return q;},order(){return q;},then(resolve,reject){return Promise.resolve({data:structuredClone(fixtureDb[table]||[]),error:null}).then(resolve,reject);}};return q;},
    channel(){const q={on(){return q;},subscribe(){return q;}};return q;}
   };
   window.EcoTrackHardwareCloud={listStatus:async()=>structuredClone(fixtureDb.states).map(s=>({...s,connection_status:'online'})),describe:()=> 'online'};
   true;
  `);
  await win.webContents.executeJavaScript(read('public/js/aircon-system.js'));
  await win.webContents.executeJavaScript(cardLogic+`
   window.repaintFixture=()=>{
    const ac=EcoTrackAirconSystem.AirconProfileManager.getById('AC-Fixture');
    if(ac)updateSingleCardDom(document.getElementById('card'),ac,EcoTrackAirconSystem.NodeService.getNode(ac.node_id));
   };
   EcoTrackAirconSystem.AirconEvents.on('devices:synced',repaintFixture);
   repaintFixture();
   true;
  `);
  const results=await win.webContents.executeJavaScript(`(async()=>{
   const checks=[],label=()=>document.querySelector('.ac-status-badge').textContent;
   async function until(fn){const stop=Date.now()+7000;while(!fn()){if(Date.now()>stop)throw Error('Timed out waiting for automatic UI update');await new Promise(resolve=>setTimeout(resolve,25));}}
   await until(()=>label().includes('Remote ON'));checks.push('Initial cloud ON renders in the native dashboard card.');
   fixtureDb.states[0].latest_ir={protocol:'TCL112AC',raw_count:20,raw_data:'3500,1750,450',sequence:2,received_at:new Date().toISOString(),state:{power:false,temp:25,mode:'dry',fan:'low'}};
   const offStarted=Date.now();await until(()=>label().includes('Remote OFF'));
   const elapsed=Date.now()-offStarted;
   if(document.querySelector('.power-toggle-btn').dataset.currentPower!=='0')throw Error('Toggle did not follow remote OFF');
   if(document.querySelector('.target-temp-val').textContent!=='25')throw Error('Setpoint did not update automatically');
   if(document.querySelector('.ac-mode-val').textContent!=='DRY'||document.querySelector('.ac-fan-val').textContent!=='LOW')throw Error('Mode/fan did not update automatically');
   checks.push('OFF, setpoint, mode, fan and toggle change automatically with real-time events absent.');
   if(elapsed>6500)throw Error('Fallback update exceeded its five-second interval allowance');
   checks.push('Native fallback renders within one five-second refresh interval plus processing time.');
   return {checks,elapsed_ms:elapsed,passed:checks.length};
  })()`);
  for(const theme of ['light','dark']){
   await win.webContents.executeJavaScript("document.documentElement.classList.toggle('dark',"+(theme==='dark')+");document.getAnimations().forEach(a=>a.finish());new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));");
   const bodyColor=await win.webContents.executeJavaScript("new Promise(resolve=>setTimeout(()=>resolve(getComputedStyle(document.body).backgroundColor),150));");
   assert.equal(bodyColor,theme==='dark'?'rgb(7, 11, 25)':'rgb(248, 250, 252)');
   results.checks.push(theme+' fixture uses the production shell theme.');results.passed++;
   fs.writeFileSync(path.join(out,'live-off-'+theme+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
  }
  fs.writeFileSync(path.join(out,'native-live-tests.json'),JSON.stringify({...results,live_database_modified:false,physical_hardware_tested:false},null,2)+'\n');
  win.destroy();app.exit(0);
 }catch(error){fs.writeFileSync(path.join(out,'native-live-failure.txt'),error.stack);win.destroy();app.exit(1);}
});
