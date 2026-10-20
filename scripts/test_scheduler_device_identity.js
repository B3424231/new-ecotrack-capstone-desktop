'use strict';
// Registered-device identity fixtures only; no live registry, database, or hardware writes.
const { test } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/device-scheduler.js'), 'utf8');
async function rows({ monitoringId = 'monitor-one', sensorId = 'monitor-one', mode = 'both', samples = false, status = 'offline', secondSensor = false, heartbeat = false, registryUnavailable = false, sensorState = 'online' } = {}) {
  const connection = {};
  const controller = { id: 'esp-one', name: 'AC Device 1', monitoring_id: monitoringId, device_mode: 'both', room_id: 'room-one', wake_time: '05:00', sleep_time: '17:00', interval_val: 1, interval_unit: 'Minutes' };
  const sensor = { id: sensorId, active: true, name: 'Same ESP32 sensor configuration', aircon_id: 'ac-one', aircon_name: 'Matrix', location: 'Building · Floor · Room', fresh: samples, latest: samples ? {connection_status: sensorState} : null,
    sensor_schedule: {wake_time:'05:00',sleep_time:'17:00',interval_seconds:60} };
  const cloud = { success: true, nodes: [controller], aircons: [{id:'ac-one',controller_node_id:controller.id,name:'Matrix'}], rooms:[], floors:[], buildings:[] };
  const context = vm.createContext({ window: { EcoTrackMode:{mode}, EcoTrackHardwareCloud:{listStatus:async()=>heartbeat?[{node_id:controller.id,last_seen:'2026-10-20T00:00:00Z'}]:[]}, electron:{invoke:async channel => channel === 'scheduler-fetch-data' && !registryUnavailable ? cloud : {success:false}} },
    document:{getElementById:()=>connection,querySelector:()=>null,addEventListener(){}}, localStorage:{getItem:()=>null},
    fetch:async()=>({ok:true,json:async()=>({items:secondSensor?[sensor,{...sensor,id:'other-monitor',name:'Separate ESP32'}]:[sensor]})}),
    URL,AbortSignal,setTimeout,clearTimeout,schedulerEscape:String,getSchedulerDeviceState:()=>status,
    scheduleDrafts:new Map(),savedRooms:{},buildings:{},floors:{},renderSchedulerLoading(){},renderSchedulerLocationCabinet(){},renderSchedulerErrorState:message=>{throw Error(message);} });
  vm.runInContext(source,context); await context.window.EcoDeviceScheduler.load(true);
  return Object.values(context.savedRooms).flatMap(room=>room.nodes);
}
test('one registered ESP32 has one name and status before its first sensor reading',async()=>{
  const result=await rows(); assert.equal(result.length,1);
  assert.equal(result[0].id,'esp-one'); assert.equal(result[0].monitorId,'monitor-one');
  assert.equal(result[0].name,'AC Device 1'); assert.equal(result[0].monitor_name,undefined);
  assert.equal(result[0].connectionDetail,undefined); assert.equal(result[0].status,'offline');
  assert.equal(result[0].deviceLabel,'Monitoring & Controlling'); assert.equal(result[0].intervalVal,1);
});
test('missing sensor readings never replace confirmed ESP32 connection states',async()=>{
  for(const status of ['online','offline','sleeping','unknown']) assert.equal((await rows({status}))[0].status,status);
});
test('fresh sensor samples do not create a second ESP32 name or connection badge',async()=>{
  const result=await rows({samples:true,status:'online'}); assert.equal(result.length,1);
  assert.equal(result[0].monitor_name,undefined); assert.equal(result[0].connectionDetail,undefined);
  assert.equal(result[0].status,'online'); assert.equal(result[0].wakeTime,'05:00'); assert.equal(result[0].sleepTime,'17:00');
});
test('a different explicit monitoring identity remains separate even on the same AC',async()=>{
  const result=await rows({sensorId:'different-esp-monitor'}); assert.equal(result.length,2);
  assert.equal(result[0].id,'esp-one'); assert.equal(result[0].monitorId,undefined);
  assert.equal(result[1].monitorId,'different-esp-monitor'); assert.equal(result[1].controller,false);
});
test('a second physical monitor cannot overwrite the shared ESP32 schedule or name',async()=>{
  const result=await rows({secondSensor:true}); assert.equal(result.length,2);
  assert.equal(result[0].monitorId,'monitor-one'); assert.equal(result[0].name,'AC Device 1');
  assert.equal(result[1].name,'Separate ESP32'); assert.equal(result[1].monitorId,'other-monitor');
});
test('monitoring-only mode keeps one sensor schedule and its actual unavailable state',async()=>{
  const result=await rows({mode:'monitoring'}); assert.equal(result.length,1);
  assert.equal(result[0].controller,false); assert.equal(result[0].status,'unknown');
  assert.equal(result[0].monitorId,'monitor-one'); assert.equal(result[0].wakeTime,'05:00');
});
test('legacy snapshots without a monitoring ID retain their existing schedule association',async()=>{
  const result=await rows({monitoringId:null}); assert.equal(result.length,1);
  assert.equal(result[0].monitorId,'monitor-one'); assert.equal(result[0].wakeTime,'05:00');
});

test('Monitoring mode uses the registered ESP32 heartbeat before sensor readings arrive',async()=>{
  for(const status of ['online','offline','sleeping']) {
    const result=await rows({mode:'monitoring',heartbeat:true,status});
    assert.equal(result.length,1);assert.equal(result[0].controller,false);
    assert.equal(result[0].status,status);assert.equal(result[0].monitor_name,undefined);
  }
});

test('Monitoring mode never borrows status from another ESP32 assigned to the same AC',async()=>{
  const result=await rows({mode:'monitoring',sensorId:'different-monitor',heartbeat:true,status:'online'});
  assert.equal(result[0].status,'unknown');
});

test('Monitoring status falls back to explicit sensor feedback when the registry is unavailable',async()=>{
  assert.equal((await rows({mode:'monitoring',registryUnavailable:true,samples:true}))[0].status,'online');
  assert.equal((await rows({mode:'monitoring',registryUnavailable:true}))[0].status,'unknown');
  assert.equal((await rows({mode:'monitoring',registryUnavailable:true,samples:true,sensorState:'unknown'}))[0].status,'unknown');
});
test('separate sensor devices on the same AC retain their own rows and schedules',async()=>{
  for(const mode of ['both','monitoring']) {
    const result=await rows({mode,secondSensor:true,monitoringId:null}); assert.equal(result.length,2);
    assert.equal(result[0].monitorId,'monitor-one'); assert.equal(result[1].monitorId,'other-monitor');
  }
});
