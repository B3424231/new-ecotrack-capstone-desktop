const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const storage = {};
global.localStorage = {getItem:key=>storage[key]??null,setItem:(key,value)=>storage[key]=String(value),removeItem:key=>delete storage[key]};
global.window = { localStorage:global.localStorage,crypto:crypto.webcrypto,performance };
require('../public/js/aircon-system.js');
const {NodeService,AirconProfileManager,CommandManager,ProtocolAdapter}=window.EcoTrackAirconSystem;
async function main(){
 await NodeService.saveNode({node_id:'node-test',db_id:'db-node',name:'node-test',status:'Connected'});
 localStorage.setItem('ecoTrack_aircons', JSON.stringify([{device_id:'AC-HARDWARE',name:'Hardware fixture',node_id:'node-test',brand:'Daikin',protocol_name:'DAIKIN2',protocol:'DAIKIN2',status:'online',state:{power:true,temperature:24,mode:'cool',fan:'auto',swing:true},capabilities:{power:true,temperature:true,sleep:true,modes:['cool','dry','fan','auto'],fans:['auto','high'],temperature_min:18,temperature_max:32}}]));
 const writes=[]; let cloudError=null, missingAircon=false, command=null, capture='frame';
 const hardware={node_id:'db-node',device_id:'esp32s3-001122334455',last_seen:new Date().toISOString(),capabilities:{ir_receiver:true,ir_transmitter:true},latest_ir:{sequence:2,raw_data:'3500,1750,450,1300',protocol:'DAIKIN2',hex:'0x1234'}};
 window.supabaseClient={
  async rpc(name,args){
   assert.equal(name,'ecotrack_cloud_request'); if(cloudError)return {error:cloudError,data:null};
   writes.push({table:'commands',payload:structuredClone(args)});
   command={id:args.p_request_id,node_id:'db-node',kind:args.p_kind,payload:args.p_payload,status:'queued',created_at:new Date().toISOString()};return {data:command,error:null};
  },
  from(table){let savedPayload=null;const q={select(){return q;},eq(){return q;},or(){return q;},limit(){return q;},update(payload){savedPayload=payload;writes.push({table,payload});return q;},upsert(payload){savedPayload=Array.isArray(payload)?payload[0]:payload;writes.push({table,payload});return q;},insert(){return q;},
   async single(){return {data:{id:table==='aircons'?'db-ac':'db-node',name:'node-test',room_id:null,...savedPayload},error:cloudError};},
   async maybeSingle(){
    if(table==='aircons')return {data:missingAircon?null:{id:'db-ac'},error:cloudError};
    if(table==='ecotrack_device_state')return {data:hardware,error:null};
    if(table==='ecotrack_device_commands')return {data:{...command,status:capture==='timeout'?'failed':'completed',result:capture==='timeout'?{success:false,error:'No new IR signal'}:{command_id:command.id,success:true,protocol:'DAIKIN2',raw_type:'DAIKIN2',raw_data:'3500,1750,450,1300',hex:'0x1234'}},error:null};
    return {data:{id:'db-node',name:'node-test',room_id:null},error:null};
   },then(resolve,reject){return Promise.resolve({data:[],error:null}).then(resolve,reject);}
  };return q;}
 };
 global.fetch=async()=>{throw new Error('Local HTTP must never be used for hardware control');};
 require('../public/js/hardware-cloud.js');
 const send=(type='TEMP',value=22)=>CommandManager.dispatch({device_id:'AC-HARDWARE',command:type,value});
 let response=await send();assert.equal(response.delivery_status,'queued');assert.equal(command.payload.protocol,'DAIKIN2');assert.equal(command.payload.state.temp,22);assert.equal(command.payload.state.power,'on');
 response=await send('FAN','high');assert.equal(command.payload.state.fan,'high');assert.equal(command.payload.state.temp,22);assert.equal(response.delivery_status,'queued');
 response=await send('MODE','dry');assert.equal(command.payload.state.mode,'dry');assert.equal(command.payload.state.fan,'high');
 response=await send('SLEEP',true);assert.equal(command.payload.state.sleep,'on');assert.equal(command.payload.state.power,'on');
 response=await send('SLEEP',false);assert.equal(command.payload.state.sleep,'off');
 response=await send('POWER',false);assert.equal(command.payload.state.power,'off');assert.equal(response.state.power,false);
 assert.equal(AirconProfileManager.getById('AC-HARDWARE').control_snapshot.reported_state,undefined,'A queued request is not measured AC state');
 response=await CommandManager.dispatch({device_id:'AC-HARDWARE',command:'TEMP',value:23,state:{power:true,temperature:23,mode:'cool',fan:'auto'}});assert.equal(response.delivery_status,'queued');assert.equal(command.payload.state.power,'on');assert.equal(command.payload.state.temp,23);assert.equal(command.payload.state.mode,'cool');assert.equal(command.payload.state.fan,'auto');
 const studioRequest=command.id;response=await CommandManager.dispatch({device_id:'AC-HARDWARE',command:'TEMP',value:23,state:{power:true,temperature:23,mode:'unsupported',fan:'auto'}});assert.equal(response.success,false);assert.equal(command.id,studioRequest,'Unsupported Studio state cannot create a cloud request');
 hardware.capabilities.ir_transmitter=false;response=await send();assert.equal(response.code,'RECEIVER_ONLY');assert.equal(response.success,false);hardware.capabilities.ir_transmitter=true;
 const before=structuredClone(AirconProfileManager.getById('AC-HARDWARE').state);cloudError={message:'Cloud denied write'};response=await send('POWER',true);assert.equal(response.success,false);assert.deepEqual(AirconProfileManager.getById('AC-HARDWARE').state,before);cloudError=null;
 missingAircon=true;response=await send();assert.equal(response.success,false);missingAircon=false;
 assert(!writes.some(write=>write.table==='nodes'),'AC commands cannot invent device connectivity or sensor readings');
 capture='timeout';response=await ProtocolAdapter.sniffProtocol('node-test');assert.equal(response.success,false);
 capture='frame';response=await ProtocolAdapter.sniffProtocol('node-test');assert.equal(response.source,'supabase');assert.equal(response.protocol,'DAIKIN2');assert(response.raw_data);
 response=await ProtocolAdapter.detectRemoteBrand('node-test');assert.equal(response.brand,null);assert.equal(response.protocol,'DAIKIN2');assert.equal(response.ambiguous,true);
 response=await ProtocolAdapter.getLatestLearned('node-test');assert.equal(response.sequence,2);assert.equal(response.source,'supabase');
 await NodeService.editDevice('node-test',{name:'Renamed controller'});assert.equal(NodeService.getNode('node-test').last_seen,null,'Metadata edit is not a hardware heartbeat');
 console.log('Hardware control passed: cloud-only full-state mode/fan/temp/power, receiver-only rejection, failures preserve state, no fabricated measurements, and actual cloud IR captures.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
