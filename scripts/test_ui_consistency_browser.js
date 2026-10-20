'use strict';
// Production pages, isolated registry/readings and blocked external traffic. No registration or maintenance writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require(process.env.ECOTRACK_PLAYWRIGHT || 'playwright');
const root=path.resolve(__dirname,'..'),out=path.join(root,'reports/workspace-modes');let server,browser;
(async()=>{
 server=http.createServer((req,res)=>{const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname),base=name.startsWith('/assets/')?root:path.join(root,'public'),file=path.resolve(base,'.'+name);if(!file.startsWith(base+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end();}res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'})[path.extname(file)] || 'application/octet-stream');fs.createReadStream(file).pipe(res);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const site='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});const checks=[],errors=[];
 const rooms=[{id:'r',name:'Room 1',floor_id:'f'}],floors=[{id:'f',name:'Floor 1',building_id:'b'}],buildings=[{id:'b',name:'IC building'}];
 const sensorId='11111111-1111-4111-8111-111111111111',nodes=[{id:'controller',name:'AC Controller 1',room_id:'r',device_mode:'controller',wake_time:'05:00',sleep_time:'05:00',interval_val:5,interval_unit:'Seconds'},{id:'sensor',name:'AC Sensor 1',room_id:'r',device_mode:'monitoring',monitor_aircon_id:'ac',monitoring_id:sensorId},{id:'combined',name:'AC Both 1',room_id:'r',device_mode:'both',monitor_aircon_id:'ac-both',wake_time:'05:00',sleep_time:'05:00',interval_val:1,interval_unit:'Minutes',sensor_config:{temperature_sensor:'MCP9808',pressure_sensor:'MPX5010DP',pressure_min_pa:0,pressure_max_pa:10000}}];
 const aircons=[{id:'ac',asset_tag:'AC-FIXTURE',name:'Matrix',controller_node_id:'controller',node_id:'controller',aircon_type:'Split Type (Inverter)'},{id:'ac-both',asset_tag:'AC-BOTH-FIXTURE',name:'Both Aircon',controller_node_id:'combined',node_id:'combined',aircon_type:'Window'}],staff=[{id:'staff',name:'Fixture Technician',role:'technician',status:'Online',room_id:'r'}];
 const hardware=nodes.map(node=>({node_id:node.id,device_id:'esp32s3-001122334455',last_seen:new Date().toISOString()}));
 const sensor={id:sensorId,name:'AC Sensor 1',active:true,aircon_id:'ac',aircon_name:'Matrix',aircon_type:'Split Type (Inverter)',location:'IC building · Floor 1 · Room 1',sensor_schedule:{wake_time:'22:00',sleep_time:'06:00',interval_seconds:120},fresh:true,latest:{outlet_temperature_c:18,differential_pressure_pa:0,battery_voltage:3.8,rssi_dbm:-61,observed_at:new Date().toISOString(),ac_on:null}};
 for(const theme of ['dark','light']) for(const mode of ['monitoring','both','controller']){
  const ctx=await browser.newContext({viewport:{width:1460,height:1000}});let pendingApi=false, hideSensors=false,selectedNodes=nodes;
  await ctx.route('**/*',async route=>{const url=route.request().url();if(url.startsWith(site+'/api/monitoring/devices')){if(pendingApi)await new Promise(resolve=>setTimeout(resolve,500));return route.fulfill({json:{items:hideSensors?[]:[sensor],sync:{enabled:false}}});}if(url.startsWith(site+'/'))return route.continue();if(url.startsWith('https://cdn.tailwindcss.com'))return route.fulfill({path:path.join(root,'public/vendor/tailwindcss.js'),contentType:'text/javascript'});if(url.startsWith('https://offline-fixture.invalid/rest/v1/')){const name=new URL(url).pathname.split('/').pop();return route.fulfill({json:({nodes,aircons,rooms,floors,buildings,staff,ecotrack_device_state:hardware,maintenance_reports:[]})[name] || []});}return route.abort();});
  await ctx.routeWebSocket(/.*/,socket=>socket.close());await ctx.exposeBinding('fixtureInvoke',(_,channel)=>Promise.resolve(channel==='scheduler-fetch-data'?{success:true,nodes:selectedNodes,aircons,rooms,floors,buildings}:channel==='staff-fetch-all'?{success:true,data:staff}:['notifications-fetch-all','maintenance-fetch-reports'].includes(channel)?{success:true,data:[]}:{success:false,error:'Isolated fixture'}));
  await ctx.addInitScript(({site,mode,theme,staff,nodes,aircons})=>{localStorage.setItem('ecoTrack_nodes',JSON.stringify(nodes.map(n=>({...n,node_id:n.id,db_id:n.id,status:'Offline'}))));localStorage.setItem('ecoTrack_aircons',JSON.stringify(aircons.map(ac=>({...ac,aircon_id:ac.id,device_id:ac.asset_tag}))));localStorage.setItem('ecoTrack_workspace_mode',mode);localStorage.setItem('ecoTrackTheme',theme);localStorage.setItem('ecoTrack_backend_url',site);localStorage.setItem('ecoTrack_supabase_url','https://offline-fixture.invalid');localStorage.setItem('ecoTrack_supabase_anon_key','sb_publishable_isolated_fixture');localStorage.setItem('ecoTrack_staff',JSON.stringify(staff));window.electron={env:{BACKEND_URL:site},invoke:(channel,input)=>window.fixtureInvoke(channel,input),on(){}};},{site,mode,theme,staff,nodes,aircons});
  const page=await ctx.newPage();page.on('pageerror',error=>errors.push(error.message));const style=[];
  for(const file of mode==='controller'?['scheduler.html','Notification.html']:['scheduler.html','Notification.html','telemetry.html']){
   await page.goto(site+'/'+file);await page.locator('.eco-location-room').first().waitFor();
   assert.equal(await page.getByRole('button',{name:'All locations',exact:true}).count(),0);
   const selected=page.locator('.eco-location-room[aria-selected="true"],.eco-location-room[aria-pressed="true"]');await selected.first().waitFor();
   style.push(await page.locator('.eco-location-panel').evaluate(element=>{const s=getComputedStyle(element);return {padding:s.padding,border:s.borderWidth,radius:s.borderRadius,width:element.getBoundingClientRect().width};}));
   if(file==='telemetry.html'){pendingApi=true;await page.locator('#sensorRefresh').click();await page.locator('#sensorLoading .eco-skeleton').first().waitFor();await page.waitForFunction(()=>!document.getElementById('sensorRefresh').disabled);assert.equal(await page.locator('#sensorLoading').count(),0);pendingApi=false;const floor=page.locator('.eco-location-floor');await floor.locator('summary').click();assert.equal(await floor.locator('.eco-location-room').isVisible(),false);await floor.locator('summary').click();assert(await floor.locator('.eco-location-room').isVisible());}
   if(file==='telemetry.html'){
    if(mode==='both'){await page.getByRole('heading',{name:'AC Controller 1',exact:true}).waitFor();const card=page.locator('.sensor-telemetry-card').filter({has:page.getByRole('heading',{name:'AC Controller 1',exact:true})});assert((await card.innerText()).includes('Awaiting readings'));assert.equal(await card.getByText('AC Device',{exact:true}).count(),0);}
    else assert.equal(await page.getByRole('heading',{name:'AC Controller 1',exact:true}).count(),0);
    hideSensors=true;await page.locator('#sensorRefresh').click();await page.waitForFunction(()=>!document.getElementById('sensorRefresh').disabled);
    await page.getByRole('heading',{name:mode==='both'?'AC Controller 1':'AC Sensor 1',exact:true}).waitFor();
    assert.equal(await page.locator('#sensorCount').innerText(),mode==='both'?'3 sensors':'2 sensors');assert.equal(await page.locator('#sensorFleet.has-devices').count(),1);
    const combined=page.locator('.sensor-telemetry-card').filter({has:page.getByRole('heading',{name:'AC Both 1',exact:true})});assert.equal(await combined.getByText('MCP9808',{exact:true}).count(),0);assert.equal(await combined.getByText('MPX5010DP',{exact:true}).count(),0);
    assert.deepEqual(await combined.locator('.sensor-schedule-preview b').allTextContents(),['05:00','05:00','1 min']);
    const positions=await page.locator('.sensor-telemetry-card').evaluateAll(cards=>cards.map(card=>({x:card.getBoundingClientRect().x,y:card.getBoundingClientRect().y})));
    assert(Math.abs(positions[0].y-positions[1].y)<2);assert(positions[1].x>positions[0].x);
    await page.locator('#sensorFleet').evaluate(element=>element.scrollTop=0);await page.screenshot({path:path.join(out,`telemetry-two-card-grid-${mode}-${theme}.png`)});
    if(mode==='both'){
     assert(positions[2].y>positions[0].y);
     const overflow=await page.locator('#sensorFleet').evaluate(element=>({scroll:element.scrollHeight,view:element.clientHeight}));assert(overflow.scroll>overflow.view);
     await page.locator('#sensorFleet').focus();await page.keyboard.press('End');await page.waitForFunction(()=>{const fleet=document.getElementById('sensorFleet');return fleet.scrollTop>=fleet.scrollHeight-fleet.clientHeight-1;});
     const top=await page.locator('#sensorFleet').evaluate(element=>element.scrollTop);await page.locator('#sensorRefresh').click();await page.waitForFunction(()=>!document.getElementById('sensorRefresh').disabled);
     const after=await page.locator('#sensorFleet').evaluate(element=>element.scrollTop);assert(Math.abs(after-top)<3,`Scroll position changed from ${top} to ${after}`);
    }
    selectedNodes=[nodes.find(node=>node.id==='combined')];await page.locator('#sensorRefresh').click();await page.waitForFunction(()=>!document.getElementById('sensorRefresh').disabled && document.getElementById('sensorCount').textContent==='1 sensor');
    assert.equal(await page.locator('.sensor-telemetry-card').count(),1);
    const sizes=await page.locator('#sensorFleet').evaluate(element=>({container:element.clientWidth,card:element.firstElementChild.getBoundingClientRect().width}));assert(sizes.card<sizes.container*.55);
    await page.screenshot({path:path.join(out,`telemetry-one-device-${mode}-${theme}.png`)});
    await combined.locator('[data-sensor-detail]').click();await page.locator('#sensorDialog[open]').waitFor();assert(await page.locator('#sensorDialog').getByText('MCP9808',{exact:true}).isVisible());assert(await page.locator('#sensorDialog').getByText('MPX5010DP',{exact:true}).isVisible());assert(await page.locator('#sensorDialog').getByText('Monitoring and Controlling',{exact:true}).isVisible());await page.keyboard.press('Escape');
    selectedNodes=[{...nodes.find(node=>node.id==='combined'),monitoring_id:sensorId}];hideSensors=false;await page.locator('#sensorRefresh').click();await page.waitForFunction(()=>!document.getElementById('sensorRefresh').disabled && document.getElementById('sensorCount').textContent==='1 sensor');
    assert.equal(await page.locator('.sensor-telemetry-card').count(),1);
    assert.deepEqual(await page.locator('.sensor-schedule-preview b').allTextContents(),mode==='both'?['05:00','05:00','1 min']:['22:00','06:00','2 min']);
    hideSensors=true;
    selectedNodes=nodes;await page.locator('#sensorRefresh').click();await page.waitForFunction(()=>!document.getElementById('sensorRefresh').disabled && document.querySelectorAll('.sensor-telemetry-card').length>1);
    await page.setViewportSize({width:390,height:1000});
    assert.equal(await page.locator('#sensorFleet').evaluate(element=>getComputedStyle(element).gridTemplateColumns.split(' ').length),1);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.locator('#sensorFleet').evaluate(element=>element.scrollTop=element.scrollHeight);assert(await page.locator('#sensorFleet').evaluate(element=>element.scrollTop>0));
    await combined.screenshot({path:path.join(out,`telemetry-device-card-mobile-${mode}-${theme}.png`)});await page.setViewportSize({width:1460,height:1000});
    hideSensors=false;
   }
   await page.waitForFunction(()=>Number(getComputedStyle(document.querySelector('main')).opacity)>.99);
   await page.screenshot({path:path.join(out,`consistent-${file.replace('.html','')}-${mode}-${theme}.png`)});
   if(file==='scheduler.html'){
    await page.evaluate(()=>loadRoomNodes([]));
    const title=mode==='monitoring'?'AC Sensor Devices':mode==='both'?'AC Devices':'AC Controllers';
    assert(await page.getByText('No '+title+' in This Room',{exact:true}).isVisible());
    assert.equal(await page.getByRole('link',{name:'Manage '+title+' →',exact:true}).getAttribute('href'),'nodes.html');
    await page.screenshot({path:path.join(out,`scheduler-room-empty-${mode}-${theme}.png`)});
   }
  }
  for(const current of style)assert.deepEqual(current,style[0]);
  await page.goto(site+'/nodes.html');
  const expectedNodes=mode==='monitoring'?['AC Sensor 1','AC Both 1']:mode==='controller'?['AC Controller 1','AC Both 1']:['AC Controller 1','AC Sensor 1','AC Both 1'];
  await page.waitForFunction(count=>document.querySelectorAll('#nodeTableBody tr[data-id]').length===count,expectedNodes.length);
  const registeredRows=await page.locator('#nodeTableBody tr[data-id]').allTextContents();
  expectedNodes.forEach(name=>assert(registeredRows.some(row=>row.includes(name))));
  if(mode==='monitoring')assert(!registeredRows.some(row=>/AC Controller/i.test(row)));
  assert.equal(await page.locator('#nodeKpiTotal').innerText(),String(expectedNodes.length));
  assert.equal(await page.locator('#nodeKpiAircons').innerText(),'2');
  await page.screenshot({path:path.join(out,`registered-devices-${mode}-${theme}.png`)});
  await page.locator('#openAddNodeBtn').click();await page.locator('#nodeModal:not(.hidden)').waitFor();
  assert.equal(await page.locator('#nodeStepTab1 .truncate').innerText(),'Bluetooth');assert.equal(await page.locator('#nodeStepTab2 .truncate').innerText(),'Wi-Fi');assert.equal(await page.locator('#nodeStepTab3 .truncate').innerText(),'Details');
  assert(await page.locator('#cancelNodeModalBtn').evaluate(element=>{const s=getComputedStyle(element);return parseFloat(s.borderTopWidth)>=1 && element.getBoundingClientRect().height>=40;}));
  await page.locator('#cancelNodeModalBtn').click();assert(await page.locator('#nodeModal').evaluate(element=>element.classList.contains('hidden')));
  // Expose the real Details component without simulating successful physical Bluetooth/Wi-Fi.
  await page.evaluate(()=>{document.getElementById('nodeModal').classList.remove('hidden');for(const index of [1,2,3])document.getElementById('nodeStep'+index).classList.toggle('hidden',index!==3);});
  for(const role of ['monitoring','controller','both']){await page.locator('#nodeFormDeviceMode').selectOption(role);assert.equal(await page.locator('#registrationSensorConfig').isVisible(),role!=='controller');assert.equal(await page.locator('#registrationIrConfig').isVisible(),role!=='monitoring');}
  await page.screenshot({path:path.join(out,`registration-details-${mode}-${theme}.png`)});await page.locator('#cancelNodeModalBtn').click();
  await page.goto(site+'/staff.html');const label=mode==='monitoring'?'AC Sensor Device':mode==='both'?'AC Device':'AC Controller';await page.getByRole('heading',{name:label+' Maintenance Reports',exact:true}).waitFor();assert.equal((await page.locator('#maintenanceDeviceColumn').innerText()),label.toUpperCase());
  await page.waitForFunction(()=>window.EcoTrackMaintenance.getAircons().length>0);
  const devices=await page.evaluate(()=>[...window.EcoTrackMaintenance.getAircons()].map(device=>device.deviceMode));if(mode==='monitoring')assert.deepEqual([...devices].sort(),['both','monitoring']);if(mode==='controller')assert.deepEqual([...devices].sort(),['both','controller']);
  await page.evaluate(()=>window.EcoTrackMaintenance.openCreateModal());await page.locator('#ecoCreateReportModal:not(.hidden)').waitFor();assert((await page.locator('#ecoCreateModalBody').innerText()).toLowerCase().includes((label+' Name').toLowerCase()));
  if(mode==='monitoring'){await page.locator('#modalAirconDropdownTrigger').click();await page.locator('#modalAirconDropdownMenu [data-aircon-id="sensor:sensor"]').click();assert((await page.locator('#ecoCreateModalBody').innerText()).includes('AC Sensor 1'));assert((await page.locator('[data-maintenance-diagnostic="pressure"]').innerText()).includes('0 Pa'));}
  await page.screenshot({path:path.join(out,`maintenance-create-${mode}-${theme}.png`)});await page.locator('#btnCloseCreateModal').click();
  await page.screenshot({path:path.join(out,`maintenance-${mode}-${theme}.png`)});
  checks.push(`${mode} ${theme}: shared cabinets, one count per device, two-card grid/inner scroll/refresh, hidden hardware labels, saved schedule preview, role filtering and maintenance diagnostics`);await ctx.close();
 }
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'ui-consistency-verification.json'),JSON.stringify({status:'PASS',checks,runtime_errors:errors,live_external_requests:0},null,2));checks.forEach(check=>console.log('PASS '+check));
})().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(async()=>{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());});
