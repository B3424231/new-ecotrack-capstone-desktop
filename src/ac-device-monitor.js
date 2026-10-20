'use strict';
// Mirror authenticated registration metadata only. No status, sample or power feedback is synthesized.
const { requestMonitoring } = require('./monitoring-local');
async function readRegistryTable(client, table, signal) {
  const records = [], seen = new Set();
  let expected;
  do {
    let query = client.from(table).select('*', { count: 'exact' });
    const paged = typeof query.range === 'function';
    if (paged) query = query.order('id', { ascending: true }).range(records.length, records.length + 499);
    if (typeof query.abortSignal === 'function') query = query.abortSignal(signal);
    const result = await query;
    if (result.error || !Array.isArray(result.data)) throw new Error('Registered AC device metadata is unavailable.');
    if (paged && (!Number.isInteger(result.count) || result.count < 0 || expected !== undefined && expected !== result.count))
      throw new Error('The registered AC device snapshot was incomplete or changed. Retry the refresh.');
    expected = paged ? result.count : result.data.length;
    for (const row of result.data) {
      if (!row.id || seen.has(row.id)) throw new Error('The registered AC device snapshot contains conflicting identities.');
      seen.add(row.id); records.push(row);
    }
    if (records.length > expected || !result.data.length && records.length < expected)
      throw new Error('The registered AC device snapshot was incomplete. Retry the refresh.');
  } while (records.length < expected);
  return records;
}
const pendingSyncs = new WeakMap();
function syncRegisteredMonitors(client, options) {
  if (pendingSyncs.has(client)) return pendingSyncs.get(client);
  const task = reconcileRegisteredMonitors(client, options).finally(() => pendingSyncs.delete(client));
  pendingSyncs.set(client, task);
  return task;
}
async function reconcileRegisteredMonitors(client, options) {
  const controller = new AbortController();
  let timeout;
  const deadline = new Promise((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error('Registered AC device metadata timed out.')); }, 8000); });
  let tables;
  try {
    tables = await Promise.race([Promise.all(['nodes','aircons','rooms','floors','buildings'].map(table =>
      readRegistryTable(client, table, controller.signal))), deadline]);
  } finally { clearTimeout(timeout); }
  const [devices, aircons, rooms, floors, buildings] = tables;
  const entries = [];
  for (const node of devices.filter(node => ['monitoring','both'].includes(node.device_mode))) {
    if (!node.monitoring_id || !node.monitor_aircon_id) throw new Error('Registered sensor configuration is incomplete.');
    const ac = aircons.find(ac => ac.id === node.monitor_aircon_id), config = node.sensor_config;
    if (!ac || !config) throw new Error('Registered sensor configuration is incomplete.');
    const room = rooms.find(room => room.id === node.room_id), floor = floors.find(floor => floor.id === room?.floor_id), building = buildings.find(building => building.id === floor?.building_id);
    const path = [building?.name, floor?.name, room?.name];
    const data = {name:node.name,aircon_id:ac.id,aircon_name:ac.name || ac.asset_tag || ac.id,aircon_type:ac.aircon_type || null,location:path.every(Boolean) ? path.join(' · ') : '',
      pressure_sensor:config.pressure_sensor,pressure_min_pa:config.pressure_min_pa,pressure_max_pa:config.pressure_max_pa};
    const multiplier = {seconds:1,minutes:60,hours:3600}[String(node.interval_unit || '').toLowerCase()];
    const seconds = Number(node.interval_val) * multiplier;
    if (Number.isFinite(seconds) && seconds >= 1 && seconds <= 86400) data.expected_interval_seconds = seconds;
    entries.push({ id: node.monitoring_id, registry_node_id: node.id, device: data });
  }
  const result = await requestMonitoring({action:'reconcile',data:{devices:entries}}, {...options,trustedImport:true});
  return {success:true,data:{changed:result.data.changed}};
}
module.exports = { syncRegisteredMonitors };
