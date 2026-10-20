const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=path.join(root,'reports/controller-details');app.setPath('userData',path.join(root,'scratch/controller-details-electron'));app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
 fs.mkdirSync(out,{recursive:true});const read=p=>fs.readFileSync(path.join(root,p),'utf8'),source=read('public/nodes.html');
 const markup=source.slice(source.indexOf('  <div id="viewNodeModal"'),source.indexOf('  <!-- EDIT ',source.indexOf('  <div id="viewNodeModal"'))>0?source.indexOf('  <!-- EDIT ',source.indexOf('  <div id="viewNodeModal"')):source.indexOf('  <div id="editNodeModal"'));
 const body=source.slice(source.indexOf('      function openViewNodeModal('),source.indexOf('      if (viewModalPingBtn)',source.indexOf('      function openViewNodeModal(')));
 const checks=[];
 for(const [width,theme] of [[1080,'light'],[390,'light'],[1080,'dark'],[390,'dark']]){
  const win=new BrowserWindow({width,height:900,show:false,useContentSize:true,webPreferences:{contextIsolation:true,nodeIntegration:false,offscreen:true}});
  const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error'&&!e.message.includes('Content Security Policy'))errors.push(e.message);});
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_d,done)=>done({cancel:true}));
  const fixture=path.join(root,'scratch/controller-details-fixture.html');
  fs.writeFileSync(fixture,'<!doctype html><html class="'+(theme==='dark'?'dark':'')+'"><head><meta charset="utf-8"><style>'+read('public/styles.css')+read('public/css/controller-details.css')+'</style></head><body>'+markup+'</body></html>');
  await win.loadFile(fixture);
  if(fs.existsSync(path.join(root,'scratch/step3-qa-tailwind.js')))await win.webContents.executeJavaScript(read('scratch/step3-qa-tailwind.js')+"\nwindow.tailwind.config={darkMode:'class'};true;");
  await win.webContents.executeJavaScript(read('public/js/controller-details.js')+`
  window.__node={node_id:'esp32s3-fixture',db_id:'node-db',name:'Office ESP32',status:'Connected',hardware:'ESP32-S3 IR controller',
   firmware:'cloud-ir-controller-1.7-live-with-a-long-version',ir_rx:true,ir_tx:true,rssi:-59,wifi_ssid:'Fixture network',ip_address:'10.0.0.66',last_seen:'2026-10-10T07:47:26Z',
   building:'IC Building with a long deployment name',floor:'Floor 1 - Administration',room_name:'Room 1',aircon_type:'Split Type (Inverter)',brand:'Matrix',protocol_name:'TCL112AC',
   admin_verified_at:'2026-10-09T06:30:05Z',deployment_saved_at:'2026-10-09T06:30:05Z',cloud_state:{capabilities:{}}};
  const NodeService={getNode:()=>window.__node},AirconProfileManager={getAll:()=>[{node_id:'esp32s3-fixture',name:'Room 1 AC with a long identifier that must wrap correctly'}]};
  const viewModal=document.getElementById('viewNodeModal');let currentViewingNodeId;
  `+body+"\nopenViewNodeModal('esp32s3-fixture');true;");
  await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  let data=await win.webContents.executeJavaScript(`(()=>{
  const rows=[...document.querySelectorAll('.controller-details-row')];
  return {mac:!!document.getElementById('viewMacAddress'),battery:document.getElementById('viewBattery').textContent,reported:document.getElementById('viewBattery').dataset.reported,
   date:document.getElementById('viewDeploymentDate').getAttribute('datetime'),time:document.getElementById('viewDeploymentTime').textContent,
   overflow:rows.some(row=>row.scrollWidth>row.clientWidth+2),aligned:rows.every(row=>Math.abs(row.children[0].getBoundingClientRect().top-row.children[1].getBoundingClientRect().top)<2),
   tag:document.getElementById('viewLocationTag').textContent};
  })()`);
  assert(!data.mac);assert.equal(data.battery,'0%');assert.equal(data.reported,'false');assert.equal(data.date,'2026-10-09T06:30:05.000Z');assert(!data.overflow&&data.aligned);assert(data.tag.includes('IC Building with'));
  await win.webContents.executeJavaScript("document.querySelector('#viewNodeModal .overflow-y-auto').scrollTop=220;true;");
  fs.writeFileSync(path.join(out,'details-'+theme+'-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
  data=await win.webContents.executeJavaScript(`__node.cloud_state.capabilities.battery_percent=68;__node.deployment_saved_at='2026-10-10T08:45:02Z';openViewNodeModal('esp32s3-fixture');({battery:document.getElementById('viewBattery').textContent,date:document.getElementById('viewDeploymentDate').getAttribute('datetime')})`);
  assert.equal(data.battery,'68%');assert.equal(data.date,'2026-10-10T08:45:02.000Z');
  data=await win.webContents.executeJavaScript(`delete __node.admin_verified_at;delete __node.deployment_saved_at;__node.cloud_state.capabilities.battery_percent='wrong';openViewNodeModal('esp32s3-fixture');({battery:document.getElementById('viewBattery').textContent,date:document.getElementById('viewDeploymentDate').textContent})`);
  assert.equal(data.battery,'0%');assert.equal(data.date,'Not recorded');assert.deepEqual(errors,[]);
  checks.push(theme+' '+width+'px: aligned wrapped rows; real battery and saved timestamp update; missing telemetry/legacy date remain honest.');
  win.destroy();
 }
 fs.writeFileSync(path.join(out,'native-results.json'),JSON.stringify({checks,passed:checks.length},null,2));console.log('Controller details: '+checks.length+' native checks passed.');app.exit(0);
}).catch(e=>{console.error(e);app.exit(1);});
