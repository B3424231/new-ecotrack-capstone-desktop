/* Sensor project page structure, using the controller shell and real local sensor records. */
(function () {
  'use strict';
  const page = document.body.dataset.sensorPage;
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const num = (value, digits = 1) => Number.isFinite(value) ? value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : 'Unavailable';
  const stamp = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('en-SG', { timeZone: 'Asia/Singapore', hour12: true }) : 'No reading';
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  let observationDate = today();
  const badge = (label, tone = '') => `<span class="sensor-badge ${tone}">${esc(label)}</span>`;
  const state = (sample, fresh = true) => sample?.ac_on == null ? '<span title="Waiting for confirmed AC ON/OFF feedback">'+badge('Not reported')+'</span>' : !fresh ? badge('No recent feedback') : badge(sample.ac_on ? 'Confirmed ON' : 'Confirmed OFF', 'good');
  const modeLabel = (sample, fresh = true) => fresh ? ({ cool: 'Cool', fan_only: 'Fan Only' }[sample?.operating_mode] || 'Unavailable') : 'Unavailable';
  let nodes = [], registryDevices = [], stats = null, energy = null, history = [], loaded = false, available = false;
  let energySelection = '';
  let controller, exportController, revision = 0, running = false, exporting = false, pageNumber = 1, total = 0, period = 'daily', locationFilter = null;
  const charts = new Map();
  let fleetPosition={location:null,top:0};
  let cloudRegistryTask, registrySyncAt = 0;
  function syncCloudRegistry({force = false} = {}) {
    if (!window.electron?.invoke) return Promise.resolve(null);
    if (cloudRegistryTask) return cloudRegistryTask;
    if (!force && Date.now() - registrySyncAt < 15000) return Promise.resolve(null);
    registrySyncAt = Date.now();
    let timer;
    cloudRegistryTask=Promise.race([window.electron.invoke('monitoring-sync-registry'),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),8000);})])
      .catch(()=>null).finally(()=>{clearTimeout(timer);cloudRegistryTask=null;});
    return cloudRegistryTask;
  }
  let locationRegistry = { buildings: [], floors: [], rooms: [] }, registryTask;
  for (const [field, key] of [['buildings', 'ecoTrack_buildings'], ['floors', 'ecoTrack_floors'], ['rooms', 'ecoTrack_rooms']]) {
    try { const stored = JSON.parse(localStorage.getItem(key) || '[]'); if (Array.isArray(stored)) locationRegistry[field] = stored; } catch (_) {}
  }

  function base() {
    const url = new URL(window.ECOTRACK_CONFIG?.backendUrl || window.electron?.env?.BACKEND_URL || 'http://localhost:5000');
    if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Sensor readings require the local EcoTrack backend.');
    return url.origin + '/api/monitoring';
  }
  async function request(path, { signal, blob = false } = {}) {
    const abort = new AbortController(), cancel = () => abort.abort();
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, 8000);
    try {
      const result = await fetch(base() + path, { signal: abort.signal, cache: 'no-store' });
      if (!result.ok) throw new Error((await result.json().catch(() => ({}))).error || 'Local sensor request failed.');
      return blob ? await result.blob() : await result.json();
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  }
  function selected() { return nodes.filter(node => node.active && (!$('sensorSelect')?.value || node.id === $('sensorSelect').value) && (locationFilter === null || node.location === locationFilter)); }
  function sensorFutureCostContext(reference) {
    let label=observationDate;
    try {
      const params=query(),date=value=>new Date(value+8*3600000).toISOString().slice(0,10);
      label=date(Date.parse(params.get('from')))+' to '+date(Date.parse(params.get('to'))-1);
      if(reference===undefined)reference=available && energySelection===params.toString()?energy:null;
    } catch (_) { reference=null; }
    return {devices:window.EcoTrackFutureCost?.sensorDevices(selected(),reference) || [],tariff:tariff(),scope:'Selected monitored AC units',reference:label+' · covered temperature-model intervals'};
  }
  function telemetryDevices() {
    const measured=nodes.filter(node=>node.active), allowed=registryDevices.filter(node=>window.EcoTrackMode?.mode==='both' || ['monitoring','both'].includes(node.device_mode));
    const cards=measured.map(sensor=>{
      const registered=allowed.find(device=>device.monitoring_id===sensor.id);
      const cloudFirst=window.EcoTrackMode?.mode==='both' && registered?.device_mode==='both';
      const first=cloudFirst?registered.sensor_schedule:sensor.sensor_schedule,second=cloudFirst?sensor.sensor_schedule:registered?.sensor_schedule;
      return {...sensor,device_mode:registered?.device_mode || sensor.device_mode || 'monitoring',sensor_schedule:first || second ? Object.fromEntries(['wake_time','sleep_time','interval_seconds'].map(key=>[key,first?.[key]??second?.[key]??null])) : null};
    });
    return [...cards,...allowed.filter(node=>!measured.some(sensor=>sensor.id===node.monitoring_id))];
  }
  function readRegistryDevices(data) {
    registryDevices=(data.nodes || []).map(node=>{
      const id=node.id || node.db_id || node.node_id;
      const room=locationRegistry.rooms.find(room=>room.id===node.room_id),floor=locationRegistry.floors.find(floor=>floor.id===room?.floor_id),building=locationRegistry.buildings.find(building=>building.id===floor?.building_id);
      const ac=(data.aircons || []).find(ac=>ac.id===node.monitor_aircon_id || ac.aircon_id===node.monitor_aircon_id || [id,node.node_id].filter(Boolean).some(value=>[ac.controller_node_id,ac.node_id].includes(value)));
      const parts=[building?.name,floor?.name,room?.name];
      const time=value=>typeof value==='string' && /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)?value.slice(0,5):null;
      const seconds=node.interval_val==null?NaN:Number(node.interval_val)*({seconds:1,minutes:60,hours:3600}[String(node.interval_unit || '').toLowerCase()] || NaN);
      const savedSchedule={wake_time:time(node.wake_time),sleep_time:time(node.sleep_time),interval_seconds:Number.isFinite(seconds) && seconds>=1 && seconds<=86400?seconds:null};
      return {id:'registry:'+id,registry_only:true,monitoring_id:node.monitoring_id,device_mode:node.device_mode || 'controller',active:true,fresh:false,latest:null,
        sensor_schedule:Object.values(savedSchedule).some(value=>value!==null)?savedSchedule:null,
        name:node.name || 'Device name unavailable',aircon_name:ac?.name || ac?.asset_tag || 'No aircon assigned',aircon_type:ac?.aircon_type || node.aircon_type,
        location:parts.every(Boolean)?parts.join(' · '):'',status:'Awaiting readings',
        temperature_sensor:node.sensor_config?.temperature_sensor || 'Not reported',pressure_sensor:node.sensor_config?.pressure_sensor || 'Not configured'};
    });
  }
  function query() {
    const params = new URLSearchParams();
    if ($('sensorSelect')?.value) params.set('node_id', $('sensorSelect').value);
    let from = page === 'logs' ? observationDate : $('sensorFrom')?.value, through = $('sensorThrough')?.value || from;
    if (!from || !through || from > through) throw new Error('Choose a valid observation date range.');
    if (page === 'logs') {
      const day = new Date(from + 'T00:00:00Z');
      if (period === 'weekly') { day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7); from = day.toISOString().slice(0, 10); through = new Date(day.getTime() + 6 * 86400000).toISOString().slice(0, 10); }
      if (period === 'monthly') { from = from.slice(0, 7) + '-01'; const start = new Date(from + 'T00:00:00Z'); start.setUTCMonth(start.getUTCMonth() + 1); through = new Date(start.getTime() - 86400000).toISOString().slice(0, 10); }
    }
    params.set('from', new Date(from + 'T00:00:00+08:00').toISOString());
    params.set('to', new Date(Date.parse(through + 'T00:00:00+08:00') + 86400000).toISOString());
    if (page === 'logs') for (const [key, id] of [['start_time', 'sensorTimeStart'], ['end_time', 'sensorTimeEnd']]) if ($(id)?.value) params.set(key, $(id).value);
    return params;
  }
  function error(message = '') { $('sensorError').hidden = !message; $('sensorError').textContent = message; }
  function empty(title, text) { return `<div class="sensor-empty"><strong>${esc(title)}</strong><p>${esc(text)}</p></div>`; }
  function chartMarkup(id, title, note) { return `<section class="sensor-panel glass-surface glass-card"><h2>${title}</h2><p>${note}</p><div class="sensor-chart"><canvas id="${id}" role="img" aria-label="${title}"></canvas><div id="${id}Empty" class="sensor-chart-empty">No measured readings in this window.</div></div></section>`; }
  function build() {
    if (page === 'analytics') {
      $('sensorFrom').value = today(); $('sensorThrough').value = today();
      $('sensorApp').innerHTML = '<div class="sensor-snapshots" id="sensorSnapshots"></div><div class="sensor-chart-grid">' + chartMarkup('sensorTempChart', 'Temperature Trend', 'MCP9808 · °C') + chartMarkup('sensorPressureChart', 'Airflow Pressure Trend', 'MPX5010DP · Pa') + '</div>' + chartMarkup('sensorStateChart', 'AC Mode & Power History', 'Reported mode · confirmed power');
    } else if (page === 'logs') {
      populateObservationDates();
      $('sensorApp').innerHTML = '<div class="sensor-forecast-space">' + $('sensorForecastTemplate').innerHTML + '</div><section class="eco-data-panel sensor-log-panel" aria-labelledby="sensorLogTitle"><div class="eco-table-toolbar"><h2 id="sensorLogTitle">Daily Sensor Logs</h2><p>Historical sensor measurements, AC feedback and hardware readings · UTC+08:00</p></div><div id="sensorLogTable"></div><div class="sensor-pagination eco-table-footer"><span class="sensor-status" id="sensorPageInfo"></span><div class="sensor-actions"><button type="button" class="sensor-button" id="sensorPrevious">Previous</button><button type="button" class="sensor-button primary" id="sensorNext">Next</button></div></div></section><p class="sensor-status sensor-export-status" id="sensorExportStatus" role="status" aria-live="polite"></p>';
    } else {
      $('sensorApp').innerHTML = `<div class="sensor-telemetry-layout"><aside class="eco-location-panel sensor-panel sensor-cabinet"><h2 class="eco-location-title">${sensorIcon('location')}Location</h2><div id="sensorLocations" class="eco-location-tree sensor-tree"></div></aside><section class="sensor-panel sensor-interface"><div class="sensor-panel-head"><h2 id="sensorInterfaceTitle">${sensorIcon('node')}AC Sensor Interface</h2><span class="sensor-status" id="sensorCount"></span></div><div id="sensorFleet" class="sensor-interface-grid" tabindex="0" role="region" aria-label="AC sensor devices"></div></section></div>`;
    }
    for (const id of ['sensorSelect', 'sensorFrom', 'sensorThrough', 'sensorTimeStart', 'sensorTimeEnd']) $(id)?.addEventListener('change', () => {
      if (page === 'logs' && id === 'sensorFrom' && $('sensorFrom').value) { observationDate = $('sensorFrom').value; populateObservationDates(); }
      pageNumber = 1; locationFilter = null; refresh();
    });
    $('sensorDateSelect')?.addEventListener('change', () => { observationDate = $('sensorDateSelect').value; $('sensorFrom').value = ''; pageNumber = 1; refresh(); });
    $('sensorClearTime')?.addEventListener('click', () => { $('sensorTimeStart').value = ''; $('sensorTimeEnd').value = ''; pageNumber = 1; refresh(); });
    document.querySelectorAll('[data-period]').forEach(button => button.addEventListener('click', () => {
      period = button.dataset.period; pageNumber = 1;
      document.querySelectorAll('[data-period]').forEach(item => { item.setAttribute('aria-pressed', String(item === button)); item.classList.toggle('active', item === button); });
      $('sensorLogTitle').textContent = period[0].toUpperCase() + period.slice(1) + ' Sensor Logs'; populateObservationDates(); refresh();
    }));
    $('sensorPrevious')?.addEventListener('click', () => { if (pageNumber > 1) { pageNumber--; refresh(); } });
    $('sensorNext')?.addEventListener('click', () => { if (pageNumber * 50 < total) { pageNumber++; refresh(); } });
    document.querySelectorAll('[data-export]').forEach(button => button.addEventListener('click', () => exportLogs(button.dataset.export)));
  }
  function populateObservationDates() {
    const select = $('sensorDateSelect'); if (!select) return;
    const choices = new Map();
    for (let i = 0; i < 7; i++) { const date = new Date(today() + 'T12:00:00Z'); if (period === 'monthly') date.setUTCMonth(date.getUTCMonth() - i, 1); else date.setUTCDate(date.getUTCDate() - i * (period === 'weekly' ? 7 : 1)); const key = date.toISOString().slice(0, 10); choices.set(key, key); }
    choices.set(observationDate, observationDate);
    const label = key => {
      const value = new Date(key + 'T12:00:00Z'), format = { month: 'long', year: 'numeric', timeZone: 'UTC' };
      if (period === 'daily') format.day = 'numeric';
      if (period === 'weekly') { value.setUTCDate(value.getUTCDate() - (value.getUTCDay() + 6) % 7); format.day = 'numeric'; return 'Week of ' + value.toLocaleDateString('en-US', format); }
      return value.toLocaleDateString('en-US', format);
    };
    const seen = new Set();
    select.innerHTML = [...choices.keys()].sort().reverse().filter(key => { const name = label(key); if (key !== observationDate && name === label(observationDate) || seen.has(name)) return false; seen.add(name); return true; }).map(key => `<option value="${key}">${esc(label(key))}</option>`).join('');
    select.value = observationDate;
  }
  function populate() {
    const select = $('sensorSelect'); if (!select) return; const previous = select.value;
    const missing = previous && !nodes.some(node => node.id === previous && node.active);
    const previousLabel = select.selectedOptions[0]?.textContent?.replace(/ \(Unavailable\)$/, '') || 'Selected sensor';
    const options = '<option value="">All Sensors</option>' + nodes.filter(node => node.active).map(node => `<option value="${esc(node.id)}">${esc(node.name)} · ${esc(node.aircon_name)}</option>`).join('')
      + (missing ? `<option value="${esc(previous)}">${esc(previousLabel)} (Unavailable)</option>` : '');
    if (select.dataset.sensorOptions !== options) { select.innerHTML = options; select.dataset.sensorOptions = options; }
    select.value = previous;
    if ($('sensorActiveCount')) $('sensorActiveCount').textContent = available ? String(nodes.filter(node => node.fresh && node.active).length) : '—';
  }
  function renderLocations() {
    const container = $('sensorLocations'); if (!container) return;
    const groups = new Map();
    locationRegistry.rooms.forEach(room => {
      const floor = locationRegistry.floors.find(item => item.id === room.floor_id), building = locationRegistry.buildings.find(item => item.id === (floor?.building_id || room.building_id));
      if (room.name && floor?.name && building?.name) groups.set([building.name, floor.name, room.name].join(' · '), 0);
    });
    telemetryDevices().forEach(node => groups.set(node.location || '', (groups.get(node.location || '') || 0) + 1));
    if (!groups.has(locationFilter)) locationFilter = [...groups.keys()].find(location => location.trim()) || null;
    const tree = new Map();
    [...groups].forEach(([location, count], index) => {
      const parts = location.split('·').map(part => part.trim()).filter(Boolean);
      if (!parts.length) return;
      let branch = tree;
      parts.forEach((part, depth) => { if (!branch.has(part)) branch.set(part, { children: new Map(), leaves: [] }); const item = branch.get(part); if (depth === parts.length - 1) item.leaves.push({ location, count, index }); branch = item.children; });
    });
    const draw = (branch, depth = 0) => [...branch].map(([name, item]) => item.children.size ? `<details class="sensor-location-level-${depth} ${depth === 0 ? 'eco-location-building-group' : 'eco-location-floor'}" open><summary class="${depth === 0 ? 'eco-location-building' : 'eco-location-floor-heading'}">${depth === 0 ? sensorIcon('building') : sensorIcon('floor')}${esc(name)}</summary><div class="${depth === 0 ? 'eco-location-floors' : 'eco-location-rooms'}">${item.leaves.map(leaf => locationButton(name, leaf)).join('')}${draw(item.children, depth + 1)}</div></details>` : item.leaves.map(leaf => locationButton(name, leaf)).join('')).join('');
    const locationButton = (name, leaf) => `<button type="button" class="eco-location-room" data-location-index="${leaf.index}" aria-pressed="${locationFilter === leaf.location}"><span>${esc(name)}</span><small>${leaf.count} device${leaf.count === 1 ? '' : 's'}</small></button>`;
    container.innerHTML = draw(tree) + (!tree.size ? '<p class="sensor-note">No locations yet</p>' : '');
    container.querySelectorAll('button').forEach(button => button.addEventListener('click', () => {
      locationFilter = button.dataset.locationIndex === '-1' ? null : [...groups.keys()][Number(button.dataset.locationIndex)];
      if ($('sensorSelect')) $('sensorSelect').value = ''; renderLocations(); renderFleet();
    }));
  }
  function refreshLocations({ renderNow = true } = {}) {
    if (page !== 'telemetry' || registryTask || !window.electron?.invoke) return registryTask;
    let timer;
    registryTask = Promise.race([window.electron.invoke('scheduler-fetch-data'), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Location registry unavailable')), 5000); })])
      .then(result => { if (!result?.success) return; for (const field of ['buildings', 'floors', 'rooms']) if (Array.isArray(result[field])) locationRegistry[field] = result[field]; readRegistryDevices(result);if(renderNow){renderLocations(); renderFleet();} })
      .catch(() => {}).finally(() => { clearTimeout(timer); registryTask = null; });
    return registryTask;
  }
  function sensorIcon(name) {
    const paths = { location: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="3"/>', node: '<rect x="5" y="3" width="14" height="18" rx="3"/><path d="M9 7h6M9 11h6M11 17h2"/>', temperature: '<path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0Z"/><path d="M12 9v9"/>', pressure: '<path d="M4 19a10 10 0 1 1 16 0M12 13l4-4M5 19h14"/>', cool: '<path d="M12 2v20M3 7l18 10M3 17 21 7M8 4l4 4 4-4M8 20l4-4 4 4"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>' };
    paths.building = '<path d="M3 21V8l9-6 9 6v13H3Z"/><path d="M9 21V11h6v10"/>';
    paths.floor = '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 12h16"/>';
    return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.node}</svg>`;
  }
  function sensorCard(node) {
    const live = available && node.fresh, sample = node.latest, schedule = node.sensor_schedule;
    const measurement = (value, unit, digits = 1) => Number.isFinite(value) ? `<strong><span>${num(value, digits)}</span><small>${unit}</small></strong>` : '<strong class="sensor-unavailable">Unavailable</strong>';
    return `<article class="sensor-node sensor-telemetry-card glass-surface glass-card"><div class="sensor-node-top"><div><h3>${esc(node.name)}</h3>${badge(available ? node.status : 'Unavailable', live ? 'good' : 'warn')}</div><div class="sensor-mode-tile">${sensorIcon('cool')}<div><span class="sensor-eyebrow">AC Mode</span><b>${modeLabel(sample, live)}</b></div></div></div><p class="sensor-node-asset">${esc(node.aircon_name)}</p>${node.registry_only ? '<p class="sensor-note">Sensor readings will appear when received.</p>' : ''}<div class="sensor-node-metrics"><div class="sensor-metric temperature">${sensorIcon('temperature')}<span>Temperature</span>${measurement(live ? sample?.outlet_temperature_c : null, '°C')}</div><div class="sensor-metric pressure">${sensorIcon('pressure')}<span>Air Pressure</span>${measurement(live ? sample?.differential_pressure_pa : null, 'Pa')}</div></div><div class="sensor-hardware-metrics"><div><span>Signal</span><b>${live && Number.isFinite(sample?.rssi_dbm) ? num(sample.rssi_dbm, 0) + ' dBm' : 'Unavailable'}</b></div><div><span>Battery</span><b>${live && Number.isFinite(sample?.battery_voltage) ? num(sample.battery_voltage, 2) + ' V' : 'Unavailable'}</b></div></div><div class="sensor-power-row"><span>AC Power</span>${state(sample, live)}</div><div class="sensor-schedule-preview" aria-label="Requested sensor schedule"><div><span>Wake</span><b>${esc(schedule?.wake_time || 'Not set')}</b></div><div><span>Sleep</span><b>${esc(schedule?.sleep_time || 'Not set')}</b></div><div><span>Interval</span><b>${Number.isFinite(schedule?.interval_seconds) ? num(schedule.interval_seconds / 60, 4).replace(/\.?0+$/, '') + ' min' : 'Not set'}</b></div></div><footer><span title="Last observation">${sensorIcon('clock')}${esc(stamp(sample?.observed_at))}</span><button type="button" class="sensor-detail-button" data-sensor-detail="${esc(node.id)}" aria-label="View details for ${esc(node.name)}">Details →</button></footer></article>`;
  }
  function renderFleet() {
    const list = telemetryDevices().filter(node=>locationFilter===null || node.location===locationFilter);
    $('sensorCount').textContent = loaded ? `${list.length} sensor${list.length===1?'':'s'}` : '';
    $('sensorCount').title='Sensor devices in this room';
    const fleet=$('sensorFleet'), location=locationFilter || '';
    const scrollTop=fleetPosition.location===location ? fleetPosition.top : 0;
    fleetPosition={location,top:scrollTop};
    fleet.dataset.location=location;fleet.classList.toggle('has-devices',list.length>0);
    $('sensorInterfaceTitle').innerHTML = sensorIcon('node') + esc(locationFilter ? locationFilter.split('·').at(-1).trim() : 'AC Sensor Interface');
    fleet.innerHTML = list.length ? list.map(sensorCard).join('') : empty(loaded ? 'No sensors in this location' : 'Loading sensors', '');
    fleet.scrollTop=scrollTop;
    document.querySelectorAll('[data-sensor-detail]').forEach(button => button.addEventListener('click', () => openSensorDetails(button.dataset.sensorDetail)));
  }
  function openSensorDetails(id) {
    const node = telemetryDevices().find(item => item.id === id); if (!node) return;
    const sample = node.latest, live = available && node.fresh;
    const deviceType=({monitoring:'Monitoring Only',controller:'Controlling Only',both:'Monitoring and Controlling'})[node.device_mode] || 'Monitoring Only';
    const rows = [['Aircon', node.aircon_name], ['Type', node.aircon_type || 'Unavailable'], ['Location', node.location || 'Unassigned'], ['Temperature', live && Number.isFinite(sample?.outlet_temperature_c) ? num(sample.outlet_temperature_c) + ' °C' : 'Unavailable'], ['Air Pressure', live && Number.isFinite(sample?.differential_pressure_pa) ? num(sample.differential_pressure_pa) + ' Pa' : 'Unavailable'], ['Reported mode', modeLabel(sample, live)], ['Power feedback', !live || sample?.ac_on == null ? 'Unknown' : sample.ac_on ? 'Confirmed ON' : 'Confirmed OFF'], ['Observed', stamp(sample?.observed_at)], ['Temperature sensor', node.temperature_sensor], ['Pressure sensor', node.pressure_sensor], ['Device type', deviceType], ['Device ID', node.id.replace(/^registry:/,'')]];
    openDialog(node.name, '<dl class="sensor-detail-list">' + rows.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('') + '</dl>', null);
  }
  function stat(label, value, note) { return `<section class="sensor-stat glass-surface glass-card"><h2>${label}</h2><strong>${esc(value)}</strong><small>${esc(note)}</small></section>`; }
  function renderStats() {
    $('sensorSnapshots').innerHTML = stat('Avg Temp', num(stats?.temperature_avg) + (stats?.temperature_avg == null ? '' : ' °C'), 'MCP9808 · measured outlet air')
      + stat('Avg Airflow Pressure', num(stats?.pressure_avg) + (stats?.pressure_avg == null ? '' : ' Pa'), 'MPX5010DP · measured differential pressure')
      + stat('Confirmed Operation', stats?.confirmed_state_count ? num(stats.confirmed_unit_hours, 3) + ' h' : 'Unknown', 'AC unit-hours · independent power feedback')
      + stat('Recorded Samples', stats ? String(stats.sample_count) : 'Unavailable', 'Timestamped observations in this period')
      + stat('Unknown AC State', stats ? String(stats.unknown_state_samples || 0) : 'Unavailable', 'Observations without confirmed power')
      + stat('Observed Intervals', stats?.sample_count ? num(stats.observed_unit_hours, 3) + ' h' : 'Unavailable', 'Recorded cadence · missing gaps excluded');
  }
  function tariff() { const value = localStorage.getItem('ecoTrack_tariff_rate'); const rate = value === null ? NaN : Number(value); return Number.isFinite(rate) && rate >= 0 ? rate : null; }
  function renderEnergy() {
    const set = (id, value) => { if ($(id)) $(id).textContent = value; };
    const rate = tariff(), dataReady = available && stats;
    const usable = energy?.available && Number.isFinite(energy.energy_kwh), cost = usable && rate !== null ? energy.energy_kwh * rate : null;
    const missing = !available ? 'Reconnect to the local backend.' : ({SENSOR_REFERENCE_DISABLED:'Experimental estimates are disabled.',SENSOR_MODEL_UNAVAILABLE:'Restart the backend to load the model.',SENSOR_WINDOW_TOO_LARGE:'Choose a shorter date range.',SENSOR_REFERENCE_NO_COVERAGE:'No continuous readings in this period.'}[energy?.code] || 'Needs 5 minutes of valid temperature readings.');
    set('kpiEnergyLabel', 'ESTIMATED ENERGY'); set('kpiEnergyVal', usable ? num(energy.energy_kwh, 3) : 'Unavailable'); $('kpiEnergyVal').style.fontSize = usable ? '' : '23px'; $('kpiEnergyUnit').hidden = !usable;
    set('kpiEnergyTrend', 'Experimental'); set('kpiEnergyTrendLabel', usable ? num(energy.estimated_unit_hours,3)+' h covered' : 'Awaiting readings');
    $('kpiEnergyVal').title = energy?.reason || 'Temperature history is required.';
    set('kpiAvgLoad', usable ? num(energy.average_power_kw,3)+' kW / AC' : 'Unavailable'); set('kpiCostLabel', 'ESTIMATED COST'); set('kpiCostVal', cost === null ? 'Unavailable' : '₱'+num(cost,2)); $('kpiCostVal').style.fontSize = cost === null ? '23px' : '';
    set('kpiCostTrend', rate === null ? 'Set tariff' : ''); set('kpiCostTrendLabel', rate === null ? '' : 'Energy × tariff');
    set('kpiCostRate', rate === null ? 'Not configured' : `₱${num(rate, 2)} / kWh`);
    set('headerTariffDisplay', rate === null ? 'Not configured' : `₱${num(rate, 2)} / kWh`);
    set('kpiRuntimeLabel', 'CONFIRMED HOURS'); set('kpiRuntimeVal', dataReady?.confirmed_state_count ? num(stats.confirmed_unit_hours, 3) : 'Unknown'); $('kpiRuntimeVal').style.fontSize = '27px';
    set('kpiRuntimeUnit', 'unit-hours'); set('kpiRuntimeTrend', 'Power feedback'); set('kpiRuntimeTrendLabel', '');
    set('kpiUtilizationLabel', 'Observed hours'); set('kpiUtilization', dataReady?.sample_count ? num(stats.observed_unit_hours, 3) + ' h' : 'Unavailable');
    const fresh = selected().filter(node => available && node.fresh), known = fresh.filter(node => node.latest?.ac_on != null), on = known.filter(node => node.latest.ac_on).length;
    set('kpiActiveLabel', 'CONFIRMED ACTIVE'); set('kpiActiveUnits', known.length ? String(on) : 'Unknown'); $('kpiActiveUnits').style.fontSize = known.length ? '' : '27px';
    set('kpiTotalUnits', loaded ? '/' + selected().length : ''); set('kpiCapacityPct', ''); set('kpiFleetStatusLabel', loaded ? `${known.length} reporting power` : 'Awaiting feedback');
    set('kpiIdleLabel', 'Confirmed OFF'); set('kpiIdleUnits', known.length ? String(known.length - on) : 'Unknown');
    set('energyTrendSubtitle', 'Experimental XGBoost · covered sensor intervals · ' + ($('sensorSelect').selectedOptions[0]?.textContent || 'All Sensors'));
    set('trendBaselineLegend', 'Previous period: Unavailable'); set('estimatedCostSubtitle', 'Experimental energy estimate × selected rate'); set('costTodayCost', cost === null ? 'Unavailable' : '₱'+num(cost,2)); set('costCurrentCycle', cost === null ? 'Unavailable' : '₱'+num(cost,2)); set('costPrevPeriod', 'Unavailable'); set('costVariance', 'Unavailable');
    set('costCardRate', rate === null ? 'Not configured' : `₱${num(rate, 2)} / kWh`); set('correlationScore', 'Unavailable');
    const points=usable ? energy.points || [] : [], values=points.map(point=>point.energy_kwh).filter(Number.isFinite);
    for(const [id,label] of [['trendLowPrefix','Covered interval low'],['trendPeakPrefix','Covered interval peak'],['trendTotalPrefix','Covered total']])set(id,label);
    set('trendLow', values.length ? num(Math.min(...values),3)+' kWh' : 'Unavailable'); set('trendPeak', values.length ? num(Math.max(...values),3)+' kWh' : 'Unavailable'); set('trendTotal', usable ? num(energy.energy_kwh,3)+' kWh' : 'Unavailable'); set('dualAxisPeriodBadge', 'Experimental · '+period+' covered intervals');
    for (const id of ['energyTrendChart', 'estimatedCostChart', 'dualAxisChart']) {
      const empty = $(id === 'energyTrendChart' ? 'energyTrendEmpty' : id === 'estimatedCostChart' ? 'estimatedCostEmpty' : 'dualAxisEmpty');
      const show=usable && (id==='energyTrendChart' || rate!==null);
      empty.classList.add('sensor-forecast-empty'); empty.style.display = show ? 'none' : 'flex';
      empty.querySelector('strong').textContent=usable ? 'Set electricity rate' : 'No estimate available';
      const detail = empty.querySelector('span'); if (detail) detail.textContent = usable ? 'Add a tariff to show estimated cost.' : missing;
      empty.title=energy?.reason || missing;
      $(id).style.visibility=show?'visible':'hidden'; $(id).setAttribute('aria-hidden',String(!show));
      if (typeof Chart !== 'function') continue;
      const dark = document.documentElement.classList.contains('dark'), color = dark ? '#94a3b8' : '#64748b';
      const dataset=(label,data,color,yAxisID='y')=>({label,data,borderColor:color,backgroundColor:color,pointRadius:1,borderWidth:2,spanGaps:false,yAxisID});
      const energyValues=points.map(point=>point.energy_kwh), costValues=energyValues.map(value=>Number.isFinite(value)&&rate!==null ? value*rate : null);
      const datasets=!show?[]:id==='energyTrendChart'?[dataset('Experimental energy (kWh)',energyValues,'#10b981')]:id==='estimatedCostChart'?[dataset('Experimental cost (₱)',costValues,'#06b6d4')]:[dataset('Experimental energy (kWh)',energyValues,'#10b981'),dataset('Experimental cost (₱)',costValues,'#06b6d4','cost')];
      const options = { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color,maxTicksLimit:6 }, grid: { display: false } }, y: { beginAtZero:true, ticks: { color }, grid: { color: dark ? '#ffffff0c' : '#0f172a0c' }, title:{display:true,text:id==='estimatedCostChart'?'PHP':'kWh',color} } } };
      if(id==='dualAxisChart')options.scales.cost={position:'right',beginAtZero:true,grid:{drawOnChartArea:false},ticks:{color},title:{display:true,text:'PHP',color}};
      const data={labels:show?points.map(point=>new Date(point.observed_at).toLocaleString('en-SG',{timeZone:'Asia/Singapore',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})):[],datasets};
      if (!charts.has(id)) charts.set(id, new Chart($(id), { type: 'line', data, options }));
      else { const instance = charts.get(id); instance.data=data;instance.options = options; instance.update('none'); }
    }
  }
  function openReferenceDialog(templateId, titleId) {
    $('sensorDialog')?.remove(); const prior=document.activeElement;
    const dialog=document.createElement('dialog');dialog.id='sensorDialog';dialog.className='sensor-reference-dialog';dialog.setAttribute('aria-labelledby',titleId);
    dialog.append($(templateId).content.cloneNode(true));$('sensorDialogs').append(dialog);
    const close=()=>{dialog.close();dialog.remove();prior?.focus?.();};
    dialog.querySelectorAll('[data-close-reference]').forEach(button=>button.addEventListener('click',close));
    dialog.addEventListener('cancel',event=>{event.preventDefault();close();});dialog.showModal();return {dialog,close};
  }
  function openTariff() {
    const {close}=openReferenceDialog('sensorTariffTemplate','tariffModalTitle');
    $('tariffRateInput').value=tariff() ?? ''; $('utilityProviderInput').value=localStorage.getItem('ecoTrack_utility_provider') || '';
    const preview=()=>{const rate=Number($('tariffRateInput').value);$('tariffPreviewBill').textContent=energy?.available && $('tariffRateInput').value!=='' && Number.isFinite(rate) && rate>=0 ? '₱'+num(energy.energy_kwh*rate,2)+' · experimental' : 'Unavailable';};
    preview();$('tariffRateInput').addEventListener('input',preview);
    $('resetTariffDefaultBtn').addEventListener('click',()=>{ for(const key of ['ecoTrack_tariff_rate','ecoTrack_target_budget','ecoTrack_utility_provider'])localStorage.removeItem(key);close();renderEnergy(); });
    $('tariffConfigForm').addEventListener('submit',event=>{
      event.preventDefault();if(!$('tariffConfigForm').reportValidity())return;
      localStorage.setItem('ecoTrack_tariff_rate',Number($('tariffRateInput').value).toFixed(2));
      const provider=$('utilityProviderInput').value.trim();if(provider)localStorage.setItem('ecoTrack_utility_provider',provider);else localStorage.removeItem('ecoTrack_utility_provider');
      close();renderEnergy();
    });
  }
  const logHeadings = ['Timestamp (UTC+08:00)', 'Sensor Name', 'Building', 'Floor', 'Room', 'Attached Aircon Type', 'AC State', 'Temperature (°C)', 'Airflow Pressure (Pa)', 'Battery (V)', 'RSSI (dBm)', 'Recorded Status'];
  function logValues(row) {
    const node = nodes.find(item => item.id === row.node_id), location = (row.location || node?.location || '').split('·').map(value => value.trim());
    return [stamp(row.observed_at), row.sensor_name || node?.name || 'Unavailable', location[0] || 'Unavailable', location[1] || 'Unavailable', location[2] || 'Unavailable', row.aircon_type || 'Unavailable', row.ac_on == null ? 'Unknown' : row.ac_on ? 'Confirmed ON' : 'Confirmed OFF', row.outlet_temperature_c ?? 'Unavailable', row.differential_pressure_pa ?? 'Unavailable', row.battery_voltage ?? 'Unavailable', row.rssi_dbm ?? 'Unavailable', row.connection_status || 'Unavailable'];
  }
  function chart(id, field, color, unit) {
    const points = stats?.points || [], isMode = field === 'operating_mode', values = points.map(point => point[field]).filter(Number.isFinite);
    const hasReadings = points.some(point => isMode ? ['cool', 'fan_only'].includes(point.operating_mode) || point.ac_on != null : Number.isFinite(point[field]));
    $(id + 'Empty').hidden = hasReadings;
    $(id + 'Empty').textContent = isMode ? 'No mode or power readings in this window.' : 'No measured readings in this window.';
    if (typeof Chart !== 'function') return;
    const datasets = isMode ? [{ label: 'Cool', field: 'operating_mode', value: 'cool', y: 3, color: '#06b6d4' }, { label: 'Fan Only', field: 'operating_mode', value: 'fan_only', y: 2, color: '#818cf8' }, { label: 'ON', field: 'ac_on', value: 1, y: 1, color: '#10b981' }, { label: 'OFF', field: 'ac_on', value: 0, y: 0, color: '#94a3b8' }].map(item => ({ label: item.label, data: points.map(point => point[item.field] === item.value ? item.y : null), borderColor: item.color, backgroundColor: item.color, showLine: false, pointRadius: 4 })) : [{ label: unit, data: points.map(point => point[field]), borderColor: color, borderWidth: 2, pointRadius: 2, spanGaps: false, tension: .1 }];
    const dark = document.documentElement.classList.contains('dark'), text = dark ? '#94a3b8' : '#64748b';
    const options = { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: isMode, labels: { color: text, boxWidth: 10 } }, tooltip: { callbacks: { label: context => isMode ? context.dataset.label : `${context.formattedValue} ${unit}` } } }, scales: { x: { grid: { display: false }, ticks: { color: text, maxTicksLimit: 6, maxRotation: 0 } }, y: { grid: { color: dark ? '#ffffff0c' : '#0f172a0c' }, ticks: { color: text }, title: { display: !!unit, text: unit, color: text } } } };
    if (isMode) Object.assign(options.scales.y, { min: -.2, max: 3.2, ticks: { color: text, stepSize: 1, callback: value => ({ 0: 'OFF', 1: 'ON', 2: 'Fan Only', 3: 'Cool' }[value] || '') } });
    if (field === 'temperature') {
      // Chart.js defaults to 0–1 without readings. Use °C bounds, with real data
      // allowed to include negative values and temperatures outside a typical room range.
      const minimum = values.length ? Math.min(...values) : 0, maximum = values.length ? Math.max(...values) : 40;
      const padding = values.length ? Math.max(2, (maximum - minimum) * .1) : 0;
      Object.assign(options.scales.y, { min: Math.floor((minimum - padding) / 5) * 5, max: Math.ceil((maximum + padding) / 5) * 5, ticks: { color: text, precision: 0 } });
    }
    const data = { labels: points.map(point => new Date(point.observed_at).toLocaleString('en-SG', { timeZone: 'Asia/Singapore', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })), datasets };
    let instance = charts.get(id);
    if (!instance) { instance = new Chart($(id), { type: 'line', data, options }); charts.set(id, instance); }
    else { instance.data = data; instance.options = options; instance.update('none'); }
  }
  function renderHistory() {
    const rows = history.length ? history.map(row => '<tr>' + logValues(row).map(value => `<td>${esc(value)}</td>`).join('') + '</tr>').join('') : `<tr><td colspan="${logHeadings.length}" class="sensor-log-empty"><div class="sensor-log-empty-content" role="status"><div class="sensor-log-empty-icon" aria-hidden="true"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 12h5l3-9 4 18 3-9h5"/></svg></div><strong>${available ? 'No Sensor Readings for This Interval' : 'Sensor Readings Unavailable'}</strong><p>${available ? 'No sensor readings match these filters.' : 'Refresh after the local backend reconnects.'}</p></div></td></tr>`;
    $('sensorLogTable').innerHTML = '<div class="sensor-table-wrap eco-table-frame" tabindex="0" role="region" aria-label="Sensor data logs, scroll to view all columns"><table class="sensor-table eco-data-table"><caption class="sr-only">Recorded sensor readings in the selected observation period</caption><thead><tr>' + logHeadings.map(label => `<th scope="col">${esc(label)}</th>`).join('') + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
    $('sensorPageInfo').textContent = total ? `${(pageNumber - 1) * 50 + 1}–${Math.min(pageNumber * 50, total)} of ${total}` : 'No readings';
    $('sensorPrevious').disabled = pageNumber <= 1; $('sensorNext').disabled = pageNumber * 50 >= total;
    document.querySelectorAll('[data-export]').forEach(button => { button.disabled = exporting; });
  }
  function render() {
    populate();
    if (page === 'analytics') renderStats();
    if (page === 'logs') renderEnergy();
    if (page === 'analytics') { chart('sensorTempChart', 'temperature', '#06b6d4', '°C'); chart('sensorPressureChart', 'pressure', '#10b981', 'Pa'); chart('sensorStateChart', 'operating_mode', '', ''); }
    else if (page === 'logs') renderHistory();
    else { renderLocations(); renderFleet(); }
  }
  function showSensorLoading() {
    if (!window.EcoTrackSkeletons) return;
    $('sensorLoading')?.remove();
    const loading = document.createElement('div'); loading.id = 'sensorLoading'; loading.setAttribute('role', 'status'); loading.setAttribute('aria-label', 'Loading sensor data');
    if (page === 'telemetry') {
      const line = width => `<div class="eco-skeleton sensor-skeleton-line" style="width:${width}" aria-hidden="true"></div>`;
      const card = `<article class="sensor-node sensor-telemetry-card" aria-hidden="true"><div class="sensor-node-top"><div>${line('130px')}${line('90px')}</div><div class="sensor-mode-tile">${line('74px')}</div></div><div class="sensor-node-asset">${line('100px')}</div><div class="sensor-node-metrics">${[0,1].map(()=>'<div class="sensor-metric">'+line('22px')+line('76px')+line('90px')+'</div>').join('')}</div><div class="sensor-hardware-metrics">${[0,1].map(()=>'<div>'+line('60px')+line('80px')+'</div>').join('')}</div><div class="sensor-power-row">${line('64px')}${line('80px')}</div><div class="sensor-schedule-preview">${[0,1,2].map(()=>'<div>'+line('46px')+line('54px')+'</div>').join('')}</div><footer>${line('80px')}${line('55px')}</footer></article>`;
      loading.innerHTML = `<div class="sensor-telemetry-layout"><aside class="eco-location-panel sensor-panel sensor-cabinet"><h2 class="eco-location-title">${sensorIcon('location')}Location</h2><div id="sensorLoadingLocations" class="eco-location-tree"></div></aside><section class="sensor-panel sensor-interface"><div class="sensor-panel-head">${line('130px')}${line('70px')}</div><div id="sensorLoadingFleet" class="sensor-interface-grid has-devices" aria-hidden="true">${card}${card}</div></section></div>`;
    } else {
      loading.innerHTML = '<div id="sensorLoadingMetrics" class="sensor-loading-metrics" aria-hidden="true"></div><div class="sensor-chart-grid" aria-hidden="true"><div id="sensorLoadingChartA"></div><div id="sensorLoadingChartB"></div></div><div id="sensorLoadingChartC" aria-hidden="true"></div>';
    }
    $('sensorApp').before(loading); $('sensorApp').hidden = true;
    if (page === 'telemetry') { EcoTrackSkeletons.renderRoomListSkeleton('sensorLoadingLocations', { count: 3 }); }
    else { EcoTrackSkeletons.renderKpiStripSkeleton('sensorLoadingMetrics', { count: page === 'analytics' ? 6 : 4 }); for (const id of ['sensorLoadingChartA', 'sensorLoadingChartB', 'sensorLoadingChartC']) EcoTrackSkeletons.renderChartSkeleton(id); }
  }
  function hideSensorLoading() { $('sensorLoading')?.remove(); $('sensorApp').hidden = false; }
  async function refresh({ poll = false } = {}) {
    if (poll && running) return;
    if(page==='telemetry' && !running && $('sensorFleet') && !$('sensorApp').hidden)fleetPosition={location:locationFilter || '',top:$('sensorFleet').scrollTop};
    const id = ++revision; controller?.abort(); controller = new AbortController(); running = true;
    $('sensorRefresh').disabled = true; $('sensorRefresh').setAttribute('aria-busy', 'true');
    $('sensorApp').setAttribute('aria-busy', 'true');
    if(page==='logs')window.EcoTrackFutureCost?.notify();
    if (!poll) showSensorLoading();
    let registry = Promise.resolve();
    try {
      // Registry work shares this loading phase; it cannot replace an already rendered
      // empty state later. Keep polling renders until both metadata and readings settle.
      registry = page === 'telemetry' ? refreshLocations({renderNow:false}) : Promise.resolve();
      const sync = syncCloudRegistry({force:!poll});
      const tasks = [request('/devices', { signal: controller.signal })];
      if (page === 'analytics' || page === 'logs') {
        const params = query(); tasks.push(request('/analytics?' + params, { signal: controller.signal }));
        if (page === 'logs') tasks.push(request('/telemetry?' + params + `&page=${pageNumber}&per_page=50`, { signal: controller.signal }), request('/energy?' + params, { signal: controller.signal }).catch(() => ({ available: false, code: 'SENSOR_MODEL_UNAVAILABLE' })));
      }
      let [data, analytics, rows, forecast] = await Promise.all(tasks);
      await registry;
      const synced = await sync;
      if (id !== revision) return;
      if (synced?.success && synced.data?.changed) data = await request('/devices', { signal: controller.signal });
      if (id !== revision) return;
      nodes = data.items; stats = analytics || null; energy = forecast || null; history = rows?.items || []; total = rows?.total || 0; loaded = true; available = true;
      if(page==='logs')energySelection=query().toString();
      if(page==='logs')window.EcoTrackFutureCost?.notify();
      if (pageNumber > 1 && !history.length && total) { pageNumber = 1; running = false; refresh(); return; }
      $('sensorConnection').textContent = 'Local backend connected'; hideSensorLoading(); error(); render();
    } catch (failure) {
      await registry;
      if (id !== revision) return;
      available = false; stats = null; energy = null; history = []; total = 0;
      if(page==='logs')window.EcoTrackFutureCost?.notify();
      $('sensorConnection').textContent = 'Local readings unavailable';
      hideSensorLoading(); error(failure.name === 'AbortError' ? 'Local sensor request timed out. Start or restart the Python backend, then retry.' : failure.message); render();
    } finally { if (id === revision) { running = false; $('sensorApp').setAttribute('aria-busy', 'false'); $('sensorRefresh').disabled = false; $('sensorRefresh').setAttribute('aria-busy', 'false'); } }
  }
  function openDialog(title, content, submitLabel, submit) {
    $('sensorDialog')?.remove(); const prior = document.activeElement;
    $('sensorDialogs').innerHTML = `<dialog class="sensor-dialog" id="sensorDialog" aria-labelledby="sensorDialogTitle"><form id="sensorForm"><h2 id="sensorDialogTitle">${esc(title)}</h2>${content}<p class="sensor-form-error" id="sensorFormError" role="alert"></p><div class="sensor-dialog-footer"><button type="button" class="sensor-button" id="sensorDialogClose">Close</button>${submitLabel ? `<button type="submit" class="sensor-button primary" id="sensorSubmit">${esc(submitLabel)}</button>` : ''}</div></form></dialog>`;
    const dialog = $('sensorDialog');
    const close = () => { dialog.close(); dialog.remove(); prior?.focus?.(); };
    $('sensorDialogClose').addEventListener('click', close);
    dialog.addEventListener('cancel', event => { event.preventDefault(); if (!$('sensorSubmit')?.disabled) close(); });
    $('sensorForm').addEventListener('submit', async event => {
      event.preventDefault(); if (!submit || $('sensorSubmit').disabled) return;
      const button = $('sensorSubmit'); button.disabled = true; button.textContent = 'Saving…'; $('sensorDialogClose').disabled = true; $('sensorFormError').textContent = '';
      try { await submit(close); } catch (failure) { if ($('sensorFormError')) $('sensorFormError').textContent = failure.message; }
      finally { if ($('sensorSubmit') === button) { button.disabled = false; button.textContent = submitLabel; $('sensorDialogClose').disabled = false; } }
    }); dialog.showModal();
  }
  async function ipc(channel, input) {
    if (!window.electron?.invoke) throw new Error('Open the EcoTrack desktop app and sign in as an administrator to save sensor settings.');
    let timer;
    try {
      const result = await Promise.race([window.electron.invoke(channel, input), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The request has not been confirmed. Refresh the registry before retrying.')), 15000); })]);
      if (!result?.success) throw new Error(result?.error || 'The sensor request was not confirmed.');
      return result.data;
    } finally { clearTimeout(timer); }
  }
  function download(blob, name) { const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  function openTopConsumers() {
    const names={buildings:'Building Name',floors:'Floor Level',rooms:'Room / Facility Name',sensors:'AC Sensor Unit',airconTypes:'Aircon Equipment Type'};
    const {dialog}=openReferenceDialog('sensorConsumersTemplate','topConsumersModalTitle');dialog.classList.add('sensor-reference-consumers');
    $('modalScopePeriod').textContent=period+' · '+observationDate+' · '+($('sensorSelect').selectedOptions[0]?.textContent || 'All Sensors');
    $('modalScopeTariff').textContent=tariff()===null ? 'Not configured' : '₱'+num(tariff(),2)+' / kWh';
    for(const id of ['modalScopeTotalKwh','modalScopeTotalCost',...['Building','Floor','Room','Control','AirconType'].flatMap(key=>['Name','Kwh','Cost','Share'].map(field=>'top'+key+field))]) $(id).textContent='Unavailable';
    for(const key of ['Building','Floor','Room','Control','AirconType']) {const energy=$('top'+key+'Kwh');energy.style.fontSize='16px';energy.nextElementSibling.hidden=true;$('top'+key+'Share').hidden=true;}
    const message=available && stats?.sample_count ? 'Consumption rankings require valid sensor energy estimates.' : available ? 'No sensor readings in this period.' : 'Local sensor readings are unavailable.';
    $('topConsumersTableBody').innerHTML='<tr><td colspan="6"><div class="sensor-reference-empty"><strong>Unavailable</strong><p>'+esc(message)+'</p></div></td></tr>';
    const usable=energy?.available && Number.isFinite(energy.energy_kwh), totalEnergy=usable?energy.energy_kwh:null, rate=tariff();
    const rankings={buildings:[],floors:[],rooms:[],sensors:[],airconTypes:[]};
    if(usable){
      for(const category of Object.keys(rankings)){
        const groups=new Map();for(const device of energy.devices || []){
          const parts=(device.location || '').split(/[·•]/).map(part=>part.trim()).filter(Boolean);
          const key=category==='sensors'?device.node_id:category==='airconTypes'?device.aircon_type || 'Type unavailable':parts.length===3?parts.slice(0,{buildings:1,floors:2,rooms:3}[category]).join(' / '):'Location unavailable';
          const label=category==='sensors'?device.sensor_name || 'Sensor name unavailable':key;
          const value=groups.get(key) || {name:label,energy:0};value.energy+=device.energy_kwh;groups.set(key,value);
        }rankings[category]=[...groups.values()].sort((a,b)=>b.energy-a.energy || a.name.localeCompare(b.name));
      }
      $('modalScopeTotalKwh').textContent=num(totalEnergy,3)+' kWh · experimental';$('modalScopeTotalCost').textContent=rate===null?'Tariff unavailable':'₱'+num(totalEnergy*rate,2);
      for(const [category,key] of Object.entries({buildings:'Building',floors:'Floor',rooms:'Room',sensors:'Control',airconTypes:'AirconType'})){
        const top=rankings[category][0];if(!top)continue;$('top'+key+'Name').textContent=top.name;$('top'+key+'Name').title=top.name;$('top'+key+'Kwh').textContent=num(top.energy,3);$('top'+key+'Kwh').nextElementSibling.hidden=false;
        $('top'+key+'Cost').textContent=rate===null?'Tariff unavailable':'₱'+num(top.energy*rate,2);$('top'+key+'Share').textContent=totalEnergy>0?num(top.energy/totalEnergy*100,1)+'%':'Share unavailable';$('top'+key+'Share').hidden=false;
      }
    }
    const buttons=[...dialog.querySelectorAll('[data-category]')],panel=$('topConsumersTableBody').closest('.eco-table-frame');
    panel.id='sensorConsumerPanel';panel.setAttribute('role','tabpanel');$('consumersTabContainer').setAttribute('role','tablist');$('consumersTabContainer').setAttribute('aria-label','Consumer categories');
    const activate=button=>{buttons.forEach(item=>{const active=item===button;item.classList.toggle('active',active);item.setAttribute('aria-selected',String(active));item.tabIndex=active?0:-1;});$('leaderboardNameHeader').textContent=names[button.dataset.category];panel.setAttribute('aria-labelledby',button.id);
      if(usable)$('topConsumersTableBody').innerHTML=rankings[button.dataset.category].slice(0,50).map((item,index)=>'<tr><td>'+(index+1)+'</td><td>'+esc(item.name)+'</td><td>'+(totalEnergy>0?num(item.energy/totalEnergy*100,1)+'%':'—')+'</td><td>'+num(item.energy,3)+'</td><td>'+(rate===null?'Unavailable':'₱'+num(item.energy*rate,2))+'</td><td>Experimental</td></tr>').join('');};
    buttons.forEach((button,index)=>{
      button.id='sensorConsumerTab-'+button.dataset.category;button.setAttribute('role','tab');button.setAttribute('aria-controls',panel.id);
      button.addEventListener('click',()=>activate(button));button.addEventListener('keydown',event=>{const offset=event.key==='ArrowRight'?1:event.key==='ArrowLeft'?-1:null;const next=event.key==='Home'?buttons[0]:event.key==='End'?buttons.at(-1):offset===null?null:buttons[(index+offset+buttons.length)%buttons.length];if(next){event.preventDefault();activate(next);next.focus();}});
    });activate(buttons[0]);
  }
  function showExportProgress(format, abort) {
    const prior=document.activeElement, dialog=document.createElement('dialog');
    dialog.id='downloadModal';dialog.className='sensor-download-dialog';dialog.setAttribute('aria-labelledby','downloadModalTitle');dialog.setAttribute('aria-describedby','downloadModalSubtitle');
    dialog.innerHTML='<div class="sensor-download-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2"><polyline points="8 17 12 21 16 17"/><path d="M12 12v9M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29"/></svg></div><h3 id="downloadModalTitle"></h3><p id="downloadModalSubtitle" aria-live="polite">Reading selected sensor logs…</p><div class="sensor-download-divider"></div><div class="sensor-download-label"><span>Progress</span><strong id="downloadProgressPercent">0%</strong></div><div class="sensor-download-track" role="progressbar" aria-label="Export preparation" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div id="downloadProgressBar" style="width:0%"></div></div><button type="button" id="cancelDownloadBtn">Cancel</button>';
    dialog.querySelector('h3').textContent=format==='pdf'?'Generating PDF':'Generating Excel';
    const cancel=()=>abort.abort();dialog.querySelector('button').addEventListener('click',cancel);dialog.addEventListener('cancel',event=>{event.preventDefault();cancel();});
    document.body.append(dialog);dialog.showModal();let last=0;
    return {
      update(value,text){last=Math.max(last,Math.min(100,value));dialog.querySelector('#downloadProgressBar').style.width=last+'%';dialog.querySelector('#downloadProgressPercent').textContent=last+'%';dialog.querySelector('[role="progressbar"]').setAttribute('aria-valuenow',last);dialog.querySelector('#downloadModalSubtitle').textContent=text;},
      close(){dialog.close();dialog.remove();prior?.focus?.();}
    };
  }
  async function readExportRows(params, signal, onProgress) {
    const rows = [], seen = new Set(); let total = null, snapshot = null;
    for (let page = 1; ; page++) {
      if (signal.aborted) throw new DOMException('Export cancelled.', 'AbortError');
      const batch = await request('/telemetry?' + params + `&page=${page}&per_page=200`, {signal});
      if (!Array.isArray(batch.items) || !Number.isSafeInteger(batch.total) || batch.total < 0) throw new Error('Invalid sensor history response. Refresh and retry the export.');
      if (total !== null && total !== batch.total) throw new Error('Sensor history changed during export. Refresh and retry.');
      total = batch.total;
      if (page === 1 && batch.snapshot != null) { snapshot = String(batch.snapshot); params.set('snapshot', snapshot); }
      else if (snapshot !== null && String(batch.snapshot) !== snapshot) throw new Error('Sensor history snapshot changed. Refresh and retry the export.');
      for (const row of batch.items) {
        if (typeof row.id !== 'string' || !row.id || seen.has(row.id)) throw new Error('Sensor history contains missing or duplicate records. Refresh and retry the export.');
        seen.add(row.id); rows.push(row);
      }
      if (rows.length > total || !batch.items.length && rows.length < total) throw new Error('Sensor history is incomplete. Refresh and retry the export.');
      onProgress(total ? 10 + Math.round(40 * rows.length / total) : 50);
      if (rows.length === total) return rows;
    }
  }
  async function exportLogs(format) {
    if (exporting || !['pdf', 'xlsx'].includes(format)) return;
    exporting = true; let exportedCount = 0;
    const abort=new AbortController();exportController=abort;
    const buttons = [...document.querySelectorAll('[data-export]')]; buttons.forEach(button => { button.disabled = true; });
    const progress=showExportProgress(format,abort), signal=abort.signal;
    const checkCancelled=()=>{if(signal.aborted)throw new DOMException('Export cancelled.','AbortError');};
    const yieldUI=()=>new Promise(resolve=>setTimeout(resolve,32));
    progress.update(5,'Reading selected sensor logs…');
    $('sensorExportStatus').textContent = 'Preparing recorded sensor logs…';
    try {
      const params = query(), selection = params.toString();
      {
        const rows = await readExportRows(params, signal, value => progress.update(value, 'Reading selected sensor logs…'));
        const [reportStats,reportEnergy]=await Promise.all([request('/analytics?'+params,{signal}),request('/energy?'+params,{signal}).catch(failure=>{checkCancelled();return {available:false,reason:'The energy estimator was unavailable when this report was generated.'};})]);
        checkCancelled();progress.update(65,'Preparing report summary…');await yieldUI();checkCancelled();
        if (query().toString() !== selection) throw new Error('Selection changed. Export the current selection again.');
        exportedCount = rows.length;
        const headings = logHeadings, body = rows.map(logValues);
        const report={rows,headings,values:body,stats:reportStats,energy:reportEnergy,generated:new Date(),date:observationDate,period,
          scope:$('sensorSelect').selectedOptions[0]?.textContent || 'All Sensors',
          time:[$('sensorTimeStart')?.value || 'Start of day',$('sensorTimeEnd')?.value || 'End of day'].join(' to '),
          rate:tariff(),provider:localStorage.getItem('ecoTrack_utility_provider')?.trim() || 'Not configured',
          devices:nodes.map(node=>({id:node.id,created_at:node.created_at}))};
        if(period!=='daily'){
          const dateLabel=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Singapore',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
          report.date=dateLabel(params.get('from'))+' to '+dateLabel(Date.parse(params.get('to'))-1);
        }
        if (!window.EcoTrackSensorReports) throw new Error('The sensor report library is unavailable. Reload and retry.');
        if(format==='pdf')report.futureCost=await window.EcoTrackFutureCost?.capture({context:sensorFutureCostContext(reportEnergy),signal:abort.signal});
        if(query().toString()!==selection)throw new Error('Selection changed. Export the current selection again.');
        let blob;progress.update(80,format==='pdf'?'Creating your monitoring report…':'Building spreadsheet logs…');await yieldUI();checkCancelled();
        if (format === 'pdf') {
          if (!window.jspdf?.jsPDF) throw new Error('Local PDF library unavailable.');
          blob=window.EcoTrackSensorReports.pdf(report).output('blob');
        } else {
          if (!window.ExcelJS?.Workbook) throw new Error('Local Excel library unavailable.');
          const workbook=window.EcoTrackSensorReports.excel(report);
          blob=new Blob([await workbook.xlsx.writeBuffer()],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
        }
        checkCancelled();progress.update(100,'Ready to download');await yieldUI();checkCancelled();
        download(blob,format==='pdf'?'sensor-logs.pdf':'sensor-logs.xlsx');
      }
      $('sensorExportStatus').textContent = exportedCount ? 'Export prepared from recorded measurements.' : 'Export prepared with column headers. No sensor readings in this period.';
    } catch (failure) { $('sensorExportStatus').textContent = signal.aborted ? 'Export cancelled.' : failure.message; }
    finally { abort.abort();exportController=null;exporting = false; buttons.forEach(button => { button.disabled = false; });progress.close(); }
  }
  function closeMenu() { document.body.classList.remove('sensor-sidebar-open'); $('sensorMenu').setAttribute('aria-expanded', 'false'); }
  document.addEventListener('DOMContentLoaded', () => {
    build();
    if(page==='logs')window.EcoTrackFutureCost?.configure({source:'sensor',context:sensorFutureCostContext});
    $('sensorFleet')?.addEventListener('scroll',()=>{if(!running && !$('sensorApp').hidden)fleetPosition={location:locationFilter || '',top:$('sensorFleet').scrollTop};},{passive:true});
    $('sensorTariff')?.addEventListener('click', openTariff);
    $('openTopConsumersModalBtn')?.addEventListener('click', openTopConsumers);
    render(); refresh();
    $('sensorRefresh').addEventListener('click', () => refresh());
    $('sensorMenu').addEventListener('click', () => { const open = document.body.classList.toggle('sensor-sidebar-open'); if (open) $('sidebar')?.classList.remove('collapsed'); $('sensorMenu').setAttribute('aria-expanded', String(open)); });
    $('sensorBackdrop').addEventListener('click', closeMenu);
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && document.body.classList.contains('sensor-sidebar-open')) { closeMenu(); $('sensorMenu').focus(); } });
    window.addEventListener('resize', () => { if (innerWidth > 760) { closeMenu(); $('sidebar')?.classList.toggle('collapsed', localStorage.getItem('sidebarCollapsed') === 'true'); } });
    const timer = setInterval(() => { if (!document.hidden && page !== 'logs') refresh({ poll: true }); }, 5000);
    window.addEventListener('pagehide', () => { clearInterval(timer); controller?.abort();exportController?.abort(); charts.forEach(chart => chart.destroy()); $('sensorDialog')?.remove(); }, { once: true });
    window.addEventListener('focus', () => { if (page !== 'logs') refresh({ poll: true }); });
    window.addEventListener('theme:changed', render);
  });
})();
