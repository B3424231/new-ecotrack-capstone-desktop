'use strict';
// Real desktop functions, isolated clients/DOM/measurements. No live services.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {syncRegisteredMonitors}=require('../src/ac-device-monitor');
const {requestMonitoring}=require('../src/monitoring-local');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
function section(file,start,end){const source=read(file),a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert(a>=0&&b>a);return source.slice(a,b);}
const fixed=Date.parse('2026-10-20T05:00:00+08:00');
class Clock extends Date{constructor(...args){super(...(args.length?args:[fixed]));}static now(){return fixed;}}
const stamp=new Clock().toISOString();
function rulesContext(role='controller'){
  const values=new Map(),writes=[];
  const node={id:'node-one',name:'AC device',room_id:'room-one',device_mode:role,monitoring_id:'sensor-one',interval_val:1,interval_unit:'Minutes'};
  const rule={id:'rule-one',enabled:true,type:'temperature',condition:'above',value:28,duration:0,unit:'°C',room_id:'room-one'};
  const context=vm.createContext({Date:Clock,Intl,URLSearchParams,AbortSignal,console:{log(){},warn(){}},
    localStorage:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)},
    window:{electron:{env:{BACKEND_URL:'http://localhost:5000'},invoke:async(channel,input)=>{if(channel==='notification-create'){writes.push(input);return {success:true,data:{id:'notification-fixture'}};}return {success:true,nodes:[node]};}}},
    getActiveRulesAndNodes:async()=>({rules:[rule],ruleNodes:[],nodes:[node],rooms:[{id:'room-one'}],nodeMap:{'node-one':node,'AC device':node}}),triggerGlobalNotification(){}});
  vm.runInContext(section('public/js/global-notifications.js','function notificationRuleClock(','// Global hook for live packet streaming'),context);
  context.getNotificationHardwareStates=async()=>({'node-one':{last_seen:stamp}});
  return {context,node,rule,writes,values};
}
test('rule windows cover overnight hours, inclusive dates and facility time in any desktop timezone',()=>{
  const {context}=rulesContext();
  for(const time of ['2026-10-20T23:00:00+08:00','2026-10-21T02:00:00+08:00'])assert(context.isRuleWithinSchedule({start_time:'22:00',end_time:'06:00'},new Date(time)));
  assert(!context.isRuleWithinSchedule({start_time:'22:00',end_time:'06:00'},new Date('2026-10-20T12:00:00+08:00')));
  assert(context.isRuleWithinSchedule({start_date:'2026-10-20'},new Clock()));
  assert(!context.isRuleWithinSchedule({end_date:'2026-10-19'},new Clock()));
  assert(context.isRuleWithinSchedule({start_time:'05:00',end_time:'05:00'},new Clock()));
  assert(!context.isRuleWithinSchedule({start_time:'06:00',end_time:'18:00'},new Clock()));
});
test('fresh controller readings generate a threshold notification on the correct local date',async()=>{
  const f=rulesContext();await f.context.evaluateTelemetryAgainstRules({id:f.node.id,name:f.node.name,created:stamp,temperature:35,interval_seconds:60});
  assert.equal(f.writes.length,1);assert.equal(f.writes[0].date,'2026-10-20');assert.equal(f.writes[0].node_id,f.node.id);
});
test('monitoring evidence uses canonical device links and does not require an unrelated cloud heartbeat',async()=>{
  const f=rulesContext('both');f.context.getNotificationHardwareStates=async()=>({});
  await f.context.evaluateTelemetryAgainstRules({id:f.node.id,name:f.node.name,source:'monitoring',monitoring_id:'sensor-one',fresh:true,observed_at:stamp,temperature:35,interval_seconds:60});
  assert.equal(f.writes.length,1);
  for(const patch of [{monitoring_id:'wrong-sensor'},{fresh:false},{connection_status:'offline'},{observed_at:'2020-01-01T00:00:00Z'},{temperature:null}]){
    const n=rulesContext('both');await n.context.evaluateTelemetryAgainstRules({id:n.node.id,name:n.node.name,source:'monitoring',monitoring_id:'sensor-one',fresh:true,observed_at:stamp,temperature:35,interval_seconds:60,...patch});assert.equal(n.writes.length,0);
  }
});
test('missing or stale samples reset duration evidence instead of extending a violation through gaps',async()=>{
  for(const sample of [{created:stamp,temperature:null},{created:'2020-01-01T00:00:00Z',temperature:35}]){
    const f=rulesContext();f.values.set('ecoTrack_violation_start_rule-one_node-one','1');
    await f.context.evaluateTelemetryAgainstRules({id:f.node.id,name:f.node.name,...sample});
    assert(!f.values.has('ecoTrack_violation_start_rule-one_node-one'));assert.equal(f.writes.length,0);
  }
});
test('duplicate display names cannot redirect targeted rules or share duration timers',async()=>{
  const f=rulesContext(),second={...f.node,id:'node-two'};
  f.context.getActiveRulesAndNodes=async()=>({rules:[f.rule],ruleNodes:[{rule_id:f.rule.id,node_id:f.node.id,node_name:f.node.name}],nodes:[f.node,second],rooms:[{id:'room-one'}],nodeMap:{'node-one':f.node,'node-two':second,'AC device':second}});
  f.context.getNotificationHardwareStates=async()=>({'node-one':{last_seen:stamp},'node-two':{last_seen:stamp}});
  await f.context.evaluateTelemetryAgainstRules({id:'node-two',pb_id:'node-two',name:'AC device',created:stamp,temperature:35});assert.equal(f.writes.length,0);
  await f.context.evaluateTelemetryAgainstRules({id:'node-one',pb_id:'node-one',name:'AC device',created:stamp,temperature:35});assert.equal(f.writes.length,1);assert.equal(f.writes[0].node_id,'node-one');
  assert(f.values.has('ecoTrack_violation_start_rule-one_node-one'));assert(!f.values.has('ecoTrack_violation_start_rule-one_node-two'));
});
test('background checker consumes items envelopes and reads the correct measurement source',async()=>{
  for(const role of ['controller','monitoring','both']){
    const f=rulesContext(role),evaluated=[],urls=[];
    f.context.fetch=async url=>{urls.push(url);return {ok:true,json:async()=>String(url).includes('/monitoring/')?{items:[{id:'sensor-one',active:true,fresh:true,latest:{outlet_temperature_c:35,temperature_quality:'ok',clock_quality:'synchronized',observed_at:stamp}}]}:{items:[{node_id:'node-one',temperature:34,created:stamp}],totalItems:1}};};
    f.context.evaluateTelemetryAgainstRules=async sample=>evaluated.push(sample);
    vm.runInContext(section('public/js/global-notifications.js','async function startGlobalRuleChecker()','// ===== CONTROL WAKE UP & SLEEP'),f.context);
    await f.context.startGlobalRuleChecker();assert.equal(evaluated.length,1);assert.equal(evaluated[0].temperature,role==='controller'?34:35);assert.equal(evaluated[0].id,'node-one');
    if(role==='controller'){const params=new URL(urls.find(url=>url.includes('/api/telemetry?'))).searchParams;assert.equal(params.get('perPage'),'1');assert(params.get('filter').includes('node-one'));}
  }
});
test('faulty monitoring temperatures never reach threshold evaluation as valid measurements',async()=>{
  const f=rulesContext('monitoring'),evaluated=[];f.context.fetch=async()=>({ok:true,json:async()=>({items:[{id:'sensor-one',active:true,fresh:true,latest:{outlet_temperature_c:35,temperature_quality:'fault',clock_quality:'synchronized',observed_at:stamp}}]})});
  f.context.evaluateTelemetryAgainstRules=async sample=>evaluated.push(sample);
  vm.runInContext(section('public/js/global-notifications.js','async function startGlobalRuleChecker()','// ===== CONTROL WAKE UP & SLEEP'),f.context);await f.context.startGlobalRuleChecker();assert.equal(evaluated[0].temperature,null);
});
test('Both-mode scheduler retains cloud controller rows during a local backend outage',async()=>{
  const connection={},errors=[],calls=[];
  const context=vm.createContext({window:{EcoTrackMode:{mode:'both'},electron:{invoke:async channel=>{calls.push(channel);return {success:true,nodes:[{id:'controller-one',name:'Controller',device_mode:'controller'}],aircons:[],rooms:[],floors:[],buildings:[]};}}},
    document:{getElementById:()=>connection,querySelector:()=>null,addEventListener(){}},localStorage:{getItem:()=>null},fetch:async()=>({ok:false}),
    URL,AbortSignal,setTimeout,clearTimeout,schedulerEscape:String,getSchedulerDeviceState:()=> 'unknown',scheduleDrafts:new Map(),savedRooms:{},buildings:{},floors:{},
    renderSchedulerLoading(){},renderSchedulerErrorState:error=>errors.push(error),renderSchedulerLocationCabinet(){}});
  vm.runInContext(read('public/js/device-scheduler.js'),context);await context.window.EcoDeviceScheduler.load(true);
  assert.equal(calls.filter(channel=>channel==='scheduler-fetch-data').length,1);assert.equal(errors.length,0);assert.equal(Object.values(context.savedRooms)[0].nodes[0].id,'controller-one');assert(connection.textContent.includes('local sensor schedules unavailable'));
});
test('registry sync submits an authoritative empty snapshot when cloud devices are controller-only',async()=>{
  let body;const client={from:table=>({select:async()=>({data:table==='nodes'?[{id:'node-one',device_mode:'controller'}]:[]})})};
  const result=await syncRegisteredMonitors(client,{adminToken:'isolated-fixture-token-not-a-real-credential',fetcher:async(url,options)=>{assert(url.pathname.endsWith('/registry/reconcile'));body=JSON.parse(options.body);return {ok:true,json:async()=>({changed:1})};}});
  assert.deepEqual(body,{devices:[]});assert.equal(result.data.changed,1);
});
test('failed or incomplete cloud reads never submit a retirement snapshot',async()=>{
  let writes=0;const options={adminToken:'isolated-fixture-token-not-a-real-credential',fetcher:async()=>{writes++;return {ok:true,json:async()=>({changed:0})};}};
  const failed={from:table=>({select:async()=>table==='nodes'?{error:{message:'denied'}}:{data:[]}})};
  await assert.rejects(syncRegisteredMonitors(failed,options),/metadata/);assert.equal(writes,0);
  const partial={from:()=>({select(){return {order(){return this;},range(){return this;},then(resolve){resolve({data:[],count:2});}};}})};
  await assert.rejects(syncRegisteredMonitors(partial,options),/incomplete/);assert.equal(writes,0);
  await assert.rejects(requestMonitoring({action:'reconcile',data:{devices:[]}},options),/verified cloud/);
});
test('cloud reconciliation reads every counted page before committing one metadata snapshot',async()=>{
  const nodes=Array.from({length:501},(_,index)=>({id:'node-'+String(index).padStart(3,'0'),device_mode:'controller'}));
  nodes[500]={...nodes[500],name:'Last-page sensor',device_mode:'both',monitoring_id:'11111111-1111-4111-8111-111111111111',monitor_aircon_id:'ac-one',sensor_config:{pressure_sensor:'MPX5010DP',pressure_min_pa:0,pressure_max_pa:10000}};
  const tables={nodes,aircons:[{id:'ac-one',name:'AC on final page'}],rooms:[],floors:[],buildings:[]},ranges=[];let body;
  const client={from:table=>({select(_fields,options){assert.equal(options.count,'exact');let start,end;const q={order(field){assert.equal(field,'id');return q;},range(a,b){start=a;end=b;ranges.push({table,start});return q;},abortSignal(){return q;},then(resolve){resolve({data:tables[table].slice(start,end+1),count:tables[table].length});}};return q;}})};
  await syncRegisteredMonitors(client,{adminToken:'isolated-fixture-token-not-a-real-credential',fetcher:async(_url,options)=>{body=JSON.parse(options.body);return {ok:true,json:async()=>({changed:1})};}});
  assert(ranges.some(range=>range.table==='nodes'&&range.start===500));assert.equal(body.devices.length,1);assert.equal(body.devices[0].registry_node_id,'node-500');assert.equal(body.devices[0].device.aircon_name,'AC on final page');
});
test('concurrent registry refreshes share one snapshot and one reconciliation',async()=>{
  let release,writes=0;const pending=new Promise(resolve=>release=resolve);
  const client={from:()=>({select:()=>pending.then(()=>({data:[]}))})},options={adminToken:'isolated-fixture-token-not-a-real-credential',fetcher:async()=>{writes++;return {ok:true,json:async()=>({changed:0})};}};
  const first=syncRegisteredMonitors(client,options),second=syncRegisteredMonitors(client,options);assert.equal(first,second);release();await Promise.all([first,second]);assert.equal(writes,1);
});
test('registry pagination follows the installed Supabase SDK count/range contract with isolated HTTP',async()=>{
  const {createClient}=require('@supabase/supabase-js'),requests=[];
  const nodes=Array.from({length:501},(_,index)=>({id:'node-'+index,device_mode:'controller'}));
  const client=createClient('https://isolated-fixture.invalid','sb_publishable_isolated_fixture',{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:async(input,init)=>{
    const url=new URL(input),table=url.pathname.split('/').pop(),offset=Number(url.searchParams.get('offset')||0),limit=Number(url.searchParams.get('limit')||500),all=table==='nodes'?nodes:[],rows=all.slice(offset,offset+limit);
    requests.push({table,offset,prefer:new Headers(init.headers).get('prefer')});
    return new Response(JSON.stringify(rows),{status:200,headers:{'Content-Type':'application/json','Content-Range':rows.length?`${offset}-${offset+rows.length-1}/${all.length}`:'*/0'}});
  }}});
  let submitted;await syncRegisteredMonitors(client,{adminToken:'isolated-fixture-token-not-a-real-credential',fetcher:async(_url,init)=>{submitted=JSON.parse(init.body);return {ok:true,json:async()=>({changed:0})};}});
  assert.deepEqual(requests.filter(request=>request.table==='nodes').map(request=>request.offset),[0,500]);assert(requests.every(request=>request.prefer.includes('count=exact')));assert.deepEqual(submitted,{devices:[]});
});
test('telemetry loading remains active until its registry resolves',async()=>{
  let release;const pending=new Promise(resolve=>{release=resolve;}),events=[],elements=new Map();
  const element=id=>{if(!elements.has(id))elements.set(id,{hidden:false,scrollTop:0,setAttribute(){},disabled:false});return elements.get(id);};
  const context=vm.createContext({page:'telemetry',$:element,running:false,controller:null,revision:0,fleetPosition:{},locationFilter:null,nodes:[],stats:null,energy:null,history:[],total:0,loaded:false,available:false,pageNumber:1,
    AbortController,request:async()=>({items:[]}),showSensorLoading:()=>events.push('show'),hideSensorLoading:()=>events.push('hide'),error(){},render:()=>events.push('render'),refreshLocations:()=>pending,syncCloudRegistry:async()=>null});
  vm.runInContext(section('public/js/sensor-workspace.js','  async function refresh({ poll = false } = {})','  function openDialog('),context);
  const refreshing=context.refresh();await new Promise(setImmediate);assert.deepEqual(events,['show']);assert.equal(element('sensorRefresh').disabled,true);
  release();await refreshing;assert.deepEqual(events,['show','hide','render']);assert.equal(element('sensorRefresh').disabled,false);
});
