const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync((file === 'public/js/node-sync.js' && process.env.ECOTRACK_NODE_SYNC_SOURCE) || (file === 'public/js/logs.js' && process.env.ECOTRACK_LOGS_SOURCE) || path.join(__dirname, '..', file), 'utf8');
async function main() {
  let now = Date.now();
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  let nodes = [{ id: 'node_db_1', name: 'node-1', room_id: 'room1', interval_val: 30, interval_unit: 'Seconds', temp: 25.2, pressure: 0.4, battery: 3.9, rssi: -61, ac_on: true, status: 'online', aircon_type: 'Split Type' }];
  const writes = []; const events = []; let failWrites = false;
  const sb = { from(table) {
    let field; let value; let update = false;
    const query = {
      select() { return query; }, not() { return query; },
      eq(f, v) { field = f; value = v; return query; }, maybeSingle() { return query; },
      update() { update = true; return query; },
      then(resolve, reject) {
        const data = update ? [] : table === 'nodes' ? (field ? nodes.find(n => n[field] === value) : nodes)
          : table === 'rooms' ? { name: 'Lab', floor_id: 'floor1' }
          : table === 'floors' ? { name: 'Floor 2', building_id: 'building1' }
          : { name: 'Science Building' };
        return Promise.resolve({ data }).then(resolve, reject);
      }
    };
    return query;
  } };
  const window = { supabaseClient: sb, dispatchEvent: event => events.push(event), addEventListener() {} };
  const context = vm.createContext({ window, document: { readyState: 'loading', addEventListener() {} }, Date: Clock,
    console, AbortController, clearTimeout, setTimeout() {}, setInterval() {}, CustomEvent: class { constructor(type, args) { this.type = type; this.detail = args.detail; } },
    fetch: async (_, options) => {
      writes.push(JSON.parse(options.body));
      return { ok: !failWrites, status: failWrites ? 500 : 201, json: async () => ({ id: `saved_${writes.length}` }) };
    } });
  vm.runInContext(read('public/js/node-sync.js'), context);
  const flush = () => new Promise(setImmediate);
  const step = window.EcoTrackNodeSync.stepBackgroundTelemetryCadence;
  for (let n=0;n<5;n++) { await step(); await flush(); now+=30000; }
  assert.equal(writes.length, 0, 'Cached node readings cannot become new measurements on a timer');
  const save=window.EcoTrackNodeSync.saveNodeTelemetryToSqlite;
  const packet={id:'node-1',pb_id:'node_db_1',temp:25.2,pressure:0.4,battery:3.9,rssi:-61,
    ac_on:true,status:'online',intervalVal:30,intervalUnit:'Seconds',telemetry_id:'real-1'};
  await save(packet);
  assert.equal(writes.length,1); assert.equal(writes[0].temperature,25.2);
  assert.equal(writes[0].node_id,'node_db_1'); assert.equal(writes[0].room_name,'Lab');
  assert.equal(writes[0].interval_seconds,30); assert.equal(writes[0].ac_on,true);
  assert.equal(writes[0].id,'real-1'); assert.equal(writes[0].pressure,0.4);
  assert.equal(events[0].type,'ecotrack:telemetry-saved');
  await save(packet); assert.equal(writes.length,1,'Burst is throttled');
  now+=1000; failWrites=true; await save({...packet,telemetry_id:'real-2'});
  assert.equal(events.length,1,'Failed persistence cannot dispatch success');
  failWrites=false; await save({...packet,telemetry_id:'real-2'});
  assert.equal(writes.length,3,'A failed save can be retried immediately');
  assert.equal(events.length,2);
  now+=1000;
  await save({...packet,ac_on:false,telemetry_id:'real-off',control_snapshot:{desired_state:{power:true}}});
  assert.equal(writes.at(-1).ac_on,false,'Selected ON must not suppress a measured OFF boundary');
  now+=1000;
  await save({...packet,ac_on:undefined,temp:undefined,pressure:undefined,telemetry_id:'real-unknown'});
  assert.equal(writes.at(-1).ac_on,undefined); assert.equal(writes.at(-1).temperature,null);
  const saved=writes.length; now+=1000;
  await save({...packet,status:'sleeping'}); assert.equal(writes.length,saved);
  nodes=[]; now+=30000; await step(); await flush(); assert.equal(writes.length,saved);

  const source = read('public/js/logs.js');
  let refreshCalls = 0; let renders = 0;
  const logs = vm.createContext({ Date: Clock, currentPeriod: 'daily', selectedDateKey: '',
    window: { addEventListener() {} }, console,
    fetchLogsFromDB: async silent => { assert.equal(silent, true); refreshCalls++; },
    populateDateRangeOptions() {}, render() { renders++; } });
  vm.runInContext(source.slice(source.indexOf('function getPeriodDateKey('), source.indexOf('function getPeriodDateLabel(')), logs);
  vm.runInContext(source.slice(source.indexOf('let telemetryRefreshPending'), source.indexOf('// Helper to get actual aircon fleet count')), logs);
  await logs.refreshLogsAfterTelemetrySaved();
  assert.equal(refreshCalls, 1);
  assert.equal(renders, 1);
  logs.selectedDateKey = '2000-01-01';
  vm.runInContext('followLatestLogPeriod = false', logs); // Simulate the date picker choosing history.
  await logs.refreshLogsAfterTelemetrySaved();
  assert.equal(refreshCalls, 1, 'Historical filters must remain stable');
  logs.currentPeriod = 'monthly';
  logs.selectedDateKey = logs.getPeriodDateKey(new Clock(), 'monthly');
  await logs.refreshLogsAfterTelemetrySaved();
  assert.equal(refreshCalls, 2);
  console.log('Telemetry tests passed: actual readings, OFF/unknown evidence, failed-save retry, no synthetic timer rows, and history filters.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
