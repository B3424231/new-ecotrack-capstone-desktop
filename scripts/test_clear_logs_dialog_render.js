// Production dialog + clear operation in isolated Chromium. All requests are local fixtures.
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=path.join(root,'reports/clear-logs-ui');
app.setPath('userData',path.join(root,'scratch/clear-logs-ui-electron'));app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const html=read('public/logs.html'),markup=html.match(/<dialog id="clearLogsDialog"[\s\S]*?<\/dialog>/)[0];
const logs=read('public/js/logs.js'),clearFn=logs.slice(logs.indexOf('async function clearAllTelemetryHistory()'),logs.indexOf('function setupEventListeners()'));
async function scenario(theme,width,height){
 const checks=[];const win=new BrowserWindow({width,height,show:false,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,partition:'clear-logs-ui-qa'}});
 win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_d,done)=>done({cancel:true}));
 const page='<!doctype html><html class="'+(theme==='dark'?'dark':'')+'"><head><meta charset="utf-8"><style>'+read('public/styles.css')+'</style><style>'+read('public/css/clear-logs-dialog.css')+'</style><style>body{font-family:Segoe UI,Arial,sans-serif}.fixture{padding:42px;color:#18392b}.dark .fixture{color:#d1fae5}.fixture h1{font-size:24px}.fixture button{padding:10px 16px;border:1px solid #e11d48;background:#fff1f2;color:#be123c;border-radius:10px}.fixture article{margin-top:32px;padding:24px;border:1px solid #cbd5e1;border-radius:18px;background:#fff}.dark .fixture article{background:#13261e;border-color:#294738}</style></head><body class="app-shell"><main class="fixture"><h1>AC Energy Analytics</h1><p>Telemetry and operating logs</p><button id="clearAllLogsBtn">Clear All Logs</button><article>Isolated confirmation preview — no live records or account.</article></main>'+markup+'</body></html>';
 await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(page));
 const bootstrap=[
 read('public/js/clear-logs-dialog.js'),
 "let nodeDataLogs=[{id:'fixture-reading'}],lastTelemetryTotalItems=1,currentPage=2,renders=0;",
 "const fixture={backendCalls:0,cloudCalls:0,auditClears:0,events:0,invalidations:0,response:{ok:true,status:200,body:{success:true}},cloudError:null,hold:false,release:null};",
 "window.ECOTRACK_CONFIG={backendUrl:'https://fixture.invalid'};window.fetch=async(url,options)=>{fixture.backendCalls++;if(options.method!=='DELETE')throw Error('Unexpected operation');if(fixture.hold)await new Promise(resolve=>fixture.release=resolve);return {ok:fixture.response.ok,status:fixture.response.status,json:async()=>fixture.response.body};};",
 "window.supabaseClient={from(table){if(table!=='telemetry')throw Error('Unexpected table');return {delete:()=>({neq:async()=>{fixture.cloudCalls++;return {error:fixture.cloudError};}})};}};",
 "window.EcoTrackAirconSystem={CentralLogService:{clearLogs:()=>fixture.auditClears++}};window.EcoDataBus={invalidate:()=>fixture.invalidations++};window.addEventListener('ecotrack:telemetry-saved',()=>fixture.events++);function render(){renders++;}",
 clearFn,
 "const trigger=document.getElementById('clearAllLogsBtn');window.EcoTrackClearLogsDialog.attach(trigger,clearAllTelemetryHistory);",
 "const get=id=>document.getElementById(id);trigger.click();true;"
 ].join('\n');
 await win.webContents.executeJavaScript(bootstrap);
 let state=await win.webContents.executeJavaScript("({open:get('clearLogsDialog').open,phase:get('clearLogsDialog').dataset.phase,focus:document.activeElement.id,calls:fixture.backendCalls,width:get('clearLogsDialog').getBoundingClientRect().width,rect:get('clearLogsDialog').getBoundingClientRect().toJSON(),vw:innerWidth,vh:innerHeight,fg:getComputedStyle(get('clearLogsDescription')).color,bg:getComputedStyle(get('clearLogsDialog')).backgroundColor,confirmFg:getComputedStyle(get('clearLogsConfirm')).color,confirmBg:getComputedStyle(get('clearLogsConfirm')).backgroundColor})");
 assert(state.open);assert.equal(state.focus,'clearLogsCancel');assert.equal(state.calls,0);assert(state.rect.x>=0&&state.rect.y>=0&&state.rect.right<=state.vw&&state.rect.bottom<=state.vh);assert.notEqual(state.fg,state.bg);assert.equal(state.confirmFg,'rgb(255, 255, 255)');checks.push('Centered responsive confirmation has readable themed text, red action, safe Cancel focus and no deletion on open');
 await win.webContents.executeJavaScript("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
 let shot=await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});fs.writeFileSync(path.join(out,'confirm-'+theme+'-'+width+'.png'),shot.toPNG());
 await win.webContents.executeJavaScript("get('clearLogsCancel').click();true;");
 await win.webContents.executeJavaScript("new Promise(resolve=>requestAnimationFrame(resolve))");
 state=await win.webContents.executeJavaScript("({open:get('clearLogsDialog').open,calls:fixture.backendCalls,focus:document.activeElement.id})");
 assert(!state.open);assert.equal(state.calls,0);assert.equal(state.focus,'clearAllLogsBtn');checks.push('Cancel restores trigger focus without a request');
 await win.webContents.executeJavaScript("trigger.click();get('clearLogsDialog').dispatchEvent(new MouseEvent('click',{clientX:1,clientY:1,bubbles:true}));true;");
 assert.equal(await win.webContents.executeJavaScript("get('clearLogsDialog').open"),false);checks.push('Backdrop dismisses without deleting');
 await win.webContents.executeJavaScript("trigger.click();fixture.hold=true;get('clearLogsConfirm').click();get('clearLogsConfirm').click();true;");
 state=await win.webContents.executeJavaScript("({phase:get('clearLogsDialog').dataset.phase,calls:fixture.backendCalls,disabled:['clearLogsConfirm','clearLogsCancel','clearLogsClose','clearAllLogsBtn'].every(id=>get(id).disabled),cancelPrevented:!get('clearLogsDialog').dispatchEvent(new Event('cancel',{cancelable:true})),open:get('clearLogsDialog').open})");
 assert.equal(state.phase,'busy');assert.equal(state.calls,1);assert(state.disabled);assert(state.cancelPrevented);assert(state.open);checks.push('Explicit confirm alone starts a request; busy state blocks duplicate clicks and dismissal');
 await win.webContents.executeJavaScript("fixture.response={ok:false,status:503,body:{}};fixture.hold=false;fixture.release();true;");
 await win.webContents.executeJavaScript("new Promise(resolve=>setTimeout(resolve,20))");
 state=await win.webContents.executeJavaScript("({phase:get('clearLogsDialog').dataset.phase,error:get('clearLogsFeedback').textContent,cloudCalls:fixture.cloudCalls,rows:nodeDataLogs.length,audit:fixture.auditClears,role:get('clearLogsFeedback').getAttribute('role'),disabled:get('clearLogsConfirm').disabled})");
 assert.equal(state.phase,'error');assert.match(state.error,/HTTP 503/);assert.equal(state.cloudCalls,0);assert.equal(state.rows,1);assert.equal(state.audit,0);assert.equal(state.role,'alert');assert(!state.disabled);checks.push('HTTP failure stays visible, keeps cached rows/audit, and allows retry');
 await win.webContents.executeJavaScript("fixture.response={ok:true,status:200,body:{success:true}};fixture.cloudError={message:'Permission denied'};get('clearLogsConfirm').click();true;");
 await win.webContents.executeJavaScript("new Promise(resolve=>setTimeout(resolve,20))");
 state=await win.webContents.executeJavaScript("({phase:get('clearLogsDialog').dataset.phase,error:get('clearLogsFeedback').textContent,rows:nodeDataLogs.length})");
 assert.equal(state.phase,'error');assert.match(state.error,/Local history was cleared.*cloud history.*Permission denied/);assert.equal(state.rows,1);checks.push('Supabase failure explains partial deletion and cannot display success');
 await win.webContents.executeJavaScript("fixture.cloudError=null;get('clearLogsConfirm').click();true;");
 await win.webContents.executeJavaScript("new Promise(resolve=>setTimeout(resolve,20))");
 state=await win.webContents.executeJavaScript("({phase:get('clearLogsDialog').dataset.phase,title:get('clearLogsTitle').textContent,label:get('clearLogsConfirmLabel').textContent,rows:nodeDataLogs.length,total:lastTelemetryTotalItems,page:currentPage,audit:fixture.auditClears,events:fixture.events,renders,buttonDisabled:trigger.disabled,warningHidden:get('clearLogsWarning').hidden})");
 assert.equal(state.phase,'success');assert.equal(state.rows,0);assert.equal(state.total,0);assert.equal(state.page,1);assert.equal(state.audit,1);assert.equal(state.events,1);assert.equal(state.renders,1);assert.equal(state.label,'Done');assert(!state.buttonDisabled);assert(state.warningHidden);checks.push('Both confirmed stores complete before success, audit/cache reset and refresh notification');
 await win.webContents.executeJavaScript("get('clearLogsConfirm').click();trigger.click();true;");
 assert.equal(await win.webContents.executeJavaScript("get('clearLogsDialog').dataset.phase"),'confirm');checks.push('Done closes and reopening resets warning and confirmation');
 win.destroy();return {theme,width,height,checks,initial:state};
}
app.whenReady().then(async()=>{fs.mkdirSync(out,{recursive:true});try{const results=[];for(const theme of ['light','dark'])for(const width of [1000,390])results.push(await scenario(theme,width,width===390?760:720));fs.writeFileSync(path.join(out,'native-ui-tests.json'),JSON.stringify({passed:results.reduce((n,r)=>n+r.checks.length,0),isolated_production_components:true,live_data_modified:false,results},null,2));app.exit(0);}catch(error){fs.writeFileSync(path.join(out,'failure.txt'),error.stack);app.exit(1);}});
