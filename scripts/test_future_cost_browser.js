'use strict';
// Production pages, production models, disposable SQLite and isolated browser storage only.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),net=require('node:net');
const {spawn}=require('node:child_process'),{chromium}=require(process.env.ECOTRACK_PLAYWRIGHT || 'playwright');
const {requestMonitoring}=require('../src/monitoring-local');
const root=path.resolve(__dirname,'..'),out=path.join(root,'reports/future-cost'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'ecotrack-future-cost-'));
const now=Date.parse('2026-10-20T07:00:00Z'),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const saved={temp:24,fan:'medium',mode:'cool',eco:false,turbo:false,quiet:false,swing:false,horizontal_swing:false,display:true};
let backend,server,browser;
async function port(){const s=net.createServer();await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));const p=s.address().port;await new Promise(resolve=>s.close(resolve));return p;}
async function until(fn,label){for(let i=0;i<250;i++){try{if(await fn())return;}catch(_){}await wait(100);}throw Error('Timed out: '+label);}
async function main(){
 fs.mkdirSync(out,{recursive:true});const api='http://127.0.0.1:'+await port();
 backend=spawn(path.join(root,'venv/Scripts/python.exe'),['-c','from backend.app import app;from backend import monitoring;import sys;monitoring.datetime=type("FixtureDateTime",(monitoring.datetime,),{"now":classmethod(lambda cls,tz=None:cls.fromtimestamp(float(sys.argv[2])/1000,tz or monitoring.timezone.utc))});app.run(host="127.0.0.1",port=int(sys.argv[1]),use_reloader=False)',new URL(api).port,String(now)],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,ECOTRACK_SQLITE_DB_PATH:path.join(temp,'telemetry.db'),ECOTRACK_TELEMETRY_SYNC:'0',ECOTRACK_MONITOR_SYNC:'0'}});
 await until(async()=>(await fetch(api+'/api/monitoring/devices')).ok,'private backend');
 const adminToken=fs.readFileSync(path.join(temp,'.ecotrack-monitoring-admin.key'),'utf8').trim();
 const asset={id:'fixture-ac-one',name:'Monitoring Fixture AC',aircon_type:'Split Type'};
 const registered=(await requestMonitoring({action:'create',data:{name:'Monitoring Fixture Node',aircon_id:asset.id,location:'Fixture Building · Floor 1 · Room 1',pressure_sensor:'MPX5010DP',pressure_min_pa:0,pressure_max_pa:10000,state_source:'power_meter',expected_interval_seconds:60}},{backendUrl:api,adminToken,lookupAircon:async()=>asset})).data;
 const samples=Array.from({length:24},(_,i)=>({boot_id:'isolated-future-cost',sequence:i,observed_at:new Date(now-(23-i)*60000).toISOString(),clock_quality:'synchronized',interval_seconds:60,outlet_temperature_c:18+i/100,differential_pressure_pa:30,ac_on:null,battery_voltage:3.8,rssi_dbm:-61,connection_status:'online'}));
 assert.equal((await fetch(api+'/api/monitoring/telemetry',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+registered.device_token},body:JSON.stringify({device_id:registered.id,samples})})).status,200);
 const metadata={success:true,rooms:[{id:'room-one',name:'Room 1',floor_id:'floor-one'}],floors:[{id:'floor-one',name:'Floor 1',building_id:'building-one'}],buildings:[{id:'building-one',name:'Fixture Building'}],nodes:[{id:'esp-one',name:'Controller Fixture Node',device_mode:'both',room_id:'room-one',wake_time:'05:00',sleep_time:'17:00',interval_val:1,interval_unit:'Minutes'},{id:'monitor-only',name:'Monitoring-only node',device_mode:'monitoring'}],aircons:[]};
 const records=Array.from({length:2},(_,i)=>({id:'future-cost-log-'+i,node_id:'esp-one',sensor_name:'Controller Fixture Node',control_name:'Controller Fixture Node',created:new Date(now-(1-i)*60000).toISOString(),interval_seconds:60,ac_on:null,status:'offline',control_snapshot:{desired_state:saved,commanded_at:new Date(now-60000).toISOString()}}));
 assert.equal((await fetch(api+'/api/telemetry',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(records)})).status,201);
 const publicRoot=path.join(root,'public');server=http.createServer((req,res)=>{const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname),file=path.resolve(publicRoot,'.'+pathname);if(!file.startsWith(publicRoot+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.ttf':'font/ttf'};res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'});fs.createReadStream(file).pipe(res);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const site='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 const evidence={status:'RUNNING',checks:[],runtimeErrors:[],externalRequestsSent:0,productionDatabaseAccessed:false};
 for(const source of ['controller','sensor']){
  const ctx=await browser.newContext({viewport:{width:1920,height:1080},timezoneId:'Asia/Singapore',acceptDownloads:true});
  await ctx.route('**/*',route=>{const url=route.request().url();if(url.startsWith(site+'/')||url.startsWith(api+'/'))return route.continue();return route.abort();});
  await ctx.routeWebSocket(/.*/,socket=>socket.close());
  await ctx.addInitScript(({api,source,metadata,now,saved})=>{
   const NativeDate=Date;window.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
   localStorage.setItem('ecoTrackTheme','dark');localStorage.setItem('ecoTrack_workspace_mode',source==='sensor'?'monitoring':'controller');localStorage.setItem('ecoTrack_backend_url',api);localStorage.setItem('ecoTrack_supabase_url','https://isolated.example.invalid');localStorage.setItem('ecoTrack_supabase_anon_key','sb_publishable_isolated_fixture');localStorage.setItem('ecoTrack_tariff_rate','13.24');
   localStorage.setItem('ecoTrack_aircons',JSON.stringify([{device_id:'fixture-asset',aircon_id:'control-ac-one',controller_node_id:'esp-one',name:'Controller Fixture AC',control_snapshot:{desired_state:saved,commanded_at:new Date(now-60000).toISOString()}}]));
   localStorage.setItem('ecoTrack_logs_metadata:'+JSON.stringify(['https://isolated.example.invalid',api,'']),JSON.stringify(metadata));
   window.electron={env:{BACKEND_URL:api},invoke:async channel=>channel==='scheduler-fetch-data'?metadata:{success:false},on(){}};
  },{api,source,metadata,now,saved});
  const page=await ctx.newPage();page.on('pageerror',error=>evidence.runtimeErrors.push(source+': '+error.message));
  await page.goto(site+(source==='sensor'?'/sensor-logs.html':'/logs.html'),{waitUntil:'domcontentloaded'});
  if(source==='sensor')await page.waitForFunction(()=>document.getElementById('sensorConnection')?.textContent==='Local backend connected');
  else await page.waitForFunction(()=>globalNodeRecords.length===2 && !energyPredictionPending && nodeDataLogs.length===2);
  const layout=await page.evaluate(source=>{const box=id=>document.getElementById(id).getBoundingClientRect(),button=box('openFutureCostBtn'),time=box(source==='sensor'?'sensorTimeStart':'startTimeFilter'),pdf=box('headerExportPdfBtn');return {sameTimeRow:Math.abs((button.top+button.height/2)-(time.top+time.height/2))<3,belowExports:button.top>=pdf.bottom,inside:button.right<=innerWidth};},source);
  assert(layout.sameTimeRow,source+' future button must align with Time');assert(layout.belowExports);assert(layout.inside);
  await page.screenshot({path:path.join(out,source+'-header.png')});
  assert.equal(await page.evaluate(()=>EcoTrackFutureCost.hasPlan()),false);
  await page.locator('#openFutureCostBtn').click();await page.locator('#futureCostDialog[open]').waitFor();
  assert(await page.locator('#futureCostDialog').evaluate(element=>{const box=element.getBoundingClientRect();return Math.abs(box.left+box.width/2-innerWidth/2)<2 && Math.abs(box.top+box.height/2-innerHeight/2)<2;}),'Empty modal centered');
  assert.equal(await page.locator('#futureCostDialog button').filter({hasText:/Generate|Export/}).count(),0);
  assert.equal(await page.locator('#futureTarget').count(),source==='controller'?1:0);
  assert.equal(await page.locator('#futureHours').inputValue(),'');
  assert.equal(await page.locator('#futureDevice option').count(),2,'One AC, and All; monitoring-only nodes excluded from controller projection');
  await page.locator('#futureHours').fill('8');await page.waitForFunction(()=>document.querySelectorAll('.fc-kpis').length===1 && document.getElementById('futureResult').getAttribute('aria-busy')==='false');
  const calculated=await page.evaluate(()=>EcoTrackFutureCost.capture());assert.equal(calculated.available,true,calculated.reason);assert.equal(calculated.rows.length,7);assert.equal(calculated.plannedUnitHours,56);assert.equal(calculated.deviceCount,1);
  if(source==='controller'){
   const expected=await(await fetch(api+'/api/predict-recorded-energy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'hist_gradient_boosting',settings:saved})})).json();assert(Math.abs(calculated.kwh-expected.kwh*56)<1e-8);
   await page.locator('#futureTarget').fill('26');await page.waitForFunction(()=>document.getElementById('futureResult').getAttribute('aria-busy')==='false');await wait(500);const changed=await page.evaluate(()=>EcoTrackFutureCost.capture());assert.equal(changed.devices[0].settings.setpoint_c,26);await page.locator('#futureTarget').fill('');await wait(500);
  }else{
   const energy=await(await fetch(api+'/api/monitoring/energy?from=2026-10-19T16:00:00Z&to=2026-10-20T16:00:00Z')).json();const device=energy.devices.find(device=>device.node_id===registered.id);assert(Math.abs(calculated.kwh-device.energy_kwh/(device.estimated_seconds/3600)*56)<1e-8);assert.match(calculated.reference,/2026-10-20 to 2026-10-20/);
  }
  evidence.checks.push(source+': production page and model integration, explicit plan hours, truthful source, exact AC count, Time-row placement');
  for(const theme of ['dark','light'])for(const width of [1460,390]){
   await page.setViewportSize({width,height:1000});await page.evaluate(theme=>document.documentElement.classList.toggle('dark',theme==='dark'),theme);
   const modal=await page.locator('#futureCostDialog').evaluate(element=>{const box=element.getBoundingClientRect(),body=element.querySelector('.fc-body');return {inside:box.left>=0&&box.right<=innerWidth&&box.top>=0&&box.bottom<=innerHeight,centered:Math.abs(box.left+box.width/2-innerWidth/2)<2 && Math.abs(box.top+box.height/2-innerHeight/2)<2,scroll:body.scrollHeight>=body.clientHeight,width:element.scrollWidth<=element.clientWidth};});assert(modal.inside);assert(modal.centered);assert(modal.width);assert(modal.scroll);
   await page.screenshot({path:path.join(out,source+'-modal-'+width+'-'+theme+'.png')});
  }
  await page.setViewportSize({width:1920,height:1080});await page.evaluate(()=>document.documentElement.classList.add('dark'));
  await page.keyboard.press('Escape');assert.equal(await page.locator('#futureCostDialog').count(),0);assert(await page.locator('#openFutureCostBtn').evaluate(element=>document.activeElement===element));
  const file=page.waitForEvent('download');await page.locator('#headerExportPdfBtn').click();await(await file).saveAs(path.join(out,source+'-future.pdf'));
  if(source==='sensor')await page.waitForFunction(()=>!document.getElementById('headerExportPdfBtn').disabled);
  const excel=page.waitForEvent('download');await page.locator('#headerExportExcelBtn').click();await(await excel).saveAs(path.join(out,source+'-history.xlsx'));
  if(source==='sensor')await page.waitForFunction(()=>!document.getElementById('headerExportPdfBtn').disabled);
  evidence.checks.push(source+': dark/light desktop/mobile modal, Close/Escape focus, existing header PDF and historical Excel downloads');
  // Change the historical selection to a date with no records. Future data stays explicitly conditional.
  if(source==='sensor')await page.locator('#sensorFrom').fill('2026-01-01');
  else await page.evaluate(()=>{selectedDateKey='2026-01-01';followLatestLogPeriod=false;render();});
  if(source==='sensor')await page.waitForFunction(()=>!document.getElementById('sensorRefresh').disabled && document.getElementById('sensorPageInfo').textContent==='No readings');
  await page.locator('#openFutureCostBtn').click();
  await page.locator('[data-fc-period="month"]').click();await page.waitForFunction(()=>document.querySelectorAll('.fc-kpis').length===1 && document.getElementById('futureResult').getAttribute('aria-busy')==='false');
  const empty=await page.evaluate(()=>EcoTrackFutureCost.capture());assert.equal(empty.rows.length,30);
  assert.equal(empty.available,source==='controller','Sensor history absent means no projected energy; saved controller controls can still project');
  if(source==='sensor'){assert.equal(empty.kwh,null);assert.equal(empty.cost,null);}
  await page.locator('#futureDone').click();
  const second=page.waitForEvent('download');await page.locator('#headerExportPdfBtn').click();await(await second).saveAs(path.join(out,source+'-empty-history-future.pdf'));
  evidence.checks.push(source+': next-calendar-month daily breakdown; empty-history PDF and missing monitoring data handled');
  await ctx.close();
 }
 await require('./test_future_cost_interactions')(browser);
 evidence.checks.push('Modal interactions: presets/custom dates, weekdays, unit selector, tariff changes, invalid hours, removed devices, stale PDF rejection, late reply after Escape');
 const actualCount=await(await fetch(api+'/api/monitoring/telemetry?from=2026-10-19T16:00:00Z&to=2026-10-20T16:00:00Z')).json();assert.equal(actualCount.total,24,'Projection must not write future observations');
 assert.deepEqual(evidence.runtimeErrors,[]);evidence.status='PASS';fs.writeFileSync(path.join(out,'browser-verification.json'),JSON.stringify(evidence,null,2));evidence.checks.forEach(check=>console.log('PASS '+check));
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(async()=>{await browser?.close();server?.close();backend?.kill();});
