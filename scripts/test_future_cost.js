'use strict';
// Isolated model-output fixtures. No database, network, or hardware writes.
const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const context=vm.createContext({Date,DOMException,AbortController,window:{},setTimeout,clearTimeout});
for(const name of ['energy-prediction','future-cost'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/js/'+name+'.js'),'utf8'),context);
const fc=context.window.EcoTrackFutureCost,normalize=context.window.EcoTrackEnergyPrediction.normalizeRecordedSettings;
const now=Date.parse('2026-10-20T00:00:00Z'),options={now};
const plan={from:'2026-10-21',to:'2026-10-27',hours:'8',days:'everyday'};
const sensor={source:'sensor',tariff:13.24,devices:[{id:'ac-one',name:'Monitored AC',referenceKwh:2,referenceSeconds:7200}]};
const control={source:'controller',tariff:13.24,devices:[{id:'esp-one',name:'Controller AC',settings:{setpoint_c:24,fan_command:'medium',operating_mode:'cool',eco:true}}],predict:async settings=>({kwh:.8,output_unit:'kWh',horizon_hours:1,settings:normalize(settings)})};
const plain=value=>JSON.parse(JSON.stringify(value));
test('Singapore future periods use calendar boundaries, including leap years and year rollover',()=>{
  assert.deepEqual(plain(fc.periodRange('tomorrow',Date.parse('2026-10-20T16:01:00Z'))),{from:'2026-10-22',to:'2026-10-22'});
  assert.deepEqual(plain(fc.periodRange('week',now)),{from:'2026-10-21',to:'2026-10-27'});
  assert.deepEqual(plain(fc.periodRange('month',Date.parse('2028-01-30T00:00Z'))),{from:'2028-02-01',to:'2028-02-29'});
  assert.deepEqual(plain(fc.periodRange('month',Date.parse('2026-12-10T00:00Z'))),{from:'2027-01-01',to:'2027-01-31'});
});
test('future dates and explicit AC operating hours are required; device wake/sleep cannot supply them',()=>{
  for(const hours of ['',null,undefined,true,-1,25,'invalid'])assert.throws(()=>fc.planDays({...plan,hours,wake_time:'05:00',sleep_time:'17:00'},now),/planned AC hours/);
  for(const from of ['2026-10-20','2026-02-30','invalid'])assert.throws(()=>fc.planDays({...plan,from},now));
  assert.throws(()=>fc.planDays({...plan,to:'2027-10-23'},now),/366/);
  assert.equal(fc.planDays({...plan,hours:'0'},now).reduce((sum,row)=>sum+row.hours,0),0);
});
test('operating weekdays and weekends apply to each calendar date',()=>{
  assert.equal(fc.planDays({...plan,days:'weekdays'},now).reduce((sum,row)=>sum+row.hours,0),40);
  assert.equal(fc.planDays({...plan,days:'weekends'},now).reduce((sum,row)=>sum+row.hours,0),16);
});
test('sensor cost uses covered modeled energy per hour and entered planned hours only',async()=>{
  const result=await fc.calculate(plan,{...sensor,predict:()=>{throw Error('Must not call controls');}},options);
  assert.equal(result.kwh,56);assert.equal(result.cost,741.44);assert.equal(result.plannedUnitHours,56);
  assert.equal(result.devices[0].coverage,2);assert.match(result.basis,/Historical/);assert.match(result.limitation,/not forecast/);
});
test('controller uses the one-hour model, preserves saved flags, and needs no fake environmental inputs',async()=>{
  const result=await fc.calculate(plan,control,options);
  assert(Math.abs(result.kwh-44.8)<1e-8);assert.equal(result.devices[0].settings.eco,true);
  assert.equal(result.devices[0].settings.setpoint_c,24);assert.equal(result.devices[0].coverage,null);
});
test('explicit controller overrides replace corresponding aliases and never write saved controls',async()=>{
  const result=await fc.calculate({...plan,target:'26',mode:'dry',fan:'low'},control,options);
  assert.equal(result.devices[0].settings.setpoint_c,26);assert.equal(result.devices[0].settings.operating_mode,'dry');assert.equal(result.devices[0].settings.fan_command,'low');
  assert.equal(control.devices[0].settings.setpoint_c,24);assert.equal(control.devices[0].settings.eco,true);
});
test('unsupported controls, invalid model units or horizons, and backend failures stay unavailable',async()=>{
  for(const predict of [async()=>({kwh:1,output_unit:'W',horizon_hours:0}),async()=>({kwh:-1,output_unit:'kWh',horizon_hours:1}),async()=>{throw Error('Backend unavailable');}]){
    const result=await fc.calculate(plan,{...control,predict},options);assert.equal(result.kwh,null);assert.equal(result.cost,null);assert.equal(result.available,false);
  }
  const result=await fc.calculate(plan,{...control,devices:[{...control.devices[0],settings:{...control.devices[0].settings,sleep:true}}]},options);
  assert.equal(result.kwh,null);assert.match(result.reason,/outside this reference model/);
});
test('missing sensor coverage and partially covered fleets never become zero or a partial total',async()=>{
  for(const missing of [{referenceKwh:null},{referenceSeconds:0},{referenceSeconds:null},{referenceKwh:NaN}]){
    const result=await fc.calculate(plan,{...sensor,devices:[...sensor.devices,{...sensor.devices[0],id:'missing',...missing}]},options);
    assert.equal(result.available,false);assert.equal(result.kwh,null);assert.equal(result.cost,null);assert.equal(result.rows[0].kwh,null);
  }
});
test('real zero energy, zero tariff, and an explicitly closed plan remain zero; missing tariff is unavailable',async()=>{
  const zero=await fc.calculate(plan,{...sensor,devices:[{...sensor.devices[0],referenceKwh:0}]},options);assert.equal(zero.kwh,0);assert.equal(zero.cost,0);
  assert.equal((await fc.calculate(plan,{...sensor,tariff:0},options)).cost,0);
  assert.equal((await fc.calculate(plan,{...sensor,tariff:null},options)).cost,null);
  assert.equal((await fc.calculate({...plan,hours:0},{...sensor,devices:[{...sensor.devices[0],referenceKwh:null}]},options)).kwh,0);
});
test('sensor grouping counts AC loads rather than temperature and pressure chips or multiple monitors',()=>{
  const nodes=[{id:'monitor-one',aircon_id:'ac-one',aircon_name:'Matrix'},{id:'monitor-two',aircon_id:'ac-one',aircon_name:'Matrix'}];
  const result=fc.sensorDevices(nodes,{available:true,devices:[{node_id:'monitor-one',aircon_id:'ac-one',energy_kwh:1,estimated_seconds:3600},{node_id:'monitor-two',aircon_id:'ac-one',energy_kwh:1,estimated_seconds:3600}]});
  assert.equal(result.length,1);assert.equal(result[0].referenceKwh/(result[0].referenceSeconds/3600),1);
  assert.equal(fc.sensorDevices(nodes,{available:false})[0].referenceKwh,null);
  assert.equal(fc.sensorDevices(nodes,{available:true,devices:[{node_id:'monitor-one',aircon_id:'other-ac',energy_kwh:9,estimated_seconds:3600}]})[0].referenceKwh,null);
});
test('AC selection remains exact and duplicate identities are rejected',async()=>{
  assert.equal((await fc.calculate({...plan,device:'ac-one'},sensor,options)).deviceCount,1);
  await assert.rejects(fc.calculate({...plan,device:'missing'},sensor,options),/No AC units/);
  await assert.rejects(fc.calculate(plan,{...sensor,devices:[...sensor.devices,...sensor.devices]},options),/identities/);
});
test('prediction workers are bounded, repeated settings are reused, and cancellation stops the plan',async()=>{
  let active=0,max=0,calls=0;
  const devices=Array.from({length:8},(_,i)=>({id:'esp-'+i,name:'AC '+i,settings:{...control.devices[0].settings,setpoint_c:16+i}}));
  const predict=async()=>{calls++;active++;max=Math.max(max,active);await new Promise(resolve=>setTimeout(resolve,5));active--;return {kwh:1,output_unit:'kWh',horizon_hours:1};};
  await fc.calculate(plan,{...control,devices,predict},options);assert(max<=3);assert.equal(calls,8);
  calls=0;await fc.calculate(plan,{...control,devices:devices.map(device=>({...device,settings:{}})),predict},options);assert.equal(calls,1);
  const abort=new AbortController();abort.abort();await assert.rejects(fc.calculate(plan,control,{...options,signal:abort.signal}),/Cancelled/);
});
