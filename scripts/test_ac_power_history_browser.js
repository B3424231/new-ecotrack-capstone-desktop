'use strict';
// Real production pages and local API, disposable records, no live cloud or hardware.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),net=require('node:net');
const {spawn}=require('node:child_process'),{chromium}=require(process.env.ECOTRACK_PLAYWRIGHT||'playwright'),{requestMonitoring}=require('../src/monitoring-local');
const root=path.resolve(__dirname,'..'),out=path.join(root,'reports/ac-power-history'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'ecotrack-power-history-'));
const now=Date.parse('2026-10-20T07:00:00Z'),date='2026-10-19',time=value=>Date.parse(date+'T'+value+':00+08:00');
let backend,server,browser;
async function port(){const s=net.createServer();await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));const p=s.address().port;await new Promise(resolve=>s.close(resolve));return p;}
async function until(fn){for(let i=0;i<250;i++){try{if(await fn())return;}catch(_){}await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Private backend did not start');}
async function main(){
 fs.mkdirSync(out,{recursive:true});const api='http://127.0.0.1:'+await port();
 backend=spawn(path.join(root,'venv/Scripts/python.exe'),['-c','from backend.app import app;from backend import monitoring;import sys;monitoring.datetime=type("FixtureDateTime",(monitoring.datetime,),{"now":classmethod(lambda cls,tz=None:cls.fromtimestamp(float(sys.argv[2])/1000,tz or monitoring.timezone.utc))});app.run(host="127.0.0.1",port=int(sys.argv[1]),use_reloader=False)',new URL(api).port,String(now)],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,ECOTRACK_SQLITE_DB_PATH:path.join(temp,'telemetry.db'),ECOTRACK_TELEMETRY_SYNC:'0',ECOTRACK_MONITOR_SYNC:'0'}});
 await until(async()=>(await fetch(api+'/api/monitoring/devices')).ok);
 const adminToken=fs.readFileSync(path.join(temp,'.ecotrack-monitoring-admin.key'),'utf8').trim(),assets=[{id:'asset-one',name:'Matrix',aircon_type:'Split Type'},{id:'asset-two',name:'Second AC',aircon_type:'Window Type'}],sensors=[];
 for(const asset of assets){const registered=(await requestMonitoring({action:'create',data:{name:asset.name+' sensor node',aircon_id:asset.id,location:'IC Building · Floor 1 · Room 1',pressure_sensor:'MPX5010DP',pressure_min_pa:0,pressure_max_pa:10000,state_source:'power_meter',expected_interval_seconds:60}},{backendUrl:api,adminToken,lookupAircon:async()=>asset})).data;sensors.push(registered);}
 const samples=Array.from({length:242},(_,i)=>({boot_id:'power-history-fixture',sequence:i,observed_at:new Date(i<240?time('08:00')+i*60000:time('12:10')+(i-240)*60000).toISOString(),clock_quality:'synchronized',interval_seconds:60,outlet_temperature_c:19,differential_pressure_pa:30,ac_on:i<120||i===240,state_source:'power_meter',connection_status:'online'}));
 assert.equal((await fetch(api+'/api/monitoring/telemetry',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+sensors[0].device_token},body:JSON.stringify({device_id:sensors[0].id,samples})})).status,200);
 const controls=[{id:'control-command',node_id:'controller-one',created:new Date(time('08:00')).toISOString(),ac_on:null,interval_seconds:60,control_snapshot:{desired_state:{power:true},command_status:'transmitted'}},...['08:00','08:10','08:20'].map((stamp,index)=>({id:'control-feedback-'+index,node_id:'controller-two',aircon_id:'asset-two',created:new Date(time(stamp)).toISOString(),ac_on:index===0,interval_seconds:600}))];
 assert.equal((await fetch(api+'/api/telemetry',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(controls)})).status,201);
 const metadata={success:true,nodes:[{id:'controller-one',name:'AC Device One',device_mode:'both',monitoring_id:sensors[0].id},{id:'controller-two',name:'AC Device Two',device_mode:'controller'},{id:'monitor-only',name:'Monitoring-only node',device_mode:'monitoring'}],aircons:assets.map((asset,index)=>({...asset,controller_node_id:'controller-'+(index===0?'one':'two')})),rooms:[],floors:[],buildings:[]};
 const publicRoot=path.join(root,'public');server=http.createServer((req,res)=>{const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname),file=path.resolve(publicRoot,'.'+pathname);if(!file.startsWith(publicRoot+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end();}res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.ttf':'font/ttf'})[path.extname(file)]||'application/octet-stream');fs.createReadStream(file).pipe(res);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const site='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 const checks=[],errors=[],requests=[];
 for(const source of ['controller','monitoring','both']){
  const ctx=await browser.newContext({viewport:{width:1460,height:1000},timezoneId:'Asia/Singapore'});
  await ctx.route('**/*',route=>{const url=route.request().url();if(url.startsWith(site+'/')||url.startsWith(api+'/')){requests.push({path:new URL(url).pathname,method:route.request().method()});return route.continue();}if(url==='https://cdn.tailwindcss.com/')return route.fulfill({path:path.join(publicRoot,'vendor/tailwindcss.js'),contentType:'text/javascript'});return route.abort();});await ctx.routeWebSocket(/.*/,socket=>socket.close());
  await ctx.addInitScript(({api,source,metadata,now})=>{
   const NativeDate=Date;window.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
   localStorage.setItem('ecoTrack_workspace_mode',source);localStorage.setItem('ecoTrackTheme','dark');localStorage.setItem('ecoTrack_backend_url',api);localStorage.setItem('ecoTrack_supabase_url','https://isolated.invalid');localStorage.setItem('ecoTrack_supabase_anon_key','sb_publishable_isolated_fixture');
   window.electron={env:{BACKEND_URL:api},invoke:async channel=>channel==='scheduler-fetch-data'?metadata:{success:false},on(){}};
  },{api,source,metadata,now});
  const page=await ctx.newPage();page.on('pageerror',error=>errors.push(source+': '+error.message));
  await page.goto(site+(source==='controller'?'/dashboard.html':'/analytics.html'),{waitUntil:'domcontentloaded'});
  if(source!=='controller'){
   await page.waitForFunction(()=>document.getElementById('sensorConnection')?.textContent==='Local backend connected');assert(await page.locator('#sensorSnapshots').isVisible());
   assert.equal(await page.locator('#analyticsPowerHistory').count(),0,'History is no longer embedded in the Analytics page');assert.equal(await page.locator('#acPowerHistoryDialog').count(),0);
   assert.equal(await page.locator('#openAcPowerHistoryBtn').getAttribute('data-power-history-source'),'monitoring');
   await page.screenshot({path:path.join(out,source+'-analytics-header.png')});
  }
  const header=await page.locator('#openAcPowerHistoryBtn').evaluate(button=>{const box=button.getBoundingClientRect(),head=button.closest('header').getBoundingClientRect();return {right:head.right-box.right,inside:box.top>=head.top&&box.bottom<=head.bottom};});assert(header.inside);assert(header.right<(source==='controller'?40:100));
  await page.locator('#openAcPowerHistoryBtn').click();await page.locator('#acPowerHistoryDialog[open]').waitFor();
  const panelId=source==='controller'?'controllerPowerHistory':'monitoringPowerHistory',panel=page.locator('#'+panelId);
  await panel.locator('[data-aph="date"]').fill(date);await panel.locator('[data-aph="date"]').dispatchEvent('change');
  await page.waitForFunction(id=>document.getElementById(id)?.getAttribute('aria-busy')==='false'&&document.getElementById(id).textContent.includes('2h 1m'),panelId);
  assert.deepEqual(await panel.locator('.aph-summary strong').allTextContents(),['08:00 AM','12:11 PM','2h 1m']);assert(await panel.locator('.aph-state.unknown').count()>0);
  const pageRequests=requests.filter(request=>request.path==='/api/monitoring/telemetry');assert(pageRequests.length>=2,'All monitoring feedback pages loaded');
  checks.push(source+': actual local API history, exact first ON / last OFF, gap exclusion and 242 samples over multiple pages');
  for(const theme of ['dark','light'])for(const width of [1460,390]){
   await page.setViewportSize({width,height:1000});await page.evaluate(theme=>document.documentElement.classList.toggle('dark',theme==='dark'),theme);
   const geometry=await page.locator('#acPowerHistoryDialog').evaluate(element=>{const box=element.getBoundingClientRect();return {inside:box.left>=0&&box.right<=innerWidth&&box.top>=0&&box.bottom<=innerHeight,center:Math.abs(box.left+box.width/2-innerWidth/2)<2&&Math.abs(box.top+box.height/2-innerHeight/2)<2};});assert(geometry.inside);assert(geometry.center);
   assert(await panel.evaluate(element=>element.getBoundingClientRect().width<=innerWidth));await page.screenshot({path:path.join(out,source+'-'+theme+'-'+width+'.png')});
  }
  await page.setViewportSize({width:1460,height:1000});
  await panel.locator('[data-select-id^="aph-unit-"]').click();await page.getByRole('option',{name:'Second AC',exact:true}).click();
  await page.waitForFunction(id=>{const element=document.getElementById(id);return element?.getAttribute('aria-busy')==='false'&&element.querySelector('[data-aph="unit"]')?.selectedOptions[0]?.textContent==='Second AC';},panelId);
  assert.equal(await panel.locator('.aph-summary strong').last().innerText(),source==='controller'?'10m':'Unavailable');
  checks.push(source+': per-AC selection keeps controller feedback separate; missing monitoring power remains unavailable');
  if(source==='controller'){
   await page.keyboard.press('Escape');assert.equal(await page.locator('#acPowerHistoryDialog').count(),0);assert(await page.locator('#openAcPowerHistoryBtn').evaluate(element=>document.activeElement===element));
   await page.locator('#openAcPowerHistoryBtn').click();await page.locator('#acPowerHistoryDialog footer button').click();assert.equal(await page.locator('#acPowerHistoryDialog').count(),0);
   let release,intercepted=false;const gate=new Promise(resolve=>release=resolve);
   const hold=async route=>{intercepted=true;await gate;await route.continue().catch(()=>{});};
   await page.route(api+'/api/telemetry?**',hold);await page.locator('#openAcPowerHistoryBtn').click();await until(()=>intercepted);
   await page.keyboard.press('Escape');assert.equal(await page.locator('#acPowerHistoryDialog').count(),0);release();await page.unroute(api+'/api/telemetry?**',hold);
   checks.push('Controller: right header button, centered modal, Escape/Close restore focus');
  }else{
   await panel.locator('[data-aph="previous"]').click();await page.waitForFunction(id=>document.getElementById(id)?.getAttribute('aria-busy')==='false',panelId);assert.equal(await panel.locator('[data-aph="date"]').inputValue(),'2026-10-18');assert.equal(await panel.locator('.aph-summary strong').last().innerText(),'Unavailable');
   await panel.locator('[data-select-id^="aph-unit-"]').click();await page.getByRole('option',{name:'Matrix',exact:true}).click();await page.waitForFunction(id=>document.getElementById(id)?.getAttribute('aria-busy')==='false',panelId);
   const incomplete=route=>new URL(route.request().url()).searchParams.get('page')==='2'?route.fulfill({json:{items:[],total:242}}):route.continue();
   await page.route(api+'/api/monitoring/telemetry?**',incomplete);await panel.locator('[data-aph="date"]').fill(date);await panel.locator('[data-aph="date"]').dispatchEvent('change');await panel.getByText('History changed while loading. Refresh to read a complete day.',{exact:true}).waitFor();assert.equal(await panel.locator('.aph-summary').count(),0);await page.unroute(api+'/api/monitoring/telemetry?**',incomplete);
   await page.route(api+'/api/monitoring/telemetry?**',route=>route.fulfill({status:503,json:{error:'Fixture backend unavailable'}}));await panel.locator('[data-aph="refresh"]').click();await panel.getByText('Fixture backend unavailable',{exact:true}).waitFor();assert.equal(await panel.locator('.aph-summary').count(),0);
   checks.push(source+': date navigation, incomplete pagination and backend failure clear stale historical totals');
   await page.keyboard.press('Escape');assert.equal(await page.locator('#acPowerHistoryDialog').count(),0);assert(await page.locator('#openAcPowerHistoryBtn').evaluate(element=>document.activeElement===element));
   await page.locator('#openAcPowerHistoryBtn').click();await page.locator('#acPowerHistoryDialog footer button').click();assert.equal(await page.locator('#acPowerHistoryDialog').count(),0);
   // Reopening follows the Analytics sensor filter and retains the monitoring source in Both mode.
   await page.unroute(api+'/api/monitoring/telemetry?**');
   await page.locator('#sensorSelect').selectOption(sensors[1].id,{force:true});await page.waitForFunction(()=>!document.getElementById('sensorRefresh').disabled);
   await page.locator('#openAcPowerHistoryBtn').click();await page.waitForFunction(()=>document.getElementById('monitoringPowerHistory')?.getAttribute('aria-busy')==='false');
   assert.equal(await page.locator('#monitoringPowerHistory [data-aph="unit"] option').count(),1);assert.equal(await page.locator('#monitoringPowerHistory [data-aph="unit"] option').innerText(),'Second AC');
   await page.locator('#acPowerHistoryDialog .aph-modal-heading button').click();assert(await page.locator('#openAcPowerHistoryBtn').evaluate(element=>document.activeElement===element));
   checks.push(source+': right-side header launch, centered modal, Close/Escape/focus restoration and Analytics filter binding');
  }
  await ctx.close();
 }
 assert.deepEqual(errors,[]);assert(requests.every(request=>request.method==='GET'),'UI history must remain read-only');
 fs.writeFileSync(path.join(out,'browser-verification.json'),JSON.stringify({status:'PASS',checks,runtime_errors:errors,production_data_accessed:false,history_ui_writes:0},null,2));checks.forEach(check=>console.log('PASS '+check));
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(async()=>{await browser?.close();server?.close();backend?.kill();});
