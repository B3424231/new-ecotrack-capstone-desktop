'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ctx=vm.createContext({Date,window:{}});vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/js/ac-power-history.js'),'utf8'),ctx);
const api=ctx.window.EcoTrackPowerHistory,date='2026-10-19',start=Date.parse(date+'T00:00:00+08:00'),now=start+86400000;
const at=time=>Date.parse(date+'T'+time+':00+08:00');
const row=(time,state,extra={})=>({id:time,node_id:'esp-one',created:new Date(typeof time==='number'?time:at(time)).toISOString(),ac_on:state,interval_seconds:60,...extra});
const result=rows=>api.analyze(rows,date,now);
test('daily history uses Singapore midnight independent of host timezone',()=>{assert.equal(api.dayStart(date),start);assert.equal(api.today(start),date);assert.throws(()=>api.dayStart('2026-02-30'));});
test('first ON, last OFF and split operating windows retain the recorded times',()=>{
 const rows=[];for(let time=at('08:05');time<=at('16:59');time+=60000)rows.push(row(time,time<at('12:00')||time>=at('13:29')&&time<at('16:58')));
 const day=result(rows);assert.equal(day.onSeconds,7*3600+24*60);assert.equal(day.firstOn,at('08:05'));assert.equal(day.lastOff,at('16:58'));assert.equal(day.events.filter(event=>event.state==='on').length,2);
});
test('missing samples split coverage instead of extending ON across a gap',()=>{const day=result([row('08:00',true),row('08:05',true)]);assert.equal(day.onSeconds,120);assert(day.segments.some(s=>s.state==='unknown'&&s.from===at('08:01')&&s.to===at('08:05')));});
test('desired controls, IR acknowledgments and online connectivity do not establish physical power',()=>{
 const rows=[row('08:00',null,{status:'online',temperature:18,control_snapshot:{desired_state:{power:true},reported_state:{power:true},command_status:'transmitted'}}),row('09:00',true,{event_type:'schedule_updated'}),row('10:00',true,{event_type:'command_queued'})];
 assert.equal(result(rows).onSeconds,null);assert.equal(result(rows).firstOn,null);
});
test('schedule and command events do not interrupt an actual measured feedback interval',()=>{
 const day=result([row('08:00',true,{interval_seconds:120}),row('08:01',false,{event_type:'schedule_updated'})]);assert.equal(day.onSeconds,120);
});
test('monitoring feedback requires its calibrated independent power source and synchronized clock',()=>{
 const sample={observed_at:new Date(at('08:00')).toISOString(),created:undefined};
 assert.equal(result([row('08:00',true,{...sample,state_source:'power_meter',clock_quality:'synchronized'})]).onSeconds,60);
 for(const extra of [{state_source:'ir_receiver'},{state_source:'none'},{state_source:'power_meter',clock_quality:'unsynchronized'}])assert.equal(result([row('08:00',true,{...sample,...extra})]).onSeconds,null);
});
test('confirmed OFF records preserve a real zero while no feedback is unavailable',()=>{assert.equal(result([row('08:00',false)]).onSeconds,0);assert.equal(result([]).onSeconds,null);assert.equal(result([row('08:00',null)]).onSeconds,null);});
test('a missing historical cadence never invents duration',()=>{const day=result([row('08:00',true,{interval_seconds:null})]);assert.equal(day.onSeconds,null);assert.equal(day.firstOn,at('08:00'));assert.equal(day.events.find(event=>event.state==='on').seconds,null);});
test('last recorded cadence is bounded by day end and current time',()=>{
 assert.equal(result([row('23:59',true,{interval_seconds:120})]).onSeconds,60);
 assert.equal(api.analyze([row('08:00',true,{interval_seconds:120})],date,at('08:00')+30000).onSeconds,30);
});
test('overnight carry-in is clipped at midnight using only the recorded interval',()=>{const day=result([row(start-30000,true,{interval_seconds:60})]);assert.equal(day.firstOn,start);assert.equal(day.onSeconds,30);assert.equal(day.segments[0].from,start);});
test('overlapping monitors of one AC do not double count operating time',()=>{const day=result([row('08:00',true),row('08:00',true,{node_id:'second-monitor'})]);assert.equal(day.onSeconds,60);});
test('conflicting independent feedback remains unknown',()=>{assert.equal(result([row('08:00',true),row('08:00',false,{node_id:'second-monitor'})]).onSeconds,null);assert.equal(result([row('08:00',true),row('08:00',false)]).firstOn,null);});
test('different recorded cadences are respected across consecutive samples',()=>{assert.equal(result([row('08:00',true,{interval_seconds:120}),row('08:01',true,{interval_seconds:30})]).onSeconds,90);});
test('unqualified and invalid timestamps are excluded',()=>{const day=result([row('08:00',true,{created:'2026-10-19 08:00:00'}),row('08:00',true,{created:'invalid'})]);assert.equal(day.onSeconds,null);assert.equal(day.discarded,2);});
test('future feedback is excluded and timeline has no future confirmed intervals',()=>{const day=api.analyze([row('08:00',true),row('09:00',true)],date,at('08:00')+30000);assert.equal(day.onSeconds,30);assert(day.segments.every(segment=>segment.to<=day.through));});
