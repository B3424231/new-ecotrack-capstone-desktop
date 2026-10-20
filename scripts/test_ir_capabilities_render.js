'use strict';
// Hidden native Chromium fixture: production engine + dashboard card updater, mocked read-only Supabase.
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=path.join(root,'reports/tcl-turbo');
const read=f=>fs.readFileSync(path.join(root,f),'utf8'),html=read('public/dashboard.html');
const slice=(a,b)=>html.slice(html.indexOf(a),html.indexOf(b,html.indexOf(a)));
const control=read('public/control.html');
const controls=control.slice(control.indexOf('        // Fan Speed Rendering'),control.indexOf('        // Right Panel Updates'));
const cardLogic=slice('      function updateSingleCardDom(','      function wireCardListeners(')+slice('      function getDashboardPowerState(','      function renderDashboard(');
app.setPath('userData',path.join(root,'scratch/ir-capabilities-electron'));app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:920,height:700,show:false,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,partition:'ir-capabilities-qa'}});
 win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_d,done)=>done({cancel:true}));
 try{
  fs.mkdirSync(out,{recursive:true});
  const fixturePath=path.join(root,'scratch/live-power-fixture.html');
  fs.writeFileSync(fixturePath,"<!doctype html><html><head><meta charset=\"utf-8\"><link rel=\"stylesheet\" href=\"../public/styles.css\"><style>main{max-width:820px;margin:24px auto;padding:20px}section{padding:22px;margin:18px 0;border-radius:20px}h1{font-size:24px;font-weight:700}h3{font-size:18px;font-weight:700}label{display:block;font-size:13px;font-weight:600;margin:20px 0 10px}#fanButtonsGroup{display:grid;gap:10px}#specialButtonsGroup{display:flex;gap:10px;flex-wrap:wrap}</style></head><body class=\"app-shell bg-[#070b19] text-gray-200\"><main><h1>AC remote controls</h1><p>Current settings received through Supabase</p><section class=\"glass-card\"><h3>TCL112AC</h3><label>BLOWER FAN SPEED</label><div id=\"fanButtonsGroup\"></div><label>SPECIAL FUNCTIONS (SUPPORTED ONLY)</label><div id=\"specialButtonsGroup\"></div></section><section class=\"glass-card\" id=\"card\"><h3>Receiver fixture</h3><p>TCL · Split Type</p><button class=\"power-toggle-btn\" aria-label=\"Power\"></button><p>Target: <b class=\"target-temp-val\"></b> °C · <span class=\"ac-status-badge\"></span></p><p>Mode: <b class=\"ac-mode-val\"></b> · Fan: <b class=\"ac-fan-val\"></b> · Swing: <b class=\"ac-swing-val\"></b></p><p>Protocol: <b class=\"ac-proto-val\"></b></p><span class=\"ac-node-status-dot\"></span><span class=\"ac-node-status-text\"></span></section></main></body></html>");
  await win.loadFile(fixturePath);
  if(fs.existsSync(path.join(root,'scratch/step3-qa-tailwind.js')))await win.webContents.executeJavaScript(read('scratch/step3-qa-tailwind.js')+"\nwindow.tailwind.config={darkMode:'class'};true;");
  await win.webContents.executeJavaScript(`
   const started=Date.now();
   window.capabilityManifest={power:true,temperature:true,min_temp:16,max_temp:31,modes:['cool','dry','fan','auto','heat'],fans:['low','medium','high','auto','quiet'],swing:true,turbo:true,eco:true,sleep:false,timer:false};
   window.requestLog=[];
   window.fixtureDb={
    nodes:[{id:'n1',name:'esp32s3-001122334455',status:'online',room_id:null}],
    aircons:[{id:'ac1',asset_tag:'AC-Fixture',node_id:'n1',controller_node_id:'n1',brand:'TCL',model:'Split Type',protocol:'generic_ac'}],
    rooms:[],floors:[],buildings:[],
    states:[{node_id:'n1',device_id:'esp32s3-001122334455',last_seen:new Date().toISOString(),capabilities:{ir_receiver:true,ir_transmitter:true},
     latest_ir:{protocol:'TCL112AC',raw_count:20,raw_data:'3500,1750,450',sequence:1,received_at:new Date(started-1000).toISOString(),state:{power:true,temp:25,mode:'auto',fan:'high',turbo:false,swing:false,eco:false},ac_capabilities:capabilityManifest}}]
   };
   window.supabaseClient={
    auth:{getSession:async()=>({data:{session:{user:{id:'fixture-admin'}}}})},
    from(table){const q={select(){return q;},order(){return q;},eq(){return q;},maybeSingle:async()=>({data:structuredClone(fixtureDb[table]?.[0]||null),error:null}),then(resolve,reject){return Promise.resolve({data:structuredClone(fixtureDb[table]||[]),error:null}).then(resolve,reject);}};return q;},
    channel(){const q={on(){return q;},subscribe(){return q;}};return q;}
   };
   window.EcoTrackHardwareCloud={listStatus:async()=>structuredClone(fixtureDb.states).map(s=>({...s,connection_status:'online'})),describe:()=> 'online',control:async(_node,intent)=>{requestLog.push(structuredClone(intent));return {command_id:'fixture-command',commanded_at:new Date().toISOString(),command_status:'queued'};}};
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
   EcoTrackAirconSystem.AirconEvents.on('devices:synced',repaintFixture);
   repaintFixture();
   true;
  `);
  const results=await win.webContents.executeJavaScript("(async()=>{\n const checks=[],turbo=()=>[...document.querySelectorAll('#specialButtonsGroup button')].find(b=>b.textContent==='Turbo');\n async function until(fn){const end=Date.now()+7000;while(!fn()){if(Date.now()>end)throw Error('Timed out waiting for automatic receiver update');await new Promise(resolve=>setTimeout(resolve,25));}}\n await until(()=>turbo()?.dataset.currentState==='off');\n if(document.querySelector('.ac-fan-val').textContent!=='HIGH')throw Error('High fan is mislabeled Turbo');\n if([...document.querySelectorAll('#fanButtonsGroup button')].some(b=>b.textContent==='turbo'))throw Error('Turbo appears as a normal TCL fan speed');\n checks.push('Production controls show supported Turbo separately from High fan, initially OFF.');\n if([...document.querySelectorAll('#specialButtonsGroup button')].some(b=>['Sleep','Timer'].includes(b.textContent)))throw Error('Unsupported receiver controls rendered');\n checks.push('Unsupported special functions are excluded by the receiver manifest.');\n turbo().click();await pendingCommand;\n if(requestLog.at(-1)?.protocol!=='TCL112AC'||requestLog.at(-1)?.state.turbo!=='on')throw Error('Native Turbo button did not dispatch detected protocol and flag');\n checks.push('Native Turbo button uses the shared command engine and a separate Turbo flag.');\n fixtureDb.states[0].latest_ir={protocol:'TCL112AC',sequence:2,frame_kind:'full_state',raw_count:227,raw_data:'3000,1650,500',received_at:new Date().toISOString(),state:{power:true,temp:25,mode:'auto',fan:'high',turbo:true,swing:true,eco:false},ac_capabilities:capabilityManifest};\n const began=Date.now();await until(()=>EcoTrackAirconSystem.AirconProfileManager.getById('AC-Fixture')?.control_snapshot?.observed_remote_state?.turbo===true&&turbo()?.getAttribute('aria-pressed')==='true'&&document.querySelector('.ac-fan-val').textContent==='HIGH · TURBO'&&document.querySelector('.ac-status-badge').textContent.trim()==='ON');\n if(document.querySelector('.ac-swing-val').textContent!=='ON')throw Error('Received swing did not follow Turbo frame');\n checks.push('Received Turbo ON activates the actual control and dashboard automatically without reloading.');\n return {checks,elapsed_ms:Date.now()-began,passed:checks.length};\n})()");
  for(const theme of ['light','dark']){
   await win.webContents.executeJavaScript("document.documentElement.classList.toggle('dark',"+(theme==='dark')+");document.getAnimations().forEach(a=>a.finish());new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));");
   const bodyColor=await win.webContents.executeJavaScript("new Promise(resolve=>setTimeout(()=>resolve(getComputedStyle(document.body).backgroundColor),150));");
   assert.equal(bodyColor,theme==='dark'?'rgb(7, 11, 25)':'rgb(248, 250, 252)');
   const buttonMetrics=await win.webContents.executeJavaScript("[...document.querySelectorAll('#specialButtonsGroup button')].filter(b=>b.textContent==='Turbo').map(b=>({width:b.getBoundingClientRect().width,pressed:b.getAttribute('aria-pressed')}))");
   assert.equal(buttonMetrics[0]?.pressed,'true');assert(buttonMetrics[0]?.width>0);
   assert.equal(await win.webContents.executeJavaScript("document.documentElement.scrollWidth>innerWidth"),false);
   results.checks.push(theme+' production shell renders received Turbo ON without overflow.');results.passed++;
   fs.writeFileSync(path.join(out,'turbo-on-'+theme+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
  }
  const final=await win.webContents.executeJavaScript("(async()=>{\n const checks=[],turbo=()=>[...document.querySelectorAll('#specialButtonsGroup button')].find(b=>b.textContent==='Turbo');\n fixtureDb.states[0].latest_ir={...fixtureDb.states[0].latest_ir,sequence:3,received_at:new Date().toISOString(),state:{power:true,temp:25,mode:'auto',fan:'high',turbo:false,swing:false,eco:false}};\n const end=Date.now()+7000;while(turbo()?.dataset.currentState!=='off'){if(Date.now()>end)throw Error('Remote Turbo OFF did not update automatically');await new Promise(resolve=>setTimeout(resolve,25));}\n if(turbo().getAttribute('aria-pressed')!=='false'||document.querySelector('.ac-fan-val').textContent!=='HIGH')throw Error('Turbo OFF state mismatch');\n checks.push('Received Turbo OFF automatically clears the control and dashboard Turbo label.');\n fixtureDb.states[0].latest_ir={...fixtureDb.states[0].latest_ir,sequence:4,received_at:new Date().toISOString(),ac_capabilities:{...capabilityManifest,turbo:false}};\n await EcoTrackAirconSystem.syncWithDatabase();if(turbo())throw Error('Denied Turbo is still rendered');\n checks.push('Changing receiver capabilities hides unsupported Turbo without reloading.');\n fixtureDb.states[0].latest_ir={...fixtureDb.states[0].latest_ir,sequence:5,received_at:new Date().toISOString(),state:{power:true,temp:25,mode:'auto',fan:'high'},ac_capabilities:capabilityManifest};\n await EcoTrackAirconSystem.syncWithDatabase();\n if(turbo()?.dataset.currentState!=='off'||turbo().getAttribute('aria-pressed')!=='false')throw Error('Missing Turbo overwrote the reliable previous value');\n checks.push('A missing decoded Turbo value preserves the previous reliable observation.');\n return checks;\n})()");
  results.checks.push(...final);results.passed+=final.length;
  fs.writeFileSync(path.join(out,'native-turbo-tests.json'),JSON.stringify({...results,live_database_modified:false,physical_hardware_tested:false},null,2)+'\n');
  win.destroy();app.exit(0);
 }catch(error){fs.writeFileSync(path.join(out,'native-turbo-failure.txt'),error.stack);win.destroy();app.exit(1);}
});

