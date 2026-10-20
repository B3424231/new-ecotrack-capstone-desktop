'use strict';
// Actual monitoring page and report generator; intercepted transports and isolated fixtures only.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require(process.env.ECOTRACK_PLAYWRIGHT||'playwright');
const root=path.resolve(__dirname,'..'),publicRoot=path.join(root,'public'),out=path.join(root,'reports/desktop-workflow-followup-fixes-20261020/browser');let server,browser;
fs.mkdirSync(out,{recursive:true});
const nodes=[{id:'audit-a',name:'Audit sensor A',aircon_id:'audit-ac-a',aircon_name:'Audit AC A',active:true,fresh:false,latest:null},{id:'audit-b',name:'Audit sensor B',aircon_id:'audit-ac-b',aircon_name:'Audit AC B',active:true,fresh:false,latest:null}];
const records=Array.from({length:3},(_,index)=>({id:'audit-reading-'+index,node_id:index<2?'audit-a':'audit-b',sensor_name:index<2?'Audit sensor A':'Audit sensor B',aircon_id:index<2?'audit-ac-a':'audit-ac-b',aircon_name:index<2?'Audit AC A':'Audit AC B',observed_at:new Date(Date.parse('2026-10-20T03:00:00Z')+index*60000).toISOString(),interval_seconds:60,clock_quality:'synchronized',outlet_temperature_c:index<2?18:26,differential_pressure_pa:30,temperature_quality:'ok',pressure_quality:'ok',location:'Audit Building · Floor · Room',ac_on:null,connection_status:'offline'}));
const initialHistory=Array.from({length:201},(_,index)=>({...records[0],id:'moving-'+index,observed_at:new Date(Date.parse('2026-10-20T03:30:00Z')-index*1000).toISOString()}));
const movingHistory=[{...records[0],id:'new-reading',observed_at:'2026-10-20T03:31:00Z'},...initialHistory];
const state={incomplete:false,growing:false,frozen:false,removed:false,queries:[]};
(async()=>{
 server=http.createServer((req,res)=>{const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname),file=path.resolve(publicRoot,'.'+name);if(!file.startsWith(publicRoot+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end();}res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'})[path.extname(file)]||'application/octet-stream');fs.createReadStream(file).pipe(res);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const site='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 const context=await browser.newContext({viewport:{width:1460,height:1000},timezoneId:'Asia/Singapore',acceptDownloads:true});
 await context.route('**/*',route=>{
  const url=new URL(route.request().url());
  if(url.origin===site&&url.pathname.startsWith('/api/monitoring/')){
   assert.equal(route.request().method(),'GET');const params=url.searchParams,chosen=params.get('node_id'),rows=(state.growing?(state.frozen&&params.get('snapshot')==='201'?initialHistory:movingHistory):records).filter(row=>!chosen||row.node_id===chosen);
   if(url.pathname.endsWith('/devices'))return route.fulfill({json:{items:nodes.map(node=>({...node,active:node.id==='audit-a'?!state.removed:true}))}});
   if(url.pathname.endsWith('/analytics')){state.queries.push({path:'analytics',node:chosen});return route.fulfill({json:{sample_count:rows.length,temperature_avg:chosen==='audit-a'?18:chosen==='audit-b'?26:62/3,pressure_avg:30,unknown_state_samples:rows.length,confirmed_state_count:0,confirmed_unit_hours:0,observed_unit_hours:rows.length/60,points:[]}});}
   if(url.pathname.endsWith('/energy'))return route.fulfill({json:{available:false,code:'SENSOR_REFERENCE_NO_COVERAGE'}});
   if(url.pathname.endsWith('/telemetry')){const exporting=params.get('per_page')==='200';if(state.growing&&exporting){const first=params.get('page')==='1';return route.fulfill({json:state.frozen?{items:first?initialHistory.slice(0,200):initialHistory.slice(200),total:201,snapshot:'201'}:{items:first?initialHistory.slice(0,200):movingHistory.slice(200),total:first?201:202}});}const items=state.incomplete&&exporting?(params.get('page')==='1'?rows.slice(0,1):[]):rows;return route.fulfill({json:{items,total:rows.length}});}
  }
  if(url.origin===site)return route.continue();return route.abort();
 });
 await context.routeWebSocket(/.*/,socket=>socket.close());
 await context.addInitScript(({site})=>{localStorage.setItem('ecoTrack_workspace_mode','monitoring');localStorage.setItem('ecoTrackTheme','light');localStorage.setItem('ecoTrack_backend_url',site);localStorage.setItem('ecoTrack_supabase_url','https://offline-audit.invalid');localStorage.setItem('ecoTrack_supabase_anon_key','sb_publishable_isolated_fixture');window.electron={env:{BACKEND_URL:site},on(){},invoke:async channel=>channel==='monitoring-sync-registry'?{success:true,data:{changed:false}}:{success:false}};},{site});
 const page=await context.newPage(),errors=[],downloads=[];page.on('pageerror',error=>errors.push(error.message));page.on('download',download=>downloads.push(download));
 await page.goto(site+'/sensor-logs.html');await page.waitForFunction(()=>document.getElementById('sensorConnection')?.textContent==='Local backend connected');
 await page.locator('#sensorSelect').selectOption('audit-a',{force:true});await page.waitForFunction(()=>!document.getElementById('sensorRefresh').disabled);
 state.removed=true;await page.locator('#sensorRefresh').click();await page.waitForFunction(()=>!document.getElementById('sensorRefresh').disabled);
 const removed=await page.evaluate(()=>({selection:document.getElementById('sensorSelect').value,scope:document.getElementById('energyTrendSubtitle').textContent,rows:document.querySelectorAll('#sensorLogTable tbody tr').length}));
 assert.equal(removed.selection,'audit-a');assert(removed.scope.includes('Unavailable'));assert(!removed.scope.includes('All Sensors'));assert.equal(state.queries.at(-1).node,'audit-a');assert.equal(removed.rows,2);
 const results=[{id:'removed-sensor-filter-scope',status:'PASS',last_analytics_query:state.queries.at(-1),displayed:removed}];
 await page.screenshot({path:path.join(out,'removed-sensor-scope.png')});
 await page.locator('#sensorSelect').selectOption('',{force:true});await page.waitForFunction(()=>!document.getElementById('sensorRefresh').disabled);
 state.incomplete=true;
 for(const format of ['xlsx','pdf']){await page.locator('[data-export="'+format+'"]').click();await page.waitForFunction(()=>document.getElementById('sensorExportStatus').textContent.includes('incomplete'));assert.equal(downloads.length,0);assert.equal(await page.locator('#sensorExportProgress').count(),0);}
 results.push({id:'incomplete-monitoring-export',status:'PASS',downloads:downloads.length});
 state.incomplete=false;state.growing=true;
 await page.locator('[data-export="xlsx"]').click();await page.waitForFunction(()=>document.getElementById('sensorExportStatus').textContent.includes('changed during export'));assert.equal(downloads.length,0);
 results.push({id:'growing-unfrozen-history',status:'PASS',downloads:downloads.length});
 state.frozen=true;const frozenDownload=page.waitForEvent('download');await page.locator('[data-export="xlsx"]').click();const frozenFile=path.join(out,'snapshot-FIXTURE.xlsx');await(await frozenDownload).saveAs(frozenFile);
 const frozen=await page.evaluate(async bytes=>{const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(new Uint8Array(bytes));const sheet=workbook.getWorksheet('Sensor Telemetry Logs'),identities=[];sheet.eachRow((row,index)=>{if(index>4)identities.push(row.getCell(1).value.toISOString()+'|'+row.getCell(2).text);});return {rows:identities.length,unique_rows:new Set(identities).size};},Array.from(fs.readFileSync(frozenFile)));
 assert.deepEqual(frozen,{rows:201,unique_rows:201});results.push({id:'frozen-history-export',status:'PASS',exported:frozen});
 const pdfDownload=page.waitForEvent('download');await page.locator('[data-export="pdf"]').click();const pdfFile=path.join(out,'snapshot-FIXTURE.pdf');await(await pdfDownload).saveAs(pdfFile);assert(fs.readFileSync(pdfFile).subarray(0,5).toString().startsWith('%PDF-'));
 assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({results,runtime_errors:errors,live_external_requests:0,production_writes:0},null,2));results.forEach(result=>console.log(result.status+' '+result.id));await context.close();
})().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(async()=>{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());});
