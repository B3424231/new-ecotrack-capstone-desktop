'use strict';
// In-memory Supabase fixtures only: this test never reads credentials or accesses a network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/^\uFEFF/, '');
const copy = value => JSON.parse(JSON.stringify(value));
const checks = [];
const pages = ['dashboard.html','control.html','scheduler.html','nodes.html','ir-library.html'];
const store = new Map();
const storage = { getItem: key => store.get(key) ?? null, setItem: (key,val) => store.set(key,String(val)), removeItem: key => store.delete(key) };
const channels = [];
class BroadcastChannel {
  constructor(name) { this.name = name; channels.push(this); }
  postMessage(data) { for (const peer of channels) if (peer !== this && peer.name === this.name) peer.onmessage?.({data:copy(data)}); }
  close() { channels.splice(channels.indexOf(this),1); }
}
const stamp = () => new Date().toISOString();
const deviceId = 'esp32s3-001122334455';
const asset = 'AC-East / 01';
const db = {
  buildings:[{id:'b1',name:'East'}], floors:[{id:'f1',building_id:'b1',name:'Ground'}],
  rooms:[{id:'r1',floor_id:'f1',name:'Lab'},{id:'r2',floor_id:'f1',name:'Workshop'}],
  nodes:[{id:'db-node',name:deviceId,room_id:'r1',brand:'Daikin',protocol_name:'DAIKIN',status:'online',temp:null,wake_time:'00:00',sleep_time:'23:00',interval_val:500,interval_unit:'Milliseconds'}],
  aircons:[{id:'db-ac',asset_tag:asset,node_id:'db-node',controller_node_id:'db-node',room_id:'r1',brand:'Daikin',protocol_name:'DAIKIN2',protocol:'DAIKIN2',model:'Split',aircon_type:'Split',status:'online'}],
  ecotrack_device_state:[{node_id:'db-node',device_id:deviceId,last_seen:stamp(),capabilities:{ir_receiver:true,ir_transmitter:true},latest_ir:{protocol:'DAIKIN2',raw_type:'DAIKIN2',raw_data:'3500,1750,450,1300',hex:'0x1234'}}],
  ecotrack_device_commands:[]
};
let failure = null, mismatch = false;
const writes = [], reads = [], realtime = [];
function from(table) {
  reads.push(table);
  let filters=[], either=null, operation=null, payload=null, executed=false, outcome;
  const matches = row => filters.every(([key,value]) => row[key] === value) && (!either || either.split(',').some(term => {
    const [key,op,...rest] = term.split('.'); return op==='eq' && String(row[key])===rest.join('.');
  }));
  function execute() {
    if (executed) return outcome; executed=true;
    if (failure && (!failure.table || failure.table===table) && (!failure.operation || failure.operation===operation)) return outcome={data:null,error:{message:failure.message}};
    const rows = db[table] ||= []; let result=rows.filter(matches);
    if (operation) writes.push({table,operation,payload:copy(payload||{}),filters:copy(filters)});
    if (operation==='delete') db[table]=rows.filter(row=>!matches(row));
    if (operation==='update') { for(const row of result) Object.assign(row,payload); }
    if (operation==='upsert' || operation==='insert') {
      const items=Array.isArray(payload)?payload:[payload]; result=[];
      for (const item of items) {
        const key=table==='aircons'?'asset_tag':'id';
        let row=operation==='upsert'?rows.find(row=>row[key]===item[key]):null;
        if(row) Object.assign(row,copy(item));
        else { row={id:item.id||'fixture-'+(item.asset_tag||rows.length),...copy(item)};rows.push(row); }
        result.push(row);
      }
    }
    const data=copy(result);
    if (mismatch && operation==='upsert' && table==='aircons') data[0].controller_node_id='wrong-controller';
    return outcome={data,error:null};
  }
  const q={
    select(){return q;},eq(k,v){filters.push([k,v]);return q;},or(v){either=v;return q;},
    order(){return q;},limit(){return q;},in(k,values){return q;},
    update(v){operation='update';payload=v;return q;},upsert(v){operation='upsert';payload=v;return q;},
    insert(v){operation='insert';payload=v;return q;},delete(){operation='delete';return q;},
    async single(){const r=execute();return {...r,data:r.data?.[0]||null};},
    async maybeSingle(){const r=execute();return {...r,data:r.data?.[0]||null};},
    then(resolve,reject){return Promise.resolve(execute()).then(resolve,reject);}
  };return q;
}
const sb={
  channel(name){const handlers=[];const channel={on(_event,filter,callback){handlers.push({filter,callback});return channel;},subscribe(callback){realtime.push({name,handlers,callback});return channel;}};return channel;},
  from,auth:{getSession:async()=>({data:{session:{user:{id:'fixture-admin'}}},error:null})},
  async rpc(name,args){
    if(failure?.operation==='rpc')return {data:null,error:{message:failure.message}};
    if(name==='ecotrack_device_mutation'){
      assert.equal(args.p_operation,'update_node');
      const node=db.nodes.find(n=>n.id===args.p_id);Object.assign(node,copy(args.p_payload));
      writes.push({table:'nodes',operation:'rpc',payload:copy(args.p_payload)});
      return {data:{node:copy(node)},error:null};
    }
    if(name==='ecotrack_finish_controller_registration'){
      const setup=args.p_setup,node=db.nodes.find(n=>n.id===args.p_node_id),ac=db.aircons.find(a=>a.id===setup.aircon_id);
      assert(node&&ac);assert.equal(args.p_device_id,deviceId);
      Object.assign(node,{name:setup.controller_name,brand:setup.brand,aircon_type:setup.aircon_type,room_id:setup.room_id});
      Object.assign(ac,{node_id:node.id,controller_node_id:node.id,brand:setup.brand,model:setup.aircon_type,aircon_type:setup.aircon_type,room_id:setup.room_id,protocol_name:setup.protocol_name});
      writes.push({table:'registration',operation:'rpc',payload:copy(args)});
      return {data:{success:true,connected:true,node:copy(node),aircon:copy(ac),cloud_state:copy(db.ecotrack_device_state[0])},error:null};
    }
    assert.equal(name,'ecotrack_cloud_request');
    const row={id:args.p_request_id,node_id:args.p_node_id,kind:args.p_kind,payload:copy(args.p_payload),status:'queued',created_at:stamp()};
    db.ecotrack_device_commands.push(row);writes.push({table:'ecotrack_device_commands',operation:'rpc',payload:copy(args)});
    if(row.kind==='ac_intent'){
      const ac=db.aircons.find(ac=>ac.controller_node_id===row.node_id);
      Object.assign(ac,{desired_state:copy(row.payload.state),command_id:row.id,command_status:'queued',commanded_at:row.created_at});
    }
    if(row.kind==='learn_ir')Object.assign(row,{status:'completed',result:{command_id:row.id,success:true,protocol:'DAIKIN2',raw_type:'DAIKIN2',raw_data:'3500,1750,450,1300',hex:'0x1234'}});
    return {data:copy(row),error:null};
  }
};
const quiet={log(){},warn(){},error(...args){throw new Error(args.join(' '));}};
function makePage(page){
  const listeners=new Map(), docListeners=new Map(), timers=new Map(), intervals=new Map();let timerId=0;
  const doc={visibilityState:'visible',addEventListener(name,fn){if(!docListeners.has(name))docListeners.set(name,[]);docListeners.get(name).push(fn);},getElementById(){return null;},querySelectorAll(){return [];}};
  const window={localStorage:storage,BroadcastChannel,crypto:crypto.webcrypto,performance,location:{search:'?id='+encodeURIComponent(asset)},addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push(fn);},dispatchEvent(){},ensureLocationHierarchy(){}};
  const context=vm.createContext({window,document:doc,localStorage:storage,BroadcastChannel,console:quiet,Date,performance,TextEncoder,TextDecoder,URLSearchParams,Uint8Array,structuredClone,CustomEvent:class{constructor(type,opts){this.type=type;this.detail=opts.detail;}},setTimeout:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),setInterval:(fn,ms)=>{const id=++timerId;intervals.set(id,{fn,ms});return id;},clearInterval:id=>intervals.delete(id),requestAnimationFrame:fn=>fn(),fetch:async()=>{throw new Error('Network access prohibited in fixtures');}});
  vm.runInContext(read('public/js/aircon-system.js'),context,{filename:page+':engine'});
  context.CapabilityEngine=window.EcoTrackAirconSystem.CapabilityEngine;
  context.NodeService=window.EcoTrackAirconSystem.NodeService;
  window.supabaseClient=sb;
  vm.runInContext(read('public/js/hardware-cloud.js'),context,{filename:page+':cloud'});
  return {page,context,window,doc,listeners,docListeners,timers,intervals,system:window.EcoTrackAirconSystem};
}
function element(tag='div'){
  const handlers=new Map(), classes=new Set();
  const el={tagName:tag.toUpperCase(),value:'',textContent:'',disabled:false,children:[],options:[],dataset:{},style:{setProperty(){}},
    classList:{add(...c){c.forEach(x=>classes.add(x));},remove(...c){c.forEach(x=>classes.delete(x));},contains:c=>classes.has(c)},
    appendChild(child){el.children.push(child);if(el.tagName==='SELECT')el.options.push(child);return child;},
    setAttribute(key,val){el[key]=val;},getAttribute(key){return el[key];},addEventListener(name,fn){if(!handlers.has(name))handlers.set(name,[]);handlers.get(name).push(fn);},
    async trigger(name){for(const fn of handlers.get(name)||[])await fn({target:el,preventDefault(){},stopPropagation(){}});},
    querySelector(){return null;},querySelectorAll(){return [];},remove(){},focus(){},handlers
  };
  let html='';
  Object.defineProperty(el,'innerHTML',{get:()=>html,set:v=>{html=String(v);el.children=[];el.options=[];if(el.tagName==='SELECT')for(const match of html.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g))el.options.push({value:match[1],textContent:match[2]});}});
  return el;
}
function loadStudio(app,requested=asset){
  const html=read('public/ir-library.html');
  const tags=new Map([...html.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)].map(match=>[match[3],{tag:match[1],attributes:match[2]}]));
  const elements=new Map(),callbacks=[];
  const get=id=>{
    if(!tags.has(id))return null;
    if(!elements.has(id)){
      const {tag,attributes}=tags.get(id),el=element(tag);
      el.value=attributes.match(/\bvalue="([^"]*)"/)?.[1]||'';
      el.classList.add(...(attributes.match(/\bclass="([^"]*)"/)?.[1]||'').split(/\s+/).filter(Boolean));
      elements.set(id,el);
    }
    return elements.get(id);
  };
  app.doc.getElementById=get;app.doc.createElement=element;app.doc.addEventListener=(name,fn)=>{if(name==='DOMContentLoaded')callbacks.push(fn);};
  app.window.location.search='?id='+encodeURIComponent(requested);
  const code=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(x=>x[1]).find(x=>x.includes('let currentDevice = null'));
  assert(code);vm.runInContext(code,app.context,{filename:'ir-library.html:inline'});
  callbacks.forEach(fn=>fn());return {get,elements};
}
async function run(){
  for(const page of pages){
    const html=read('public/'+page);
    assert(html.includes('js/aircon-system.js'),page+' loads shared engine');
    assert(html.includes('js/hardware-cloud.js'),page+' loads cloud transport');
    assert(html.indexOf('js/hardware-cloud.js')<html.indexOf('js/aircon-system.js'),page+' cloud transport is available before initial engine sync');
    for(const script of html.matchAll(/<script[^>]*src="([^"]+)"/g))if(!/^https?:/.test(script[1]))assert(fs.existsSync(path.resolve(root,'public',script[1].split('?')[0])));
    for(const block of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(block[1],{filename:page});
  }
  const sidebar=read('public/sidebar-template.html');for(const page of pages)assert(sidebar.includes(page),page+' sidebar route');
  checks.push('All five navigation routes and local scripts exist; inline JavaScript compiles in every page.');
  const apps=pages.map(makePage);for(const app of apps)await app.system.syncWithDatabase();
  for(const app of apps){
    const ac=app.system.AirconProfileManager.getById(asset);
    assert.equal(ac.aircon_id,'db-ac');assert.equal(ac.controller_node_id,'db-node');assert.equal(ac.node_id,deviceId);assert.equal(ac.protocol_name,'DAIKIN2');assert.equal(ac.status,'online');assert.equal(ac.state.temperature,null);
  }
  checks.push('Five independent page engines resolve the same persisted AC, physical controller, exact protocol, heartbeat, and unknown measurements.');
  const a=apps[0].system, manager=a.AirconProfileManager, original=copy(manager.getById(asset));
  const dashboardHtml=read('public/dashboard.html');
  const updateCard=dashboardHtml.slice(dashboardHtml.indexOf('      function updateSingleCardDom('),dashboardHtml.indexOf('      function wireCardListeners('));
  const powerHelper=dashboardHtml.slice(dashboardHtml.indexOf('      function getDashboardPowerState('),dashboardHtml.indexOf('      function renderDashboard('));
  apps[0].context.NodeService=a.NodeService;
  vm.runInContext(updateCard+powerHelper,apps[0].context);
  const fields=new Map();const card=element();
  card.querySelector=selector=>{if(!fields.has(selector))fields.set(selector,element());return fields.get(selector);};
  apps[0].context.fixtureCard=card;apps[0].context.fixtureAc=original;apps[0].context.fixtureNode=a.NodeService.getNode(deviceId);
  vm.runInContext('updateSingleCardDom(fixtureCard, fixtureAc, fixtureNode)',apps[0].context);
  assert.equal(fields.get('.target-temp-val').textContent,'\u2014');assert.equal(fields.get('.ac-mode-val').textContent,'\u2014');assert.equal(fields.get('.ac-fan-val').textContent,'\u2014');
  assert.equal(fields.get('.ac-proto-val').textContent,'DAIKIN2');
  checks.push('Dashboard renders unknown setpoint/mode/fan as empty and displays the same exact IR protocol as Control and Profiles.');
  let events=0;apps[1].system.AirconEvents.on('aircon:saved',()=>events++);
  failure={table:'aircons',operation:'upsert',message:'RLS denied profile save'};
  await assert.rejects(manager.save({...original,protocol_name:'DAIKIN64'}),/RLS denied/);
  assert.equal(manager.getById(asset).protocol_name,'DAIKIN2');assert.equal(events,0);
  failure=null;delete apps[0].window.supabaseClient;
  await assert.rejects(manager.save(original),/Supabase is not ready/);assert.equal(events,0);apps[0].window.supabaseClient=sb;
  checks.push('Denied writes and unavailable Supabase preserve the old profile and emit no success across pages.');
  mismatch=true;await assert.rejects(manager.save(original),/did not confirm/);mismatch=false;assert.equal(events,0);
  await assert.rejects(manager.save({...original,node_id:'unknown',controller_node_id:'unknown'}),/not found/);
  await assert.rejects(manager.save({...original,device_id:'AC-Other'}),/already assigned/);
  checks.push('Unconfirmed response, missing controller, and occupied controller are rejected before cache success.');
  await manager.save({...original,protocol_name:'DAIKIN64',protocol:'DAIKIN64',capabilities:a.CapabilityEngine.getCapabilities('DAIKIN64')});
  assert(events>0);
  for(const app of apps){assert.equal(app.system.AirconProfileManager.getById(asset).protocol_name,'DAIKIN64');await app.system.syncWithDatabase();assert.equal(app.system.AirconProfileManager.getById(asset).protocol_name,'DAIKIN64');}
  checks.push('Protocol changes broadcast to other pages and remain the exact selected variant after database refresh.');
  assert(!fs.existsSync(path.join(root,'public/ir-profiles.html')));
  assert(!sidebar.includes('ir-profiles.html'));
  assert(!read('public/ir-library.html').includes('ir-profiles.html'));
  checks.push('IR Remote Profiles page and its executable handlers are removed; navigation contains no dead links to the deleted page.');
  const studio=loadStudio(apps[4]);
  assert.equal(studio.get('targetDeviceSelect').value,asset);assert.equal(studio.get('protocolSelect').value,'DAIKIN64');
  const studioWritesBefore=writes.length,studioCommandsBefore=db.ecotrack_device_commands.length;
  studio.get('protocolSelect').value='DAIKIN2';await studio.get('protocolSelect').trigger('change');
  await a.syncWithDatabase();assert.equal(studio.get('protocolSelect').value,'DAIKIN2');
  assert.equal(manager.getById(asset).protocol_name,'DAIKIN64');
  assert.equal(writes.length,studioWritesBefore);assert.equal(db.ecotrack_device_commands.length,studioCommandsBefore);
  for(const id of ['saveProtocolBtn','dispatchIntentBtn','testPowerSelect','testModeSelect','testFanSelect','jsonPreviewConsole'])assert.equal(studio.get(id),null);
  checks.push('Protocol Studio preserves the selected browsing protocol during heartbeat events without persisting configuration or sending commands; the removed dispatch console has no remaining controls.');
  db.ecotrack_device_state[0].capabilities.ir_transmitter=false;
  const before=db.ecotrack_device_commands.length;const blocked=await a.CommandManager.dispatch({device_id:asset,command:'POWER',value:false});
  assert.equal(blocked.code,'RECEIVER_ONLY');assert.equal(db.ecotrack_device_commands.length,before);db.ecotrack_device_state[0].capabilities.ir_transmitter=true;
  checks.push('Receiver-only devices reject AC actuation without queuing a command.');
  await a.NodeService.saveRemoteProfile(deviceId,{brand:'Daikin',aircon_type:'Split',protocol_name:'DAIKIN64'});
  await a.syncWithDatabase();assert.equal(db.nodes[0].protocol_name,'DAIKIN64');assert.equal(db.aircons[0].protocol_name,'DAIKIN64');assert.equal(manager.getById(asset).protocol_name,'DAIKIN64');
  checks.push('IR profiles saved on Devices persist both the controller metadata and the same AC profile.');
  const heartbeat=db.ecotrack_device_state[0].last_seen;
  await a.NodeService.updateNodeLocation(deviceId,{room_id:'r2',room_name:'Workshop',floor_name:'Ground',building_name:'East'});
  await a.syncWithDatabase();assert.equal(db.nodes[0].room_id,'r2');assert.equal(db.aircons[0].room_id,'r2');assert.equal(db.ecotrack_device_state[0].last_seen,heartbeat);
  checks.push('Moving a controller updates the linked AC location without inventing a hardware heartbeat.');
  const sharedCode=read('public/js/shared.js');
  vm.runInContext(sharedCode.slice(sharedCode.indexOf('window.ensureLocationHierarchy = function')),apps[2].context);
  vm.runInContext(read('public/js/scheduler.js'),apps[2].context,{filename:'scheduler.js'});
  await vm.runInContext('loadSchedulerWithSWR(true)',apps[2].context);
  let room=vm.runInContext('savedRooms.r2',apps[2].context), node=room.nodes[0];
  assert.equal(node.id,deviceId);assert.equal(node.pb_id,'db-node');assert.equal(node.ac_tag,asset);assert.equal(node.wakeTime,'00:00');assert.equal(node.intervalVal,500);assert.equal(node.intervalUnit,'Milliseconds');assert.equal(node.temp,null);assert.equal(node.pressure,null);
  checks.push('Schedules use actual controller and AC IDs, preserve midnight and millisecond values, and keep missing measurements empty.');
  db.nodes[0].room_id=null;await vm.runInContext('loadSchedulerWithSWR(true)',apps[2].context);
  assert.equal(vm.runInContext('savedRooms.__unassigned_controllers__.nodes[0].pb_id',apps[2].context),'db-node');
  assert.equal(db.rooms.length,2);checks.push('Unassigned controllers remain visible in Schedules without creating database rooms.');
  const priorScheduleLookup=apps[2].doc.getElementById;
  const draftFields=new Map([
    ['wake-'+deviceId,{value:'06:30'}],['sleep-'+deviceId,{value:'22:00'}],
    ['interval-val-'+deviceId,{value:'17'}],['interval-unit-'+deviceId,{value:'Seconds'}],
    ['sleep-note-'+deviceId,{textContent:'',classList:{toggle(){}}}]
  ]);
  apps[2].doc.getElementById=id=>draftFields.get(id)||null;apps[2].context.draftId=deviceId;
  vm.runInContext("rememberScheduleDraft({target:{id:'interval-val-'+draftId}});scheduleDrafts.get(draftId).editedAt=Date.now()-60000",apps[2].context);
  apps[2].doc.getElementById=priorScheduleLookup;
  await vm.runInContext('loadSchedulerWithSWR(true)',apps[2].context);
  assert.equal(vm.runInContext('savedRooms.__unassigned_controllers__.nodes[0].intervalVal',apps[2].context),'17');
  assert.equal(vm.runInContext('savedRooms.__unassigned_controllers__.nodes[0].wakeTime',apps[2].context),'06:30');
  draftFields.get('interval-val-'+deviceId).value='';
  apps[2].doc.getElementById=id=>draftFields.get(id)||null;
  vm.runInContext("rememberScheduleDraft({target:{id:'interval-val-'+draftId}})",apps[2].context);
  apps[2].doc.getElementById=priorScheduleLookup;
  await vm.runInContext('loadSchedulerWithSWR(true)',apps[2].context);
  assert.equal(vm.runInContext('savedRooms.__unassigned_controllers__.nodes[0].intervalVal',apps[2].context),'');
  vm.runInContext('scheduleDrafts.delete(draftId)',apps[2].context);
  checks.push('Live schedule reloads preserve typed values, paused drafts and a cleared field until the user applies the edit.');
  db.aircons[0].reported_state={power:'on',mode:'fan',fan:'low'};db.aircons[0].reported_at=new Date(Date.now()+1000).toISOString();
  await vm.runInContext('loadSchedulerWithSWR(true)',apps[2].context);
  assert.equal(vm.runInContext('getSchedulerControlMode(savedRooms.__unassigned_controllers__.nodes[0])',apps[2].context),'FAN / LOW FAN');
  checks.push('Schedule mode follows newer hardware feedback instead of an older requested mode.');
  const previousIR=copy(db.ecotrack_device_state[0].latest_ir);
  db.ecotrack_device_state[0].capabilities.ir_transmitter=false;
  db.ecotrack_device_state[0].latest_ir={protocol:'DAIKIN64',raw_count:20,raw_data:'3500,1750,450',captured_at_epoch_ms:Date.now()+5000,state:{power:true,temp:22,mode:'dry',fan:'high'}};
  for(const app of apps){
    await app.system.syncWithDatabase();const profile=app.system.AirconProfileManager.getById(asset);
    assert.equal(profile.state.temperature,22);assert.equal(profile.state.mode,'dry');assert.equal(profile.state.power,true);
    assert.equal(profile.ir_monitoring,true);assert.equal(profile.ir_controlling,false);
    const label=app.window.EcoTrackAirconState.describeAirconState(profile.control_snapshot);
    assert.equal(label.remoteObserved,true);assert.equal(label.confirmed,false);assert.equal(label.power,null);
  }
  await vm.runInContext('loadSchedulerWithSWR(true)',apps[2].context);
  assert.equal(vm.runInContext('getSchedulerTargetTemperature(savedRooms.__unassigned_controllers__.nodes[0])',apps[2].context),'22 °C');
  assert.equal(vm.runInContext('getSchedulerControlMode(savedRooms.__unassigned_controllers__.nodes[0])',apps[2].context),'DRY / HIGH FAN');
  assert.equal(vm.runInContext('getSchedulerPowerMode(savedRooms.__unassigned_controllers__.nodes[0])',apps[2].context),'ON');
  checks.push('Decoded remote temperature, mode, fan and power agree in all five engines and Schedules while remaining observations, with transmission disabled.');
  const nodesHtml=read('public/nodes.html');
  vm.runInContext(nodesHtml.slice(nodesHtml.indexOf('      function controllerIrSummary('),nodesHtml.indexOf('      function renderNodes(')),apps[3].context);
  apps[3].context.receiverNode=apps[3].system.NodeService.getNode(deviceId);
  apps[3].context.attachedProfiles=[apps[3].system.AirconProfileManager.getById(asset)];
  assert.equal(vm.runInContext('controllerIrSummary(receiverNode,attachedProfiles)',apps[3].context),'Remote: ON • 22°C • DRY • HIGH fan');
  checks.push('Controller Devices displays the same decoded setpoint, mode, fan, and remote power.');
  const flush=()=>new Promise(resolve=>setImmediate(resolve));
  for(const app of apps)app.listeners.get('supabase:ready').forEach(fn=>fn());
  await flush();
  for(const app of apps)assert.equal([...app.intervals.values()].filter(timer=>timer.ms===5000).length,1);
  checks.push('All five open pages start exactly one automatic five-second cloud refresh.');
  apps[0].system.AirconEvents.on('devices:synced',()=>{
    apps[0].context.fixtureAc=manager.getById(asset);apps[0].context.fixtureNode=a.NodeService.getNode(deviceId);
    if(!apps[0].context.fixtureAc)return;
    vm.runInContext('updateSingleCardDom(fixtureCard,fixtureAc,fixtureNode)',apps[0].context);
  });
  const offTime=new Date(Date.now()+6000).toISOString(), onTime=new Date(Date.now()+7000).toISOString();
  const offFrame={protocol:'TCL112AC',raw_count:20,raw_data:'3500,1750,450',sequence:2,received_at:offTime,state:{power:false,temp:24,mode:'cool',fan:'auto'}};
  db.ecotrack_device_state[0].latest_ir=offFrame;
  realtime.find(channel=>channel.name==='realtime_aircon_nodes').handlers.find(item=>item.filter.table==='ecotrack_device_state').callback({});
  for(const [id,timer] of apps[0].timers)if(timer.ms===150){apps[0].timers.delete(id);timer.fn();}
  await flush();
  for(const app of apps){
    const profile=app.system.AirconProfileManager.getById(asset);
    assert.equal(profile.state.power,false);assert.equal(profile.state.temperature,24);
    assert.equal(app.window.EcoTrackAirconState.describeAirconState(profile.control_snapshot).label,'REMOTE OFF');
  }
  assert(fields.get('.ac-status-badge').innerHTML.includes('Power unconfirmed'));
  assert.equal(fields.get('.power-toggle-btn').getAttribute('data-current-power'),'0');
  await vm.runInContext('loadSchedulerWithSWR(true)',apps[2].context);
  assert.equal(vm.runInContext('getSchedulerPowerMode(savedRooms.__unassigned_controllers__.nodes[0])',apps[2].context),'OFF');
  checks.push('A TCL112AC OFF cloud event changes all five page states, the dashboard toggle and Schedule power without a reload; its remote observation keeps the operation badge unconfirmed.');
  db.ecotrack_device_state[0].latest_ir={...offFrame,sequence:3,received_at:onTime,state:{power:true,temp:25,mode:'fan',fan:'low'}};
  const writesBeforeRefresh=writes.length,readsBeforeRefresh=reads.length;
  [...apps[0].intervals.values()].find(timer=>timer.ms===5000).fn();await flush();
  assert.equal(manager.getById(asset).state.power,true);assert(fields.get('.ac-status-badge').innerHTML.includes('Power unconfirmed'));
  assert.equal(String(fields.get('.target-temp-val').textContent),'25');
  assert.equal(writes.length,writesBeforeRefresh);assert(reads.length>readsBeforeRefresh);
  checks.push('With real-time events missing, the timer imports a later remote ON and new setpoint into the open card using reads only.');
  apps[0].doc.visibilityState='hidden';const readsWhileHidden=reads.length;
  [...apps[0].intervals.values()].find(timer=>timer.ms===5000).fn();await flush();assert.equal(reads.length,readsWhileHidden);
  apps[0].doc.visibilityState='visible';apps[0].docListeners.get('visibilitychange').forEach(fn=>fn());
  for(const [id,timer] of apps[0].timers)if(timer.ms===150){apps[0].timers.delete(id);timer.fn();}
  await flush();assert(reads.length>readsWhileHidden);
  checks.push('Hidden pages pause refresh reads and returning to the page refreshes its current state.');
  const retained=copy(manager.getById(asset).control_snapshot);
  db.ecotrack_device_state[0].latest_ir={protocol:'UNKNOWN',raw_data:'3500,450,450',raw_count:3,received_at:new Date(Date.now()+9000).toISOString()};
  [...apps[0].intervals.values()].find(timer=>timer.ms===5000).fn();await flush();
  assert.equal(manager.getById(asset).control_snapshot.observed_remote_at,retained.observed_remote_at);
  assert.equal(manager.getById(asset).state.power,true);
  checks.push('Trailing undecoded IR does not erase the last decoded remote power or give it a newer timestamp.');
  db.aircons[0].desired_state={power:'off',temp:25,mode:'cool',fan:'auto'};db.aircons[0].commanded_at=new Date(Date.now()+8000).toISOString();db.aircons[0].command_status='queued';
  db.ecotrack_device_state[0].latest_ir={...offFrame,sequence:3,received_at:onTime,state:{power:true,temp:25,mode:'fan',fan:'low'}};
  [...apps[0].intervals.values()].find(timer=>timer.ms===5000).fn();await flush();
  assert.equal(manager.getById(asset).state.power,false);assert(fields.get('.ac-status-badge').innerHTML.includes('Power unconfirmed'));
  db.aircons[0].command_status='transmitted';[...apps[0].intervals.values()].find(timer=>timer.ms===5000).fn();await flush();
  assert(fields.get('.ac-status-badge').innerHTML.includes('Power unconfirmed'));
  checks.push('A newer UI OFF request replaces an older remote ON; the request and receipt remain unconfirmed physical operation on the open card.');
  const helper=apps[0].window.EcoTrackAirconState;
  const stableSnapshot=copy(manager.getById(asset).control_snapshot);
  failure={table:'ecotrack_device_state',message:'Temporary hardware read failure'};
  [...apps[0].intervals.values()].find(timer=>timer.ms===5000).fn();await flush();
  assert.deepEqual(copy(manager.getById(asset).control_snapshot),stableSnapshot);failure=null;
  checks.push('A temporary device-state read error preserves the prior observation and command receipt instead of silently replacing them.');
  const tclOff={protocol:'TCL112AC',frame_kind:'full_state',raw_data:'3000,1650,500',raw_count:227,sequence:40,hex:'0x23CB2601002003074000000080CB',captured_at_epoch_ms:Date.now()+13000,received_at:new Date(Date.now()+13000).toISOString(),state:{power:false,temp:24,mode:'cool',fan:'auto'}};
  db.ecotrack_device_state[0].latest_ir=tclOff;
  [...apps[0].intervals.values()].find(timer=>timer.ms===5000).fn();await flush();
  assert.equal(manager.getById(asset).state.power,false);assert(fields.get('.ac-status-badge').innerHTML.includes('Power unconfirmed'));
  const actualOffTime=manager.getById(asset).control_snapshot.observed_remote_at;
  db.ecotrack_device_state[0].latest_ir={protocol:'TCL112AC',frame_kind:'settings_only',raw_count:227,raw_data:'3000,1650,500',sequence:41,received_at:new Date(Date.now()+14000).toISOString(),state:{power:true,temp:23,mode:'fan',fan:'low'},last_decoded:tclOff};
  [...apps[0].intervals.values()].find(timer=>timer.ms===5000).fn();await flush();
  for(const app of apps)assert.equal(app.system.AirconProfileManager.getById(asset).state.power,false);
  assert.equal(manager.getById(asset).control_snapshot.observed_remote_at,actualOffTime);
  assert(fields.get('.ac-status-badge').innerHTML.includes('Power unconfirmed'));
  checks.push('A full TCL OFF stays OFF across all five pages when an auxiliary packet carries the previous ON fields; auxiliary power is never a fresh reading.');
  const delayed=helper.remoteObservation({...tclOff,captured_at_epoch_ms:Date.parse('2026-10-09T15:00:00Z'),received_at:'2026-10-09T15:00:10Z'},'2026-10-09T15:00:10Z');
  assert.equal(delayed.observed_remote_at,'2026-10-09T15:00:00.000Z');
  assert.equal(helper.selectSettings({...delayed,desired_state:{power:'on'},commanded_at:'2026-10-09T15:00:05Z'}).source,'requested');
  assert.equal(helper.selectSettings({...delayed,desired_state:{power:'on'},commanded_at:'2026-10-09T14:59:55Z'}).source,'remote');
  const invalidClock=helper.remoteObservation({...tclOff,captured_at_epoch_ms:Date.parse('2026-10-09T16:00:00Z'),received_at:'2026-10-09T15:00:10Z'},null);
  assert.equal(invalidClock.observed_remote_at,'2026-10-09T15:00:10.000Z');
  checks.push('A delayed capture keeps the true remote/UI ordering, while an implausibly future device clock falls back to server time.');
  const noClock={protocol:'TCL112AC',raw_count:20,sequence:1,state:{power:false,temp:24,mode:'cool',fan:'auto'}};
  const first=helper.remoteObservation(noClock,'2026-01-01T10:00:00Z');
  const repeated=helper.remoteObservation(noClock,'2026-01-01T10:01:00Z',first);
  assert.equal(repeated.observed_remote_at,first.observed_remote_at);
  const inherited=helper.remoteObservation({protocol:'UNKNOWN',raw_count:3,last_decoded:noClock},'2026-01-01T10:00:00Z');
  assert.equal(inherited.observed_remote_state.power,false);
  assert.deepEqual(copy(helper.remoteObservation(null,stamp(),inherited)),{});
  checks.push('Captures without a device clock retain their first timestamp; retained decoded OFF survives unknown frames while removed cloud captures clear observations.');
  assert.equal(helper.selectSettings({observed_remote_state:{temp:22},observed_remote_at:'2026-01-01',desired_state:{temp:25},commanded_at:'2026-01-02'}).state.temp,25);
  assert.deepEqual(copy(helper.remoteObservation({protocol:'UNKNOWN',raw_count:20},stamp())),{});
  const ambiguous=a.ProtocolAdapter.decodeRemoteCapture({protocol:'COOLIX',raw_count:10});
  assert.equal(ambiguous.success,true);assert.equal(ambiguous.brand,null);assert.equal(ambiguous.protocol,'COOLIX');
  checks.push('Older observations do not replace newer requests; unknown captures invent no state or manufacturer.');
  db.nodes.push({id:'draft-node',name:'draft-receiver',room_id:'r1'});
  storage.setItem('ecoTrack_controller_drafts:current',JSON.stringify(['draft-node']));
  for(const app of apps){await app.system.syncWithDatabase();assert(!app.system.NodeService.getDevices().some(node=>node.db_id==='draft-node'));}
  await vm.runInContext('loadSchedulerWithSWR(true)',apps[2].context);
  assert(!vm.runInContext('Object.values(savedRooms).flatMap(room=>room.nodes).some(node=>node.pb_id==="draft-node")',apps[2].context));
  apps[0].window.EcoTrackHardwareCloud.completeRegistration('draft-node');
  await a.syncWithDatabase();assert(a.NodeService.getDevices().some(node=>node.db_id==='draft-node'));
  db.nodes.pop();db.ecotrack_device_state[0].latest_ir=previousIR;db.ecotrack_device_state[0].capabilities.ir_transmitter=true;
  checks.push('Incomplete setup drafts stay out of Devices and Schedules until explicit completion.');
  const button=element('button');apps[2].context.receiptButton=button;
  vm.runInContext("scheduleDeliveries.set('fixture',{nodeId:'fixture',databaseNodeId:'db-node',commandId:'schedule-1',seconds:0.5,wakeTime:'00:00',sleepTime:'23:00',label:'Queued',button:receiptButton})",apps[2].context);
  for(const receipt of [
    {id:'different',node_id:'db-node',status:'completed',result:{success:true}},
    {id:'schedule-1',node_id:'wrong-node',status:'completed',result:{success:true}}]){
    apps[2].context.receipt=receipt;vm.runInContext('reconcileScheduleDelivery(receipt)',apps[2].context);assert.notEqual(button.textContent,'Applied');
  }
  apps[2].context.receipt={id:'schedule-1',node_id:'db-node',status:'completed',result:{success:true,command_id:'schedule-1',interval_ms:500,wake_time:'00:00',sleep_time:'23:00'}};
  vm.runInContext('reconcileScheduleDelivery(receipt)',apps[2].context);assert.equal(button.textContent,'Applied');
  apps[2].context.receipt.result.interval_ms=1000;vm.runInContext('reconcileScheduleDelivery(receipt)',apps[2].context);assert.equal(button.textContent,'Failed');
  checks.push('Delayed schedule receipts must match controller, request ID, interval, wake, and sleep before showing Applied.');
  apps[2].context.receipt.result.interval_ms=500;db.ecotrack_device_commands.push(copy(apps[2].context.receipt));
  vm.runInContext("scheduleDeliveries.get('fixture').label='Queued'",apps[2].context);
  const writesBeforeReceipt=writes.length;
  const receiptRead=vm.runInContext('refreshSchedulerCommandReceipts()',apps[2].context);
  assert.equal(vm.runInContext('refreshSchedulerCommandReceipts()',apps[2].context),receiptRead);
  await receiptRead;assert.equal(button.textContent,'Applied');assert.equal(writes.length,writesBeforeReceipt);
  vm.runInContext("scheduleDeliveries.get('fixture').label='Queued'",apps[2].context);
  failure={table:'ecotrack_device_commands',message:'Receipt read denied'};
  await vm.runInContext('refreshSchedulerCommandReceipts()',apps[2].context);failure=null;
  assert.equal(vm.runInContext("scheduleDeliveries.get('fixture').label",apps[2].context),'Queued');
  checks.push('Schedules poll matching queued receipts when real-time is missed, deduplicate concurrent reads and preserve Queued on read failure without writes.');
  db.ecotrack_device_state[0].last_seen=new Date(Date.now()-60000).toISOString();
  for(const app of apps){await app.system.syncWithDatabase();assert.equal(app.system.AirconProfileManager.getById(asset).status,'offline');assert.equal(app.system.NodeService.getNode(deviceId).status,'Offline');}
  checks.push('Expired heartbeats mark controllers and linked ACs offline across all five engines even when legacy status says online.');
  db.ecotrack_device_state[0].last_seen=stamp();await a.syncWithDatabase();
  const countBefore=writes.length;
  await assert.rejects(a.NodeService.deleteDevice(deviceId),/Unassign/);assert.equal(writes.length,countBefore);assert.equal(db.aircons.length,1);
  checks.push('Removing a controller with a linked AC is blocked without deleting either database record.');
  failure={table:'aircons',operation:'delete',message:'Deletion denied'};
  await assert.rejects(manager.delete(asset),/Deletion denied/);assert(manager.getById(asset));failure=null;
  await manager.delete(asset);for(const app of apps)await app.system.syncWithDatabase();
  assert.equal(db.nodes.length,1);assert.equal(manager.getAll().length,0);assert.equal(studio.get('targetDeviceSelect').value,'');assert.equal(studio.get('autoDetectBtn').disabled,true);assert.equal(studio.get('latestLearnedFrameBtn').disabled,true);assert(studio.get('learnedFramePanel').classList.contains('hidden'));
  checks.push('Profile deletion clears every page, preserves its controller, and cannot be recreated by stale cache or Devices rendering.');
  await a.NodeService.saveNode({cloud_registered:true,node_id:deviceId,db_id:'db-node',name:'Real receiver',brand:'Daikin',protocol_name:'DAIKIN2',aircon_type:'Split',room_id:'r1',cloud_state:copy(db.ecotrack_device_state[0])});
  assert.equal(db.aircons.length,1);assert.equal(db.aircons[0].controller_node_id,'db-node');assert.equal(db.aircons[0].protocol_name,'DAIKIN2');
  checks.push('Explicit cloud registration creates a real persisted AC binding and preserves the exact protocol.');
  await manager.delete(db.aircons[0].asset_tag);
  db.aircons.push({id:'existing-unit',asset_tag:'AC-Existing',brand:'Daikin',model:'Split',aircon_type:'Split',protocol_name:'DAIKIN64',node_id:null,controller_node_id:null,room_id:null});
  await a.syncWithDatabase();
  await a.NodeService.saveNode({cloud_registered:true,node_id:deviceId,db_id:'db-node',aircon_id:'existing-unit',name:'Receiver',aircon_type:'Split',room_id:'r1',cloud_state:copy(db.ecotrack_device_state[0])});
  assert.equal(db.aircons.length,1);assert.equal(db.aircons[0].asset_tag,'AC-Existing');assert.equal(db.aircons[0].id,'existing-unit');assert.equal(db.aircons[0].brand,'Daikin');assert.equal(db.aircons[0].protocol_name,'DAIKIN64');
  checks.push('Registering onto an existing unassigned AC keeps its original ID, brand, and protocol and creates no duplicate.');
  await manager.save({...manager.getById('AC-Existing'),node_id:'',controller_node_id:null});
  assert.equal(db.aircons[0].controller_node_id,null);assert.equal(db.aircons[0].node_id,null);
  checks.push('Explicit Unassigned selection clears both controller links while preserving the AC profile.');
  const assignment={controller_name:'Registered controller',assignment_mode:'existing',aircon_id:'existing-unit',brand:'Daikin',
    aircon_type:'Custom ceiling unit',room_id:'r1',protocol_name:'DAIKIN64'};
  const atomicPayload={cloud_registered:true,registration_assignment:assignment,node_id:deviceId,db_id:'db-node',
    name:assignment.controller_name,brand:assignment.brand,aircon_type:assignment.aircon_type,room_id:'r1',cloud_state:copy(db.ecotrack_device_state[0])};
  const beforeAtomic=writes.length;await a.NodeService.saveNode(atomicPayload);
  assert.equal(writes.length,beforeAtomic+1);assert.equal(writes.at(-1).table,'registration');
  for(const app of apps){await app.system.syncWithDatabase();const ac=app.system.AirconProfileManager.getById('AC-Existing');
    assert.equal(ac.controller_node_id,'db-node');assert.equal(ac.node_id,deviceId);assert.equal(ac.aircon_type,'Custom ceiling unit');assert.equal(ac.protocol_name,'DAIKIN64');}
  checks.push('Atomic registration publishes the same persisted AC identity, custom type and exact protocol to all five connected page engines without separate writes.');
  failure={operation:'rpc',message:'Atomic registration denied'};
  await assert.rejects(()=>a.NodeService.saveNode({...atomicPayload,registration_assignment:{...assignment,controller_name:'Should not persist'}}),/Atomic registration denied/);failure=null;
  assert.equal(db.nodes[0].name,'Registered controller');assert.equal(db.aircons.length,1);
  checks.push('Failed atomic registration keeps the previous controller and AC relationship across all pages.');
  // Verify missing-target navigation never silently selects a different unit.
  const absent=loadStudio(makePage('missing-target'), 'deleted-target');
  assert.equal(absent.get('targetDeviceSelect').value,'');assert.equal(absent.get('autoDetectBtn').disabled,true);assert.equal(absent.get('latestLearnedFrameBtn').disabled,true);assert(absent.get('learnedFramePanel').classList.contains('hidden'));
  checks.push('A missing Studio deep-link target stays unavailable and never changes another AC.');
}
run().then(()=>{
  const report={status:'passed',count:checks.length,checks,liveDatabaseModified:false,physicalHardwareTested:false};
  fs.mkdirSync(path.join(root,'reports/page-connections'),{recursive:true});
  fs.writeFileSync(path.join(root,'reports/page-connections/integration-tests.json'),JSON.stringify(report,null,2)+'\n');
  console.log('Five-page integration: '+checks.length+' checks passed (in-memory fixtures, no network).');
}).catch(error=>{console.error(error);process.exitCode=1;});
