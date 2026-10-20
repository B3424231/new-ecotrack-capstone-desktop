'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('public/js/scheduler.js','utf8'),checks=[];
const section=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
const helpers=section('function normalizeScheduleTime(', 'function composeTimeValue(');
const apply=section('async function applyNodeSchedule(', '// Custom Warning Modal');
function harness(wake='',sleep='',value='5',unit='Seconds'){
 const calls=[],errors=[],successes=[],focused=[];const fields={};
 for(const [key,val]of Object.entries({wake,sleep,'interval-val':value,'interval-unit':unit}))
  fields[key+'-test']={value:val,focus(){focused.push(key);}};
 fields['sleep-note-test']={textContent:'',classList:{toggle(){}}};
 const button={textContent:'Apply',disabled:false,dataset:{}};
 const context=vm.createContext({console,document:{getElementById:id=>fields[id],querySelector:selector=>({focus(){focused.push(selector);}})},savedRooms:{},scheduleDrafts:new Map(),scheduleDeliveries:new Map(),localStorage:{setItem(){}},CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}},
 window:{EcoToast:{error:message=>errors.push(message),success:message=>successes.push(message)},EcoTrackHardwareCloud:{request:async(...args)=>{calls.push(args);return {id:'command-'+calls.length,node_id:'db-node',status:'queued'};}},dispatchEvent(){}}});
 vm.runInContext(helpers+apply,context);
 return {context,calls,errors,successes,focused,fields,button,apply:()=>context.applyNodeSchedule('test',button)};
}
async function main(){
 let app=harness();
 assert.equal(app.context.formatTimeDisplay(null),'Not set');assert.equal(app.context.formatTimeDisplay(''),'Not set');assert.equal(app.context.formatTimeDisplay('25:00'),'Invalid time');
 checks.push('Unset and malformed times are visible instead of a false 05:00 AM default');
 for(const [value,display,canonical]of [['05:00','05:00 AM','05:00'],['5:00','05:00 AM','05:00'],['22:00:00','10:00 PM','22:00'],['00:00:00.000000','12:00 AM','00:00'],['12:05','12:05 PM','12:05']]){
  assert.equal(app.context.formatTimeDisplay(value),display);assert.equal(app.context.normalizeScheduleTime(value),canonical);
 }
 checks.push('Minute times and stored zero-second timestamps display and normalize correctly across midnight and noon');
 for(const invalid of ['24:00','29:00','06:60','06:00:30','06:00:00.1','not-a-time','05:00 PM'])assert.equal(app.context.normalizeScheduleTime(invalid),null);
 checks.push('Invalid clocks and unsupported sub-minute precision are rejected without silently rounding');
 await app.apply();assert.equal(app.calls.length,0);assert.match(app.errors.at(-1),/wake time/);assert.equal(app.button.disabled,false);assert.equal(app.button.textContent,'Apply');
 checks.push('Missing wake time gets a specific error and no database request');
 app=harness('05:00','');await app.apply();assert.equal(app.calls.length,0);assert.match(app.errors.at(-1),/sleep time/);
 checks.push('Missing sleep time is identified independently of a valid interval');
 app=harness('05:00:00','22:00:00');await app.apply();assert.equal(app.calls.length,1);
 assert.deepEqual(JSON.parse(JSON.stringify(app.calls[0][2])),{interval_seconds:5,interval_val:5,interval_unit:'Seconds',wake_time:'05:00',sleep_time:'22:00'});
 assert.equal(app.fields['wake-test'].value,'05:00');assert.equal(app.fields['sleep-test'].value,'22:00');assert.equal(app.button.textContent,'Queued');
 checks.push('The shown 5-second interval queues valid normalized times and never claims Applied without a device receipt');
 app=harness('05:00','05:00');await app.apply();assert.equal(app.calls.length,1);assert.match(app.fields['sleep-note-test'].textContent,/keep this controller awake/);
 checks.push('Equal explicit times remain valid and explain that sleeping is disabled');
 for(const [value,unit,seconds]of [['1','Seconds',1],['5','Minutes',300],['24','Hours',86400]]){
  app=harness('06:00','22:00',value,unit);await app.apply();assert.equal(app.calls[0][2].interval_seconds,seconds);
 }
 checks.push('All interval units and the minimum/maximum hardware bounds remain supported');
 for(const [value,unit]of [['0','Seconds'],['1.5','Minutes'],['25','Hours'],['5','invalid'],['','Seconds']]){
  app=harness('06:00','22:00',value,unit);await app.apply();assert.equal(app.calls.length,0);assert.match(app.errors.at(-1),/report interval/);
 }
 checks.push('Invalid interval values report the interval problem and produce no writes');
 app=harness('06:00','22:00');app.context.window.EcoTrackHardwareCloud.request=async()=>{throw Error('Supabase rejected write');};await app.apply();
 assert.equal(app.button.textContent,'Apply');assert.equal(app.button.disabled,false);assert.match(app.errors.at(-1),/Supabase rejected/);
 checks.push('A rejected write cannot claim a queued or applied schedule');
 fs.mkdirSync('reports/node-schedule-times',{recursive:true});fs.writeFileSync('reports/node-schedule-times/unit-tests.json',JSON.stringify({passed:checks.length,checks,live_hardware_tested:false,live_database_tested:false},null,2));
 console.log('Node schedule times: '+checks.length+' checks passed.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
