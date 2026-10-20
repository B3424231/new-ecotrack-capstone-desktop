'use strict';
// Actual desktop pages with isolated cloud/local transports; no live records or hardware.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require(process.env.ECOTRACK_PLAYWRIGHT||'playwright');
const root=path.resolve(__dirname,'..'),out=path.join(root,'reports/desktop-workflow-fixes-20261020/browser');
let server,browser;
(async()=>{
  fs.mkdirSync(out,{recursive:true});
  server=http.createServer((req,res)=>{
    const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname),base=path.join(root,'public'),file=path.resolve(base,'.'+name);
    if(!file.startsWith(base+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end();}
    res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream');fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const site='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const errors=[],checks=[],node={id:'controller-fixture',name:'Fixture AC Device',device_mode:'both',monitoring_id:'11111111-1111-4111-8111-111111111111',monitor_aircon_id:'ac-one',room_id:'room-one',wake_time:'05:00',sleep_time:'18:00',interval_val:1,interval_unit:'Minutes',sensor_config:{temperature_sensor:'MCP9808',pressure_sensor:'MPX5010DP'}};
  const registry={success:true,nodes:[node],aircons:[{id:'ac-one',name:'Fixture AC',controller_node_id:node.id,aircon_type:'Window'}],buildings:[{id:'building-one',name:'Building'}],floors:[{id:'floor-one',name:'Floor 1',building_id:'building-one'}],rooms:[{id:'room-one',name:'Room 1',floor_id:'floor-one'}]};
  const sensor={id:node.monitoring_id,name:node.name,aircon_id:'ac-one',aircon_name:'Fixture AC',aircon_type:'Window',location:'Building · Floor 1 · Room 1',active:true,latest:null,fresh:false,status:'Awaiting readings',sensor_schedule:{wake_time:'05:00',sleep_time:'18:00',interval_seconds:60}};
  async function context(width,theme,mode,state){
    const ctx=await browser.newContext({viewport:{width,height:1000},timezoneId:'Asia/Singapore'});
    await ctx.route('**/*',route=>{
      const url=route.request().url();
      if(url.startsWith(site+'/api/monitoring/devices'))return state.failLocal?route.fulfill({status:503,json:{error:'Fixture local backend unavailable'}}):route.fulfill({json:{items:state.empty?[]:[sensor],sync:{enabled:false}}});
      if(url.startsWith(site+'/'))return route.continue();return route.abort();
    });
    await ctx.routeWebSocket(/.*/,socket=>socket.close());
    await ctx.exposeBinding('fixtureInvoke',async(_,channel,input)=>{
      if(channel==='scheduler-fetch-data'){if(state.gate)await state.gate;if(state.failCloud)return {success:false,error:'Fixture cloud unavailable'};return registry;}
      if(channel==='monitoring-sync-registry')return {success:true,data:{changed:0}};
      if(channel==='monitoring-admin-request'){state.localWrites.push(input);return {success:true,data:{success:true}};}
      return {success:false,error:'Isolated fixture'};
    });
    await ctx.addInitScript(({site,theme,mode,width})=>{
      localStorage.setItem('ecoTrack_workspace_mode',mode);localStorage.setItem('ecoTrackTheme',theme);localStorage.setItem('sidebarCollapsed',String(width<760));
      localStorage.setItem('ecoTrack_backend_url',site);localStorage.setItem('ecoTrack_supabase_url','https://offline-fixture.invalid');localStorage.setItem('ecoTrack_supabase_anon_key','sb_publishable_isolated_fixture');
      window.electron={env:{BACKEND_URL:site},invoke:(channel,input)=>window.fixtureInvoke(channel,input),on(){}};
      let hardware;window.fixtureCommands=[];
      Object.defineProperty(window,'EcoTrackHardwareCloud',{configurable:true,get:()=>hardware,set:api=>{hardware={...api,listStatus:async()=>[{node_id:'controller-fixture',last_seen:new Date().toISOString()}],request:async(id,kind,payload)=>{window.fixtureCommands.push({id,kind,payload});return {id:'command-fixture',node_id:id,kind};},waitForResult:undefined};}});
    },{site,theme,mode,width});
    return ctx;
  }
  for(const [width,theme] of [[1460,'dark'],[390,'light']]){
    let release;const state={gate:new Promise(resolve=>release=resolve),empty:true,localWrites:[]};
    const ctx=await context(width,theme,'monitoring',state),page=await ctx.newPage();page.on('pageerror',error=>errors.push(error.message));
    await page.goto(site+'/telemetry.html');await page.locator('#sensorLoading').waitFor();
    assert.equal(await page.locator('#sensorLoading .sensor-telemetry-card').count(),2);
    assert.equal(await page.locator('#sensorApp').isVisible(),false);assert(await page.locator('#sensorRefresh').isDisabled());
    await page.screenshot({path:path.join(out,`telemetry-loading-${width}-${theme}.png`)});
    state.gate=null;release();await page.locator('#sensorFleet .sensor-telemetry-card').waitFor();
    assert.equal(await page.locator('#sensorCount').innerText(),'1 sensor');assert.equal(await page.locator('#sensorLoading').count(),0);assert(!(await page.locator('#sensorRefresh').isDisabled()));
    state.failLocal=true;await page.locator('#sensorRefresh').click();await page.locator('#sensorError').waitFor();await page.waitForFunction(()=>!document.getElementById('sensorRefresh').disabled);
    assert.equal(await page.locator('#sensorLoading').count(),0);assert(await page.locator('#sensorFleet .sensor-telemetry-card').isVisible());
    state.failLocal=false;await page.locator('#sensorRefresh').click();await page.waitForFunction(()=>!document.getElementById('sensorRefresh').disabled);assert.equal(await page.locator('#sensorError').isVisible(),false);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:path.join(out,`telemetry-recovered-${width}-${theme}.png`)});checks.push(`Telemetry ${width}px ${theme}: two-card skeleton, registry wait, unavailable/retry, no overflow`);await ctx.close();
  }
  const state={failLocal:true,empty:false,localWrites:[]},ctx=await context(1460,'dark','both',state),page=await ctx.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(site+'/scheduler.html');await page.locator('.apply-schedule-btn').waitFor();assert((await page.locator('#sensorConnection').innerText()).includes('local sensor schedules unavailable'));
  assert.equal(await page.locator('#schedulerTableBody tr').count(),1);await page.locator('.apply-schedule-btn').click();await page.waitForFunction(()=>window.fixtureCommands.length===1);assert.equal(state.localWrites.length,0);
  assert.equal((await page.evaluate(()=>window.fixtureCommands))[0].kind,'configure');await page.screenshot({path:path.join(out,'both-scheduler-local-outage.png')});
  state.failLocal=false;await page.locator('#schedulerRefresh').click();await page.waitForFunction(()=>!document.getElementById('schedulerRefresh').disabled);await page.locator('.apply-schedule-btn').click();await page.waitForFunction(()=>window.fixtureCommands.length===2);assert.equal(state.localWrites.length,1);
  state.failCloud=true;await page.locator('#schedulerRefresh').click();await page.waitForFunction(()=>!document.getElementById('schedulerRefresh').disabled);assert.equal(await page.locator('#schedulerTableBody tr').count(),1);assert((await page.locator('#sensorConnection').innerText()).includes('controller registry unavailable'));
  state.failLocal=true;await page.locator('#schedulerRefresh').click();await page.getByText('Failed to Load Schedules',{exact:true}).waitFor();state.failLocal=false;state.failCloud=false;await page.getByRole('button',{name:'Retry Loading',exact:true}).click();await page.locator('.apply-schedule-btn').waitFor();
  checks.push('Both scheduler: cloud schedule queues during local outage; local recovery resumes combined saves; each source and total failure recover');await ctx.close();
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({status:'PASS',checks,runtime_errors:errors,external_requests:0,physical_hardware_tested:false},null,2));checks.forEach(check=>console.log('PASS '+check));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());});
