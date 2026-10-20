const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const checks=[];
async function main(){
 const handlers=new Map(),callbacks=[];
 const frame={url:pathToFileURL(path.resolve('public/nodes.html')).href};
 const sender={mainFrame:frame,getURL:()=>frame.url};
 const source=fs.readFileSync('src/main.js','utf8');
 const trusted=source.slice(source.indexOf('function isTrustedDatabaseCaller('),source.indexOf('let databaseSessionSync'));
 const pairing=source.slice(source.indexOf('const bluetoothSelections = new Map();'),source.indexOf("ipcMain.handle('scan-ble'"));
 const context=vm.createContext({require,path,__dirname:path.resolve('src'),mainWindow:{webContents:sender},ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},setTimeout:()=>1,clearTimeout:()=>{},console});
 vm.runInContext(trusted+pairing+'\nglobalThis.maps={bluetoothSelections,bluetoothPairings};',context);
 const trustedEvent={sender,senderFrame:frame};
 const maps=context.maps;
 maps.bluetoothSelections.set('choose',{sender,devices:[{deviceId:'real-device'}],callback:value=>callbacks.push(value),timer:1});
 let response=await handlers.get('bluetooth-select-response')({sender:{},senderFrame:frame},{request_id:'choose',device_id:'real-device'});assert.equal(response.success,false);assert.equal(callbacks.length,0);checks.push('Untrusted renderer cannot authorize BLE selection');
 response=await handlers.get('bluetooth-select-response')(trustedEvent,{request_id:'choose',device_id:'invented-device'});assert.equal(response.success,false);assert.equal(callbacks.length,0);checks.push('Only actual discovered devices can be selected');
 response=await handlers.get('bluetooth-select-response')(trustedEvent,{request_id:'choose',device_id:'real-device'});assert.equal(response.success,true);assert.equal(callbacks[0],'real-device');
 response=await handlers.get('bluetooth-select-response')(trustedEvent,{request_id:'choose',device_id:'real-device'});assert.equal(response.success,false);assert.equal(callbacks.length,1);checks.push('Selection callback can be used once');
 maps.bluetoothPairings.set('pair',{sender,kind:'providePin',callback:value=>callbacks.push(value),timer:1});
 response=await handlers.get('bluetooth-pairing-response')(trustedEvent,{request_id:'pair',confirmed:true,pin:'wrong'});assert.equal(response.success,false);assert.equal(callbacks.length,1);
 response=await handlers.get('bluetooth-pairing-response')(trustedEvent,{request_id:'pair',confirmed:true,pin:'123456'});assert.equal(response.success,true);assert.equal(callbacks[1].pin,'123456');checks.push('Secure pairing validates and forwards a six-digit PIN');
 // Exercise the production renderer's Just Works confirmation and main-process callback.
 const pairingListeners=new Map(), createdTags=[], dialogButtons=[];
 const pinlessDocument={body:{append(node){pinlessDocument.dialog=node;}},createElement(tag){
  createdTags.push(tag);
  const listeners=new Map();
  const el={style:{},children:[],textContent:'',append(...children){this.children.push(...children);},
   addEventListener(event,fn){listeners.set(event,fn);},showModal(){},close(){},remove(){},focus(){},setAttribute(){},
   click(){listeners.get('click')?.();}};
  if(tag==='button')dialogButtons.push(el);
  return el;
 }};
 const pairingRoot={document:pinlessDocument,electron:{on:(event,fn)=>pairingListeners.set(event,fn),
  invoke:async(channel,data)=>handlers.get(channel)(trustedEvent,data)}};
 const pinlessContext=vm.createContext({window:pairingRoot,console});
 vm.runInContext(fs.readFileSync('public/js/hardware-cloud.js','utf8'),pinlessContext);
 maps.bluetoothPairings.set('pair-no-pin',{sender,kind:'confirm',callback:value=>callbacks.push(value),timer:1});
 const confirming=pairingListeners.get('bluetooth-pairing-request')({}, {request_id:'pair-no-pin',pairingKind:'confirm',deviceId:'real-device'});
 assert(!createdTags.includes('input'),'Just Works confirmation must not create a PIN field');
 const pairButton=dialogButtons.find(button=>button.textContent==='Pair');
 assert(pairButton);
 pairButton.click();
 await confirming;
 assert.equal(callbacks.at(-1).confirmed,true);
 assert.equal(callbacks.at(-1).pin,undefined);
 checks.push('Actual desktop Just Works confirmation pairs without creating or requesting a PIN');
 // Exercise the actual schedule UI function, including failed writes.
 const scheduler=fs.readFileSync('public/js/scheduler.js','utf8');
 const apply=scheduler.slice(scheduler.indexOf('async function applyNodeSchedule('),scheduler.indexOf('// Custom Warning Modal'));
 const inputs={'wake-controller':{value:'06:00'},'sleep-controller':{value:'22:00'},'interval-val-controller':{value:'30'},'interval-unit-controller':{value:'Minutes'}};
 const localNodes=[{node_id:'controller',wake_time:'05:00',sleep_time:'21:00',interval_val:15,interval_unit:'Minutes'}];
 const rooms={room:{nodes:[{id:'controller',wakeTime:'05:00',sleepTime:'21:00',intervalVal:15,intervalUnit:'Minutes'}]}};
 const toast=[];let failed=true,request;
 const ui=vm.createContext({document:{getElementById:id=>inputs[id]},savedRooms:rooms,scheduleDrafts:new Map(),scheduleDeliveries:new Map(),localStorage:{setItem:()=>{}},CustomEvent:class{constructor(name,options){this.name=name;this.detail=options.detail;}},console,
  window:{EcoTrackHardwareCloud:{request:async(...args)=>{request=args;if(failed)throw new Error('Database denied request');return {id:'queued-command',status:'queued'};}},EcoTrackAirconSystem:{NodeService:{getNodes:()=>localNodes}},EcoToast:{error:message=>toast.push(message),success:message=>toast.push(message)},dispatchEvent:()=>{}}});
 const timeHelpers=scheduler.slice(scheduler.indexOf('function normalizeScheduleTime('),scheduler.indexOf('function composeTimeValue('));
 vm.runInContext(timeHelpers+apply,ui);
 const button={disabled:false,textContent:'Apply'};
 await ui.applyNodeSchedule('controller',button);assert.equal(localNodes[0].wake_time,'05:00');assert.equal(rooms.room.nodes[0].intervalVal,15);assert.equal(button.textContent,'Apply');checks.push('Failed schedule write preserves local saved settings');
 failed=false;await ui.applyNodeSchedule('controller',button);assert.equal(request[2].interval_seconds,1800);assert.equal(request[2].interval_val,30);assert.equal(request[2].interval_unit,'Minutes');assert.equal(request[3].wait,false);assert.equal(button.textContent,'Queued');assert.equal(localNodes[0].wake_time,'06:00');checks.push('Confirmed schedule queue preserves selected units and labels delivery as queued');
 ui.window.EcoTrackHardwareCloud.waitForResult=async()=>({success:true,command_id:'queued-command',interval_ms:1800000,wake_time:'06:00',sleep_time:'22:00'});
 await ui.applyNodeSchedule('controller',button); await Promise.resolve(); assert.equal(button.textContent,'Applied'); checks.push('Applied label requires a matching hardware receipt');
 ui.window.EcoTrackHardwareCloud.waitForResult=async()=>({success:true,command_id:'queued-command',interval_ms:1,wake_time:'06:00',sleep_time:'22:00'});
 await ui.applyNodeSchedule('controller',button); await Promise.resolve(); await Promise.resolve(); assert.equal(button.textContent,'Failed'); checks.push('Mismatched hardware receipt cannot show Applied');
 inputs['wake-controller'].value='25:00';request=null;await ui.applyNodeSchedule('controller',button);assert.equal(request,null);checks.push('UI rejects invalid clocks before sending');
 // Parse every inline script in changed pages.
 const pages=[];for(const file of fs.readdirSync('public').filter(file=>file.endsWith('.html'))){const html=fs.readFileSync('public/'+file,'utf8');if(!html.includes('hardware-cloud.js'))continue;for(const block of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))if(block[1].trim())new vm.Script(block[1],{filename:file});pages.push(file);}
 checks.push('Changed page inline JavaScript parses');
 fs.writeFileSync('reports/cloud-hardware/ui-tests.json',JSON.stringify({checks,passed:checks.length,pages,browser_visual_tested:false},null,2));console.log(`Hardware UI/IPC: ${checks.length} checks passed.`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
