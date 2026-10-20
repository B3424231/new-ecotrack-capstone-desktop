const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=path.join(root,'reports/registration-modal');
app.setPath('userData',path.join(root,'scratch/registration-modal-electron'));app.disableHardwareAcceleration();
app.on('window-all-closed',()=>{});
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
async function main(){
 fs.mkdirSync(out,{recursive:true});
 const source=read('public/nodes.html'),script=[...source.matchAll(/<script>([\s\S]*?)<\/script>/g)].find(m=>m[1].includes('const remoteCapture')).at(1);
 let markup=source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace(/<link\b[^>]*>/g,'');
 markup=markup.replace('</head>','<style>'+read('public/styles.css')+'</style><style>'+read('public/css/controller-registration.css')+'</style></head>');
 const win=new BrowserWindow({width:1120,height:960,show:false,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_d,done)=>done({cancel:true}));
 const errors=[];win.webContents.on('console-message',event=>{if(event.level==='error'){errors.push(event.message);console.error('Renderer:',event.message);}});
 const fixtureFile=path.join(root,'scratch/registration-modal-fixture.html');fs.writeFileSync(fixtureFile,markup);await win.loadFile(fixtureFile);
 if(fs.existsSync(path.join(root,'scratch/step3-qa-tailwind.js')))await win.webContents.executeJavaScript(read('scratch/step3-qa-tailwind.js')+"\nwindow.tailwind.config={darkMode:'class'};true;");
 await win.webContents.executeJavaScript(`
 localStorage.clear();
 window.fixture={mode:'refresh',reconnectError:null,finishError:null,slowFinish:false,finishCount:0,provisionCount:0,validateCount:0,statusCount:0,completeCount:0,
  device:{device_id:'esp32s3-001122334455',cloud_protocol:1,cloud_status:'error',wifi_status:'connected',wifi_ssid:'Fixture network',ip_address:'10.0.0.4',firmware_version:'fixture-rxtx',capabilities:{ir_receiver:true,ir_transmitter:true}},
  tables:{buildings:[{id:'b1',name:'East building'}],floors:[{id:'f1',name:'First floor',building_id:'b1'}],rooms:[{id:'r1',name:'Office',floor_id:'f1'}],aircons:[{id:'available',asset_tag:'Available AC',brand:'Daikin',aircon_type:'Split Type (Inverter)',protocol_name:'DAIKIN64',node_id:null,controller_node_id:null},{id:'taken',asset_tag:'Taken AC',brand:'TCL',node_id:'other-controller',controller_node_id:'other-controller'}],nodes:[],ecotrack_device_state:[]}};
 const f=window.fixture;
 window.EcoToast={show:(message,kind)=>{(f.toasts||=[]).push({message,kind});}};
 window.supabaseClient={supabaseUrl:'https://fixture.supabase.co',from(table){
  const filters=[];let op='select',payload;const q={select(){return q},eq(k,v){filters.push([k,v]);return q},order(){return q},limit(){return q},in(){return q},
   update(v){op='update';payload=v;return q},insert(v){op='insert';payload=Array.isArray(v)?v[0]:v;return q},delete(){op='delete';return q},
   result(){let data=(f.tables[table]||[]).filter(row=>filters.every(([k,v])=>row[k]===v));if(op==='insert'){const row={id:'fixture-created-'+table,...payload};(f.tables[table]||=[]).push(row);data=[row];}if(op==='update')data.forEach(row=>Object.assign(row,payload));return {data,error:null};},
   async maybeSingle(){const r=q.result();return {...r,data:r.data[0]||null}},async single(){return q.maybeSingle()},then(yes,no){return Promise.resolve(q.result()).then(yes,no)}};return q;
  },async rpc(name,args){
   if(name==='ecotrack_finish_controller_registration'){
    f.finishCount++;if(f.slowFinish)await new Promise(resolve=>f.resolveFinish=resolve);
    if(f.finishError)return {data:null,error:{message:f.finishError}};
    const setup=args.p_setup;let ac=setup.assignment_mode==='existing'?f.tables.aircons.find(row=>row.id===setup.aircon_id):f.tables.aircons.find(row=>row.asset_tag===setup.asset_tag);
    if(!ac){ac={id:'created-ac',asset_tag:setup.asset_tag};f.tables.aircons.push(ac);}
    Object.assign(ac,{name:setup.aircon_name||ac.name||ac.asset_tag,brand:setup.brand||ac.brand||'Unspecified',model:setup.aircon_type,aircon_type:setup.aircon_type,room_id:setup.room_id,node_id:args.p_node_id,controller_node_id:args.p_node_id,protocol_name:setup.protocol_name});
    f.node={id:args.p_node_id,name:setup.controller_name,room_id:setup.room_id,brand:ac.brand,aircon_type:ac.aircon_type};
    f.tables.nodes=[f.node];f.mode='reuse';f.tables.ecotrack_device_state=[{node_id:f.node.id,device_id:f.device.device_id,last_seen:new Date().toISOString()}];
    return {data:{success:true,connected:true,node:f.node,aircon:ac,cloud_state:{node_id:f.node.id,device_id:f.device.device_id,last_seen:new Date().toISOString()}},error:null};
   }return {data:[],error:null};
  }};
 window.EcoTrackHardwareCloud={
  resume:async()=>({...f.device}),readInfo:async()=>({...f.device}),
  reconnect:async id=>{if(f.reconnectError)throw Object.assign(new Error(f.reconnectError),{code:'BLE_DISCONNECTED'});if(id!==f.device.device_id)throw Error('Wrong identity');return {...f.device};},
  connect:async id=>{if(id&&id!==f.device.device_id)throw Error('Wrong identity');return {...f.device};},
  pendingRegistrations:()=>[],listStatus:async()=>[],describe:()=>f.mode==='reuse'?'online':'offline',
  registrationStatus:async info=>{f.statusCount++;return {state:f.mode,node:f.node||null,aircon:f.tables.aircons.find(ac=>ac.controller_node_id==='fixture-node')||null,info:{...info},cloud_state:{device_id:info.device_id,last_seen:new Date().toISOString(),connection_status:'online'}};},
  validateAssignment:async()=>{f.validateCount++;return {valid:true};},
  register:async(_meta,credentials,id,options)=>{if(!credentials.pass)throw Error('Missing credential');if(!options.preserveMetadata)throw Error('Metadata unsafe');f.provisionCount++;f.node={id:'fixture-node',name:id};f.mode='reuse';f.device.cloud_status='verified';return {node:f.node,info:{...f.device},cloud_state:{device_id:id,last_seen:new Date().toISOString(),connection_status:'online'}};},
  completeRegistration:()=>f.completeCount++
 };
 true;
 `);
 for(const file of ['public/js/aircon-state.js','public/js/aircon-system.js','public/js/controller-locations.js','public/js/controller-registration.js'])
  await win.webContents.executeJavaScript(read(file)+'\ntrue;');
 await win.webContents.executeJavaScript(script+"\ndocument.dispatchEvent(new Event('DOMContentLoaded'));true;");
 const checks=await win.webContents.executeJavaScript(`(async()=>{
 const f=fixture,checks=[],get=id=>document.getElementById(id),wait=async()=>{for(let n=0;n<30;n++)await new Promise(r=>setTimeout(r,2));};
 const check=(ok,message)=>{if(!ok)throw Error(message);checks.push(message);};
 const change=(id,value,type='input')=>{get(id).value=value;get(id).dispatchEvent(new Event(type,{bubbles:true}));};
 const open=document.getElementById('openAddNodeBtn');
 if(!open)throw Error('Missing add button');
 open.click();await wait();
 check(!get('nodeModal').classList.contains('hidden')&&!get('nodeStep3').classList.contains('hidden'),'Configured Bluetooth and Wi-Fi skip directly to Controller Info');
 check(get('registrationCloudTitle').textContent==='Registration Required','Fresh cloud registration is accurately labelled');
 check(get('saveNodeBtn').disabled,'Save requires explicit AC assignment');
 check(!Array.from(get('nodeFormAircon').options).some(option=>option.value==='taken'),'AC profiles assigned to another controller are excluded');
 get('saveNodeBtn').form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await wait();
 check(get('registrationAssignmentError').textContent&&f.provisionCount===0,'Missing assignment shows a field error before provisioning');
 document.querySelector('[name="registrationAssignment"][value="new"]').click();change('registrationAcName','Office AC');change('nodeFormName','Office controller');
 change('nodeFormAirconType','__custom__','change');
 check(!get('registrationCustomTypeWrap').hidden&&get('saveNodeBtn').disabled,'Other / Custom requires a custom type');
 change('registrationCustomType',' Ducted custom unit ');change('registrationWifiPassword','fixture-password');
 check(!get('saveNodeBtn').disabled&&get('registrationWifiPassword').type==='password','Valid new assignment enables Save; password starts hidden');
 change('registrationAcName','Office AC / Lab – East');check(!get('saveNodeBtn').disabled,'Readable profile names allow punctuation and Unicode');change('registrationAcName','Office AC');
 get('registrationPasswordToggle').click();check(get('registrationWifiPassword').type==='text'&&get('registrationPasswordToggle').getAttribute('aria-label')==='Hide password','Eye toggle reveals password accessibly');
 get('registrationPasswordToggle').click();check(get('registrationWifiPassword').type==='password'&&get('registrationWifiPassword').value==='fixture-password','Eye toggle hides without losing the password');
 get('nodeFormBrand').focus();change('nodeFormBrand','');
 const allBrands=Array.from(get('registrationBrandList').querySelectorAll('[role="option"]')).map(el=>el.textContent);
 check(new Set(allBrands.map(v=>v.toLowerCase())).size===allBrands.length&&JSON.stringify(allBrands)===JSON.stringify([...allBrands].sort((a,b)=>a.localeCompare(b))),'Manufacturer options are deduplicated and alphabetical');
 change('nodeFormBrand','da');
 let options=[...get('registrationBrandList').querySelectorAll('[role="option"]')];
 check(options.length&&options.some(el=>el.textContent==='Daikin'),'Manufacturer search filters existing manufacturers');
 get('nodeFormBrand').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));
 get('nodeFormBrand').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
 check(get('nodeFormBrand').value==='Daikin'&&get('registrationBrandList').hidden,'Keyboard manufacturer selection works');
 get('nodeFormBrand').focus();change('nodeFormBrand','zzzz');
 check(get('registrationBrandList').textContent.includes('No matches'),'Manufacturer search provides a no-results state');
 get('nodeFormBrand').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
 check(!get('nodeModal').classList.contains('hidden'),'Escape dismisses brand choices without closing the modal');
 change('nodeFormBrand','TCL');get('nodeFormBrand').blur();
 f.reconnectError='Fixture disconnected';
 get('reconnectRegistrationBtn').click();await wait();
 check(get('registrationCloudTitle').textContent==='Reconnect required'&&get('registrationAcName').value==='Office AC','Failed reconnect preserves the assignment draft');
 f.reconnectError=null;get('reconnectRegistrationBtn').click();await wait();
 check(!get('saveNodeBtn').disabled&&f.provisionCount===0&&get('registrationWifiPassword').value==='fixture-password','Reconnect restores the same device without provisioning or clearing the password');
 f.finishError='Fixture backend rejected assignment';
 get('saveNodeBtn').click();await wait();
 check(!get('nodeModal').classList.contains('hidden')&&get('registrationAcName').value==='Office AC'&&f.completeCount===0,'Backend failure keeps form open and never claims success');
 check(f.provisionCount===1&&f.finishCount===1,'First registration refreshes credentials only once');
 f.finishError=null;f.slowFinish=true;get('saveNodeBtn').click();await wait();
 check(get('saveNodeBtn').disabled,'Save remains busy while backend confirmation is pending');
 get('nodeForm').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await wait();
 check(f.finishCount===2&&f.provisionCount===1,'Retry reuses verified cloud credentials; duplicate submissions are guarded');
 f.resolveFinish();await wait();
 check(get('nodeModal').classList.contains('hidden')&&f.completeCount===1,'Only confirmed backend registration closes the wizard');
 const ac=EcoTrackAirconSystem.AirconProfileManager.getAll().find(ac=>ac.aircon_id==='created-ac');
 check(ac&&ac.controller_node_id==='fixture-node'&&ac.node_id===f.device.device_id&&ac.aircon_type==='Ducted custom unit','Shared AC cache receives actual controller linkage and trimmed custom type');
 check(!JSON.stringify(localStorage).includes('fixture-password'),'Wi-Fi password never enters local storage');
 f.slowFinish=false;open.click();await wait();
 check(get('nodeFormName').value==='Office controller'&&get('nodeFormAircon').value==='created-ac','Reopening restores the registered controller and its existing AC');
 check(get('registrationCloudTitle').textContent==='Connected'&&get('registrationCredentialsWrap').hidden&&get('registrationWifiPassword').value==='','Verified registration does not ask for a Wi-Fi password');
 check(document.querySelector('[name="registrationAssignment"]:checked').value==='existing','Previously assigned AC is explicitly selected');
 f.mode='refresh';get('reconnectRegistrationBtn').click();await wait();
 check(!get('registrationCredentialsWrap').hidden&&get('nodeFormAircon').value==='created-ac','Credential recovery preserves the current AC assignment and requests only the needed password');
 f.mode='reuse';
 f.mode='waiting';get('reconnectRegistrationBtn').click();await wait();get('saveNodeBtn').click();await wait();
 check(get('registrationCloudMessage').textContent.includes('not reporting')&&f.provisionCount===1,'Offline device cannot save or rotate valid credentials');
 f.mode='reuse';get('reconnectRegistrationBtn').click();await wait();
 check([...get('nodeFormAircon').options].some(o=>o.value==='__custom_name__'&&o.textContent.includes('Add custom Air conditioner name')),'Available AC choices offer an admin custom-name action');
 const beforeCount=f.tables.aircons.length,controllerName=get('nodeFormName').value;
 change('nodeFormAircon','__custom_name__','change');await wait();
 check(!get('registrationCustomNameWrap').hidden&&get('nodeFormAircon').value==='created-ac','Custom name preserves the AC already assigned to this controller');
 change('registrationCustomName','Matrix');get('saveNodeBtn').click();await wait();
 check(f.tables.aircons.length===beforeCount&&f.tables.aircons.find(ac=>ac.id==='created-ac').name==='Matrix'&&f.node.name===controllerName,'Saving the admin name updates the same AC without duplicating it or changing the controller name');
 open.click();await wait();
 check([...get('nodeFormAircon').options].find(o=>o.value==='created-ac').textContent.startsWith('Matrix')&&EcoTrackAirconSystem.AirconProfileManager.getById('Office AC').name==='Matrix','Persisted AC name is restored in the dropdown and shared page cache');
 return checks;
 })()`);
 assert.equal(errors.length,0,'Native page console errors: '+errors.join('\n'));
 for(const [theme,width,height] of [['light',1120,960],['dark',1120,960],['mobile',390,844]]){
  win.setSize(width,height);await win.webContents.executeJavaScript("document.documentElement.classList.toggle('dark',"+(theme==='dark')+");document.querySelector('.registration-body').scrollTop=0;true;");
  await new Promise(resolve=>setTimeout(resolve,120));
  const layout=await win.webContents.executeJavaScript(`(()=>{const card=document.querySelector('#nodeModal > div'),footer=document.querySelector('#nodeModal .registration-footer'),box=card.getBoundingClientRect(),actions=footer.getBoundingClientRect();return {fits:box.left>=0&&box.right<=innerWidth&&box.bottom<=innerHeight,footerVisible:actions.bottom<=innerHeight&&actions.top>=0,overflow:card.scrollWidth>card.clientWidth};})()`);
  assert(layout.fits&&layout.footerVisible&&!layout.overflow,'Modal/action overflow for '+theme);
  checks.push(theme+' layout keeps modal and actions inside the viewport');
  fs.writeFileSync(path.join(out,'registration-'+theme+'.png'),(await win.webContents.capturePage()).toPNG());
 }
 fs.writeFileSync(path.join(out,'native-results.json'),JSON.stringify(checks,null,2));
 win.destroy();console.log('Native controller registration: '+checks.length+' checks passed.');app.quit();
}
app.whenReady().then(main).catch(error=>{console.error(error);app.exit(1);});
