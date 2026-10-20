const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=path.join(root,'reports/multi-brand-capabilities'),read=f=>fs.readFileSync(path.join(root,f),'utf8'),html=read('public/control.html');
app.setPath('userData',path.join(root,'scratch/multi-brand-controls-electron'));app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
function section(a,b){const start=html.indexOf(a),end=html.indexOf(b,start);assert(start>=0&&end>start);return html.slice(start,end);}
app.whenReady().then(async()=>{
 const markup=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]*>/gi,'').replace('</head>','<style>'+read('public/styles.css')+'</style></head>');
 const file=path.join(root,'scratch/multi-brand-controls-fixture.html');fs.writeFileSync(file,markup);
 const win=new BrowserWindow({width:1400,height:1000,show:false,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error'&&!e.message.includes('Content Security Policy')){errors.push(e.message);console.error('Renderer: '+e.message);}});
 win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_d,cb)=>cb({cancel:true}));await win.loadFile(file);
 if(fs.existsSync(path.join(root,'scratch/step3-qa-tailwind.js')))await win.webContents.executeJavaScript(read('scratch/step3-qa-tailwind.js')+"\nwindow.tailwind.config={darkMode:'class'};true;");
 await win.webContents.executeJavaScript(`
 localStorage.clear();window.fixtureReads=0;window.fixtureWrites=[];
 window.dbFixture={aircons:[{id:'ac-ui',asset_tag:'AC-UI',name:'Matrix',brand:'Matrix',protocol_name:'TCL112AC',node_id:'node-ui',controller_node_id:'node-ui',model:'Split Type (Inverter)'}],nodes:[{id:'node-ui',name:'ESP32 UI',room_id:null}],rooms:[],floors:[],buildings:[]};
 window.hardwareFixture=[{node_id:'node-ui',device_id:'esp32s3-001122334455',last_seen:new Date().toISOString(),capabilities:{ir_receiver:true,ir_transmitter:true},connection_status:'online',latest_ir:{protocol:'TCL112AC',raw_count:227,frame_kind:'full_state',sequence:1,received_at:new Date().toISOString(),state:{power:true,temp:24.5,mode:'cool',fan:'high',turbo:false,source:'ir_receiver'}}}];
 window.supabaseClient={from(table){fixtureReads++;let key,value;const q={select(){return q},order(){return q},eq(k,v){key=k;value=v;return q},async maybeSingle(){return {data:dbFixture[table].find(r=>!key||r[key]===value),error:null}},then(a,b){return Promise.resolve({data:dbFixture[table]||[],error:null}).then(a,b)}};return q;}};
 window.EcoTrackHardwareCloud={listStatus:async()=>structuredClone(hardwareFixture),describe:()=> 'online',control:async(_node,payload)=>{window.fixtureControlTarget=_node;if(window.fixtureControlFail)throw Error('Controller connection unavailable');fixtureWrites.push(structuredClone(payload));return {command_id:'fixture-queued',commanded_at:new Date().toISOString()};}};
 `+read('public/js/aircon-system.js')+`
 const {AirconProfileManager,CapabilityEngine,CommandManager,NodeService}=EcoTrackAirconSystem;let activeDeviceId='AC-UI';
 function executeCommand(command,value){window.pendingCommand=applySettings(command,value);return pendingCommand;}
 function openCommandErrorModal(result){window.lastControlError=result;}
 `+section('      // Dynamic Aircon Dropdown Elements','      function renderDeviceDropdown()')+
 html.match(/function renderDeviceDropdown\([\s\S]*?\n      \}/)[0]+html.match(/function renderDropdownItems\([\s\S]*?\n      \}/)[0]+
 section('      function renderControlPanel()','      // Pending command tracking')+
 section('      function enforceControllerCapabilities(device)','      async function executeCommand(')+
 'const applySettings = '+html.match(/async function executeCommand\([\s\S]*?\n      \}/)[0]+';'+

 section('      // Temperature Clickers','      // Workspace Tabs logic')+'\ntrue;');
 await win.webContents.executeJavaScript("(async()=>{await EcoTrackAirconSystem.syncWithDatabase();const end=Date.now()+5000;while(!AirconProfileManager.getById('AC-UI')){if(Date.now()>end)throw Error('Fixture sync failed');await new Promise(r=>setTimeout(r,20));}renderDeviceDropdown();renderControlPanel();return true;})()");
 const checks=[];
 let specialLabels=await win.webContents.executeJavaScript("[...specialButtonsGroup.children].map(button=>button.textContent)");
 assert(specialLabels.includes('Vertical Swing')&&specialLabels.includes('Horizontal Swing'));
 assert(!specialLabels.some(label=>label.toLowerCase()==='filter'));
 assert.equal(await win.webContents.executeJavaScript("CapabilityEngine.getCapabilities(AirconProfileManager.getById('AC-UI')).filter"),true);
 for(const [label,field,expected] of [['Vertical Swing','swing_vertical','on'],['Horizontal Swing','swing_horizontal','on'],['Vertical Swing','swing_vertical','off']]){
  await win.webContents.executeJavaScript("[...specialButtonsGroup.children].find(button=>button.textContent==="+JSON.stringify(label)+").click();true;");
  await win.webContents.executeJavaScript('pendingCommand');await win.webContents.executeJavaScript('renderControlPanel();true;');
  const intent=await win.webContents.executeJavaScript('fixtureWrites.at(-1)');
  assert.equal(intent.state[field],expected);
  if(field==='swing_vertical')assert.equal(intent.state.swing,expected);
  if(field==='swing_vertical'&&expected==='off')assert.equal(intent.state.swing_horizontal,'on');
 }
 const specialSummary=await win.webContents.executeJavaScript("document.getElementById('liveSpecialFunctions').textContent");
 assert(specialSummary.includes('Vertical Swing: OFF')&&specialSummary.includes('Horizontal Swing: ON'));
 assert(!specialSummary.includes('Filter'));
 checks.push('FILTER is absent, and separate vertical/horizontal swing actions retain the other direction and keep legacy vertical aliases consistent.');
 checks.push('Current settings update their supported special-function values without a page reload.');
 fs.mkdirSync(path.join(root,'reports/special-functions-ui'),{recursive:true});
 await win.webContents.executeJavaScript('document.getAnimations().forEach(animation=>{if(animation.effect.getComputedTiming().iterations!==Infinity)animation.finish()});new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 const summaryRect=await win.webContents.executeJavaScript("(()=>{const r=document.getElementById('liveSpecialFunctions').closest('.glass-panel').getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)};})()");
 fs.writeFileSync(path.join(root,'reports/special-functions-ui/current-settings.png'),(await win.webContents.capturePage(summaryRect)).toPNG());
 let result=await win.webContents.executeJavaScript("({name:unitNameEl.textContent,selector:selectedAcName.textContent,badgeHidden:unitBrandBadgeEl.classList.contains('hidden'),menu:[...airconDropdownList.querySelectorAll('.ac-controller-name')].map(el=>el.textContent),range:tempRangeHelp.textContent,temp:tempValueDisplay.textContent,fans:[...fanButtonsGroup.children].map(b=>b.textContent),hasHelp:!!document.querySelector('.ac-capability-summary'),canAdjust:!tempPlusBtn.disabled,power:masterPowerText.textContent,side:dispCommandedState.textContent,role:document.getElementById('hardwareRoleMessage').textContent})");
 assert.equal(result.name,'ESP32 UI');assert.equal(result.selector,'ESP32 UI');assert.deepEqual(result.menu,['ESP32 UI']);assert(result.badgeHidden);
 assert.equal(await win.webContents.executeJavaScript("AirconProfileManager.getById('AC-UI').brand"),'Matrix');
 checks.push('Control heading and selector use the controller display name while retaining the persisted AC manufacturer.');assert(result.range.includes('16°C')&&result.range.includes('31°C')&&result.range.includes('Step: 1°C')&&!result.range.includes('unverified'));
 assert.equal(result.temp,'24.5');assert(!result.hasHelp&&result.canAdjust&&!result.fans.includes('turbo'));assert.equal(result.power,'ON');assert.equal(result.side,'ON');assert.equal(result.role,'');
 await win.webContents.executeJavaScript("tempPlusBtn.click();pendingCommand.then(()=>renderControlPanel());true;");
 await win.webContents.executeJavaScript("pendingCommand");
 result=await win.webContents.executeJavaScript('fixtureWrites.at(-1)');
 assert.equal(result.state.temp,25);assert.equal(result.requested_feature,'TEMP');
 assert.equal(await win.webContents.executeJavaScript('commandStatusText.textContent'),'✓ Settings saved.');
 const beforeFailure=result.state.temp;
 await win.webContents.executeJavaScript('window.fixtureControlFail=true;tempPlusBtn.click();true;');await win.webContents.executeJavaScript('pendingCommand');
 assert((await win.webContents.executeJavaScript('commandStatusText.textContent')).includes('unavailable'));
 assert.equal(await win.webContents.executeJavaScript("AirconProfileManager.getById('AC-UI').state.temperature"),beforeFailure);
 await win.webContents.executeJavaScript('window.fixtureControlFail=false;true;');
 checks.push('Plain action feedback keeps backend errors visible and does not apply a failed setting.');
 await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 fs.mkdirSync(path.join(root,'reports/normal-control-ui'),{recursive:true});fs.writeFileSync(path.join(root,'reports/normal-control-ui/control-desktop.png'),(await win.webContents.capturePage()).toPNG());
 checks.push('Production Control panel preserves received fractional settings and sends whole-degree app targets.');
 await win.webContents.executeJavaScript(`(async()=>{hardwareFixture[0].last_seen=new Date(Date.now()+2000).toISOString();hardwareFixture[0].latest_ir={protocol:'FUJITSU_AC',remote_model:3,raw_count:260,frame_kind:'full_state',sequence:2,received_at:new Date(Date.now()+2000).toISOString(),state:{power:true,temp:24.25,mode:'cool',fan:'low',turbo:false,source:'ir_receiver'}};await EcoTrackAirconSystem.syncWithDatabase();renderControlPanel();return true;})()`);
 result=await win.webContents.executeJavaScript("({range:tempRangeHelp.textContent,temp:tempValueDisplay.textContent,turbo:[...specialButtonsGroup.children].some(b=>b.textContent==='Turbo'),fans:[...fanButtonsGroup.children].map(b=>b.textContent)})");
 assert(result.range.includes('Step: 1°C'));assert.equal(result.temp,'24.25');assert(result.turbo&&result.fans.includes('quiet'));
 checks.push('Detected exact Fujitsu model preserves received quarter-degree values while app controls use whole degrees and retain model-specific functions.');
 await win.webContents.executeJavaScript(`(async()=>{hardwareFixture[0].last_seen=new Date(Date.now()+3000).toISOString();hardwareFixture[0].latest_ir={...hardwareFixture[0].latest_ir,protocol:'DAIKIN2',remote_model:null,sequence:3,received_at:new Date(Date.now()+3000).toISOString(),state:{power:true,temp:20,mode:'fan',fan:'low',source:'ir_receiver'}};await EcoTrackAirconSystem.syncWithDatabase();renderControlPanel();return true;})()`);
 result=await win.webContents.executeJavaScript("({disabled:tempPlusBtn.disabled&&tempMinusBtn.disabled,modes:[...modeButtonsGroup.children].map(b=>b.textContent),remoteView:!!document.getElementById('remoteLayoutContainer')})");
 assert(result.disabled);assert(result.modes.includes('cool'));assert.equal(result.remoteView,false);
 checks.push('Fan mode disables desktop temperature adjustments; the retired remote layout is absent.');
 await win.webContents.executeJavaScript(`(async()=>{dbFixture.aircons=[{id:'unknown-unit',asset_tag:'AC-UNKNOWN',name:'Unknown unit',brand:'Custom maker',protocol_name:'UNKNOWN',node_id:'node-ui',controller_node_id:'node-ui',model:'Window'}];hardwareFixture[0].latest_ir={};activeDeviceId='AC-UNKNOWN';await EcoTrackAirconSystem.syncWithDatabase();renderControlPanel();return true;})()`);
 result=await win.webContents.executeJavaScript("({power:masterPowerBtn.disabled,temp:tempPlusBtn.disabled,modes:modeButtonsGroup.children.length,fans:fanButtonsGroup.children.length,range:tempRangeHelp.textContent,protocol:AirconProfileManager.getById('AC-UNKNOWN').protocol_name})");
 assert(result.power&&result.temp&&result.modes===0&&result.fans===0);assert.equal(result.protocol,'UNKNOWN');assert.equal(result.range,'—');
 assert.equal(await win.webContents.executeJavaScript('masterPowerText.textContent'),'—');
 checks.push('A different unknown AC on the same controller does not inherit the previous profile or fabricate controls.');
 const dashboard=read('public/dashboard.html'),cut=(a,b)=>dashboard.slice(dashboard.indexOf(a),dashboard.indexOf(b,dashboard.indexOf(a)));
 const cardStart=dashboard.indexOf('            filtered.forEach(ac => {',dashboard.indexOf("          grid.innerHTML = '';"));
 const renderCards=dashboard.slice(cardStart,dashboard.indexOf('          wireCardListeners(grid);',cardStart));
 await win.webContents.executeJavaScript(cut('      function updateSingleCardDom(','      function wireCardListeners(')+cut('      function getDashboardPowerState(','      function renderDashboard(')+cut('      function wireCardListeners(','      function getDashboardPowerState(')+'\nfunction renderDashboardCards(filtered, grid) {\n'+renderCards+'\n}\ntrue;');
 await win.webContents.executeJavaScript(`(async()=>{
 dbFixture.aircons=[{id:'ac-ui',asset_tag:'AC-UI',name:'Matrix',brand:'Matrix',protocol_name:'FUJITSU_AC',node_id:'node-ui',controller_node_id:'node-ui',model:'Split'}];
 hardwareFixture[0].last_seen=new Date().toISOString();hardwareFixture[0].latest_ir={protocol:'FUJITSU_AC',remote_model:3,frame_kind:'full_state',raw_count:260,sequence:5,received_at:new Date().toISOString(),state:{power:true,temp:24.25,mode:'cool',fan:'low',source:'ir_receiver'}};
 await EcoTrackAirconSystem.syncWithDatabase();
 const container=document.createElement('div');container.id='dashboard-name-fixture';
 renderDashboardCards([AirconProfileManager.getById('AC-UI')],container);
 document.body.appendChild(container);wireCardListeners(container);container.querySelector('.temp-step-btn[data-action="up"]').click();return true;
 })()`);
 await win.webContents.executeJavaScript("new Promise(r=>setTimeout(r,120))");
 result=await win.webContents.executeJavaScript("fixtureWrites.at(-1)");
 assert.equal(result.protocol,'FUJITSU_AC');assert.equal(result.state.temp,25);assert.equal(result.model,3);
 checks.push('Production dashboard quick adjustment uses the exact model and the next whole degree, preserving the received setpoint until the user adjusts it.');
 const cardState = () => win.webContents.executeJavaScript("(()=>{const card=document.getElementById('ac-card-AC-UI');return {title:card.querySelector('h3').textContent,type:card.querySelector('h3 + p').textContent,footer:card.querySelector('.ac-node-name').textContent,text:card.textContent,href:card.querySelector('a').getAttribute('href'),device:card.dataset.deviceId};})()");
 result=await cardState();assert.equal(result.title,'ESP32 UI');assert.equal(result.footer,'ESP32 UI');assert.equal(result.type,'Split');assert(!result.text.includes('Matrix')&&!result.text.includes('esp32s3-001122334455'));
 assert.equal(result.href,'control.html?id=AC-UI');assert.equal(result.device,'AC-UI');assert.equal(await win.webContents.executeJavaScript('fixtureControlTarget'),'esp32s3-001122334455');
 await win.webContents.executeJavaScript("(async()=>{dbFixture.nodes[0].name='Office <AC>';await EcoTrackAirconSystem.syncWithDatabase();const ac=AirconProfileManager.getById('AC-UI');updateSingleCardDom(document.getElementById('ac-card-AC-UI'),ac,NodeService.getNode(ac.node_id));return true;})()");
 await win.webContents.executeJavaScript('renderDeviceDropdown();renderControlPanel();true;');
 const renamedControl=await win.webContents.executeJavaScript('({title:unitNameEl.textContent,selector:selectedAcName.textContent,menu:airconDropdownList.querySelector(".ac-controller-name").textContent,badgeHidden:unitBrandBadgeEl.classList.contains("hidden")})');
 assert.equal(renamedControl.title,'Office <AC>');assert.equal(renamedControl.selector,'Office <AC>');assert.equal(renamedControl.menu,'Office <AC>');assert(renamedControl.badgeHidden);
 result=await cardState();assert.equal(result.title,'Office <AC>');assert.equal(result.footer,'Office <AC>');assert.equal(result.device,'AC-UI');assert.equal(result.href,'control.html?id=AC-UI');
 assert.equal(await win.webContents.executeJavaScript("document.getElementById('ac-card-AC-UI').querySelector('h3').children.length"),0);
 await win.webContents.executeJavaScript("(async()=>{dbFixture.nodes[0].name=hardwareFixture[0].device_id;await EcoTrackAirconSystem.syncWithDatabase();const ac=AirconProfileManager.getById('AC-UI');updateSingleCardDom(document.getElementById('ac-card-AC-UI'),ac,NodeService.getNode(ac.node_id));return true;})()");
 result=await cardState();assert.equal(result.title,'AC Controller');assert.equal(result.footer,'AC Controller');assert(!result.text.includes('esp32s3-001122334455'));
 checks.push('Initial dashboard cards and in-place name edits use the saved controller display name, hide manufacturer/raw IDs, escape custom text, and retain stable command targets.');

 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(root,'reports/special-functions-ui','control-native-results.json'),JSON.stringify({passed:checks.length,checks,physical_hardware_tested:false},null,2));win.destroy();console.log('Dynamic production controls: '+checks.length+' native scenario groups passed.');app.exit(0);
}).catch(e=>{console.error(e);app.exit(1);});
