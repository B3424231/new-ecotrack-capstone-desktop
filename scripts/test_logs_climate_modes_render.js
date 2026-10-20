'use strict';
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=path.join(root,'reports/special-functions-ui'),read=file=>fs.readFileSync(path.join(root,file),'utf8');
const source=read('public/js/logs.js'),html=read('public/logs.html'),section=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
const tableStart=html.lastIndexOf('          <!-- TABLE -->',html.indexOf('id="logsTableBody"'));
const table=html.slice(tableStart,html.indexOf('          <!-- PAGINATION -->',tableStart));
app.setPath('userData',path.join(root,'scratch/analytics-climate-modes-electron'));app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
 fs.mkdirSync(out,{recursive:true});const results=[];
 for(const [width,theme] of [[1460,'light'],[1460,'dark'],[390,'light']]){
  const page='<!doctype html><html class="'+(theme==='dark'?'dark':'')+'"><head><meta charset="utf-8"><style>'+read('public/styles.css')+'</style><style>body{margin:0;padding:24px;background:'+(theme==='dark'?'#081223':'#f8fafc')+'}main{border:1px solid #10b981;border-radius:16px;overflow:hidden;background:'+(theme==='dark'?'#0c1328':'white')+'}h1{font-size:20px;margin:20px;color:#059669}thead th{color:white!important}#qa-hidden{display:none}</style></head><body class="app-shell"><main><h1>AC Energy Analytics</h1>'+table+'</main><div id="qa-hidden"><span id="logsTitle"></span><span id="totalRecords"></span><span id="avgTemp"></span><span id="avgPressure"></span><span id="pageInfo"></span><button id="prevPageBtn"></button><button id="nextPageBtn"></button></div></body></html>';
  const file=path.join(root,'scratch/analytics-climate-modes-'+theme+'-'+width+'.html');fs.writeFileSync(file,page);
  const win=new BrowserWindow({width,height:450,show:false,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_request,callback)=>callback({cancel:true}));await win.loadFile(file);
  if(fs.existsSync(path.join(root,'scratch/step3-qa-tailwind.js')))await win.webContents.executeJavaScript(read('scratch/step3-qa-tailwind.js')+"\nwindow.tailwind.config={darkMode:'class'};true;");
  await win.webContents.executeJavaScript(read('public/js/aircon-state.js'));
  await win.webContents.executeJavaScript(`
   let currentPage=1;const currentPeriod='daily',PAGE_SIZE=20,controlNameMap={},locationMap={},globalAirconMap={};
   let fixtureRows=[{timestamp:new Date('2026-10-10T09:00:00Z'),nodeId:'fixture',controlName:'Office Controller',roomName:'Room 1',floorName:'Floor 1',buildingName:'IC Building',airconType:'Split Type (Inverter)',temperature:null,battery:0,rssi:-59,status:'online',
    controlSnapshot:{observed_remote_state:{power:true,temp:21.5,mode:'cool',fan:'quiet',turbo:true},observed_remote_at:'2026-10-10T09:00:00Z',desired_state:{mode:'heat',fan:'auto'},commanded_at:'2026-10-10T09:01:00Z',command_status:'transmitted'}}];
   const nodeDataLogs=fixtureRows;
   function populateDateRangeOptions(){}function getFilteredLogs(){return fixtureRows;}
   function calculateStats(){return {totalRecords:fixtureRows.length,avgTemp:'--',onlineNodes:1};}
   function updateActiveFilterBadge(){}function predictEnergyConsumption(){}function getBatteryPercentage(){return 0;}
   function getSignalIcon(rssi){return rssi+' dBm';}
  `+section('function locationLabel(','// Get room name for a node')+section('function getAnalyticsRecordingPower(','function getRuntimeIntervalMs(')+section('function render({','// ── REDESIGNED EXECUTIVE EXCEL')+'\nrender();true;');
  let state=await win.webContents.executeJavaScript("({headers:[...document.querySelectorAll('thead th')].map(el=>el.textContent.trim()),values:[...document.querySelectorAll('#logsTableBody tr:first-child td')].map(el=>el.textContent.trim()),scrollable:document.querySelector('table').parentElement.scrollWidth>document.querySelector('table').parentElement.clientWidth})");
  assert.equal(state.headers.length,13);assert.deepEqual(state.headers.slice(6,10),['Target Temperature','Operating Mode','Blower Fan Mode','Special Functions']);assert.equal(state.values.length,13);assert.deepEqual(state.values.slice(6,10),['21.5°C','COOL','QUIET · TURBO','Turbo: ON']);assert(!state.values.join(' ').includes('REQUESTED'));
  if(width===390)assert(state.scrollable);
  await win.webContents.executeJavaScript('document.getAnimations().forEach(animation=>{if(animation.effect.getComputedTiming().iterations!==Infinity)animation.finish()});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.join(out,'table-'+theme+'-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript("fixtureRows=[{...fixtureRows[0],controlSnapshot:{observed_remote_state:{power:true,mode:'fan',fan:'low'},observed_remote_at:'2026-10-10T09:02:00Z'}}];render({preserveScroll:true});true;");
  state=await win.webContents.executeJavaScript("[7,8].map(index=>document.querySelectorAll('#logsTableBody tr:first-child td')[index].textContent.trim())");assert.deepEqual(state,['FAN','LOW']);
  await win.webContents.executeJavaScript("fixtureRows=[{...fixtureRows[0],controlSnapshot:{observed_remote_state:{power:false,mode:'fan',fan:'low'},observed_remote_at:'2026-10-10T09:03:00Z'}}];render({preserveScroll:true});true;");
  assert.equal(await win.webContents.executeJavaScript("document.getElementById('pageInfo').textContent"),'Showing 0 of 0 logs');
  assert.equal(await win.webContents.executeJavaScript("document.getElementById('totalRecords').textContent"),'0');
  await win.webContents.executeJavaScript('document.getAnimations().forEach(animation=>{if(animation.effect.getComputedTiming().iterations!==Infinity)animation.finish()});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  fs.mkdirSync(path.join(root,'reports/special-functions-ui'),{recursive:true});
  fs.writeFileSync(path.join(root,'reports/special-functions-ui','off-'+theme+'-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript('fixtureRows=[];render();true;');assert.equal(await win.webContents.executeJavaScript("document.querySelector('#logsTableBody td').colSpan"),13);
  results.push({width,theme,recorded_mode_and_fan:true,updates_without_reload:true,off_power_hidden:true,empty_state_aligned:true});win.destroy();
 }
 fs.writeFileSync(path.join(root,'reports/special-functions-ui','native-results.json'),JSON.stringify({passed:results.length,results,live_hardware_tested:false},null,2));
 console.log('Analytics mode/fan native rendering: '+results.length+' viewport/theme scenarios passed.');app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
