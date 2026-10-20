'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync('public/nodes.html','utf8'),checks=[];
const section=(start,end)=>{const a=html.indexOf(start),b=html.indexOf(end,a);assert(a>=0&&b>a,start);return html.slice(a,b);};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function element(){const classes=new Set();return {value:'',textContent:'',innerHTML:'Save',disabled:false,dataset:{},attributes:{},options:[],selectedIndex:0,
 focus(){},setAttribute(k,v){this.attributes[k]=v;},removeAttribute(k){delete this.attributes[k]},addEventListener(){},replaceChildren(...items){this.options=items;},appendChild(item){this.options.push(item);},reportValidity:()=>true,
 classList:{contains:n=>classes.has(n),add:(...ns)=>ns.forEach(n=>classes.add(n)),remove:(...ns)=>ns.forEach(n=>classes.delete(n)),toggle(n,on){on?classes.add(n):classes.delete(n);}}};}
const deviceId='esp32s3-001122334455';
const registration=()=>({node:{id:'n1'},info:{device_id:deviceId,firmware_version:'fixture',wifi_ssid:'Fixture network',ip_address:'10.0.0.4',capabilities:{ir_receiver:true,ir_transmitter:false}},cloud_state:{connection_status:'online'}});
async function settle(){for(let n=0;n<30;n++)await Promise.resolve();}
function harness(){
 const elements=new Map(),handlers=new Map(),calls=[],saved=[],completed=[],toasts=[],capture=deferred(),persisted=deferred(),writes=[];
 const get=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);};
 for(const [id,value]of Object.entries({nodeFormId:deviceId,nodeFormDeviceMode:'controller',registrationAcName:'Receiver AC',nodeFormAirconType:'Split Type (Inverter)',nodeFormName:'Receiver lab',nodeFormIp:'10.0.0.4',nodeFormSsid:'Fixture network',nodeFormPassword:'fixture-password',nodeFormBuilding:'b1',nodeFormFloor:'f1',nodeFormRoom:'r1',editNodeIdHidden:deviceId,editNodeIp:'10.0.0.4'}))get(id).value=value;
 get('nodeFormAircon').options=[{value:''},{value:'existing-ac'}];
 const db={aircons:[{id:'existing-ac',asset_tag:'Existing AC',brand:'Daikin',protocol_name:'DAIKIN64'}],buildings:[{id:'b1',name:'Fixture building'}],floors:[{id:'f1',name:'Fixture floor',building_id:'b1'}],rooms:[{id:'r1',name:'Fixture room',floor_id:'f1'}]};
 let denied=null;
 const window={document:{getElementById:get,querySelector:()=>({value:get('nodeFormAircon').value?'existing':'new'})},EcoTrackHardwareCloud:{registrationStatus:async info=>({state:'refresh',info,node:null}),validateAssignment:async()=>({valid:true}),reconnect:async id=>({device_id:id,wifi_status:'connected',wifi_ssid:'Fixture network',ip_address:'10.0.0.4',capabilities:{ir_receiver:true}}),connect:async id=>({device_id:id,wifi_status:'connected',wifi_ssid:'Fixture network',ip_address:'10.0.0.4'}),register:async(...args)=>{calls.push(args);return capture.promise;},completeRegistration:id=>completed.push(id)},EcoToast:{show:(message,kind)=>toasts.push({message,kind})},EcoDataBus:{invalidate(){}}};
 window.supabaseClient={from(table){let id,payload;const q={then(yes,no){return Promise.resolve({data:db[table]||[],error:null}).then(yes,no)},select(){return q;},eq(k,v){id=v;return q;},insert(v){payload=v[0];return q;},async maybeSingle(){return {data:db[table].find(r=>r.id===id),error:null};},async single(){
 if(denied===table)return {data:null,error:{message:'Location save denied'}};
 assert(!Object.hasOwn(payload,'id'),'IDs must come from Supabase defaults');const row={id:table+'-server-'+db[table].length,...payload};writes.push({table,payload});db[table].push(row);return {data:row,error:null};
 }};return q;}};
 const context=vm.createContext({window,console,TextEncoder,crypto:require('node:crypto'),POPULAR_AC_BRANDS:['Daikin','TCL'],Option:class{constructor(text,value){this.textContent=text;this.value=value}},document:window.document,setTimeout:()=>1,openBtn:get('openAddNodeBtn'),
 NodeService:{saveNode:async data=>{saved.push(data);return persisted.promise;},getNode:()=>({db_id:'n1',node_id:deviceId,brand:null}),saveRemoteProfile:async()=>{throw Error('Unnecessary profile save');}},
 CapabilityEngine:{resolveProtocolName:brand=>brand?'DAIKIN':null},ProtocolAdapter:{detectRemoteBrand:async()=>({success:true,brand:'Daikin',protocol:'DAIKIN2'})},
 renderBrandChips(){},renderNodes(){},setNodeModalStep(){},resetDeviceIpFeedback(){},updateDeviceIpResult(){},setDeviceIpFeedback(){},updateNextButtonState(){},nodeCurrentPage:1,
 _cachedBuildings:[...db.buildings],_cachedFloors:[...db.floors],_cachedRooms:[...db.rooms],
 currentModalStep:3,selectedBleDevice:{nodeId:deviceId,info:{device_id:deviceId}},wifiConfirmedFor:'Fixture network',
 AirconProfileManager:{getById:()=>null},modal:get('nodeModal'),saveNodeBtn:get('saveNodeBtn'),form:{addEventListener:(name,fn)=>handlers.set(name,fn)}});
 vm.runInContext(fs.readFileSync('public/js/controller-locations.js','utf8'),context);
 vm.runInContext(fs.readFileSync('public/js/controller-registration.js','utf8'),context);
 window.EcoTrackControllerRegistration.mount=()=>{};
 vm.runInContext(section('      const remoteCapture = {','      let nodeCurrentPage = 1;')+
 section('      // Connection diagnostics and existing Wi-Fi reuse.','      async function scanForBleDevices()')+
 section('      function updateConfigSummary() {','      // Manage state and restrictions')+
 section('      function closeModal() {',"      closeBtn.addEventListener('click'")+
 section('      async function loadRegistrationAirconChoices(', '      // Modal open/close')+
 section('      // Enter in a text field',"      const nPrev = document.getElementById('nodePrevBtn');"),context);
 vm.runInContext("registrationBluetoothLive=true;registrationCheck={state:'refresh'};registrationAircons=[{id:'existing-ac',brand:'Daikin',protocol_name:'DAIKIN64'}];",context);
 return {get,window,context,calls,saved,completed,toasts,capture,persisted,writes,db,handlers,deny:table=>denied=table,submit:()=>handlers.get('submit')({preventDefault(){}})};
}
async function main(){
 assert(!html.includes('id="editNodeStatus"'));assert.match(html,/id="editNodeIp"[^>]*readonly/);checks.push('Editable Status removed; IP stays hardware-reported');
 let app=harness();vm.runInContext("selectedBleDevice=null; resetRemoteDetection('register');",app.context);
 assert.equal(app.get('registerRemoteBtn').disabled,true);let learned=0;app.context.ProtocolAdapter.detectRemoteBrand=async()=>learned++;
 await app.context.listenForRemote('register');assert.equal(learned,0);checks.push('Remote detection requires an actual Bluetooth selection');
 app=harness();const ir=deferred();let options;app.context.ProtocolAdapter.detectRemoteBrand=async(id,opt)=>{assert.equal(id,deviceId);options=opt;opt.onListening();return ir.promise;};
 const listening=app.context.listenForRemote('register');assert.equal(options.nearby,true);assert.equal(app.calls.length,0);assert.equal(app.get('saveNodeBtn').disabled,true);
 ir.resolve({success:true,brand:'Daikin',protocol:'DAIKIN2',capture:{raw_count:10}});await listening;
 assert.equal(app.get('nodeFormBrand').value,'');assert.match(app.get('registerRemoteStatus').textContent,/DAIKIN2/);assert.equal(app.get('registerRemoteBtn').disabled,false);assert.equal(app.calls.length,0);
 checks.push('Bluetooth remote detection works before registration without adding a controller');
 let enterPrevented=false;app.handlers.get('keydown')({key:'Enter',target:{tagName:'INPUT',type:'password'},preventDefault(){enterPrevented=true;}});
 assert(enterPrevented);assert.equal(app.calls.length,0);checks.push('Password Enter does not implicitly register a device');
 for(const role of ['monitoring','both']) {
  app=harness();app.get('nodeFormDeviceMode').value=role;app.get('registrationPressureSensor').value='MPX5010DP';app.get('registrationPressureMin').value='0';app.get('registrationPressureMax').value='10000';
  const pending=app.submit();await settle();app.capture.resolve(registration());app.persisted.resolve();await pending;
  assert.equal(app.saved[0].registration_assignment.device_mode,role);assert.equal(app.saved[0].registration_assignment.sensor_config.pressure_min_pa,0);
  if(role==='monitoring')assert.equal(app.saved[0].registration_assignment.protocol_name,null);
 }
 checks.push('Monitoring/Both submit explicit device roles and sensor configuration; monitoring never submits an IR protocol');
 app=harness();app.get('nodeFormDeviceMode').value='';await app.submit();assert.equal(app.calls.length,0);
 app.get('nodeFormDeviceMode').value='monitoring';await app.submit();assert.equal(app.calls.length,0);
 checks.push('Missing device role or sensor range blocks registration before credentials or metadata writes');
 app=harness();const saving=app.submit();await settle();assert.equal(app.calls.length,1);assert.equal(app.get('saveNodeBtn').disabled,true);assert.equal(app.get('registrationCloudStatus').dataset.state,'verifying');
 await app.submit();app.context.closeModal();assert.equal(app.calls.length,1);assert.equal(app.get('nodeModal').classList.contains('hidden'),false);
 app.capture.resolve(registration());await settle();assert.equal(app.saved.length,1);assert.equal(app.saved[0].name,'Receiver lab');assert.equal(app.saved[0].room_id,'r1');assert.equal(app.completed.length,0);
 app.persisted.resolve();await saving;assert.deepEqual(app.completed,['n1']);assert.equal(app.get('registrationCloudStatus').dataset.state,'verified');assert.equal(app.get('nodeModal').classList.contains('hidden'),true);
 checks.push('Save waits for heartbeat and metadata/AC binding, guards duplicates, then publishes completion');
 app=harness();const failure=app.submit();await settle();app.capture.reject(Error('Cloud authentication rejected'));await failure;
 assert.equal(app.get('registrationCloudStatus').dataset.state,'failed');assert.equal(app.saved.length,0);assert.equal(app.get('saveNodeBtn').disabled,false);assert.equal(app.completed.length,0);
 checks.push('Cloud failure stays incomplete and leaves Save available for retry');
 app.window.EcoTrackHardwareCloud.register=async(...args)=>{app.calls.push(args);return registration();};app.persisted.resolve();await app.submit();
 assert.equal(app.calls.length,2);assert.equal(app.get('registrationCloudStatus').dataset.state,'verified');checks.push('Rejected registration can be retried');
 app=harness();const failedMetadata=app.submit();await settle();app.capture.resolve(registration());await settle();app.persisted.reject(Error('Metadata denied'));await failedMetadata;
 assert.equal(app.completed.length,0);assert.equal(app.get('registrationCloudStatus').dataset.state,'failed');assert.equal(app.get('nodeModal').classList.contains('hidden'),false);
 checks.push('Metadata failure cannot mark the draft complete or close the form');
 app=harness();app.get('nodeFormBrand').value='Daikin';const exact=deferred();app.context.ProtocolAdapter.detectRemoteBrand=async()=>({success:true,brand:'Daikin',protocol:'DAIKIN64'});
 await app.context.listenForRemote('register');const variant=app.submit();await settle();app.capture.resolve(registration());app.persisted.resolve();await variant;
 assert.equal(app.saved[0].protocol_name,'DAIKIN64');checks.push('Registration preserves the exact detected IR variant and has no redundant profile write');
 app=harness();app.get('nodeFormAircon').value='existing-ac';app.context.AirconProfileManager.getById=()=>({brand:'Daikin',protocol_name:'DAIKIN64'});
 const existing=app.submit();await settle();app.capture.resolve(registration());app.persisted.resolve();await existing;
 assert.equal(app.saved[0].aircon_id,'existing-ac');assert.equal(app.saved[0].brand,'Daikin');assert.equal(app.saved[0].protocol_name,'DAIKIN64');
 checks.push('Choosing an existing AC with an empty brand field retains its real brand and protocol');
 app=harness();const transmitter=registration();transmitter.info.capabilities.ir_transmitter=true;
 const txRegistration=app.submit();await settle();app.capture.resolve(transmitter);app.persisted.resolve();await txRegistration;
 assert.equal(app.saved[0].ir_tx,true);assert.equal(app.saved[0].ir_rx,true);assert.equal(app.saved[0].hardware,'ESP32-S3 IR controller');assert(app.saved[0].controls.includes('IR Control'));
 checks.push('A receiver/transmitter sketch enables control using its reported capability instead of a fixed receiver-only registration');
 app=harness();app.get('nodeFormPassword').value='';app.get('registrationWifiPassword').value='fixture-password';
 vm.runInContext("existingWifiInfo={device_id:'"+deviceId+"',wifi_status:'connected',wifi_ssid:'Fixture network',ip_address:'10.0.0.4',cloud_status:'error'};",app.context);
 const recovery=app.submit();await settle();assert.equal(app.calls[0][1].pass,'fixture-password');app.capture.resolve(registration());app.persisted.resolve();await recovery;assert.equal(app.completed.length,1);
 checks.push('Already connected Wi-Fi can repair a deleted cloud credential from Step 3');
 app=harness();app.get('nodeFormRoom').value='custom';app.get('nodeFormCustomRoom').value='New lab';app.deny('rooms');
 await app.submit();assert.equal(app.calls.length,0);assert.equal(app.context._cachedRooms.length,1);app.deny(null);app.capture.resolve(registration());app.persisted.resolve();await app.submit();
 assert.equal(app.writes[0].payload.floor_id,'f1');assert.equal(app.saved[0].room_id,'rooms-server-1');
 checks.push('Custom room failure does not enter the cache; retry uses the server ID and actual floor');
 app=harness();app.db.rooms.length=0;await app.submit();
 assert.equal(app.calls.length,0);assert.equal(app.get('registrationCloudStatus').dataset.state,'failed');assert.match(app.toasts.at(-1).message,/no longer available/);
 checks.push('A deleted room is rejected before rotating hardware credentials');
 app=harness();let closed=false;const edits=[];app.context.editForm=app.get('editNodeForm');app.context.saveEditBtn=app.get('saveEditNodeBtn');app.context.editSaving=false;
 app.context.closeEditNodeModal=()=>closed=true;app.context.NodeService.editDevice=async(id,payload)=>edits.push(payload);
 for(const level of ['Building','Floor','Room'])app.get('editNode'+level).value='custom';
 app.get('editNodeCustomBuilding').value='New building';app.get('editNodeCustomFloor').value='New floor';app.get('editNodeCustomRoom').value='New room';app.get('editNodeName').value='Renamed receiver';
 vm.runInContext(section('      async function handleSaveEditNode()', '      if (saveEditBtn) saveEditBtn.addEventListener'),app.context);
 app.deny('buildings');await app.context.handleSaveEditNode();assert.equal(edits.length,0);assert(!closed);assert.equal(app.context._cachedBuildings.length,1);
 app.deny(null);await app.context.handleSaveEditNode();assert.equal(edits.length,1);assert(closed);assert.equal(edits[0].brand,null);assert(!Object.hasOwn(edits[0],'status'));
 assert.equal(edits[0].room_id,app.context._cachedRooms.at(-1).id);assert.equal(app.context._cachedRooms.at(-1).floor_id,app.context._cachedFloors.at(-1).id);
 checks.push('Edit saves a complete custom hierarchy without requiring a brand or changing real status');
 app=harness();app.context.ProtocolAdapter.detectRemoteBrand=async()=>{throw Error('Controller is sleeping');};await app.context.listenForRemote('edit');assert.match(app.get('editRemoteStatus').textContent,/sleeping/);assert.equal(app.get('saveEditNodeBtn').disabled,false);checks.push('IR failures remain actionable and release edit controls');
 app=harness();app.get('nodeFormRoom').value='custom';app.get('nodeFormCustomRoom').value='Preserved room';
 app.window.EcoTrackHardwareCloud.reconnect=async()=>{throw Object.assign(new Error('Bluetooth disconnected. Select Reconnect ESP32.'),{code:'BLE_DISCONNECTED'});};
 await app.submit();assert.equal(app.calls.length,0);assert.equal(app.writes.length,0);assert.equal(app.get('registrationCloudStatus').dataset.state,'bluetooth');
 assert.equal(app.get('nodeFormCustomRoom').value,'Preserved room');assert.equal(app.get('nodeFormName').value,'Receiver lab');assert.equal(app.get('nodeFormPassword').value,'fixture-password');
 assert.equal(app.get('saveNodeBtn').disabled,true);assert.equal(app.get('reconnectRegistrationBtn').disabled,false);
 checks.push('A dropped Bluetooth connection preserves the form and is reported before location writes or credential rotation');
 app=harness();app.window.EcoTrackHardwareCloud.reconnect=async()=>({device_id:'esp32s3-ffeeddccbbaa',wifi_status:'connected',wifi_ssid:'Fixture network',ip_address:'10.0.0.9'});
 await app.submit();assert.equal(app.calls.length,0);assert.equal(app.writes.length,0);assert.equal(app.get('registrationCloudStatus').dataset.state,'bluetooth');
 checks.push('A different ESP32 cannot be registered under the selected controller details');
 app=harness();app.window.EcoTrackHardwareCloud.reconnect=async()=>({device_id:deviceId,wifi_status:'connected',wifi_ssid:'Changed network',ip_address:'10.0.0.4'});
 await app.submit();assert.equal(app.calls.length,0);assert.equal(app.context.wifiConfirmedFor,null);assert.match(app.toasts.at(-1).message,/Wi-Fi connection has changed/);
 checks.push('Changed Wi-Fi must be verified before any registration write');
 app=harness();const reconnect=deferred();let selections=0;app.window.EcoTrackHardwareCloud.reconnect=async id=>{assert.equal(id,deviceId);selections++;return reconnect.promise;};
 app.window.EcoTrackHardwareCloud.connect=async()=>{throw Error('Reconnect must not open the picker');};
 const reconnecting=app.context.reconnectRegistrationController();assert.equal(app.get('saveNodeBtn').disabled,true);assert.equal(app.get('reconnectRegistrationBtn').attributes['aria-busy'],'true');
 await app.context.reconnectRegistrationController();assert.equal(selections,1);
 reconnect.resolve({device_id:deviceId,wifi_status:'connected',wifi_ssid:'Fixture network',ip_address:'10.0.0.6'});await reconnecting;
 assert.equal(app.get('nodeFormName').value,'Receiver lab');assert.equal(app.get('nodeFormRoom').value,'r1');assert.equal(app.get('nodeFormPassword').value,'fixture-password');
 assert.equal(app.get('registrationCloudStatus').dataset.state,'pending');assert.equal(app.calls.length,0);assert.equal(app.get('saveNodeBtn').disabled,false);
 checks.push('Step 3 reconnect reuses the known device, checks live Wi-Fi, preserves values, guards duplicates, and never saves automatically');
 app=harness();app.window.EcoTrackHardwareCloud.reconnect=async()=>({device_id:deviceId,wifi_status:'connected',wifi_ssid:'Changed network',ip_address:'10.0.0.8'});
 await app.context.reconnectRegistrationController();assert.equal(app.get('nodeFormSsid').value,'Changed network');assert.equal(app.get('nodeFormPassword').value,'');assert.equal(app.get('registrationWifiPassword').value,'');
 checks.push('Reconnecting to a changed SSID discards the old network password');
 app=harness();const late=deferred();app.window.EcoTrackHardwareCloud.reconnect=()=>late.promise;const waiting=app.context.reconnectRegistrationController();app.context.closeModal();late.resolve({device_id:deviceId,wifi_status:'connected',wifi_ssid:'New network',ip_address:'10.0.0.7'});await waiting;
 assert.equal(app.get('nodeFormSsid').value,'Fixture network');assert.equal(app.get('nodeModal').classList.contains('hidden'),true);assert.equal(app.calls.length,0);
 checks.push('A late reconnect reply cannot repopulate a closed wizard');
 app=harness();app.context.reportRegistrationFailure(Object.assign(new Error('GATT read failed while the link remains connected.'),{code:'BLE_CONNECTION_FAILED',bluetooth_connected:true}));
 assert.equal(app.get('registrationCloudStatus').dataset.state,'bluetooth_request');assert.doesNotMatch(app.get('summaryStatusBadge').textContent,/disconnected/);
 assert.equal(app.get('chooseRegistrationBtn').classList.contains('hidden'),false);
 checks.push('A connected GATT failure requests a retry without claiming the Bluetooth link disconnected');
 app.context.acceptLiveBluetoothInfo({device_id:deviceId,wifi_status:'connected',wifi_ssid:'Fixture network',ip_address:'10.0.0.6',cloud_status:'error',firmware_version:'cloud-ir-controller-1.3-rxtx',capabilities:{ir_receiver:true,ir_transmitter:true}});
 assert.equal(app.get('registrationCloudStatus').dataset.state,'pending');assert.equal(app.get('nodeFormFw').value,'cloud-ir-controller-1.3-rxtx');assert.equal(app.get('nodeFormHw').value,'ESP32-S3 IR receiver + transmitter');
 assert.equal(app.get('nodeFormIp').value,'10.0.0.6');assert.equal(app.get('nodeFormName').value,'Receiver lab');assert.equal(app.calls.length,0);
 checks.push('A fresh device reply clears a stale Bluetooth warning and shows actual firmware and hardware capabilities without saving');
 app.context.setRegistrationCloudStatus('failed','Actual cloud authentication failure');
 app.context.acceptLiveBluetoothInfo({device_id:deviceId,wifi_status:'connected',wifi_ssid:'Fixture network',ip_address:'10.0.0.6',firmware_version:'actual',capabilities:{}});
 assert.equal(app.get('registrationCloudStatus').dataset.state,'failed');assert.equal(app.get('registrationCloudMessage').textContent,'Actual cloud authentication failure');
 checks.push('A Bluetooth reply cannot erase a genuine cloud failure or mark Supabase verified');
 app=harness();let chooserCalls=0;app.window.EcoTrackHardwareCloud.connect=async id=>{chooserCalls++;return {device_id:id,wifi_status:'connected',wifi_ssid:'Fixture network',ip_address:'10.0.0.4'};};
 await app.context.reconnectRegistrationController(true);assert.equal(chooserCalls,1);assert.equal(app.calls.length,0);
 checks.push('Choosing a device again is a separate explicit action and still does not register automatically');
 assert.match(html,/id="nodeFormFw"[^>]*readonly/);assert.match(html,/id="nodeFormHw"[^>]*readonly/);
 checks.push('Firmware and hardware capability fields are read-only device reports');
 for(const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))if(script[1].trim())new vm.Script(script[1]);
 fs.mkdirSync('reports/controller-workflow',{recursive:true});fs.writeFileSync('reports/controller-workflow/registration-tests.json',JSON.stringify({passed:checks.length,checks,physical_hardware_tested:false},null,2));
 console.log('Registration progress: '+checks.length+' checks passed.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
