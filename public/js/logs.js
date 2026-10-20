// Initialize metadata (Supabase) and local telemetry clients.
const sb = window.supabaseClient || window.sb;
const pb = window.pb || (typeof PocketBase === 'function' ? new PocketBase() : null);

// Real telemetry logs from the local backend.
let nodeDataLogs = [];
let currentPeriod = 'daily';
let currentNodeFilter = '';
let selectedDateKey = '';
let startTimeFilter = '';
let endTimeFilter = '';
let roomMap = {}; // Store node to room mapping
let controlNameMap = {}; // Store node to control name mapping
let locationMap = {}; // Store node to location details
let globalAirconMap = {}; // Store node to aircon type mapping
let globalInstallDateMap = {}; // Store node to installation date mapping
let selectedAlgorithm = 'hist_gradient_boosting'; // The selected research-estimate model.
let currentEvaluatedKwh = null;
let currentEvaluatedCost = null;
let currentAnalyticsResult = null;
let currentActiveConsumerTab = 'buildings';
let globalNodeRecords = []; // Store raw nodes from Supabase / aircon system
let telemetryRefreshPending = false;
let telemetryRefreshRunning = false;
let telemetryRefreshTimer = null;
let telemetryMetadataPending = false;
let telemetryMetadataRefresh = null;
let telemetryResetPending = false;
let lastTelemetryResetAt = null;
let lastTelemetryTotalItems = null;
let followLatestLogPeriod = true;
let lastTelemetryRevision = null;
let telemetryPollRunning = false;

function isCurrentLogPeriod() {
  return followLatestLogPeriod || !selectedDateKey || selectedDateKey === getPeriodDateKey(new Date(), currentPeriod);
}

function onTelemetrySavedDebounced(force = false) {
  if (force === true) telemetryResetPending = true;
  if (!isCurrentLogPeriod() && !telemetryResetPending) return;
  clearTimeout(telemetryRefreshTimer);
  telemetryRefreshTimer = setTimeout(() => {
    telemetryRefreshTimer = null;
    refreshLogsAfterTelemetrySaved(telemetryResetPending);
  }, 800);
}

// Coalesce saves from several controllers and preserve historical date filters.
async function refreshLogsAfterTelemetrySaved(force = false) {
  if (force) telemetryResetPending = true;
  if (!isCurrentLogPeriod() && !telemetryResetPending) return;
  telemetryRefreshPending = true;
  if (telemetryRefreshRunning) return;
  telemetryRefreshRunning = true;
  try {
    while (telemetryRefreshPending) {
      telemetryRefreshPending = false;
      const resetRefresh = telemetryResetPending;
      telemetryResetPending = false;
      if (telemetryMetadataPending) {
        telemetryMetadataPending = false;
        refreshLogMetadata();
      }
      await fetchLogsFromDB(true);
      if (isCurrentLogPeriod() || resetRefresh) render({ preserveScroll: true });
    }
  } catch (error) {
    console.warn('[Daily Logs] Telemetry refresh failed:', error.message);
  } finally {
    telemetryRefreshRunning = false;
  }
}
window.addEventListener('ecotrack:telemetry-saved', onTelemetrySavedDebounced);
window.addEventListener('focus', onTelemetrySavedDebounced);

function refreshLogMetadata() {
  if (!telemetryMetadataRefresh) {
    telemetryMetadataRefresh = loadRoomMap().then(changed => {
      if (changed) render({ preserveScroll: true });
    }).catch(error => console.warn('[Daily Logs] Background metadata refresh:', error.message))
      .finally(() => { telemetryMetadataRefresh = null; });
  }
  return telemetryMetadataRefresh;
}
window.addEventListener('online', refreshLogMetadata);

function getTelemetryRevision(data) {
  if (data.history_revision) return data.history_revision;
  const latest = data.items?.[0];
  return JSON.stringify([data.totalItems, latest?.id, latest?.created, latest?.updated, data.reset_at]);
}

async function pollLatestTelemetry() {
  if (telemetryPollRunning) return;
  telemetryPollRunning = true;
  try {
    const backendUrl = window.ECOTRACK_CONFIG?.backendUrl || 'http://localhost:5000';
    const response = await (window.EcoNetwork?.fetch.bind(window.EcoNetwork) || fetch)(`${backendUrl}/api/telemetry?perPage=1&sort=-created`, { cache: 'no-store' }, { timeout: 8000, retries: 0, silent: true });
    if (!response.ok) return;
    const data = await response.json();
    if (getTelemetryRevision(data) !== lastTelemetryRevision) {
      const resetChanged = data.reset_at !== undefined && (data.reset_at || null) !== lastTelemetryResetAt;
      onTelemetrySavedDebounced(resetChanged || data.totalItems === 0);
    }
  } catch (_) {} finally {
    telemetryPollRunning = false;
  }
}

// Helper to get actual aircon fleet count synchronized with Dashboard Controller & Supabase
function getAirconFleetCount() {
  try {
    if (window.EcoTrackAirconSystem?.AirconProfileManager?.getAll) {
      const list = window.EcoTrackAirconSystem.AirconProfileManager.getAll();
      if (Array.isArray(list)) {
        const online = list.filter(a => String(a.status || '').toLowerCase() === 'online').length;
        return { total: list.length, online };
      }
    }
  } catch (_) {}

  try {
    const raw = localStorage.getItem('ecoTrack_aircons');
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        const online = list.filter(a => String(a.status || '').toLowerCase() === 'online').length;
        return { total: list.length, online };
      }
    }
  } catch (_) {}

  try {
    if (Array.isArray(globalNodeRecords) && globalNodeRecords.length > 0) {
      const online = globalNodeRecords.filter(n => String(n.status || '').toLowerCase() === 'online').length;
      return { total: globalNodeRecords.length, online };
    }
  } catch (_) {}

  return { total: 0, online: 0 };
}

// Pagination state
let currentPage = 1;
const PAGE_SIZE = 20;

function getPeriodDateKey(date, period = currentPeriod) {
  const dObj = (date instanceof Date) ? date : new Date(date);
  if (isNaN(dObj.getTime())) return '';
  const year = dObj.getFullYear();
  const month = String(dObj.getMonth() + 1).padStart(2, '0');
  const day = String(dObj.getDate()).padStart(2, '0');

  if (period === 'monthly') {
    return `${year}-${month}`;
  }

  if (period === 'yearly') {
    return `${year}`;
  }

  if (period === 'weekly') {
    const d = new Date(dObj);
    d.setHours(0, 0, 0, 0);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
    const monday = new Date(d.setDate(diff));
    const mYear = monday.getFullYear();
    const mMonth = String(monday.getMonth() + 1).padStart(2, '0');
    const mDay = String(monday.getDate()).padStart(2, '0');
    return `${mYear}-${mMonth}-${mDay}`;
  }

  return `${year}-${month}-${day}`;
}

function getPeriodDateLabel(key, period = currentPeriod) {
  if (!key) return 'Select Date';

  if (period === 'yearly') {
    return key;
  }

  if (period === 'weekly') {
    const [year, month, day] = key.split('-').map(Number);
    const monday = new Date(year, month - 1, day);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    const monStr = monday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const sunStr = sunday.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return `${monStr} - ${sunStr}`;
  }

  if (period === 'monthly') {
    const [year, month] = key.split('-').map(Number);
    return new Date(year, month - 1, 1).toLocaleDateString('en-US', {
      month: 'long',
      year: 'numeric'
    });
  }

  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  });
}

function getDefaultDateKey() {
  const todayKey = getPeriodDateKey(new Date(), currentPeriod);
  if (!nodeDataLogs || nodeDataLogs.length === 0) {
    return todayKey;
  }
  const actualKeys = new Set(nodeDataLogs.map(log => getPeriodDateKey(log.timestamp, currentPeriod)).filter(Boolean));
  // If today actually has telemetry data, default to today
  if (actualKeys.has(todayKey)) {
    return todayKey;
  }
  // Otherwise default to the most recent date with real telemetry data
  const sortedActual = Array.from(actualKeys).sort((left, right) => right.localeCompare(left));
  return sortedActual[0] || todayKey;
}

function getAvailableDateKeys() {
  const todayKey = getPeriodDateKey(new Date(), currentPeriod);
  const keys = new Set(nodeDataLogs.map(log => getPeriodDateKey(log.timestamp, currentPeriod)).filter(Boolean));
  if (todayKey) keys.add(todayKey);
  return Array.from(keys).sort((left, right) => right.localeCompare(left));
}

function populateDateRangeOptions() {
  const dateSelect = document.getElementById('dateRangeSelect');
  if (!dateSelect) return;

  const availableKeys = getAvailableDateKeys();
  const defaultKey = getDefaultDateKey();

  if (followLatestLogPeriod || !selectedDateKey) {
    if (selectedDateKey !== defaultKey) currentPage = 1;
    selectedDateKey = defaultKey;
  }

  // Bound the visible list regardless of how much historical telemetry is retained.
  const visibleKeys = availableKeys.slice(0, 7);
  if (selectedDateKey && !visibleKeys.includes(selectedDateKey)) {
    if (visibleKeys.length === 7) visibleKeys.pop();
    visibleKeys.push(selectedDateKey);
  }
  const optionsHtml = visibleKeys.map(key => {
    const label = getPeriodDateLabel(key, currentPeriod);
    return `<option value="${key}">${label}</option>`;
  }).join('') + (availableKeys.length > visibleKeys.length ? '<option value="__older__">Choose older date…</option>' : '');
  if (dateSelect.dataset.optionsHtml !== optionsHtml) {
    dateSelect.innerHTML = optionsHtml;
    dateSelect.dataset.optionsHtml = optionsHtml;
  }

  dateSelect.value = selectedDateKey;
  const historyDatePicker = document.getElementById('historyDatePicker');
  if (historyDatePicker && historyDatePicker.style && selectedDateKey && dateSelect.value === selectedDateKey) {
    historyDatePicker.style.display = 'none';
  }
}

// Initialize logs on page load
document.addEventListener('DOMContentLoaded', async () => {
  console.log('Logs page loaded');
  setupEventListeners();
  setupTariffModal();
  setupTopConsumersModal();
  updateTariffUI();
  window.EcoTrackFutureCost?.configure({source:'controller',context:controllerFutureCostContext});

  // Cached labels and SQLite records are sufficient to render and run the local model.
  await loadRoomMap({ localOnly: true });
  await fetchLogsFromDB();
  console.log('Loaded', nodeDataLogs.length, 'telemetry log records');
  if (!selectedDateKey) {
    selectedDateKey = getDefaultDateKey();
  }
  populateDateRangeOptions();
  render();

  // 2. Enhance metadata asynchronously in background without blocking initial render
  refreshLogMetadata();

  // Poll the newest row as well as its count; replacement rows can keep the same count.
  setInterval(pollLatestTelemetry, 4000);

  // Real-time event subscription for immediate updates when packets arrive in Supabase
  const sbClient = window.supabaseClient || window.sb;
  if (sbClient) {
    try {
      sbClient.channel('telemetry-logs-realtime')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'telemetry' }, onTelemetrySavedDebounced)
        .subscribe();
    } catch (_) {}
    try {
      sbClient.channel('nodes-logs-schedules')
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'nodes' }, () => {
          telemetryMetadataPending = true;
          onTelemetrySavedDebounced();
        }).subscribe();
    } catch (_) {}
  }
});

function logMetadataCacheKey() {
  let userId = '';
  try { userId = JSON.parse(localStorage.getItem('ecoTrack_profile_user') || '{}').id || ''; } catch (_) {}
  return 'ecoTrack_logs_metadata:' + JSON.stringify([
    window.ECOTRACK_CONFIG?.supabaseUrl || '', window.ECOTRACK_CONFIG?.backendUrl || '', userId
  ]);
}

// Cache display metadata and schedule fields only, never credentials or live power/online state.
function sanitizeLogMetadata(data) {
  const fields = {
    rooms: ['id', 'name', 'floor_id'], floors: ['id', 'name', 'building_id'], buildings: ['id', 'name'],
    nodes: ['id', 'name', 'node_id', 'device_id', 'device_mode', 'room_id', 'aircon_type', 'created',
      'wake_time', 'sleep_time', 'interval_seconds', 'interval_val', 'interval_unit']
  };
  if (!data || Object.keys(fields).some(table => !Array.isArray(data[table]))) return null;
  return Object.fromEntries(Object.entries(fields).map(([table, names]) => [table,
    data[table].filter(row => row && typeof row.id === 'string').map(row =>
      Object.fromEntries(names.filter(name => row[name] != null).map(name => [name, row[name]])))
  ]));
}

async function requestLogMetadata(signal) {
  if (window.electron && typeof window.electron.invoke === 'function') {
    const data = await window.electron.invoke('scheduler-fetch-data');
    if (data?.success) return data;
  }
  if (!sb || signal.aborted) return null;
  const results = await Promise.all(['rooms', 'floors', 'buildings', 'nodes'].map(table =>
    sb.from(table).select('*').abortSignal(signal)));
  if (results.some(result => result.error)) return null;
  return Object.fromEntries(['rooms', 'floors', 'buildings', 'nodes'].map((table, index) =>
    [table, results[index].data || []]));
}

// Local rendering never waits for cloud requests. Refreshes are bounded and keep the last good metadata.
async function loadRoomMap({ localOnly = false } = {}) {
  const nodeFilter = document.getElementById('nodeFilter');
  if (nodeFilter && nodeFilter.options.length <= 1) {
    nodeFilter.innerHTML = '<option value="">All Controls</option>';
  }
  
  try {
    let cached = null;
    try { cached = sanitizeLogMetadata(JSON.parse(localStorage.getItem(logMetadataCacheKey()) || 'null')); } catch (_) {}
    let metadata = cached;
    if (!localOnly && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
      const controller = new AbortController();
      let timer;
      try {
        const deadline = new Promise((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error('Cloud metadata refresh timed out')); }, 4000);
        });
        const fresh = sanitizeLogMetadata(await Promise.race([requestLogMetadata(controller.signal), deadline]));
        if (fresh) {
          metadata = fresh;
          try { localStorage.setItem(logMetadataCacheKey(), JSON.stringify(fresh)); } catch (_) {}
        }
      } catch (_) { /* Keep locally saved labels when the internet cannot respond. */ }
      finally { clearTimeout(timer); }
    }
    const { rooms: roomRecords = [], floors: floorRecords = [], buildings: buildingRecords = [],
      nodes: nodeRecords = [] } = metadata || {};
    globalNodeRecords = nodeRecords;

    const buildingMapById = {};
    buildingRecords.forEach(b => { buildingMapById[b.id] = b.name; });
    
    const floorMapById = {};
    floorRecords.forEach(f => { floorMapById[f.id] = { name: f.name, building_id: f.building_id }; });

    const roomDetailsById = {};
    roomRecords.forEach(room => {
      const fInfo = floorMapById[room.floor_id] || { name: 'Unknown', building_id: null };
      const bName = buildingMapById[fInfo.building_id] || 'Unknown';
      roomDetailsById[room.id] = {
        roomId: room.id,
        roomName: room.name,
        floorName: fInfo.name,
        buildingName: bName
      };
    });

    nodeRecords.forEach(node => {
      const nodeIdStr = node.name || node.id;
      controlNameMap[node.id] = nodeIdStr; // e.g. "AC-SRV-01"
      if (node.name) controlNameMap[node.name] = node.name;

      const airconType = node.aircon_type || 'Unknown';
      globalAirconMap[node.id] = airconType;
      globalAirconMap[nodeIdStr] = airconType;

      const installDate = node.created ? new Date(node.created) : new Date();
      const formattedDate = `${installDate.getFullYear()}-${String(installDate.getMonth() + 1).padStart(2, '0')}-${String(installDate.getDate()).padStart(2, '0')} ${String(installDate.getHours()).padStart(2, '0')}:${String(installDate.getMinutes()).padStart(2, '0')}:${String(installDate.getSeconds()).padStart(2, '0')}`;
      globalInstallDateMap[node.id] = formattedDate;
      globalInstallDateMap[nodeIdStr] = formattedDate;

      if (node.room_id && roomDetailsById[node.room_id]) {
        const details = roomDetailsById[node.room_id];
        const controller = window.EcoTrackAirconSystem?.NodeService?.getNode(node.id);
        for (const alias of new Set([node.id, node.name, node.node_id, node.device_id, controller?.node_id].filter(Boolean))) {
          locationMap[alias] = details;
          roomMap[alias] = node.room_id;
        }
      }

      const filterVal = node.name || node.id;
      if (nodeFilter && !nodeFilter.querySelector(`option[value="${CSS.escape(filterVal)}"]`)) {
        const option = document.createElement('option');
        option.value = filterVal;
        option.textContent = filterVal;
        nodeFilter.appendChild(option);
      }
    });
    return JSON.stringify(metadata) !== JSON.stringify(cached);
  } catch(e) {
    console.warn('[Daily Logs] Metadata unavailable:', e.message);
    return false;
  }
}

// Placeholders are missing metadata, not an assigned location.
function locationLabel(value) {
  const label = typeof value === 'string' ? value.trim() : '';
  return /^(?:unassigned|unknown|unavailable|null|undefined|[-—])$/i.test(label) ? '' : label;
}

function resolveLogLocation(record) {
  const location = locationMap[record.nodeId || record.node_id] || {};
  const room = locationLabel(record.roomName ?? record.room_name);
  const floor = locationLabel(record.floorName ?? record.floor_name);
  const building = locationLabel(record.buildingName ?? record.building_name);
  const roomId = record.roomId || record.room_id;
  // A controller may have moved. Do not attach today's parents to an old room.
  const sameRoom = (!roomId || !location.roomId || roomId === location.roomId) &&
    (!room || room === locationLabel(location.roomName));
  const sameFloor = !floor || floor === locationLabel(location.floorName);
  return {
    roomName: room || (sameRoom && locationLabel(location.roomName)) || 'Unassigned',
    floorName: floor || (sameRoom && locationLabel(location.floorName)) || 'Unassigned',
    buildingName: building || (sameRoom && sameFloor && locationLabel(location.buildingName)) || 'Unassigned'
  };
}

// Get room name for a node
function getRoomForNode(nodeId) {
  const loc = locationMap[nodeId];
  if (loc && loc.roomName && loc.roomName !== 'Unassigned') return loc.roomName;
  return roomMap[nodeId] || 'Unassigned';
}

// Calculate battery percentage matching Telemetry (4.2V = 100%)
function getBatteryPercentage(voltage) {
  const v = parseFloat(voltage);
  if (isNaN(v)) return 0;
  if (v > 10) return Math.min(100, Math.max(0, Math.round(v)));
  return Math.min(100, Math.max(0, Math.round((v / 4.2) * 100)));
}

// Convert RSSI to signal bars (1-4) matching Telemetry getSignalBars
function getSignalBars(rssi) {
  const r = parseFloat(rssi);
  if (isNaN(r)) return 1;
  // If raw dBm (negative values, standard RSSI)
  if (r < 0) {
    if (r > -60) return 4;
    if (r > -70) return 3;
    if (r > -80) return 2;
    return 1;
  }
  // If already percentage
  if (r >= 75) return 4;
  if (r >= 50) return 3;
  if (r >= 25) return 2;
  return 1;
}

// Generate signal icon matching Telemetry
function getSignalIcon(rssi) {
  const filledBars = getSignalBars(rssi);
  const r = parseFloat(rssi);
  const barColor = filledBars >= 3 ? '#10b981' : (filledBars === 2 ? '#fbbf24' : '#fb7185');
  const emptyColor = '#d1d5db';
  
  return `
    <span class="inline-flex items-center gap-1.5" title="${!isNaN(r) && r < 0 ? r + ' dBm' : ''}">
      <svg viewBox="0 0 24 24" width="22" height="22" style="display: inline-block; vertical-align: middle;">
        <!-- Bar 1 (smallest) -->
        <rect x="2" y="18" width="2.8" height="4" rx="0.5" fill="${filledBars >= 1 ? barColor : emptyColor}" opacity="${filledBars >= 1 ? '1' : '0.4'}"/>
        <!-- Bar 2 -->
        <rect x="6.8" y="14" width="2.8" height="8" rx="0.5" fill="${filledBars >= 2 ? barColor : emptyColor}" opacity="${filledBars >= 2 ? '1' : '0.4'}"/>
        <!-- Bar 3 -->
        <rect x="11.6" y="10" width="2.8" height="12" rx="0.5" fill="${filledBars >= 3 ? barColor : emptyColor}" opacity="${filledBars >= 3 ? '1' : '0.4'}"/>
        <!-- Bar 4 (tallest) -->
        <rect x="16.4" y="6" width="2.8" height="16" rx="0.5" fill="${filledBars >= 4 ? barColor : emptyColor}" opacity="${filledBars >= 4 ? '1' : '0.4'}"/>
      </svg>
    </span>
  `;
}

// Setup event listeners
async function clearAllTelemetryHistory() {
  const client = window.supabaseClient || window.sb;
  if (!client || typeof client.from !== 'function') throw new Error('Connect to Supabase before clearing history.');
  const backendUrl = window.ECOTRACK_CONFIG?.backendUrl || 'http://localhost:5000';
  let response;
  try { response = await fetch(backendUrl + '/api/telemetry', {method:'DELETE'}); }
  catch (_) { throw new Error('Could not reach the telemetry service. Check its connection and try again.'); }
  if (!response.ok) throw new Error('The telemetry service could not confirm deletion (HTTP ' + response.status + ').');
  const result = await response.json();
  if (result?.success !== true) throw new Error(result?.error || 'The telemetry service could not confirm deletion.');
  try {
    const cloud = await client.from('telemetry').delete().neq('id','___none___');
    if (cloud.error) throw cloud.error;
  } catch (error) {
    throw new Error('Local history was cleared, but cloud history could not be cleared. ' + (error?.message || 'Check the connection and retry.'));
  }
  window.EcoTrackAirconSystem?.CentralLogService?.clearLogs?.();
  nodeDataLogs = []; lastTelemetryTotalItems = 0; currentPage = 1;
  render();
  window.EcoDataBus?.invalidate('telemetry');
  window.dispatchEvent(new CustomEvent('ecotrack:telemetry-saved', {detail:{cleared:true}}));
}

function setupEventListeners() {
  // Centralized period switcher that syncs throughout entire page
  window.setPeriod = function(period) {
    if (!period) return;
    currentPeriod = period;
    followLatestLogPeriod = true;
    if (historyDatePicker) historyDatePicker.style.display = 'none';

    // Sync Header Period Buttons
    document.querySelectorAll('.header-period-btn').forEach(btn => {
      const isAct = btn.dataset.period === period;
      btn.classList.toggle('active', isAct);
      if (isAct) {
        btn.style.setProperty('background-color', '#10b981', 'important');
        btn.style.setProperty('color', '#ffffff', 'important');
        btn.style.setProperty('border', '1px solid #10b981', 'important');
        const svg = btn.querySelector('svg');
        if (svg) svg.style.setProperty('stroke', '#ffffff', 'important');
      } else {
        btn.style.removeProperty('background-color');
        btn.style.removeProperty('color');
        btn.style.removeProperty('border');
        const svg = btn.querySelector('svg');
        if (svg) svg.style.removeProperty('stroke');
      }
    });

    // Sync Table Log-Tabs if present
    document.querySelectorAll('.log-tab').forEach(b => {
      const isAct = b.dataset.period === period;
      b.classList.toggle('active', isAct);
      if (isAct) {
        b.classList.add('bg-[#10b981]', 'text-white', 'border-[#10b981]');
        b.classList.remove('bg-white', 'dark:bg-slate-900', 'text-gray-700', 'dark:text-gray-200');
        b.style.setProperty('background-color', '#10b981', 'important');
        b.style.setProperty('color', '#ffffff', 'important');
        const svg = b.querySelector('svg');
        if (svg) svg.style.setProperty('stroke', '#ffffff', 'important');
        const label = b.querySelector('.tab-label');
        if (label) label.style.setProperty('color', '#ffffff', 'important');
      } else {
        b.classList.remove('active', 'bg-[#10b981]', 'text-white', 'border-[#10b981]');
        b.classList.add('bg-white', 'dark:bg-slate-900', 'text-gray-700', 'dark:text-gray-200');
        b.style.removeProperty('background-color');
        b.style.removeProperty('color');
        const svg = b.querySelector('svg');
        if (svg) svg.style.removeProperty('stroke');
        const label = b.querySelector('.tab-label');
        if (label) label.style.removeProperty('color');
      }
    });

    selectedDateKey = getDefaultDateKey();
    currentPage = 1;
    populateDateRangeOptions();
    render();
  };

  // Header Period Buttons
  document.querySelectorAll('.header-period-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const p = e.currentTarget.dataset.period;
      if (p) window.setPeriod(p);
    });
  });

  // Table Log Tab Buttons
  document.querySelectorAll('.log-tab').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const p = e.currentTarget.dataset.period;
      if (p) window.setPeriod(p);
    });
  });

  const dateRangeSelect = document.getElementById('dateRangeSelect');
  const historyDatePicker = document.getElementById('historyDatePicker');
  if (dateRangeSelect) {
    dateRangeSelect.addEventListener('change', (e) => {
      if (e.target.value === '__older__') {
        dateRangeSelect.value = selectedDateKey;
        if (historyDatePicker) {
          const asDate = key => key.length === 4 ? key + '-01-01' : key.length === 7 ? key + '-01' : key;
          historyDatePicker.min = '';
          historyDatePicker.max = getPeriodDateKey(new Date(), 'daily');
          historyDatePicker.value = asDate(selectedDateKey);
          historyDatePicker.setCustomValidity('');
          historyDatePicker.style.display = '';
          historyDatePicker.focus();
          try { historyDatePicker.showPicker?.(); } catch (_) {}
        }
        return;
      }
      if (historyDatePicker) historyDatePicker.style.display = 'none';
      selectedDateKey = e.target.value;
      followLatestLogPeriod = false; // This is an explicit observation-date selection.
      currentPage = 1;
      render();
    });
  }

  if (historyDatePicker) {
    historyDatePicker.addEventListener('change', () => {
      const key = getPeriodDateKey(new Date(historyDatePicker.value + 'T12:00:00'), currentPeriod);
      if (!key) {
        historyDatePicker.setCustomValidity('Choose a valid observation date.');
        historyDatePicker.reportValidity();
        return;
      }
      historyDatePicker.setCustomValidity('');
      selectedDateKey = key;
      followLatestLogPeriod = false; // Keep an explicit date even when it has no readings.
      currentPage = 1;
      historyDatePicker.style.display = 'none';
      render();
    });
    historyDatePicker.addEventListener('input', () => historyDatePicker.setCustomValidity(''));
    historyDatePicker.addEventListener('blur', () => {
      if (!historyDatePicker.value) historyDatePicker.style.display = 'none';
    });
  }

  // Time filter inputs
  const startTimeInput = document.getElementById('startTimeFilter');
  const endTimeInput = document.getElementById('endTimeFilter');
  const clearTimeBtn = document.getElementById('clearTimeFilterBtn');

  if (startTimeInput) {
    startTimeInput.addEventListener('change', (e) => {
      startTimeFilter = e.target.value;
      currentPage = 1;
      render();
    });
  }

  if (endTimeInput) {
    endTimeInput.addEventListener('change', (e) => {
      endTimeFilter = e.target.value;
      currentPage = 1;
      render();
    });
  }

  if (clearTimeBtn) {
    clearTimeBtn.addEventListener('click', () => {
      startTimeFilter = '';
      endTimeFilter = '';
      if (startTimeInput) startTimeInput.value = '';
      if (endTimeInput) endTimeInput.value = '';
      currentPage = 1;
      render();
    });
  }

  // Node filter dropdown
  const nodeFilterEl = document.getElementById('nodeFilter');
  if (nodeFilterEl) {
    nodeFilterEl.addEventListener('change', (e) => {
      currentNodeFilter = e.target.value;
      currentPage = 1;
      render();
    });
  }

  // Reset all filters button
  const resetFiltersBtn = document.getElementById('resetAllFiltersBtn');
  if (resetFiltersBtn) {
    resetFiltersBtn.addEventListener('click', () => {
      currentNodeFilter = '';
      if (nodeFilterEl) nodeFilterEl.value = '';

      followLatestLogPeriod = true;
      if (historyDatePicker) historyDatePicker.style.display = 'none';
      selectedDateKey = getDefaultDateKey();
      if (dateRangeSelect) dateRangeSelect.value = selectedDateKey;

      startTimeFilter = '';
      endTimeFilter = '';
      if (startTimeInput) startTimeInput.value = '';
      if (endTimeInput) endTimeInput.value = '';

      currentPage = 1;
      populateDateRangeOptions();
      render();
    });
  }

  // Clear All Logs uses an in-app confirmation with progress and error states.
  const clearAllLogsBtn = document.getElementById('clearAllLogsBtn');
  if (clearAllLogsBtn && window.EcoTrackClearLogsDialog) {
    window.EcoTrackClearLogsDialog.attach(clearAllLogsBtn, clearAllTelemetryHistory);
  } else if (clearAllLogsBtn) {
    clearAllLogsBtn.disabled = true;
  }

  let downloadProgressInterval = null;

  function showDownloadModal(type, actualDownloadFn) {
    const modal = document.getElementById('downloadModal');
    const title = document.getElementById('downloadModalTitle');
    const subtitle = document.getElementById('downloadModalSubtitle');
    const progressBar = document.getElementById('downloadProgressBar');
    const percentText = document.getElementById('downloadProgressPercent');
    
    if (!modal || !title || !subtitle || !progressBar) return;
    
    if (type === 'pdf') {
      title.textContent = 'Generating PDF';
      subtitle.textContent = 'Creating your monitoring report...';
    } else {
      title.textContent = 'Generating Excel';
      subtitle.textContent = 'Building spreadsheet logs...';
    }
    
    progressBar.style.width = '0%';
    if (percentText) percentText.textContent = '0%';
    modal.style.display = 'flex';
    
    let progress = 0;
    clearInterval(downloadProgressInterval);
    
    downloadProgressInterval = setInterval(() => {
      progress += Math.floor(Math.random() * 12) + 5;
      if (progress >= 100) {
        progress = 100;
        progressBar.style.width = '100%';
        if (percentText) percentText.textContent = '100%';
        clearInterval(downloadProgressInterval);
        
        setTimeout(() => {
          modal.style.display = 'none';
          actualDownloadFn();
        }, 400);
      } else {
        progressBar.style.width = `${progress}%`;
        if (percentText) percentText.textContent = `${progress}%`;
      }
    }, 120);
  }

  // Export buttons (Header & Table)
  const headerPdfBtn = document.getElementById('headerExportPdfBtn');
  if (headerPdfBtn) {
    headerPdfBtn.addEventListener('click', () => {
      showDownloadModal('pdf', exportLogs);
    });
  }

  const headerExcelBtn = document.getElementById('headerExportExcelBtn');
  if (headerExcelBtn) {
    headerExcelBtn.addEventListener('click', () => {
      showDownloadModal('excel', exportExcelLogs);
    });
  }

  const tablePdfBtn = document.getElementById('exportBtn');
  if (tablePdfBtn) {
    tablePdfBtn.addEventListener('click', () => {
      showDownloadModal('pdf', exportLogs);
    });
  }

  const tableExcelBtn = document.getElementById('exportExcelBtn');
  if (tableExcelBtn) {
    tableExcelBtn.addEventListener('click', () => {
      showDownloadModal('excel', exportExcelLogs);
    });
  }

  const cancelDownloadBtn = document.getElementById('cancelDownloadBtn');
  if (cancelDownloadBtn) {
    cancelDownloadBtn.addEventListener('click', () => {
      clearInterval(downloadProgressInterval);
      const modal = document.getElementById('downloadModal');
      if (modal) modal.style.display = 'none';
    });
  }



  // Pagination buttons
  const prevPageBtn = document.getElementById('prevPageBtn');
  const nextPageBtn = document.getElementById('nextPageBtn');

  if (prevPageBtn) {
    prevPageBtn.addEventListener('click', () => {
      if (currentPage > 1) {
        currentPage--;
        render();
      }
    });
  }

  if (nextPageBtn) {
    nextPageBtn.addEventListener('click', () => {
      const filtered = getFilteredLogs();
      const totalPages = Math.ceil(filtered.length / PAGE_SIZE) || 1;
      if (currentPage < totalPages) {
        currentPage++;
        render();
      }
    });
  }
}

// Fetch real control telemetry data from Native SQLite3 (backend/telemetry.db)
async function fetchLogsFromDB(silent = false) {
  const tbody = document.getElementById('logsTableBody');
  if (!silent && tbody && (!nodeDataLogs || nodeDataLogs.length === 0)) {
    window.EcoTrackSkeletons?.renderTableSkeleton('logsTableBody', {
      rows: 8,
      cols: 9,
      colWidths: ['w-28', 'w-20', 'w-24', 'w-20', 'w-16', 'w-16', 'w-16', 'w-16', 'w-20']
    });
  }
  try {
    const backendUrl = window.ECOTRACK_CONFIG?.backendUrl || 'http://localhost:5000';
    const requestHistory = url => (window.EcoNetwork?.fetch.bind(window.EcoNetwork) || fetch)(url,
      { cache: 'no-store' }, { timeout: 8000, retries: 0, silent: true });
    let data;
    if (window.EcoTrackTelemetryHistory) data = await window.EcoTrackTelemetryHistory.read(backendUrl, requestHistory);
    else {
      const res = await requestHistory(`${backendUrl}/api/telemetry?perPage=0&sort=-created`);
      if (!res.ok) throw new Error(`Telemetry request failed (HTTP ${res.status})`);
      data = await res.json();
    }
    if (!Array.isArray(data.items)) throw new Error('Telemetry response must contain an items array');
    const records = data.items;
    document.getElementById('logsLoadError')?.remove();
    lastTelemetryTotalItems = data.totalItems ?? records.length;
    lastTelemetryRevision = getTelemetryRevision(data);
    lastTelemetryResetAt = data.reset_at || null;

    nodeDataLogs = records.map((r, i) => {
      // 1. Direct fields saved in PocketBase telemetry collection
      let controlName = r.control_name || r.sensor_name;
      let roomName = r.room_name;
      let floorName = r.floor_name;
      let buildingName = r.building_name;
      let airconType = r.aircon_type;

      // 2. Relational expanded fields from PocketBase if not directly on the record
      if (r.expand && r.expand.node_id) {
        const n = r.expand.node_id;
        if (!controlName) controlName = n.name || r.node_id;
        if (!airconType) airconType = n.aircon_type;
        if (n.expand && n.expand.room_id) {
          const rm = n.expand.room_id;
          if (!locationLabel(roomName)) roomName = rm.name;
          if (rm.expand && rm.expand.floor_id) {
            const fl = rm.expand.floor_id;
            if (!locationLabel(floorName)) floorName = fl.name;
            if (fl.expand && fl.expand.building_id) {
              const b = fl.expand.building_id;
              if (!locationLabel(buildingName)) buildingName = b.name;
            }
          }
        }
      }

      // 3. Fallback to loaded PocketBase node maps
      if (!controlName) controlName = controlNameMap[r.node_id] || r.node_id;
      ({ roomName, floorName, buildingName } = resolveLogLocation({ ...r, roomName, floorName, buildingName }));
      if (!airconType) airconType = globalAirconMap[r.node_id] || null;

      // Cache back into maps for quick UI lookup
      controlNameMap[r.node_id] = controlName;
      if (!locationMap[r.node_id]) {
        locationMap[r.node_id] = {
          roomName: roomName || 'Unassigned',
          floorName: floorName || 'Unassigned',
          buildingName: buildingName || 'Unassigned'
        };
      }
      globalAirconMap[r.node_id] = airconType;

      return {
        id: r.id,
        nodeId: r.node_id,
        roomId: r.room_id || null,
        controlName: controlName || r.node_id,
        roomName: roomName || 'Unassigned',
        floorName: floorName || 'Unassigned',
        buildingName: buildingName || 'Unassigned',
        airconType: airconType,
        timestamp: new Date(r.created),
        temperature: r.temperature,
        pressure: r.pressure,
        battery: r.battery,
        rssi: r.rssi,
        status: r.status || 'unknown',
        eventType: r.event_type,
        intervalSeconds: r.interval_seconds,
        intervalVal: r.interval_val,
        intervalUnit: r.interval_unit,
        wakeTime: r.wake_time,
        sleepTime: r.sleep_time,
        acOn: r.ac_on ?? r.acOn,
        powerState: r.power_state ?? r.powerState,
        acState: r.ac_state ?? r.acState,
        aircon_state: r.aircon_state,
        ac_current_a: r.ac_current_a,
        compressor_current_a: r.compressor_current_a,
        airconId: r.aircon_id,
        controlSnapshot: window.EcoTrackAirconState?.parseAirconSnapshot(r.control_snapshot)
      };
    });

    // Clear stale analytics immediately; abort predictions based on deleted rows.
    if (!records.length) predictEnergyConsumption({ totalRecords: 0 }, []);

    // Populate filter options with real controls and historical records.
    const nodeFilter = document.getElementById('nodeFilter');
    if (nodeFilter) {
      const addedValues = new Set();
      if (nodeFilter.options.length === 0) {
        const defaultOpt = document.createElement('option');
        defaultOpt.value = '';
        defaultOpt.textContent = 'All Controls';
        nodeFilter.appendChild(defaultOpt);
      }

      nodeDataLogs.forEach(log => {
        const sName = log.controlName || log.nodeId;
        const filterVal = sName;
        if (!addedValues.has(filterVal)) {
          addedValues.add(filterVal);
          const roomSuffix = (log.roomName && log.roomName !== 'Unassigned') ? ` (${log.roomName})` : '';

          if (!nodeFilter.querySelector(`option[value="${CSS.escape(filterVal)}"]`)) {
            const option = document.createElement('option');
            option.value = filterVal;
            option.textContent = `${sName}${roomSuffix}`;
            nodeFilter.appendChild(option);
          }
        }
      });
    }
  } catch(e) {
    console.error('Local telemetry load error:', e);
    const parent = tbody?.closest('table')?.parentElement;
    if (parent && !document.getElementById('logsLoadError')) {
      const notice = document.createElement('div');
      notice.id = 'logsLoadError'; notice.className = 'p-4 text-sm text-rose-500'; notice.setAttribute('role', 'alert');
      const message = document.createElement('p');
      message.textContent = nodeDataLogs.length ? 'Unable to refresh logs. Showing previously loaded records.' : 'Unable to load logs. Start the Python backend and retry.';
      const retry = document.createElement('button');
      retry.type = 'button'; retry.textContent = 'Retry'; retry.className = 'mt-2 font-semibold underline';
      retry.addEventListener('click', () => refreshLogsAfterTelemetrySaved(true));
      notice.append(message, retry); parent.prepend(notice);
    }
  }
}

// Get filtered logs based on current period, node filter, and time range
function getFilteredLogs() {
  const activeDateKey = selectedDateKey || getDefaultDateKey();
  let filtered = nodeDataLogs;
  
  // Include all telemetry logs (do not filter out unassigned nodes)
  filtered = filtered.filter(log => getPeriodDateKey(log.timestamp, currentPeriod) === activeDateKey);
  
  // Filter by AC Control (matches name or database id)
  if (currentNodeFilter) {
    filtered = filtered.filter(log => 
      log.nodeId === currentNodeFilter || 
      log.controlName === currentNodeFilter ||
      (controlNameMap[currentNodeFilter] && controlNameMap[currentNodeFilter] === log.controlName) ||
      (controlNameMap[log.nodeId] && controlNameMap[log.nodeId] === currentNodeFilter)
    );
  }

  // Filter by Start Time and End Time
  if (startTimeFilter || endTimeFilter) {
    filtered = filtered.filter(log => {
      const logMinutes = log.timestamp.getHours() * 60 + log.timestamp.getMinutes();

      if (startTimeFilter && endTimeFilter) {
        const [sH, sM] = startTimeFilter.split(':').map(Number);
        const [eH, eM] = endTimeFilter.split(':').map(Number);
        const startMinutes = sH * 60 + sM;
        const endMinutes = eH * 60 + eM;

        if (startMinutes <= endMinutes) {
          return logMinutes >= startMinutes && logMinutes <= endMinutes;
        } else {
          // Overnight range (e.g. 22:00 to 06:00)
          return logMinutes >= startMinutes || logMinutes <= endMinutes;
        }
      }

      if (startTimeFilter) {
        const [sH, sM] = startTimeFilter.split(':').map(Number);
        const startMinutes = sH * 60 + sM;
        return logMinutes >= startMinutes;
      }

      if (endTimeFilter) {
        const [eH, eM] = endTimeFilter.split(':').map(Number);
        const endMinutes = eH * 60 + eM;
        return logMinutes <= endMinutes;
      }

      return true;
    });
  }
  
  return filtered;
}

// Calculate statistics from filtered logs
function calculateStats() {
  const filtered = getFilteredLogs();
  
  if (filtered.length === 0) {
    return {
      totalRecords: 0,
      avgTemp: '--',
      onlineNodes: '0/0'
    };
  }
  
  // Calculate averages
  const temps = filtered.map(l => parseFloat(l.temperature)).filter(Number.isFinite);
  const avgTemp = temps.length ? Math.round(temps.reduce((a, b) => a + b, 0) / temps.length) : '--';
  
  // Count online nodes
  const activeNodes = new Set();
  const onlineActiveNodes = new Set();
  
  filtered.forEach(l => {
    activeNodes.add(l.nodeId);
    if (l.status === 'online') {
      onlineActiveNodes.add(l.nodeId);
    }
  });

  const fleet = getAirconFleetCount();
  const totalFleetUnits = currentNodeFilter ? 1 : Math.max(fleet.total, activeNodes.size);
  const onlineFleetUnits = currentNodeFilter ? Math.min(1, onlineActiveNodes.size) : Math.max(fleet.online, onlineActiveNodes.size);
  
  return {
    totalRecords: filtered.length,
    avgTemp: avgTemp,
    onlineNodes: `${onlineFleetUnits}/${totalFleetUnits}`
  };
}

// ─── ENERGY CONSUMPTION PREDICTION (via Flask research model) ──────────

// ─── DYNAMIC ELECTRICITY TARIFF & BUDGET MANAGEMENT ───────────────────
function getActiveTariffRate() {
  const stored = parseFloat(localStorage.getItem('ecoTrack_tariff_rate'));
  return Number.isFinite(stored) && stored > 0 ? stored : null;
}

function getTargetBudget() {
  const stored = parseFloat(localStorage.getItem('ecoTrack_target_budget'));
  return Number.isFinite(stored) && stored > 0 ? stored : null;
}

function getUtilityProvider() {
  return localStorage.getItem('ecoTrack_utility_provider')?.trim() || 'Not configured';
}

function calculateEnergyCost(kwh, rate = getActiveTariffRate()) {
  return Number.isFinite(kwh) && Number.isFinite(rate) && rate > 0 ? kwh * rate : null;
}

function formatTariffRate(rate = getActiveTariffRate(), currency = '₱') {
  return Number.isFinite(rate) && rate > 0 ? `${currency}${formatAnalyticsNumber(rate)} / kWh` : 'Not configured';
}

function formatAnalyticsNumber(value, decimals = 2) {
  return Number.isFinite(value) ? value.toFixed(decimals) : 'Unavailable';
}

function saveTariffSettings(rate, budget, provider) {
  const numRate = parseFloat(rate);
  const numBudget = parseFloat(budget);
  if (!Number.isFinite(numRate) || numRate <= 0) return false;

  localStorage.setItem('ecoTrack_tariff_rate', numRate.toFixed(2));
  if (!isNaN(numBudget) && numBudget > 0) {
    localStorage.setItem('ecoTrack_target_budget', numBudget.toFixed(1));
  }
  if (provider?.trim()) localStorage.setItem('ecoTrack_utility_provider', provider.trim());
  else localStorage.removeItem('ecoTrack_utility_provider');


  updateTariffUI();
  return true;
}

function updateTariffUI() {
  const rate = getActiveTariffRate();
  const budget = getTargetBudget();
  const rateFmt = formatTariffRate(rate);

  const headerDisplay = document.getElementById('headerTariffDisplay');
  if (headerDisplay) headerDisplay.textContent = rateFmt;

  const kpiRate = document.getElementById('kpiCostRate');
  if (kpiRate) kpiRate.textContent = rateFmt;

  const costCardRate = document.getElementById('costCardRate');
  if (costCardRate) costCardRate.textContent = rateFmt;

  const targetBudgetEl = document.getElementById('kpiTargetBudget');
  if (targetBudgetEl) targetBudgetEl.textContent = formatAnalyticsNumber(budget, 1);
}

function setupTariffModal() {
  const modal = document.getElementById('tariffSettingsModal');
  const openBtn = document.getElementById('openTariffModalBtn');
  const closeBtn = document.getElementById('closeTariffModalBtn');
  const cancelBtn = document.getElementById('cancelTariffModalBtn');
  const form = document.getElementById('tariffConfigForm');
  const rateInput = document.getElementById('tariffRateInput');
  const budgetInput = document.getElementById('targetBudgetInput');
  const providerInput = document.getElementById('utilityProviderInput');
  const previewBill = document.getElementById('tariffPreviewBill');
  const resetBtn = document.getElementById('resetTariffDefaultBtn');

  if (!modal) return;

  function openModal() {
    if (rateInput) rateInput.value = getActiveTariffRate()?.toFixed(2) || '';
    if (budgetInput) budgetInput.value = getTargetBudget()?.toFixed(1) || '';
    if (providerInput) providerInput.value = localStorage.getItem('ecoTrack_utility_provider') || '';
    updatePreview();
    modal.classList.remove('hidden');
  }

  function closeModal() {
    modal.classList.add('hidden');
  }

  function updatePreview() {
    if (!previewBill || !rateInput) return;
    const rate = parseFloat(rateInput.value);
    const cost = calculateEnergyCost(currentEvaluatedKwh, rate);
    previewBill.textContent = Number.isFinite(cost)
      ? '₱' + cost.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ` (${currentEvaluatedKwh.toFixed(1)} kWh)`
      : 'Enter a rate and load valid energy data to preview cost.';
  }

  if (openBtn) openBtn.addEventListener('click', openModal);
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);

  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      closeModal();
    }
  });

  if (rateInput) {
    rateInput.addEventListener('input', updatePreview);
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      for (const key of ['ecoTrack_tariff_rate', 'ecoTrack_target_budget', 'ecoTrack_utility_provider']) localStorage.removeItem(key);
      if (rateInput) rateInput.value = '';
      if (budgetInput) budgetInput.value = '';
      if (providerInput) providerInput.value = '';
      updateTariffUI();
      render();
      updatePreview();
    });
  }

  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const newRate = parseFloat(rateInput.value);
      const newBudget = parseFloat(budgetInput.value);
      const newProvider = providerInput ? providerInput.value : '';

      if (saveTariffSettings(newRate, newBudget, newProvider)) {
        closeModal();
        render();
        const cModal = document.getElementById('topConsumersModal');
        if (cModal && !cModal.classList.contains('hidden')) {
          updateTopConsumersModal();
        }
      }
    });
  }
}

// ─── HIGHEST CONSUMPTION BREAKDOWN MODAL (INFO MODAL) ─────────────────
function getDrawLevelBadge(sharePct) {
  if (sharePct >= 35) {
    return `<span class="px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider bg-rose-500/15 text-rose-600 dark:text-rose-400 border border-rose-500/30">CRITICAL DRAW</span>`;
  } else if (sharePct >= 22) {
    return `<span class="px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30">HIGH DRAW</span>`;
  } else if (sharePct >= 12) {
    return `<span class="px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider bg-blue-500/15 text-blue-600 dark:text-blue-400 border border-blue-500/30">MODERATE</span>`;
  } else {
    return `<span class="px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">OPTIMAL</span>`;
  }
}

function getRankBadge(index) {
  if (index === 0) {
    return `<span class="inline-flex items-center gap-1 font-black text-amber-500 bg-amber-500/15 px-2 py-0.5 rounded-md border border-amber-500/30">🥇 #1</span>`;
  } else if (index === 1) {
    return `<span class="inline-flex items-center gap-1 font-black text-slate-400 bg-slate-400/15 px-2 py-0.5 rounded-md border border-slate-400/30">🥈 #2</span>`;
  } else if (index === 2) {
    return `<span class="inline-flex items-center gap-1 font-black text-amber-700 dark:text-amber-500 bg-amber-700/15 px-2 py-0.5 rounded-md border border-amber-700/30">🥉 #3</span>`;
  } else {
    return `<span class="inline-flex items-center font-bold text-slate-500 dark:text-gray-400 px-2 py-0.5">#${index + 1}</span>`;
  }
}

function getShareProgressBar(sharePct) {
  let color = 'bg-emerald-500';
  if (sharePct >= 35) color = 'bg-rose-500';
  else if (sharePct >= 22) color = 'bg-amber-500';
  else if (sharePct >= 12) color = 'bg-blue-500';

  return `
    <div class="flex items-center gap-2.5 min-w-[130px]">
      <div class="flex-1 h-2 rounded-full bg-slate-200 dark:bg-white/10 overflow-hidden">
        <div class="h-full rounded-full ${color} transition-all duration-300" style="width: ${Math.min(100, Math.max(2, sharePct))}%;"></div>
      </div>
      <span class="text-xs font-mono font-black text-slate-700 dark:text-gray-300 w-12 text-right">${sharePct.toFixed(1)}%</span>
    </div>
  `;
}

function computeConsumptionRankings() {
  const rate = getActiveTariffRate();
  const groups = { buildings: {}, floors: {}, rooms: {}, controls: {}, airconTypes: {} };
  const jobs = (currentAnalyticsResult?.nodes || []).filter(job => Number.isFinite(job.kwh));
  const totalKwh = jobs.length ? jobs.reduce((sum, job) => sum + job.kwh, 0) : null;
  jobs.forEach(job => {
    const log = job.logs?.[0];
    if (!log) return;
    const names = { buildings: log.buildingName, floors: log.floorName, rooms: log.roomName,
      controls: log.controlName || controlNameMap[job.id] || job.id, airconTypes: log.airconType || globalAirconMap[job.id] };
    Object.entries(names).forEach(([category, name]) => {
      if (!name || ['Unassigned', 'Unknown'].includes(name)) return;
      groups[category][name] = (groups[category][name] || 0) + job.kwh;
    });
  });
  const result = { totalKwh, totalCost: calculateEnergyCost(totalKwh, rate), rate, period: currentPeriod };
  Object.entries(groups).forEach(([category, entries]) => {
    result[category] = Object.entries(entries).sort((a, b) => b[1] - a[1]).map(([name, kwh]) => ({
      name, kwh, cost: calculateEnergyCost(kwh, rate), share: totalKwh > 0 ? kwh / totalKwh * 100 : 0
    }));
  });
  return result;
}

function updateTopConsumersModal(activeCategory = currentActiveConsumerTab) {
  currentActiveConsumerTab = activeCategory;
  const rankings = computeConsumptionRankings();
  const fmt = (v) => Number.isFinite(v) ? '₱' + v.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'Unavailable';
  const fmtKwh = (v) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  // 1. Update Scope Banner
  const periodEl = document.getElementById('modalScopePeriod');
  const tariffEl = document.getElementById('modalScopeTariff');
  const totalKwhEl = document.getElementById('modalScopeTotalKwh');
  const totalCostEl = document.getElementById('modalScopeTotalCost');

  if (periodEl) periodEl.textContent = rankings.period.toUpperCase();
  if (tariffEl) tariffEl.textContent = formatTariffRate(rankings.rate);
  if (totalKwhEl) totalKwhEl.textContent = rankings.totalKwh > 0 ? `${fmtKwh(rankings.totalKwh)} kWh` : '--';
  if (totalCostEl) totalCostEl.textContent = rankings.totalCost > 0 ? fmt(rankings.totalCost) : '--';

  // 2. Update Top 5 Highlights Cards (#1 in each category)
  const updateHighlight = (topItem, nameId, kwhId, costId, shareId) => {
    const elName = document.getElementById(nameId);
    const elKwh = document.getElementById(kwhId);
    const elCost = document.getElementById(costId);
    const elShare = document.getElementById(shareId);
    if (topItem && topItem.name) {
      if (elName) { elName.textContent = topItem.name; elName.title = topItem.name; }
      if (elKwh) elKwh.textContent = rankings.totalKwh > 0 ? fmtKwh(topItem.kwh) : '--';
      if (elCost) elCost.textContent = rankings.totalCost > 0 ? fmt(topItem.cost) : '--';
      if (elShare) elShare.textContent = `${topItem.share.toFixed(1)}%`;
    } else {
      if (elName) { elName.textContent = '--'; elName.title = ''; }
      if (elKwh) elKwh.textContent = '--';
      if (elCost) elCost.textContent = '--';
      if (elShare) elShare.textContent = '--%';
    }
  };

  updateHighlight(rankings.buildings[0], 'topBuildingName', 'topBuildingKwh', 'topBuildingCost', 'topBuildingShare');
  updateHighlight(rankings.floors[0], 'topFloorName', 'topFloorKwh', 'topFloorCost', 'topFloorShare');
  updateHighlight(rankings.rooms[0], 'topRoomName', 'topRoomKwh', 'topRoomCost', 'topRoomShare');
  updateHighlight(rankings.controls[0], 'topControlName', 'topControlKwh', 'topControlCost', 'topControlShare');
  updateHighlight(rankings.airconTypes[0], 'topAirconTypeName', 'topAirconTypeKwh', 'topAirconTypeCost', 'topAirconTypeShare');

  // 3. Update Category Tabs Active State
  const tabButtons = document.querySelectorAll('#consumersTabContainer .consumer-tab-btn');
  tabButtons.forEach(btn => {
    const isAct = btn.dataset.category === activeCategory;
    btn.classList.toggle('active', isAct);
    if (isAct) {
      btn.className = 'consumer-tab-btn active px-3 py-1.5 rounded-lg transition-all cursor-pointer bg-[#10b981] text-white shadow-xs font-bold';
    } else {
      btn.className = 'consumer-tab-btn px-3 py-1.5 rounded-lg transition-all cursor-pointer text-slate-600 dark:text-gray-300 hover:text-[#10b981] font-bold';
    }
  });

  // 4. Update Header Label
  const headerMap = {
    buildings: 'Building Name',
    floors: 'Floor Level',
    rooms: 'Room / Facility Name',
    controls: 'AC Control Unit',
    airconTypes: 'Aircon Equipment Type'
  };
  const headerEl = document.getElementById('leaderboardNameHeader');
  if (headerEl) headerEl.textContent = headerMap[activeCategory] || 'Entity Name';

  // 5. Render Leaderboard Rows
  const tbody = document.getElementById('topConsumersTableBody');
  if (!tbody) return;

  const categoryList = rankings[activeCategory] || [];
  if (categoryList.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="px-4 py-6 text-center text-slate-400 font-bold">No ranking data available for this category</td></tr>`;
    return;
  }

  tbody.innerHTML = categoryList.map((item, idx) => {
    const rankBadge = getRankBadge(idx);
    const progressBar = getShareProgressBar(item.share);
    const drawBadge = getDrawLevelBadge(item.share);
    const rowBg = idx === 0 ? 'bg-amber-500/5 dark:bg-amber-500/10 font-medium' : (idx % 2 === 0 ? 'bg-transparent' : 'bg-slate-50/50 dark:bg-white/[0.02]');

    return `
      <tr class="${rowBg} hover:bg-slate-100 dark:hover:bg-white/5 transition-colors">
        <td class="px-4 py-3 font-bold whitespace-nowrap">${rankBadge}</td>
        <td class="px-4 py-3 font-bold text-slate-900 dark:text-white">
          <div class="flex items-center gap-2">
            <span>${item.name}</span>
            ${idx === 0 ? '<span class="px-1.5 py-0.5 rounded text-[9px] font-black uppercase bg-amber-500/20 text-amber-600 dark:text-amber-400 border border-amber-500/30">TOP #1</span>' : ''}
          </div>
        </td>
        <td class="px-4 py-3 whitespace-nowrap">${progressBar}</td>
        <td class="px-4 py-3 font-mono font-bold text-emerald-600 dark:text-emerald-400 whitespace-nowrap">${fmtKwh(item.kwh)} kWh</td>
        <td class="px-4 py-3 font-mono font-bold text-slate-700 dark:text-gray-300 whitespace-nowrap">${fmt(item.cost)}</td>
        <td class="px-4 py-3 text-right whitespace-nowrap">${drawBadge}</td>
      </tr>
    `;
  }).join('');
}

function setupTopConsumersModal() {
  const modal = document.getElementById('topConsumersModal');
  const openBtn = document.getElementById('openTopConsumersModalBtn');
  const closeBtn = document.getElementById('closeTopConsumersModalBtn');
  const closeBottomBtn = document.getElementById('closeTopConsumersBtn');
  const tabContainer = document.getElementById('consumersTabContainer');

  if (!modal) return;

  function openModal() {
    updateTopConsumersModal(currentActiveConsumerTab);
    modal.classList.remove('hidden');
  }

  function closeModal() {
    modal.classList.add('hidden');
  }

  if (openBtn) openBtn.addEventListener('click', openModal);
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (closeBottomBtn) closeBottomBtn.addEventListener('click', closeModal);

  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      closeModal();
    }
  });

  if (tabContainer) {
    tabContainer.querySelectorAll('.consumer-tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const cat = e.currentTarget.dataset.category;
        if (cat) {
          updateTopConsumersModal(cat);
        }
      });
    });
  }
}

// ─── INTERACTIVE CHART.JS ANALYTICS DASHBOARD ─────────────────────────
let energyTrendChartInstance = null;
let estimatedCostChartInstance = null;
let dualAxisChartInstance = null;
let currentChartGranularity = 'daily';

function updateOrCreateAnalyticsChart(instance, canvas, config) {
  if (!instance) return new Chart(canvas, config);
  instance.data = config.data;
  instance.options = config.options;
  instance.update('none');
  return instance;
}

function initAnalyticsCharts() {
  updateAnalyticsCharts();
}

function updateAnalyticsCharts(currentKwh, currentCost) {
  if (typeof Chart === 'undefined') return;

  const isDark = document.documentElement.classList.contains('dark');
  const textColor = isDark ? '#94a3b8' : '#64748b';
  const gridColor = isDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.05)';
  const rate = getActiveTariffRate();

  let labels = [];
  let trendData = [];
  let baselineData = [];
  let costData = [];
  let lowLabel = '--';
  let peakLabel = '--';
  let periodBadgeText = '';

  const filteredLogs = getFilteredLogs();
  const baseKwh = Number.isFinite(currentKwh) ? currentKwh : currentKwh === null ? null : currentAnalyticsResult?.kwh ?? null;
  const available = Number.isFinite(baseKwh);
  const result = currentAnalyticsResult;
  const definitions = {
    daily: { labels: ['12:00 AM', '3:00 AM', '6:00 AM', '9:00 AM', '12:00 PM', '3:00 PM', '6:00 PM', '9:00 PM', '11:59 PM'], badge: '24-hour observation interval' },
    weekly: { labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], badge: '7-day observation interval' },
    monthly: { labels: ['Week 1', 'Week 2', 'Week 3', 'Week 4'], badge: 'Monthly observation interval' },
    yearly: { labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], badge: 'Annual observation interval' }
  };
  const definition = definitions[currentPeriod] || definitions.daily;
  labels = definition.labels;
  periodBadgeText = definition.badge;
  trendData = available ? getAnalyticsChartSeries(result?.nodes, currentPeriod) : labels.map(() => null);
  baselineData = (result?.previous?.nodes?.length && (result.previous.kwh !== null || result.previous.runtime !== null)) ? getAnalyticsChartSeries(result.previous.nodes, currentPeriod) : labels.map(() => null);
  costData = trendData.map(kwh => Number.isFinite(kwh) ? calculateEnergyCost(kwh, rate) : null);
  const knownIndices = trendData.map((value, index) => Number.isFinite(value) ? index : -1).filter(index => index >= 0);
  if (knownIndices.length) {
    lowLabel = labels[knownIndices.reduce((best, index) => trendData[index] < trendData[best] ? index : best, knownIndices[0])];
    peakLabel = labels[knownIndices.reduce((best, index) => trendData[index] > trendData[best] ? index : best, knownIndices[0])];
  }
  const known = trendData.filter(Number.isFinite);
  const format = value => Number.isFinite(value) ? value.toLocaleString('en-US', value > 0 && value < 0.1
    ? { maximumSignificantDigits: 4 } : { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : 'Unavailable';
  const periodLow = format(known.length ? Math.min(...known) : null);
  const periodPeak = format(known.length ? Math.max(...known) : null);
  const periodTotal = format(baseKwh);
  for (const id of ['energyTrendEmpty', 'estimatedCostEmpty', 'dualAxisEmpty']) {
    const empty = document.getElementById(id);
    if (empty) {
      empty.style.display = (available && (id !== 'estimatedCostEmpty' || Number.isFinite(rate))) ? 'none' : 'flex';
      const explanation = empty.querySelector?.('span');
      if (explanation) explanation.textContent = available && !Number.isFinite(rate)
        ? 'Set an electricity tariff to estimate cost.' : result?.reason || 'No complete estimate is available for this selection.';
    }
  }
  const periodCap = currentPeriod.charAt(0).toUpperCase() + currentPeriod.slice(1);

  const lowEl = document.getElementById('trendLow');
  if (lowEl) lowEl.textContent = available && lowLabel !== '--' ? `${periodLow} kWh (${lowLabel})` : 'Unavailable';
  const peakEl = document.getElementById('trendPeak');
  if (peakEl) peakEl.textContent = available && peakLabel !== '--' ? `${periodPeak} kWh (${peakLabel})` : 'Unavailable';
  const totalEl = document.getElementById('trendTotal');
  if (totalEl) totalEl.textContent = available ? `${periodTotal} kWh` : 'Unavailable';

  const lowPrefix = document.getElementById('trendLowPrefix');
  if (lowPrefix) lowPrefix.textContent = `${periodCap} Low`;
  const peakPrefix = document.getElementById('trendPeakPrefix');
  if (peakPrefix) peakPrefix.textContent = `${periodCap} Peak`;
  const totalPrefix = document.getElementById('trendTotalPrefix');
  if (totalPrefix) totalPrefix.textContent = `${periodCap} Total`;

  const trendBaselineLegend = document.getElementById('trendBaselineLegend');
  if (trendBaselineLegend) {
    trendBaselineLegend.textContent = result?.previous?.complete ? 'Previous period estimate' : 'Previous period: Unavailable';
  }

  const controlScopeName = currentNodeFilter ? (controlNameMap[currentNodeFilter] || currentNodeFilter) : 'All Controls';

  const trendSub = document.getElementById('energyTrendSubtitle');
  if (trendSub) {
    trendSub.textContent = `${result?.recordedColumns && available ? 'Controls-only model: recorded columns and timestamps' : result?.forecast ? 'Research estimate from recorded control intervals' : available ? 'Research estimate from recorded controls' : result?.reason || 'No complete estimate for this selection'} • Scope: ${controlScopeName} • ${getDateRangeText()}`;
  }

  const costSub = document.getElementById('estimatedCostSubtitle');
  if (costSub) {
    costSub.innerHTML = `Electricity Rate: <span id="costCardRate" class="font-bold text-amber-600 dark:text-amber-400">₱${formatAnalyticsNumber(rate)} / kWh</span> • Scope: <strong class="text-slate-700 dark:text-white">${controlScopeName}</strong>`;
  }

  const badgeEl = document.getElementById('dualAxisPeriodBadge');
  if (badgeEl) badgeEl.textContent = `${periodBadgeText} • Scope: ${controlScopeName}`;

  // 1. ENERGY CONSUMPTION TREND CHART
  const trendCanvas = document.getElementById('energyTrendChart');
  if (trendCanvas) {
    const ctx = trendCanvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 240);
    grad.addColorStop(0, 'rgba(16, 185, 129, 0.35)');
    grad.addColorStop(1, 'rgba(16, 185, 129, 0.0)');

    energyTrendChartInstance = updateOrCreateAnalyticsChart(energyTrendChartInstance, trendCanvas, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            label: `Usage (${controlScopeName}) (kWh)`,
            data: trendData,
            borderColor: '#10b981',
            backgroundColor: grad,
            borderWidth: 2.5,
            fill: true,
            tension: 0.4,
            pointBackgroundColor: '#ffffff',
            pointBorderColor: '#10b981',
            pointBorderWidth: 2,
            pointRadius: 4,
            pointHoverRadius: 6
          },
          {
            label: 'Prev. Period Baseline',
            data: baselineData,
            borderColor: isDark ? '#64748b' : '#94a3b8',
            borderWidth: 1.5,
            borderDash: [5, 5],
            fill: false,
            pointRadius: 0
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: isDark ? '#0c1328' : '#ffffff',
            titleColor: isDark ? '#f8fafc' : '#0f172a',
            bodyColor: isDark ? '#cbd5e1' : '#334155',
            borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)',
            borderWidth: 1,
            padding: 10,
            filter: (ctx) => Number.isFinite(ctx.raw),
            callbacks: {
              label: (ctx) => ` ${ctx.dataset.label}: ${ctx.raw} kWh`
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: textColor, font: { weight: '600', size: 11 } }
          },
          y: {
            min: 0,
            max: Math.ceil((Math.max(...trendData) * 1.25) / 5) * 5 || 10,
            grid: { color: gridColor },
            ticks: {
              color: textColor,
              font: { weight: '600', size: 11 },
              callback: (v) => `${v}`
            }
          }
        }
      }
    });
  }

  // 2. ESTIMATED ELECTRICITY COST CHART
  const costCanvas = document.getElementById('estimatedCostChart');
  if (costCanvas) {
    const maxCostIdx = costData.indexOf(Math.max(...costData));

    // Green bars for normal days, bright amber/gold for peak interval
    const barColors = costData.map((_, idx) => idx === maxCostIdx ? '#f59e0b' : '#10b981');
    const barHoverColors = costData.map((_, idx) => idx === maxCostIdx ? '#fbbf24' : '#34d399');

    estimatedCostChartInstance = updateOrCreateAnalyticsChart(estimatedCostChartInstance, costCanvas, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: `Estimated Cost (${controlScopeName})`,
          data: costData,
          backgroundColor: barColors,
          hoverBackgroundColor: barHoverColors,
          borderRadius: 6,
          borderSkipped: false
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: isDark ? '#0c1328' : '#ffffff',
            titleColor: isDark ? '#f8fafc' : '#0f172a',
            bodyColor: isDark ? '#cbd5e1' : '#334155',
            borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)',
            borderWidth: 1,
            padding: 10,
            filter: (ctx) => Number.isFinite(ctx.raw),
            callbacks: {
              label: (ctx) => Number.isFinite(ctx.raw) ? ` Cost: ₱${ctx.raw.toLocaleString('en-PH', { minimumFractionDigits: 2 })} (@ ₱${formatAnalyticsNumber(rate)}/kWh)` : ' Cost: Unavailable'
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: textColor, font: { weight: '600', size: 11 } }
          },
          y: {
            min: 0,
            max: Math.ceil((Math.max(...costData) * 1.25) / 25) * 25 || 50,
            grid: { color: gridColor },
            ticks: {
              color: textColor,
              font: { weight: '600', size: 11 },
              callback: (v) => '₱' + (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v)
            }
          }
        }
      }
    });
  }

  // 3. DUAL-AXIS CORRELATION CHART (CONSUMPTION VS COST)
  const dualCanvas = document.getElementById('dualAxisChart');
  if (dualCanvas) {
    dualAxisChartInstance = updateOrCreateAnalyticsChart(dualAxisChartInstance, dualCanvas, {
      data: {
        labels: labels,
        datasets: [
          {
            type: 'bar',
            label: `Cost (${controlScopeName}) (₱)`,
            data: costData,
            backgroundColor: 'rgba(16, 185, 129, 0.75)',
            hoverBackgroundColor: '#10b981',
            borderRadius: 6,
            yAxisID: 'y1',
            barPercentage: 0.5
          },
          {
            type: 'line',
            label: `Energy (${controlScopeName}) (kWh)`,
            data: trendData,
            borderColor: '#22d3ee',
            backgroundColor: '#22d3ee',
            borderWidth: 2.5,
            fill: false,
            tension: 0.35,
            pointBackgroundColor: '#ffffff',
            pointBorderColor: '#22d3ee',
            pointBorderWidth: 2.5,
            pointRadius: 4.5,
            pointHoverRadius: 6.5,
            yAxisID: 'y'
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: isDark ? '#0c1328' : '#ffffff',
            titleColor: isDark ? '#f8fafc' : '#0f172a',
            bodyColor: isDark ? '#cbd5e1' : '#334155',
            borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)',
            borderWidth: 1,
            padding: 10,
            filter: (ctx) => Number.isFinite(ctx.raw),
            callbacks: {
              label: (ctx) => {
                if (!Number.isFinite(ctx.raw)) return ctx.dataset.yAxisID === 'y1' ? ' Cost: Unavailable' : ' Energy: Unavailable';
                if (ctx.dataset.yAxisID === 'y1') {
                  return ` Cost: ₱${Number(ctx.raw).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;
                }
                return ` Energy: ${ctx.raw} kWh`;
              }
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: textColor, font: { weight: '600', size: 11 } }
          },
          y: {
            type: 'linear',
            display: true,
            position: 'left',
            min: 0,
            max: Math.ceil((Math.max(...trendData) * 1.25) / 5) * 5 || 10,
            grid: { color: gridColor },
            ticks: {
              color: '#06b6d4',
              font: { weight: 'bold', size: 11 },
              callback: (v) => `${v} kWh`
            }
          },
          y1: {
            type: 'linear',
            display: true,
            position: 'right',
            min: 0,
            max: Math.ceil((Math.max(...costData) * 1.25) / 25) * 25 || 50,
            grid: { drawOnChartArea: false },
            ticks: {
              color: '#10b981',
              font: { weight: 'bold', size: 11 },
              callback: (v) => '₱' + Number(v).toLocaleString('en-PH')
            }
          }
        }
      }
    });
  }

  const energyMaxVal = baseKwh > 0 ? (Math.ceil((Math.max(...trendData, 0) * 1.25) / 5) * 5 || 10) : 10;
  const costMaxVal = baseKwh > 0 ? (Math.ceil((Math.max(...costData, 0) * 1.25) / 25) * 25 || 50) : 50;

  const dualAxisEnergyLegend = document.getElementById('dualAxisEnergyLegend');
  if (dualAxisEnergyLegend) {
    dualAxisEnergyLegend.textContent = baseKwh > 0
      ? `Energy (Left Axis: 0 - ${energyMaxVal} kWh)`
      : available ? 'Energy (Left Axis: 0 kWh)' : 'Energy: Unavailable';
  }

  const dualAxisCostLegend = document.getElementById('dualAxisCostLegend');
  if (dualAxisCostLegend) {
    dualAxisCostLegend.textContent = baseKwh > 0
      ? `Cost (Right Axis: ₱0 - ₱${Number(costMaxVal).toLocaleString('en-PH')})`
      : available ? 'Cost (Right Axis: ₱0)' : 'Cost: Unavailable';
  }

  const corrEl = document.getElementById('correlationScore');
  if (corrEl) {
    const pairs = trendData.map((energy, index) => [energy, costData[index]]).filter(([energy, cost]) => Number.isFinite(energy) && Number.isFinite(cost));
    const meanX = pairs.reduce((sum, pair) => sum + pair[0], 0) / (pairs.length || 1);
    const meanY = pairs.reduce((sum, pair) => sum + pair[1], 0) / (pairs.length || 1);
    const covariance = pairs.reduce((sum, [x, y]) => sum + (x - meanX) * (y - meanY), 0);
    const varianceX = pairs.reduce((sum, [x]) => sum + (x - meanX) ** 2, 0);
    const varianceY = pairs.reduce((sum, [, y]) => sum + (y - meanY) ** 2, 0);
    corrEl.textContent = pairs.length > 1 && varianceX > 0 && varianceY > 0
      ? 'r = ' + Math.max(-1, Math.min(1, covariance / Math.sqrt(varianceX * varianceY))).toFixed(3) : 'Unavailable';
  }
}

// ─── ENERGY CONSUMPTION PREDICTION (via Flask research model) ──────────

const BACKEND_URL = window.EcoTrackEnergyPrediction.backendUrl();

const ALGO_TO_MODEL = {
  hist_gradient_boosting: 'hist_gradient_boosting'
};

// ─── AIRCON RUNTIME & OPERATIONAL TIMESTAMPS ENGINE ──────────

// Determine actual AC operation from feedback; schedule forecasts are handled separately.
function getConfirmedAcOnState(log) {
  if (log.eventType === 'schedule_updated' || log.event_type === 'schedule_updated') return null;
  if (['offline', 'disconnected'].includes(String(log.status).toLowerCase())) return null;
  const snapshot = typeof window !== 'undefined' && window.EcoTrackAirconState
    ? window.EcoTrackAirconState.describeAirconState(log.controlSnapshot ?? log.control_snapshot) : { confirmed: false };
  if (snapshot.confirmed && typeof snapshot.power === 'boolean') return snapshot.power;
  const value = log.aircon_state ?? log.acOn ?? log.ac_on ?? log.powerState ?? log.power_state ?? log.acState ?? log.ac_state;
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const state = String(value ?? '').trim().toLowerCase().replace(/[_-]/g, ' ');
  if (['on', 'true', '1', 'cooling', 'active cooling', 'fan only', 'running'].includes(state)) return true;
  if (['off', 'false', '0', 'standby', 'idle', 'stopped'].includes(state)) return false;
  const current = log.ac_current_a ?? log.compressor_current_a;
  if (current !== null && current !== undefined && current !== '' && Number.isFinite(Number(current))) return Number(current) > 0;

  return null;
}

function getDisplayAcState(log) {
  const snapshot = typeof window !== 'undefined' && window.EcoTrackAirconState
    ? window.EcoTrackAirconState.describeAirconState(log.controlSnapshot ?? log.control_snapshot) : { label: 'UNCONFIRMED' };
  if (snapshot.confirmed && snapshot.summary) return snapshot.summary;
  const explicitState = String(log.aircon_state ?? log.acState ?? log.ac_state ?? '').trim().toLowerCase().replace(/[_-]/g, ' ');
  if (explicitState === 'fan only') return 'FAN ONLY';
  if (['active cooling', 'cooling'].includes(explicitState)) return 'ACTIVE COOLING';
  const confirmed = getConfirmedAcOnState(log);
  if (confirmed === false) return 'OFF';
  if (confirmed === true) return 'ON';
  if (snapshot.summary && snapshot.label !== 'UNCONFIRMED') return snapshot.summary;
  return 'STATE NOT RECORDED';
}

// Historical settings come from the state saved with this reading.
function getAnalyticsRecordingPower(log) {
  const api = typeof window !== 'undefined' ? window.EcoTrackAirconState : null;
  const selected = api?.displaySettings?.(log.controlSnapshot ?? log.control_snapshot)?.power;
  if (typeof selected === 'boolean') return selected;
  const value = log.ac_on ?? log.acOn ?? log.power_state ?? log.powerState ?? log.ac_state ?? log.acState;
  if (value === true || value === 1 || ['on','true','1','cooling','active cooling','fan only','running'].includes(String(value).toLowerCase())) return true;
  if (value === false || value === 0 || ['off','false','0','standby','idle','stopped'].includes(String(value).toLowerCase())) return false;
  return null;
}

function getRecordedClimateSettings(log) {
  const api = typeof window !== 'undefined' ? window.EcoTrackAirconState : null;
  const snapshot = api?.parseAirconSnapshot(log.controlSnapshot ?? log.control_snapshot);
  if (!snapshot || !api?.displaySettings) return null;
  return api.displaySettings({
    reported_state: snapshot.reported_state,
    reported_at: snapshot.reported_at,
    observed_remote_state: snapshot.observed_remote_state,
    observed_remote_at: snapshot.observed_remote_at,
    observed_remote_field_at: snapshot.observed_remote_field_at
  });
}

function getRecordedSpecialFunctions(log) {
  const state = getRecordedClimateSettings(log)?.state || {};
  const fields = [
    ['Vertical Swing', state.swing_vertical ?? state.swing],
    ['Horizontal Swing', state.swing_horizontal], ['Turbo', state.turbo],
    ['Eco', state.eco], ['Quiet', state.quiet], ['Sleep', state.sleep],
    ['Display', state.display], ['Clean', state.clean], ['Beep', state.beep], ['I Feel', state.i_feel]
  ];
  return fields.flatMap(([label, value]) => {
    if (value == null) return [];
    const known = String(value).toLowerCase();
    return ['true','on','1'].includes(known) ? [label + ': ON']
      : ['false','off','0'].includes(known) ? [label + ': OFF'] : [];
  }).join(' · ') || 'Unavailable';
}

function getRecordedClimateModes(log) {
  const display = getRecordedClimateSettings(log);
  if (!display) return { mode: 'Unavailable', fan: 'Unavailable' };
  return {
    mode: display.modeLabel === '—' ? 'Unavailable' : display.modeLabel,
    fan: display.fanLabel === '—' ? 'Unavailable'
      : display.fanLabel + (display.state?.turbo === true ? ' · TURBO' : '')
  };
}

function getRuntimeIntervalMs(log, node = {}) {
  const seconds = Number(log.intervalSeconds ?? log.interval_seconds ?? node.interval_seconds);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 3600000);
  const value = Number(log.intervalVal ?? log.interval_val ?? node.interval_val ?? node.intervalVal);
  const unit = String(log.intervalUnit ?? log.interval_unit ?? node.interval_unit ?? node.intervalUnit ?? '').toLowerCase();
  const multiplier = unit.startsWith('sec') ? 1000 : unit.startsWith('min') ? 60000 : (unit.startsWith('hour') || unit.startsWith('hr')) ? 3600000 : 0;
  // An absent historical cadence cannot establish a thirty-second or fifteen-minute interval.
  const calcMs = Number.isFinite(value) && value > 0 && multiplier ? value * multiplier : 0;
  return Math.min(calcMs, 3600000);
}

function runtimeClockMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(value ?? ''));
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function runtimeDayWindows(day, startMinutes, endMinutes) {
  const nextDay = new Date(day); nextDay.setDate(nextDay.getDate() + 1);
  const begin = day.getTime(), end = nextDay.getTime();
  if (startMinutes === null || endMinutes === null || startMinutes === endMinutes) return [[begin, end]];
  const at = minutes => { const date = new Date(day); date.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0); return date.getTime(); };
  return endMinutes > startMinutes ? [[at(startMinutes), at(endMinutes)]] : [[begin, at(endMinutes)], [at(startMinutes), end]];
}

function clipRuntimeSegment(start, end, node = {}) {
  const segments = [];
  const day = new Date(start); day.setHours(0, 0, 0, 0);
  const filterStart = typeof startTimeFilter === 'string' && startTimeFilter.trim() ? runtimeClockMinutes(startTimeFilter) : null;
  const filterEnd = typeof endTimeFilter === 'string' && endTimeFilter.trim() ? runtimeClockMinutes(endTimeFilter) : null;
  while (day.getTime() < end) {
    const nextDay = new Date(day); nextDay.setDate(nextDay.getDate() + 1);
    const dayBoundaryStart = day.getTime();
    const dayBoundaryEnd = nextDay.getTime();
    
    // Day-clipped session boundaries based on exact calendar day timestamps
    const daySegmentStart = Math.max(start, dayBoundaryStart);
    const daySegmentEnd = Math.min(end, dayBoundaryEnd);
    
    const operatingWindows = runtimeDayWindows(day, runtimeClockMinutes(node.wake_time ?? node.wakeTime),
      runtimeClockMinutes(node.sleep_time ?? node.sleepTime));
    const filteredWindows = runtimeDayWindows(day, filterStart ?? 0, filterEnd ?? 1440);
    for (const [wake, sleep] of operatingWindows) for (const [f, t] of filteredWindows) {
      const clippedStart = Math.max(daySegmentStart, wake, f);
      const clippedEnd = Math.min(daySegmentEnd, sleep, t);
      if (clippedEnd > clippedStart) segments.push([clippedStart, clippedEnd]);
    }
    day.setDate(day.getDate() + 1);
  }
  return segments;
}

function mergeRuntimeSegments(segments) {
  const merged = [];
  segments.sort((a, b) => a[0] - b[0]).forEach(([start, end]) => {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  });
  return merged;
}

// Ground truth runtime calculation: strictly timestamp-based per unit and partitioned each day
function calculateRuntimeFromLogs(logs) {
  const logsByNode = new Map();
  (logs || []).forEach(log => {
    const originalId = log.nodeId || log.node_id || log.sensor_name;
    const timestamp = new Date(log.timestamp ?? log.created).getTime();
    if (!originalId || !Number.isFinite(timestamp)) return;
    const node = globalNodeRecords.find(n => [n.id, n.name, n.node_id, n.db_id].some(id => id && [originalId, log.controlName, log.sensor_name].includes(id))) || {};
    const id = node.id || originalId;
    if (!logsByNode.has(id)) logsByNode.set(id, { node, samples: [] });
    logsByNode.get(id).samples.push({ log, timestamp });
  });

  const nodeRuntimes = {};
  const dailyNodeRuntimes = {};
  const dailyFacilitySegments = new Map();
  const allFacilitySegments = [];
  const settingsSegments = [];
  let totalRuntimeSum = 0;
  let missingCadenceSamples = 0;

  logsByNode.forEach(({ node, samples }, id) => {
    let config = { ...node };
    const readings = [];
    samples.sort((a, b) => a.timestamp - b.timestamp).forEach(sample => {
      const { log } = sample;
      if (Number(log.intervalSeconds ?? log.interval_seconds) > 0) config.interval_seconds = Number(log.intervalSeconds ?? log.interval_seconds);
      if (log.wakeTime ?? log.wake_time) config.wake_time = log.wakeTime ?? log.wake_time;
      if (log.sleepTime ?? log.sleep_time) config.sleep_time = log.sleepTime ?? log.sleep_time;
      if (log.eventType !== 'schedule_updated' && log.event_type !== 'schedule_updated' && String(log.status).toLowerCase() !== 'schedule') readings.push({ ...sample, config: { ...config } });
    });

    const segments = [];
    readings.forEach(({ log, timestamp, config }, index) => {
      if (getConfirmedAcOnState(log) !== true) return;
      const intervalMs = getRuntimeIntervalMs(log, config);
      if (!intervalMs) { missingCadenceSamples++; return; }
      const next = readings[index + 1];
      const gap = next ? next.timestamp - timestamp : Infinity;
      const dayEnd = new Date(timestamp); dayEnd.setHours(24, 0, 0, 0);
      const maxSessionGap = intervalMs * 2.5;
      const end = (gap > 0 && gap <= maxSessionGap)
        ? next.timestamp : Math.min(timestamp + intervalMs, dayEnd.getTime());
      const clipped = clipRuntimeSegment(timestamp, end, config);
      segments.push(...clipped);
      settingsSegments.push(...clipped.map(([start, end]) => ({ nodeId: id, start, end, log })));
    });

    const merged = mergeRuntimeSegments(segments);
    const nodeTotalHours = merged.reduce((sum, [start, end]) => sum + end - start, 0) / 3600000;
    nodeRuntimes[id] = nodeTotalHours;
    totalRuntimeSum += nodeTotalHours;
    allFacilitySegments.push(...merged);

    // Group segments by each calendar day based on timestamp
    merged.forEach(([start, end]) => {
      const day = new Date(start); day.setHours(0, 0, 0, 0);
      const dayKey = day.getTime();
      if (!dailyNodeRuntimes[dayKey]) dailyNodeRuntimes[dayKey] = {};
      const hrs = (end - start) / 3600000;
      dailyNodeRuntimes[dayKey][id] = (dailyNodeRuntimes[dayKey][id] || 0) + hrs;

      if (!dailyFacilitySegments.has(dayKey)) dailyFacilitySegments.set(dayKey, []);
      dailyFacilitySegments.get(dayKey).push([start, end]);
    });
  });

  const activeUnits = Object.values(nodeRuntimes).filter(hours => hours > 0).length;

  // Calculate facility active operational hours across each day based on merged timestamp sessions
  let totalFacilityActiveHrs = 0;
  dailyFacilitySegments.forEach((daySegments) => {
    const mergedDay = mergeRuntimeSegments(daySegments);
    const dayFacilityHrs = mergedDay.reduce((sum, [start, end]) => sum + end - start, 0) / 3600000;
    totalFacilityActiveHrs += dayFacilityHrs;
  });

  if (totalFacilityActiveHrs === 0 && allFacilitySegments.length > 0) {
    totalFacilityActiveHrs = mergeRuntimeSegments(allFacilitySegments).reduce((sum, [start, end]) => sum + end - start, 0) / 3600000;
  }

  const mergedAllFacility = mergeRuntimeSegments(allFacilitySegments);
  const facilitySpanHrs = mergedAllFacility.reduce((sum, [start, end]) => sum + end - start, 0) / 3600000;

  return {
    runtimeHrs: totalFacilityActiveHrs || facilitySpanHrs,
    perUnitUtil: activeUnits ? totalRuntimeSum / activeUnits : 0,
    totalRuntimeSum,
    missingCadenceSamples,
    activeUnits,
    nodeRuntimes,
    dailyNodeRuntimes,
    settingsSegments,
    confirmedSegments: allFacilitySegments,
    facilityActiveHrs: facilitySpanHrs
  };
}

// Helper: Calculate previous period date key for comparative trend evaluation
function getPreviousPeriodDateKey(dateKey, period = currentPeriod) {
  if (!dateKey) return null;
  try {
    if (period === 'yearly') {
      const yr = parseInt(dateKey, 10);
      return isNaN(yr) ? null : String(yr - 1);
    }
    if (period === 'monthly') {
      const [y, m] = dateKey.split('-').map(Number);
      const d = new Date(y, m - 1, 1);
      d.setMonth(d.getMonth() - 1);
      const prevY = d.getFullYear();
      const prevM = String(d.getMonth() + 1).padStart(2, '0');
      return `${prevY}-${prevM}`;
    }
    if (period === 'weekly') {
      const [y, m, dNum] = dateKey.split('-').map(Number);
      const d = new Date(y, m - 1, dNum);
      d.setDate(d.getDate() - 7);
      return getPeriodDateKey(d, 'weekly');
    }
    // daily: subtract 1 calendar day
    const [y, m, dNum] = dateKey.split('-').map(Number);
    const d = new Date(y, m - 1, dNum);
    d.setDate(d.getDate() - 1);
    return getPeriodDateKey(d, 'daily');
  } catch (_) {
    return null;
  }
}

// Helper: Get previous period runtime derived from actual telemetry logs
function getPreviousPeriodRuntime(period = currentPeriod) {
  const activeDateKey = selectedDateKey || getDefaultDateKey();
  const prevDateKey = getPreviousPeriodDateKey(activeDateKey, period);
  if (!prevDateKey) return null;

  let prevLogs = nodeDataLogs.filter(log => getPeriodDateKey(log.timestamp, period) === prevDateKey);
  if (currentNodeFilter) {
    prevLogs = prevLogs.filter(log =>
      log.nodeId === currentNodeFilter ||
      log.controlName === currentNodeFilter ||
      (controlNameMap[currentNodeFilter] && controlNameMap[currentNodeFilter] === log.controlName) ||
      (controlNameMap[log.nodeId] && controlNameMap[log.nodeId] === currentNodeFilter)
    );
  }

  if (prevLogs.length === 0) return 0;
  return calculateRuntimeFromLogs(prevLogs).runtimeHrs;
}





let currentPredictionSession = 0;
let predictionAbortController = null;
let energyPredictionPending = false;

function getEnergySelectionKey() {
  return JSON.stringify([currentPeriod, currentNodeFilter, selectedDateKey, startTimeFilter, endTimeFilter]);
}

function getEnergyPredictionForExport() {
  return !energyPredictionPending && currentAnalyticsResult?.selectionKey === getEnergySelectionKey()
    ? currentAnalyticsResult : null;
}

// Partition recorded intervals without double-counting duplicate readings or choosing between conflicting states.
function getRecordedEnergySegments(logs, client) {
  const intervals = calculateRuntimeFromLogs(logs).settingsSegments;
  return partitionEnergyIntervals(intervals, client);
}

function partitionEnergyIntervals(intervals, client) {
  const events = new Map();
  intervals.forEach((interval, index) => {
    let settings = null, error = null;
    try { settings = client.normalizeSettings(getRecordedClimateSettings(interval.log)?.state); }
    catch (failure) { error = failure.message; }
    const item = { ...interval, index, settings, error, key: settings ? JSON.stringify(settings) : null };
    for (const [time, entering] of [[interval.start, true], [interval.end, false]]) {
      if (!events.has(time)) events.set(time, []);
      events.get(time).push({ item, entering });
    }
  });
  const times = [...events.keys()].sort((a, b) => a - b), active = new Map(), segments = [];
  let missingHours = 0, reason = null;
  times.forEach((start, index) => {
    events.get(start).forEach(({ item, entering }) => entering ? active.set(item.index, item) : active.delete(item.index));
    const end = times[index + 1];
    if (!active.size || !(end > start)) return;
    const records = [...active.values()], invalid = records.find(record => record.error);
    if (invalid || new Set(records.map(record => record.key)).size !== 1) {
      missingHours += (end - start) / 3600000;
      reason ||= invalid?.error || 'Conflicting controls are recorded during the same interval.';
      return;
    }
    const record = records[0], last = segments[segments.length - 1];
    if (last && last.end === start && last.key === record.key) last.end = end;
    else segments.push({ start, end, settings: record.settings, key: record.key });
  });
  return { segments, missingHours, reason };
}

// Conditional forecast intervals use the exact saved columns and timestamp/cadence,
// never a schedule or fabricated physical power feedback.
function getRecordedControlProjection(id, logs, client) {
  const node = globalNodeRecords.find(record => [record.id, record.name, record.node_id, record.db_id].includes(id)) || {};
  const samples = getAnalyticsReadings(logs).map(log => ({ log, time: new Date(log.timestamp ?? log.created).getTime() }))
    .sort((a, b) => a.time - b.time);
  const intervals = [];
  let missingCadence = 0;
  samples.forEach(({ log, time }, index) => {
    if (getAnalyticsRecordingPower(log) === false || getConfirmedAcOnState(log) === false ||
        ['offline', 'disconnected'].includes(String(log.status).toLowerCase())) return;
    const cadence = getRuntimeIntervalMs(log, node);
    if (!cadence) { missingCadence++; return; }
    const next = samples[index + 1], gap = next ? next.time - time : Infinity;
    const dayEnd = new Date(time); dayEnd.setHours(24, 0, 0, 0);
    const end = gap > 0 && gap <= cadence * 2.5 ? next.time : Math.min(time + cadence, dayEnd.getTime());
    for (const [start, finish] of clipRuntimeSegment(time, end)) intervals.push({ start, end: finish, log });
  });
  const partition = partitionEnergyIntervals(intervals, { normalizeSettings: client.normalizeRecordedSettings });
  const segments = partition.segments.map(segment => [segment.start, segment.end]);
  const hoursUsed = segments.reduce((sum, [start, end]) => sum + end - start, 0) / 3600000;
  return { segments, controlSegments: partition.segments, hoursUsed, acOnRatio: 1,
    missingHours: partition.missingHours,
    reason: partition.reason || (missingCadence ? 'The recorded sampling interval is missing; a timestamp alone cannot establish the last interval.' : null) ||
      (!intervals.length ? 'No bounded recorded control intervals are available for this selection.' : null) };
}



function getAnalyticsNodeId(log) {
  const id = log.nodeId || log.node_id || log.sensor_name;
  const node = globalNodeRecords.find(n => [n.id, n.name, n.node_id, n.db_id].some(value => value && [id, log.controlName, log.sensor_name].includes(value)));
  return node?.id || id;
}

function getAnalyticsReadings(logs) {
  return (logs || []).filter(log => getAnalyticsNodeId(log) && Number.isFinite(new Date(log.timestamp ?? log.created).getTime()) &&
    log.eventType !== 'schedule_updated' && log.event_type !== 'schedule_updated' && String(log.status).toLowerCase() !== 'schedule');
}

function getAnalyticsCoverage(logs, totalUnits) {
  const readings = getAnalyticsReadings(logs), latest = new Map();
  let confirmedSamples = 0, unknownSamples = 0;
  readings.forEach(log => {
    const id = getAnalyticsNodeId(log), time = new Date(log.timestamp ?? log.created).getTime();
    if (typeof getConfirmedAcOnState(log) === 'boolean') confirmedSamples++;
    else unknownSamples++;
    if (!latest.has(id) || time >= latest.get(id).time) latest.set(id, { time, state: getConfirmedAcOnState(log) });
  });
  let activeUnits = 0, offUnits = 0;
  latest.forEach(({ state }) => { if (state === true) activeUnits++; else if (state === false) offUnits++; });
  totalUnits = Math.max(totalUnits || 0, latest.size);
  return { confirmedSamples, unknownSamples, activeUnits, offUnits, totalUnits,
    knownUnits: activeUnits + offUnits, unknownUnits: Math.max(0, totalUnits - activeUnits - offUnits) };
}

function getPreviousAnalyticsLogs() {
  const key = getPreviousPeriodDateKey(selectedDateKey || getDefaultDateKey(), currentPeriod);
  return nodeDataLogs.filter(log => {
    if (getPeriodDateKey(log.timestamp ?? log.created, currentPeriod) !== key) return false;
    const matchesControl = getAnalyticsNodeId(log) === getAnalyticsNodeId({ nodeId: currentNodeFilter }) ||
      [log.nodeId, log.node_id, log.controlName, controlNameMap[log.nodeId]].includes(currentNodeFilter) ||
      (controlNameMap[currentNodeFilter] && controlNameMap[currentNodeFilter] === log.controlName);
    if (currentNodeFilter && !matchesControl) return false;
    const date = new Date(log.timestamp ?? log.created);
    const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    if (startTimeFilter && endTimeFilter && startTimeFilter > endTimeFilter) {
      return time >= startTimeFilter || time <= endTimeFilter;
    }
    return (!startTimeFilter || time >= startTimeFilter) && (!endTimeFilter || time <= endTimeFilter);
  });
}

function getAcStateFeatures(filteredLogs) {
  const readings = getAnalyticsReadings(filteredLogs);
  let onCount = 0, offCount = 0;
  readings.forEach(log => { const state = getConfirmedAcOnState(log); if (state === true) onCount++; else if (state === false) offCount++; });
  const runtime = calculateRuntimeFromLogs(readings);
  return { acOnRatio: onCount / (onCount + offCount || 1), hoursUsed: runtime.totalRuntimeSum,
    confirmedCount: onCount + offCount, unknownCount: readings.length - onCount - offCount };
}

function getSavedForecastSettings(logs) {
  for (const item of [...logs].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))) {
    let snapshot = item?.controlSnapshot ?? item?.control_snapshot;
    if (typeof snapshot === 'string') { try { snapshot = JSON.parse(snapshot); } catch (_) { continue; } }
    const state = snapshot?.desired_state || snapshot?.configured_state;
    if (state && typeof state === 'object' && !Array.isArray(state)) return state;
  }
  return null;
}

// This projection is an explicit assumption about the saved schedule, never device feedback.
function getScheduledEnergyProjection(id, logs, targetDateKey = (selectedDateKey || getDefaultDateKey())) {
  const node = globalNodeRecords.find(record => [record.id, record.name, record.node_id, record.db_id].some(v => v && [id, controlNameMap[id]].includes(v)));
  const wakeTime = node?.wake_time || logs.find(l => l.wakeTime || l.wake_time)?.wakeTime || logs.find(l => l.wakeTime || l.wake_time)?.wake_time;
  const sleepTime = node?.sleep_time || logs.find(l => l.sleepTime || l.sleep_time)?.sleepTime || logs.find(l => l.sleepTime || l.sleep_time)?.sleep_time;
  if (runtimeClockMinutes(wakeTime) === null || runtimeClockMinutes(sleepTime) === null) return null;
  const schedNode = node ? { ...node, wake_time: wakeTime, sleep_time: sleepTime } : { id, wake_time: wakeTime, sleep_time: sleepTime };
  const state = getSavedForecastSettings(logs);
  if (!state || state.power === undefined || state.power === null) return null;
  const mode = String(state.mode || '').toLowerCase();
  if (!['cool', 'dry', 'fan', 'auto', 'heat'].includes(mode)) return null;
  const dateKey = targetDateKey || selectedDateKey || getDefaultDateKey(), parts = (dateKey || '').split('-').map(Number);
  const start = new Date(parts[0], (parts[1] || 1) - 1, parts[2] || 1), end = new Date(start);
  if (currentPeriod === 'yearly') end.setFullYear(end.getFullYear() + 1);
  else if (currentPeriod === 'monthly') end.setMonth(end.getMonth() + 1);
  else end.setDate(end.getDate() + (currentPeriod === 'weekly' ? 7 : 1));
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null;
  const off = state?.power === false || state?.power === 0 || ['off', 'false', '0'].includes(String(state?.power).toLowerCase());
  const on = state.power === true || state.power === 1 || ['on', 'true', '1'].includes(String(state.power).toLowerCase());
  if (!off && !on) return null;
  const segments = [];
  if (!off) {
    const day = new Date(start);
    while (day < end) {
      for (const [begin, finish] of runtimeDayWindows(day, runtimeClockMinutes(wakeTime), runtimeClockMinutes(sleepTime))) {
        segments.push(...clipRuntimeSegment(begin, Math.min(finish, end.getTime()), schedNode));
      }
      day.setDate(day.getDate() + 1);
    }
  }
  return { segments, hoursUsed: segments.reduce((sum, [begin, finish]) => sum + finish - begin, 0) / 3600000,
    acOnRatio: off ? 0 : 1, setpoint: state.temp ?? null, mode, settings: state };
}

function getMissingForecastReason(id, logs) {
  const node = globalNodeRecords.find(record => [record.id, record.name, record.node_id, record.db_id].some(v => v && [id, controlNameMap[id]].includes(v)));
  const wake = node?.wake_time || logs.find(log => log.wakeTime || log.wake_time)?.wakeTime || logs.find(log => log.wakeTime || log.wake_time)?.wake_time;
  const sleep = node?.sleep_time || logs.find(log => log.sleepTime || log.sleep_time)?.sleepTime || logs.find(log => log.sleepTime || log.sleep_time)?.sleep_time;
  if (runtimeClockMinutes(wake) === null || runtimeClockMinutes(sleep) === null) {
    return 'Physical AC power is unconfirmed. Set both wake and sleep times in Control Schedules for a forecast.';
  }
  return 'Physical AC power is unconfirmed. Save complete controller power and operating-mode settings for a schedule forecast.';
}

function getAnalyticsPeriodHours() {
  const parts = (selectedDateKey || getDefaultDateKey()).split('-').map(Number);
  const start = new Date(parts[0], (parts[1] || 1) - 1, parts[2] || 1), end = new Date(start);
  if (currentPeriod === 'yearly') end.setFullYear(end.getFullYear() + 1);
  else if (currentPeriod === 'monthly') end.setMonth(end.getMonth() + 1);
  else end.setDate(end.getDate() + (currentPeriod === 'weekly' ? 7 : 1));
  const filterStart = runtimeClockMinutes(startTimeFilter), filterEnd = runtimeClockMinutes(endTimeFilter);
  if (filterStart === null && filterEnd === null) return (end - start) / 3600000;
  let hours = 0;
  for (const day = new Date(start); day < end; day.setDate(day.getDate() + 1)) {
    for (const [begin, finish] of runtimeDayWindows(day, filterStart ?? 0, filterEnd ?? 1440)) {
      hours += Math.max(0, Math.min(finish, end.getTime()) - Math.max(begin, start.getTime())) / 3600000;
    }
  }
  return hours;
}

// Use the same successful per-controller estimates as the forecast energy chart.
function getForecastOperatingMetrics(result) {
  const jobs = result.nodes.filter(job => Number.isFinite(job.kwh));
  let activeUnits = 0, totalRuntimeSum = 0;
  const segments = [];
  jobs.forEach(job => {
    const metrics = job.projection ? { totalRuntimeSum: job.projection.hoursUsed, confirmedSegments: job.projection.segments }
      : calculateRuntimeFromLogs(job.logs);
    totalRuntimeSum += metrics.totalRuntimeSum;
    if (metrics.totalRuntimeSum > 0) activeUnits++;
    segments.push(...metrics.confirmedSegments.map(segment => [...segment]));
  });
  const runtimeHrs = mergeRuntimeSegments(segments).reduce((sum, [start, end]) => sum + end - start, 0) / 3600000;
  return { runtimeHrs, perUnitUtil: activeUnits ? totalRuntimeSum / activeUnits : 0,
    activeUnits, offUnits: jobs.length - activeUnits, knownUnits: jobs.length,
    unknownUnits: Math.max(0, result.coverage.totalUnits - jobs.length), totalUnits: result.coverage.totalUnits };
}

function setAnalyticsText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function setAnalyticsValue(id, value, unitId) {
  const element = document.getElementById(id);
  if (element) {
    element.textContent = value;
    const unavailable = value === 'Unavailable';
    element.style.fontSize = unavailable ? '1.125rem' : '';
  }
  const unit = unitId && document.getElementById(unitId);
  if (unit) unit.style.display = value === 'Unavailable' ? 'none' : '';
}

function updateKpiCardsTrends(period, isSingleNode, kwh, cost, runtimeHrs, activeUnits, totalUnits, idleUnits, capacityPct) {
  const result = currentAnalyticsResult;
  const previous = !result?.forecast && result?.previous?.complete &&
    !result?.missingEstimates && !result?.coverage?.unknownUnits && !result?.coverage?.unknownSamples
    ? result.previous : null;
  const labels = { daily: 'vs previous day', weekly: 'vs previous week', monthly: 'vs previous month', yearly: 'vs previous year' };
  const compare = (id, value, prior, unit) => {
    let text = '--';
    let className = 'font-bold text-slate-500 dark:text-gray-400';
    if (Number.isFinite(value) && Number.isFinite(prior)) {
      const difference = value - prior;
      if (unit === 'hrs') {
        const sign = difference > 0 ? '+' : difference < 0 ? '-' : '';
        text = `${sign}${Math.abs(difference).toFixed(1)} hrs`;
        className = difference < 0 ? 'font-bold text-emerald-500 dark:text-emerald-400' : difference > 0 ? 'font-bold text-cyan-500 dark:text-cyan-400' : 'font-bold text-slate-400';
      } else if (prior > 0) {
        const pct = (difference / prior) * 100;
        const sign = pct > 0 ? '+' : pct < 0 ? '-' : '';
        text = `${sign}${Math.abs(pct).toFixed(1)}%`;
        className = pct < 0 ? 'font-bold text-emerald-500 dark:text-emerald-400' : pct > 0 ? 'font-bold text-amber-500 dark:text-amber-400' : 'font-bold text-slate-400';
      } else {
        text = difference === 0 ? '0.0%' : (difference > 0 ? '+100%' : '0.0%');
        className = 'font-bold text-slate-400';
      }
    } else if (Number.isFinite(value) && (!previous || prior === null || prior === undefined)) {
      text = 'Unavailable';
      className = 'font-bold text-slate-400';
    } else {
      text = 'Unavailable';
      className = 'font-bold text-slate-500 dark:text-gray-400';
    }
    setAnalyticsText(id, text);
    const element = document.getElementById(id);
    if (element) element.className = className;
  };
  compare('kpiEnergyTrend', kwh, previous?.kwh);
  compare('kpiCostTrend', cost, previous?.cost);
  compare('kpiRuntimeTrend', runtimeHrs, previous?.runtime, 'hrs');
  for (const id of ['kpiEnergyTrendLabel', 'kpiCostTrendLabel', 'kpiRuntimeTrendLabel']) setAnalyticsText(id, labels[period] || 'vs previous period');
  setAnalyticsText('kpiUtilizationLabel', `${period.charAt(0).toUpperCase() + period.slice(1)} utilization factor`);
}

function renderEnergyAnalytics(result) {
  energyPredictionPending = false;
  const { coverage, kwh, runtime, previous } = result;
  const rate = getActiveTariffRate(), cost = Number.isFinite(kwh) ? calculateEnergyCost(kwh, rate) : null;
  result.cost = cost;
  currentAnalyticsResult = result;
  currentEvaluatedKwh = kwh;
  currentEvaluatedCost = cost;
  const money = value => Number.isFinite(value) ? '₱' + value.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'Unavailable';
  const energy = value => Number.isFinite(value) ? value.toLocaleString('en-US', value > 0 && value < 0.1
    ? { maximumSignificantDigits: 4 } : { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : 'Unavailable';
  const operating = result.forecast ? getForecastOperatingMetrics(result) : { ...runtime, ...coverage };
  const partial = result.forecast ? operating.unknownUnits > 0 || result.missingEstimates > 0
    : coverage.unknownUnits > 0 || coverage.unknownSamples > 0 || result.missingEstimates > 0 || runtime.missingCadenceSamples > 0;
  const hasRuntime = result.forecast ? operating.knownUnits > 0
    : coverage.confirmedSamples > 0 && !(runtime.missingCadenceSamples > 0 && !runtime.totalRuntimeSum);
  setAnalyticsText('energyConsumption', Number.isFinite(kwh) ? energy(kwh) + ' kWh' : 'Unavailable');
  setAnalyticsValue('kpiEnergyVal', energy(kwh), 'kpiEnergyUnit');
  for (const id of ['kpiCostVal', 'estBillValue', 'costTodayCost', 'costCurrentCycle']) setAnalyticsValue(id, money(cost));
  for (const id of ['kpiCostRate', 'costCardRate']) setAnalyticsText(id, formatTariffRate(rate));
  setAnalyticsText('estBillPeriod', currentPeriod.charAt(0).toUpperCase() + currentPeriod.slice(1));
  setAnalyticsText('costPrevPeriod', previous?.complete ? money(previous.cost) : 'Unavailable');
  setAnalyticsText('costVariance', !result.forecast && !partial && previous?.complete && Number.isFinite(cost) && Number.isFinite(previous.cost)
    ? `${cost >= previous.cost ? '+' : '-'}${money(Math.abs(cost - previous.cost))}` : 'Unavailable');
  setAnalyticsValue('kpiRuntimeVal', hasRuntime ? operating.runtimeHrs.toFixed(1) : 'Unavailable', 'kpiRuntimeUnit');
  setAnalyticsText('kpiUtilization', hasRuntime ? `${operating.perUnitUtil.toFixed(1)} hrs / unit${partial ? ' · partial' : ''}` : 'Unavailable');
  setAnalyticsValue('kpiActiveUnits', operating.knownUnits ? String(operating.activeUnits) : 'Unavailable');
  setAnalyticsText('kpiTotalUnits', operating.knownUnits ? `/${operating.totalUnits}` : '');
  setAnalyticsText('kpiFleetStatusLabel', result.recordedColumns && result.forecast ? '• Conditional operation over recorded intervals' : result.forecast ? '• Planned during selected period'
    : coverage.knownUnits ? `• ${coverage.knownUnits}/${coverage.totalUnits} units have confirmed state` : '• Awaiting AC power feedback');
  setAnalyticsText('kpiIdleUnits', result.forecast ? `${operating.offUnits} planned idle${operating.unknownUnits ? ' · ' + operating.unknownUnits + ' without estimate' : ''}`
    : `${coverage.offUnits} confirmed off · ${coverage.unknownUnits} unknown`);
  const capacity = operating.knownUnits && operating.totalUnits ? operating.activeUnits / operating.totalUnits * 100 : null;
  setAnalyticsText('kpiCapacityPct', Number.isFinite(capacity) ? `${capacity.toFixed(1)}% ${result.forecast ? 'projected active' : 'confirmed active'}` : 'Unavailable');
  setAnalyticsText('kpiRuntimeLabel', result.forecast ? 'FORECAST OPERATING HOURS' : 'Facility active hours');
  setAnalyticsText('kpiActiveLabel', result.forecast ? 'FORECAST ACTIVE UNITS' : 'ACTIVE AIRCONS');
  setAnalyticsText('kpiIdleLabel', result.forecast ? 'Forecast Idle Units' : 'Standby / Idle Units');
  const runtimeLabel = document.getElementById('kpiRuntimeLabel');
  if (runtimeLabel) runtimeLabel.title = result.forecast
    ? 'Projected hours with at least one unit scheduled to run. Overlapping unit schedules count once; physical power is unconfirmed.'
    : 'Observed span from confirmed AC-on readings. Utilization sums bounded sessions per unit.';
  const bar = document.getElementById('kpiCapacityBar');
  if (bar) bar.style.width = `${capacity || 0}%`;
  const hours = getAnalyticsPeriodHours();
  setAnalyticsText('kpiAvgLoad', Number.isFinite(kwh) ? `${energy(kwh / (hours || 1))} kW${partial ? ' · partial' : ''}` : 'Unavailable');
  const basis = result.recordedColumns
    ? (result.forecast ? 'Forecast from recorded columns and timestamps. Physical AC power is unconfirmed.'
      : 'Estimated from recorded columns and confirmed operating intervals.') + ' The trained model uses AC controls only; unrecorded functions are averaged across supported control variants.'
    : result.forecast ? 'Forecast from recorded control intervals. Physical AC power is unconfirmed.'
      : 'Estimated from recorded controls and runtime.';
  const referenceRange = result.referenceRange && Number.isFinite(kwh)
    ? ` Reference range: ${energy(result.referenceRange.min)}–${energy(result.referenceRange.max)} kWh.` : '';
  const status = Number.isFinite(kwh)
    ? (partial ? 'Partial estimate. ' : '') + basis + referenceRange +
      (result.reason ? ' Missing coverage: ' + result.reason : '')
    : 'Estimate unavailable. ' + (result.reason || 'Recorded target temperature, operating mode and fan mode are required.');
  setAnalyticsText('kpiEnergyLabel', result.forecast ? 'FORECAST ENERGY' : 'ESTIMATED ENERGY');
  setAnalyticsText('kpiCostLabel', result.forecast ? 'FORECAST COST' : 'ESTIMATED COST');
  const explanation = Number.isFinite(kwh) && result.estimatedHours === 0
    ? 'No estimated operating hours. Standby electricity is excluded.' + (result.forecast ? ' Physical AC power is unconfirmed.' : '') : status;
  setAnalyticsText('aiSuggestion', explanation);
  updateKpiCardsTrends(currentPeriod, !!currentNodeFilter, kwh, cost, hasRuntime ? operating.runtimeHrs : null,
    coverage.activeUnits, coverage.totalUnits, coverage.offUnits, capacity);
  updateAnalyticsCharts(kwh, cost);
}

async function predictEnergyConsumption(stats, filteredLogs) {
  const sessionId = ++currentPredictionSession;
  predictionAbortController?.abort();
  const controller = predictionAbortController = new AbortController();
  energyPredictionPending = true;
  const client = typeof window !== 'undefined' ? window.EcoTrackEnergyPrediction : null;
  const total = currentNodeFilter ? 1 : getAirconFleetCount().total;
  const periods = [getAnalyticsReadings(filteredLogs), getAnalyticsReadings(getPreviousAnalyticsLogs())];
  const groups = periods.map(logs => {
    const byNode = new Map();
    logs.forEach(log => { const id = getAnalyticsNodeId(log); if (!byNode.has(id)) byNode.set(id, []); byNode.get(id).push(log); });
    return byNode;
  });
  groups[0].forEach((_, id) => { if (!groups[1].has(id)) groups[1].set(id, []); });
  const coverage = getAnalyticsCoverage(periods[0], total), runtime = calculateRuntimeFromLogs(periods[0]);
  const result = { coverage, runtime, kwh: null, nodes: [], missingEstimates: 0, previous: null,
    researchEstimate: true, inputScope: 'controls_only', selectionKey: getEnergySelectionKey(), estimatedHours: 0, reason: null };
  if (!periods[0].length) { result.reason = 'No readings match this selection.'; renderEnergyAnalytics(result); return; }
  // Keep same-selection refreshes steady, but never display another date/control's totals during recalculation.
  if (currentAnalyticsResult && currentAnalyticsResult.selectionKey !== result.selectionKey) {
    renderEnergyAnalytics(result);
    energyPredictionPending = true;
    setAnalyticsText('aiSuggestion', 'Updating the energy estimate…');
  }
  const recordedColumns = typeof client?.predictRecorded === 'function';
  result.recordedColumns = recordedColumns;
  const jobs = groups.flatMap((group, period) => [...group].map(([id, logs]) => ({
    id, logs, period, kwh: null, estimatedHours: 0, estimatedSegments: [], missingHours: 0, reason: null
  })));
  const predictions = new Map();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, async () => {
    while (next < jobs.length && sessionId === currentPredictionSession && !controller.signal.aborted) {
      const job = jobs[next++], features = getAcStateFeatures(job.logs);
      if (!recordedColumns) { job.reason = 'The controls-only Histogram Gradient Boosting client is unavailable. Reload this page.'; continue; }
      if (!features.confirmedCount) {
        job.projection = getRecordedControlProjection(job.id, job.logs, client);
        job.missingHours = job.projection.missingHours;
        job.reason = job.projection.reason;
        if (!job.projection.hoursUsed) { job.reason ||= 'No complete recorded control interval is available.'; continue; }
      }
      const operating = job.projection || features;
      if (operating.acOnRatio === 0 || (job.projection && operating.hoursUsed <= 0)) { job.kwh = 0; continue; }
      if (operating.hoursUsed <= 0) { job.reason = 'No bounded operating interval is available; check the recorded cadence and schedule.'; continue; }
      let segments;
      try {
        const recorded = job.projection ? { segments: job.projection.controlSegments,
          missingHours: job.projection.missingHours, reason: job.projection.reason }
          : getRecordedEnergySegments(job.logs, { normalizeSettings: client.normalizeRecordedSettings });
        segments = recorded.segments;
        job.missingHours = recorded.missingHours;
        job.reason = recorded.reason;
      } catch (error) { job.reason = error.message; continue; }
      for (const segment of segments) {
        if (sessionId !== currentPredictionSession || controller.signal.aborted) return;
        const hours = (segment.end - segment.start) / 3600000;
        try {
          const key = 'controls-only:' + segment.key;
          if (!predictions.has(key)) predictions.set(key, client.predictRecorded(segment.settings, { signal: controller.signal }));
          const data = await predictions.get(key);
          const kwh = data.kwh * hours; // Static one-hour rate approximation, never a measured interval label.
          job.kwh = (job.kwh ?? 0) + kwh;
          job.estimatedHours += hours;
          job.estimatedSegments.push({ start: segment.start, end: segment.end, kwh });
          if (recordedColumns) {
            job.referenceMin = (job.referenceMin || 0) + data.reference_range_kwh.min * hours;
            job.referenceMax = (job.referenceMax || 0) + data.reference_range_kwh.max * hours;
          }
        } catch (error) {
          if (error.name === 'AbortError') return;
          job.missingHours += hours;
          job.reason ||= error.message;
        }
      }
      if (!segments.length) job.reason ||= 'Complete controls are not recorded for the confirmed intervals.';
    }
  }));
  if (sessionId !== currentPredictionSession || controller.signal.aborted) return;
  result.nodes = jobs.filter(job => job.period === 0);
  result.forecast = result.nodes.some(job => job.projection && Number.isFinite(job.kwh));
  result.forecastPartial = result.nodes.filter(job => Number.isFinite(job.kwh) && !job.missingHours).length < total;
  result.missingEstimates = result.nodes.filter(job => job.kwh === null || job.missingHours > 0).length;
  const estimates = result.nodes.filter(job => Number.isFinite(job.kwh));
  result.kwh = estimates.length ? estimates.reduce((sum, job) => sum + job.kwh, 0) : null;
  if (recordedColumns && estimates.length) result.referenceRange = {
    min: estimates.reduce((sum, job) => sum + (job.referenceMin ?? job.kwh), 0),
    max: estimates.reduce((sum, job) => sum + (job.referenceMax ?? job.kwh), 0)
  };
  result.estimatedHours = estimates.reduce((sum, job) => sum + job.estimatedHours, 0);
  result.reason = result.nodes.find(job => job.reason)?.reason || null;
  const prior = jobs.filter(job => job.period === 1), priorCoverage = getAnalyticsCoverage(periods[1], total);
  const priorKnown = prior.filter(job => Number.isFinite(job.kwh));
  const priorKwh = priorKnown.length ? priorKnown.reduce((sum, job) => sum + job.kwh, 0) : null;
  const priorOperating = result.forecast ? getForecastOperatingMetrics({ nodes: prior, coverage: priorCoverage }) : null;
  result.previous = { nodes: prior, kwh: priorKwh,
    cost: Number.isFinite(priorKwh) ? calculateEnergyCost(priorKwh) : null,
    runtime: result.forecast ? (priorOperating?.runtimeHrs ?? null)
      : priorCoverage.confirmedSamples ? calculateRuntimeFromLogs(periods[1]).runtimeHrs : null,
    complete: priorKnown.length === total && priorKnown.length > 0 && priorKnown.every(job => !job.missingHours) &&
      (result.forecast || (priorCoverage.unknownUnits === 0 && priorCoverage.unknownSamples === 0))
  };
  if (!result.previous.complete) { result.previous.kwh = null; result.previous.cost = null; }
  renderEnergyAnalytics(result);
}

function getAnalyticsChartSeries(nodes, period) {
  const size = { daily: 9, weekly: 7, monthly: 4, yearly: 12 }[period] || 9;
  const series = new Array(size).fill(null);
  const bucket = log => {
    const date = new Date(log.timestamp ?? log.created);
    if (period === 'yearly') return date.getMonth();
    if (period === 'monthly') return Math.min(3, Math.floor((date.getDate() - 1) / 7));
    if (period === 'weekly') return (date.getDay() + 6) % 7;
    const hour = date.getHours() + date.getMinutes() / 60;
    return [1.5, 4.5, 7.5, 10.5, 13.5, 16.5, 19.5, 22.5, 24.1].findIndex(cutoff => hour < cutoff);
  };
  (nodes || []).forEach(node => {
    if (!Number.isFinite(node.kwh)) return;
    if (node.estimatedSegments?.length) {
      for (const segment of node.estimatedSegments) {
        let start = segment.start;
        while (start < segment.end) {
          const boundary = new Date(start), index = bucket({ timestamp: boundary });
          if (period === 'yearly') { boundary.setMonth(boundary.getMonth() + 1, 1); boundary.setHours(0, 0, 0, 0); }
          else if (period === 'monthly') {
            if (index < 3) boundary.setDate((index + 1) * 7 + 1);
            else boundary.setMonth(boundary.getMonth() + 1, 1);
            boundary.setHours(0, 0, 0, 0);
          } else if (period === 'weekly') { boundary.setDate(boundary.getDate() + 1); boundary.setHours(0, 0, 0, 0); }
          else boundary.setHours(0, [90, 270, 450, 630, 810, 990, 1170, 1350, 1440][index], 0, 0);
          const finish = Math.min(segment.end, boundary.getTime());
          if (finish <= start) break;
          const energy = segment.kwh * (finish - start) / (segment.end - segment.start);
          series[index] = (series[index] ?? 0) + energy;
          start = finish;
        }
      }
      return;
    }
    const groups = Array.from({ length: size }, () => []);
    getAnalyticsReadings(node.logs).forEach(log => { if (typeof getConfirmedAcOnState(log) === 'boolean') groups[bucket(log)].push(log); });
    const metrics = node.projection ? { confirmedSegments: node.projection.segments, totalRuntimeSum: node.projection.hoursUsed } : calculateRuntimeFromLogs(node.logs);
    const weights = new Array(size).fill(0);
    for (const segment of metrics.confirmedSegments || []) {
      let [start, end] = segment;
      while (start < end) {
        const date = new Date(start), boundary = new Date(start);
        const index = bucket({ timestamp: date });
        if (period === 'yearly') { boundary.setMonth(boundary.getMonth() + 1, 1); boundary.setHours(0, 0, 0, 0); }
        else if (period === 'monthly') {
          if (index < 3) boundary.setDate((index + 1) * 7 + 1);
          else boundary.setMonth(boundary.getMonth() + 1, 1);
          boundary.setHours(0, 0, 0, 0);
        } else if (period === 'weekly') { boundary.setDate(boundary.getDate() + 1); boundary.setHours(0, 0, 0, 0); }
        else { const minutes = [90, 270, 450, 630, 810, 990, 1170, 1350, 1440][index]; boundary.setHours(0, minutes, 0, 0); }
        const finish = Math.min(end, boundary.getTime());
        if (finish <= start) break;
        weights[index] += (finish - start) / 3600000;
        start = finish;
      }
    }
    const hours = metrics.totalRuntimeSum;
    groups.forEach((logs, index) => {
      if ((!node.projection && !logs.length && weights[index] === 0) || (node.kwh > 0 && !hours)) return;
      const value = hours > 0 ? node.kwh * weights[index] / hours : 0;
      series[index] = (series[index] ?? 0) + value;
    });
  });
  return series;
}




// Convert 24-hour HH:MM time string to 12-Hour Clock (numbers 1-12 with AM/PM)
function formatTime12Hour(timeStr) {
  if (!timeStr) return '';
  const parts = timeStr.split(':');
  if (parts.length < 2) return timeStr;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h)) return timeStr;
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  const mStr = isNaN(m) ? '00' : String(m).padStart(2, '0');
  return `${h12}:${mStr} ${period}`;
}

// Get date range text (including active time filters formatted in 12-Hour Clock)
function getDateRangeText() {
  const baseLabel = getPeriodDateLabel(selectedDateKey || getDefaultDateKey(), currentPeriod);
  if (startTimeFilter && endTimeFilter) {
    return `${baseLabel} (${formatTime12Hour(startTimeFilter)} - ${formatTime12Hour(endTimeFilter)})`;
  } else if (startTimeFilter) {
    return `${baseLabel} (From ${formatTime12Hour(startTimeFilter)})`;
  } else if (endTimeFilter) {
    return `${baseLabel} (Until ${formatTime12Hour(endTimeFilter)})`;
  }
  return baseLabel;
}

// Update active filter badge in header
function updateActiveFilterBadge(filteredCount) {
  const badgeEl = document.getElementById('activeFilterText');
  if (!badgeEl) return;

  const controlLabel = currentNodeFilter ? (controlNameMap[currentNodeFilter] || currentNodeFilter) : 'All Controls';
  const dateLabel = getDateRangeText();
  const countStr = typeof filteredCount === 'number' ? ` • ${filteredCount} logs` : '';
  badgeEl.textContent = `${controlLabel} • ${dateLabel}${countStr}`;
}

// Render the page
function render({ preserveScroll = false } = {}) {
  globalThis.EcoTrackFutureCost?.notify();
  populateDateRangeOptions();
  
  const history = getFilteredLogs();
  const filtered = history.filter(log => getAnalyticsRecordingPower(log) === true);
  const stats = calculateStats();

  updateActiveFilterBadge(filtered.length);
  
  console.log('Filtered logs:', filtered.length, 'from total:', nodeDataLogs.length);
  
  // Update title
  const titleMap = {
    daily: 'Daily Logs',
    weekly: 'Weekly Logs',
    monthly: 'Monthly Logs',
    yearly: 'Yearly Logs'
  };
  document.getElementById('logsTitle').textContent = titleMap[currentPeriod];

  // Update statistics
  document.getElementById('totalRecords').textContent = filtered.length;
  document.getElementById('avgTemp').textContent = stats.avgTemp === '--' ? '--°C' : `${stats.avgTemp}°C`;
  document.getElementById('avgPressure').textContent = stats.onlineNodes || '--';
  
  // Predict energy consumption (also updates estimated bill card)
  predictEnergyConsumption(stats, history);
  
  // Render table rows
  const tbody = document.getElementById('logsTableBody');
  if (tbody) {
    const scrollContainer = tbody.closest('.overflow-y-auto');
    if (scrollContainer && currentPage === 1 && !preserveScroll) scrollContainer.scrollTop = 0;
  }
  
  if (filtered.length === 0) {
    currentPage = 1;
    const pageInfo = document.getElementById('pageInfo');
    if (pageInfo) pageInfo.textContent = 'Showing 0 of 0 logs';
    const prevPageBtn = document.getElementById('prevPageBtn');
    const nextPageBtn = document.getElementById('nextPageBtn');
    if (prevPageBtn) prevPageBtn.disabled = true;
    if (nextPageBtn) nextPageBtn.disabled = true;

    tbody.innerHTML = `
      <tr>
        <td colspan="13" class="px-6 py-12 text-center">
          <div class="flex flex-col items-center justify-center max-w-md mx-auto">
            <div class="w-14 h-14 rounded-2xl bg-teal-500/10 dark:bg-teal-500/15 text-teal-600 dark:text-teal-400 border border-teal-500/30 flex items-center justify-center mb-3 shadow-xs">
              <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
              </svg>
            </div>
            <h4 class="font-bold text-sm text-slate-800 dark:text-gray-200 mb-1">No AC Operating Logs for This Interval</h4>
            <p class="text-xs text-slate-500 dark:text-gray-400 mb-4 leading-relaxed">
              No AC operating readings match these filters. Readings are recorded while the AC power setting is ON.
            </p>
            <div class="flex items-center gap-2">
              <button type="button" onclick="const todayBtn = document.getElementById('filterTodayBtn'); if (todayBtn) todayBtn.click(); else if (typeof applyFilters === 'function') applyFilters();" class="px-3.5 py-1.5 rounded-xl bg-teal-500/15 hover:bg-teal-500/25 text-teal-600 dark:text-teal-400 border border-teal-500/30 text-xs font-bold transition-all cursor-pointer">
                Jump to Today's Logs
              </button>
              <button type="button" onclick="const resetBtn = document.getElementById('resetFiltersBtn'); if (resetBtn) resetBtn.click();" class="px-3.5 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-white/5 dark:hover:bg-white/10 text-slate-700 dark:text-gray-300 border border-slate-200 dark:border-white/10 text-xs font-bold transition-all cursor-pointer">
                Clear Filters
              </button>
            </div>
          </div>
        </td>
      </tr>
    `;
    return;
  }
  
  // Pagination
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE) || 1;
  if (currentPage > totalPages) currentPage = totalPages;
  
  const startIndex = (currentPage - 1) * PAGE_SIZE;
  const paginatedLogs = filtered.slice(startIndex, startIndex + PAGE_SIZE);

  // Update page info
  const pageInfo = document.getElementById('pageInfo');
  if (pageInfo) {
    pageInfo.textContent = `Showing ${filtered.length === 0 ? 0 : startIndex + 1}-${Math.min(startIndex + PAGE_SIZE, filtered.length)} of ${filtered.length}`;
  }
  
  // Enable/Disable buttons
  const prevPageBtn = document.getElementById('prevPageBtn');
  const nextPageBtn = document.getElementById('nextPageBtn');
  if (prevPageBtn) prevPageBtn.disabled = currentPage === 1;
  if (nextPageBtn) nextPageBtn.disabled = currentPage >= totalPages;

  // Use DocumentFragment to batch DOM operations for better performance
  const fragment = document.createDocumentFragment();
  
  paginatedLogs.forEach(log => {
    const row = document.createElement('tr');
    row.className = 'hover:bg-gray-50 dark:hover:bg-slate-900 transition-colors text-sm text-gray-700 dark:text-gray-300 font-medium';
    
    const timestampStr = log.timestamp.toLocaleString('en-US', {
      month: '2-digit',
      day: '2-digit',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    });
    
    const { roomName, floorName, buildingName } = resolveLogLocation(log);
    const controlName = log.controlName || controlNameMap[log.nodeId] || log.nodeId;
    
    const acType = log.airconType || globalAirconMap[log.nodeId] || 'Unknown';
    
    const targetTemperature = getRecordedClimateSettings(log)?.temperature;
    const climateModes = getRecordedClimateModes(log);
    const modeClass = climateModes.mode === 'Unavailable' ? 'text-slate-400 dark:text-slate-500' : 'text-[#10b981] dark:text-emerald-400';
    const fanClass = climateModes.fan === 'Unavailable' ? 'text-slate-400 dark:text-slate-500' : 'text-[#18392B] dark:text-cyan-400';
    
    const isOnline = String(log.status).toLowerCase() === 'online';
    const statusText = log.eventType === 'schedule_updated' ? `Interval set: ${log.intervalSeconds}s` : isOnline ? 'Online' : 'Offline';
    const statusClass = isOnline ? 'text-green-600 dark:text-emerald-400 font-bold' : 'text-red-500 dark:text-rose-400 font-bold';
    
    // Convert battery voltage to percentage matching Telemetry (4.2V = 100%)
    const batteryPercent = getBatteryPercentage(log.battery);
    
    row.innerHTML = `
      <td class="px-6 py-4">${timestampStr}</td>
      <td class="px-6 py-4 font-bold text-[#18392B] dark:text-cyan-400">${controlName}</td>
      <td class="px-6 py-4 font-bold text-[#10b981] dark:text-emerald-400">${buildingName}</td>
      <td class="px-6 py-4 font-bold text-[#10b981] dark:text-emerald-400">${floorName}</td>
      <td class="px-6 py-4 font-bold text-[#10b981] dark:text-emerald-400">${roomName}</td>
      <td class="px-6 py-4 font-bold text-[#18392B] dark:text-cyan-400 whitespace-nowrap">${acType}</td>
      <td class="px-6 py-4 whitespace-nowrap">${Number.isFinite(targetTemperature) ? `${targetTemperature}°C` : 'Unavailable'}</td>
      <td class="px-6 py-4 font-bold ${modeClass} whitespace-nowrap">${climateModes.mode}</td>
      <td class="px-6 py-4 font-bold ${fanClass} whitespace-nowrap">${climateModes.fan}</td>
      <td class="px-6 py-4 text-xs leading-relaxed min-w-[16rem] max-w-xs">${getRecordedSpecialFunctions(log)}</td>
      <td class="px-6 py-4">
        <span class="font-bold text-[#18392B] dark:text-cyan-400">${batteryPercent}%</span>
      </td>
      <td class="px-6 py-4">
        ${getSignalIcon(log.rssi)}
      </td>
      <td class="px-6 py-4 ${statusClass}">${statusText}</td>
    `;
    
    fragment.appendChild(row);
  });
  
  tbody.replaceChildren(fragment);
}
// Shared snapshot: export the selected readings, including schedule forecasts.
function reportNumber(value) {
  return value === null || value === undefined || value === '' || typeof value === 'boolean'
    ? null : Number.isFinite(Number(value)) ? Number(value) : null;
}

function reportText(value, fallback = 'Unavailable') {
  return value === null || value === undefined || String(value).trim() === '' ? fallback : String(value);
}

function reportFormat(value, decimals = 2) {
  return Number.isFinite(value) ? value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : 'Unavailable';
}

// Excel dates have no timezone. Store the displayed local wall-clock time.
function reportExcelDate(date) {
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()));
}

function buildLogsReportSnapshot() {
  const prediction = getEnergyPredictionForExport();
  const rate = getActiveTariffRate();
  const settings = new Map();
  const rows = getFilteredLogs().map(log => {
    const modes = getRecordedClimateModes(log);
    const special = getRecordedSpecialFunctions(log);
    if (!settings.has(special)) settings.set(special, `S${String(settings.size + 1).padStart(2, '0')}`);
    let snapshot = log.controlSnapshot ?? log.control_snapshot;
    if (typeof snapshot === 'string') { try { snapshot = JSON.parse(snapshot); } catch (_) { snapshot = null; } }
    const location = resolveLogLocation(log);
    const battery = reportNumber(log.battery);
    return {
      id: getAnalyticsNodeId(log), timestamp: new Date(log.timestamp ?? log.created),
      name: reportText(log.controlName || controlNameMap[log.nodeId] || log.nodeId),
      building: location.buildingName,
      floor: location.floorName,
      room: location.roomName,
      type: reportText(log.airconType || globalAirconMap[log.nodeId]),
      mode: modes.mode, fan: modes.fan, special, settingsId: settings.get(special),
      setpoint: reportNumber(getRecordedClimateSettings(log)?.temperature),
      temperature: reportNumber(log.temperature), battery: battery === null ? null : getBatteryPercentage(battery),
      rssi: reportNumber(log.rssi), status: reportText(log.status, 'Unknown'),
      power: getConfirmedAcOnState(log), synthetic: snapshot?.test_fixture?.synthetic === true,
      registered: reportText(globalInstallDateMap[log.nodeId])
    };
  }).sort((a, b) => a.timestamp - b.timestamp || a.name.localeCompare(b.name));
  const groups = new Map();
  rows.forEach(row => {
    if (!groups.has(row.id)) groups.set(row.id, []);
    groups.get(row.id).push(row);
  });
  const controllers = [...groups].map(([id, readings]) => {
    const latest = readings[readings.length - 1];
    const job = prediction?.nodes?.find(node => node.id === id);
    return { ...latest, count: readings.length, kwh: reportNumber(job?.kwh),
      cost: calculateEnergyCost(job?.kwh, rate), hours: reportNumber(job?.estimatedHours),
      basis: job?.projection ? 'Saved schedule' : job && Number.isFinite(job.kwh) ? 'Recorded runtime' : 'Unavailable',
      reason: job?.reason || null };
  });
  const runtime = prediction?.forecast ? getForecastOperatingMetrics(prediction) : prediction?.runtime;
  const hasRuntime = prediction?.forecast ? runtime?.knownUnits > 0
    : prediction?.coverage?.confirmedSamples > 0 && !(runtime?.missingCadenceSamples > 0 && !runtime?.totalRuntimeSum);
  const labels = { daily: ['12 AM', '3 AM', '6 AM', '9 AM', '12 PM', '3 PM', '6 PM', '9 PM', '12 M'],
    weekly: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    monthly: ['Week 1', 'Week 2', 'Week 3', 'Week 4'], yearly: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] }[currentPeriod] || [];
  const series = getAnalyticsChartSeries(prediction?.nodes, currentPeriod);
  const comparable = prediction && !prediction.forecast && prediction.previous?.complete &&
    !prediction.missingEstimates && !prediction.coverage?.unknownUnits && !prediction.coverage?.unknownSamples;
  const notes = [];
  const synthetic = rows.some(row => row.synthetic);
  if (synthetic) notes.push('TEST DATA: synthetic records for demonstration. These are not physical meter readings.');
  notes.push(prediction?.recordedColumns ? 'Prediction uses each recorded Target Temperature, Operating Mode, Blower Fan Mode, Special Functions and its timestamp/cadence. Only the nine AC controls are model inputs. Unrecorded function flags are averaged over supported control variants; indoor/outdoor temperature and humidity are excluded.'
    : prediction?.forecast ? 'Forecast uses recorded AC control intervals. Physical AC power is unconfirmed.'
    : 'Energy is a research estimate from recorded controls and confirmed operating intervals; it is not metered consumption.');
  if (prediction?.recordedColumns) {
    notes.push('Predictions use Histogram Gradient Boosting trained on AC controls only. Missing function flags remain unrecorded. Physical AC power remains unconfirmed where feedback is missing.');
    if (prediction.referenceRange) notes.push(`Reference envelope: ${prediction.referenceRange.min} to ${prediction.referenceRange.max} kWh; not a statistical confidence interval.`);
  }
  notes.push('Model: controls-only Histogram Gradient Boosting, Haier reference. Inputs: target temperature, operating mode, fan mode and special functions. Timestamps scale one-hour estimates over the selected intervals. Physical accuracy is unverified.');
  const unknown = rows.filter(row => typeof row.power !== 'boolean').length;
  if (unknown) notes.push(`${unknown} of ${rows.length} readings have unknown physical AC power. No on/off state has been inferred from IR commands or connectivity.`);
  if (!Number.isFinite(prediction?.kwh)) notes.push('Energy unavailable: ' + (prediction?.reason || 'No matching completed estimate. Recorded target temperature, operating mode and fan mode are required.'));
  if (prediction?.missingEstimates || prediction?.forecastPartial) notes.push('Partial estimate: one or more controllers or intervals could not be estimated. See controller coverage below.');
  if (!Number.isFinite(rate)) notes.push('Cost unavailable: configure an electricity tariff in the existing tariff dialog.');
  if (!comparable) notes.push('Previous-period comparison unavailable: comparable complete recorded operating data is not available for this selection.');
  return { rows, controllers, settings: [...settings].map(([text, id]) => ({ id, text })),
    prediction, synthetic, rate, provider: getUtilityProvider(), kwh: reportNumber(prediction?.kwh),
    cost: calculateEnergyCost(prediction?.kwh, rate), runtime: hasRuntime ? reportNumber(runtime.runtimeHrs) : null,
    unitHours: reportNumber(prediction?.estimatedHours), unknown, notes,
    previous: comparable ? reportNumber(prediction.previous.kwh) : null,
    intervals: labels.map((label, i) => ({ label, kwh: reportNumber(series[i]), cost: calculateEnergyCost(series[i], rate) })),
    period: currentPeriod, date: getDateRangeText(), scope: currentNodeFilter ? (controlNameMap[currentNodeFilter] || currentNodeFilter) : 'All Controls',
    time: startTimeFilter || endTimeFilter ? `${startTimeFilter || '00:00'} to ${endTimeFilter || '23:59'}` : 'All times',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local time', generated: new Date()
  };
}

async function prepareLogsReport({ allowEmpty = false } = {}) {
  const key = getEnergySelectionKey();
  const deadline = Date.now() + 15000;
  while (energyPredictionPending && getEnergySelectionKey() === key && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (getEnergySelectionKey() !== key || energyPredictionPending) throw Error('The selection is updating. Wait for the estimate to finish, then export again.');
  const report = buildLogsReportSnapshot();
  if (!report.rows.length && !allowEmpty) throw Error('No readings match the selected filters. Choose a date or control with saved logs.');
  if (getEnergySelectionKey() !== key || energyPredictionPending) throw Error('The selection is updating. Wait for the estimate to finish, then export again.');
  return report;
}

function showReportError(error) {
  console.error('Report export failed:', error);
  if (window.EcoToast) window.EcoToast.error(error.message || 'Could not create the report.');
  else alert(error.message || 'Could not create the report.');
}

// Read-only supplemental PDF data. Kept separate from Excel preparation.
function pdfTargetTemperature(value) {
  return Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 2 }) : 'Not recorded';
}

function pdfNumericSummary(rows, field) {
  const values = rows.map(row => row[field]).filter(Number.isFinite);
  return { count: values.length, mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
    min: values.length ? values.reduce((a,b)=>Math.min(a,b)) : null, max: values.length ? values.reduce((a,b)=>Math.max(a,b)) : null };
}

function pdfNotificationTime(record) {
  for (const value of [record.created, record.created_at, record.timestamp]) {
    if (!value) continue;
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(record.date || '')) || !record.time) return null;
  const date = new Date(`${record.date} ${record.time}`);
  return Number.isFinite(date.getTime()) ? date : null;
}

function pdfNotificationContent(record) {
  const text = String(record.content || record.message || record.title || '').replace(/^__INBOX_DISMISSED__\|\|\|/, '');
  const parts = text.split('|||');
  return parts.length > 1 ? { target: parts.shift().trim(), text: parts.join('|||').trim() } : { target: null, text };
}

function pdfIsViolation(record) {
  if (!record || record.triggered === false || record.triggered === 0) return false;
  const type = String(record.type || record.category || '').toLowerCase();
  if (['controller_installation', 'schedule', 'wake', 'sleep', 'system'].includes(type) ||
      /maintenance|verification|battery/.test(type) || record.is_schedule) return false;
  const text = pdfNotificationContent(record).text.toLowerCase();
  if (/\b(battery|wake|sleep|schedule|scheduled|scheduler|interval|cycle|routine|maintenance|verification)\b/.test(text)) return false;
  if (record.rule_id) return true;
  return Boolean(record.triggered) && /temperature|\btemp\b|threshold|breach|went above|went below|condition:/.test(text);
}

function pdfReportScope() {
  const key = selectedDateKey || getDefaultDateKey();
  const parts = key.split('-').map(Number);
  const start = new Date(parts[0], (parts[1] || 1) - 1, parts[2] || 1), end = new Date(start);
  if (currentPeriod === 'yearly') end.setFullYear(end.getFullYear() + 1);
  else if (currentPeriod === 'monthly') end.setMonth(end.getMonth() + 1);
  else end.setDate(end.getDate() + (currentPeriod === 'weekly' ? 7 : 1));
  return { start, end, control: currentNodeFilter, startTime: startTimeFilter, endTime: endTimeFilter };
}

function pdfTimeMatches(date, scope) {
  if (!date || date < scope.start || date >= scope.end) return false;
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (scope.startTime && scope.endTime && scope.startTime > scope.endTime) return time >= scope.startTime || time <= scope.endTime;
  return (!scope.startTime || time >= scope.startTime) && (!scope.endTime || time <= scope.endTime);
}

async function pdfReadNotifications() {
  const bounded = async promise => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Notification read timed out')), 8000); })]); }
    finally { clearTimeout(timer); }
  };
  let records = null, source = 'Notification service', state = 'unavailable';
  if (window.electron?.invoke) {
    try {
      const result = await bounded(window.electron.invoke('notifications-fetch-all'));
      if (result?.success && Array.isArray(result.data)) { records = result.data; source = 'Desktop notifications'; }
    } catch (_) { /* Continue through the existing authenticated browser client. */ }
  }
  const client = window.supabaseClient || window.sb || (typeof sb !== 'undefined' ? sb : null);
  if (records === null && client?.from) {
    try {
      const result = await bounded(client.from('notifications').select('*').order('created', { ascending: false }));
      if (!result.error && Array.isArray(result.data)) { records = result.data; source = 'Supabase notifications'; }
    } catch (_) { /* Unavailable is reported explicitly, never as zero violations. */ }
  }
  if (records !== null) state = records.length >= 1000 ? 'partial' : 'loaded';
  const audit = [];
  let auditUnreadable = false;
  for (const key of ['ecoTrack_violation_audit_history', 'ecoTrack_violationAuditHistory']) {
    try {
      const values = JSON.parse(localStorage.getItem(key) || '[]');
      if (Array.isArray(values)) audit.push(...values);
      else auditUnreadable = true;
    } catch (_) { auditUnreadable = true; }
  }
  if (state === 'loaded' && auditUnreadable) state = 'partial';
  return { records: records || [], audit, source, state, auditUnreadable };
}

function buildPdfSupplement(report, loaded, scope) {
  const nodes = typeof globalNodeRecords !== 'undefined' ? globalNodeRecords : [];
  const normalize = value => String(value || '').trim().toLowerCase();
  const aliases = new Map(), roomLocations = new Map();
  nodes.forEach(node => {
    const location = locationMap[node.id] || locationMap[node.name] || {};
    if (node.room_id) roomLocations.set(String(node.room_id), location);
    for (const key of [node.id, node.name, node.node_id, node.db_id]) if (key) aliases.set(normalize(key), { ...location, ...node, name: node.name || node.id });
  });
  const aggregation = report.controllers.map(controller => {
    const readings = report.rows.filter(row => row.id === controller.id);
    const node = aliases.get(normalize(controller.id)) || aliases.get(normalize(controller.name)) || {};
    const result = { ...controller, readings, first: readings[0], last: readings[readings.length - 1],
      targetStats: pdfNumericSummary(readings, 'setpoint'),
      temperatureStats: pdfNumericSummary(readings, 'temperature'), batteryStats: pdfNumericSummary(readings, 'battery'),
      rssiStats: pdfNumericSummary(readings, 'rssi'), on: readings.filter(row => row.power === true).length,
      off: readings.filter(row => row.power === false).length, unknown: readings.filter(row => typeof row.power !== 'boolean').length,
      registeredAt: node.created || null, roomId: node.room_id || null };
    for (const key of [controller.id, controller.name]) aliases.set(normalize(key), { ...node, ...controller });
    return result;
  });
  const selectedAliases = new Set(aggregation.flatMap(row => [row.id, row.name]).map(normalize));
  if (scope.control) {
    const selected = aliases.get(normalize(scope.control));
    for (const key of [scope.control, selected?.id, selected?.name, selected?.node_id, selected?.db_id]) if (key) selectedAliases.add(normalize(key));
  }
  const selectedRooms = new Set(aggregation.map(row => row.roomId).filter(Boolean).map(String));
  const violationRows = [], installations = [], ids = new Set(), signatures = new Set();
  let invalidTimes = 0;
  const records = loaded.records.map(record => ({ record, audit: false })).concat(loaded.audit.map(record => ({ record, audit: true })));
  for (const { record, audit } of records) {
    if (!record || typeof record !== 'object') continue;
    const content = pdfNotificationContent(record);
    const date = record.type === 'controller_installation' ? new Date(record.installation?.installed_at || '') : pdfNotificationTime(record);
    if (!date || !Number.isFinite(date.getTime())) { invalidTimes++; continue; }
    if (!pdfTimeMatches(date, scope)) continue;
    const targets = [record.node_id, record.node, record.control, content.target, record.installation?.node_id, record.installation?.controller_name].filter(Boolean);
    const node = targets.map(target => aliases.get(normalize(target))).find(Boolean);
    const roomId = record.installation?.room_id || record.room_id || record.roomId || record.room;
    const matches = targets.some(target => selectedAliases.has(normalize(target))) ||
      (node && [node.id, node.name].some(key => selectedAliases.has(normalize(key)))) ||
      (!targets.length && roomId && selectedRooms.has(String(roomId)));
    if (scope.control && !matches) continue;
    const signature = JSON.stringify([content.text, Math.floor(date.getTime()/1000), roomId || '', record.rule_id || '', content.target || record.node_id || '']);
    if ((record.id && ids.has(String(record.id))) || (audit && signatures.has(signature))) continue;
    if (record.id) ids.add(String(record.id));
    signatures.add(signature);
    if (record.type === 'controller_installation') {
      const saved = record.installation;
      if (!saved || !saved.node_id || !saved.controller_name || !saved.room_id || (record.room_id && record.room_id !== saved.room_id)) continue;
      installations.push({ date, controller: saved.controller_name, installer: saved.installer_name || 'Unavailable',
        building: saved.building_name || 'Unavailable', floor: saved.floor_name || 'Unavailable', room: saved.room_name || 'Unavailable',
        type: saved.aircon_type || 'Unavailable', kind: saved.event_kind === 'reinstallation' ? 'Reinstallation' : 'Installation' });
      continue;
    }
    if (!pdfIsViolation(record)) continue;
    const location = node || roomLocations.get(String(roomId)) || {};
    violationRows.push({ date, controller: node?.name || content.target || record.node_id || (roomId ? 'Room-level alert' : 'Unavailable'),
      building: location.building || location.buildingName || 'Unavailable', floor: location.floor || location.floorName || 'Unavailable',
      room: location.room || location.roomName || 'Unavailable', rule: record.rule_name || record.rule_id || 'Environmental threshold',
      severity: record.severity || record.priority || 'Not recorded', details: content.text, dismissed: record.is_dismissed_from_inbox === true || String(record.content || '').startsWith('__INBOX_DISMISSED__|||') });
  }
  const rooms = new Map();
  report.controllers.forEach(controller => {
    const key = JSON.stringify([controller.building, controller.floor, controller.room]);
    if (!rooms.has(key)) rooms.set(key, { building: controller.building, floor: controller.floor, room: controller.room, kwh: null, missing: 0 });
    const room = rooms.get(key);
    if (Number.isFinite(controller.kwh)) room.kwh = (room.kwh ?? 0) + controller.kwh;
    if (!Number.isFinite(controller.kwh) || controller.reason) room.missing++;
  });
  const ranking = [...rooms.values()].sort((a,b) => (b.kwh ?? -1)-(a.kwh ?? -1));
  return { aggregation, violations: violationRows.sort((a,b)=>b.date-a.date), installations: installations.sort((a,b)=>b.date-a.date),
    ranking, notificationStatus: loaded.state === 'loaded' && invalidTimes ? 'partial' : loaded.state, notificationSource: loaded.source, invalidTimes,
    target: pdfNumericSummary(report.rows,'setpoint'),
    temperature: pdfNumericSummary(report.rows,'temperature'), battery: pdfNumericSummary(report.rows,'battery'), rssi: pdfNumericSummary(report.rows,'rssi') };
}

async function preparePdfSupplement(report) {
  const key = getEnergySelectionKey(), scope = pdfReportScope();
  const data = await pdfReadNotifications();
  if (getEnergySelectionKey() !== key || energyPredictionPending) throw Error('The selection changed while loading report details. Export again for the current filters.');
  return buildPdfSupplement(report, data, scope);
}

function renderPdfSupplement(doc, report, supplemental, layout) {
  const { table, paragraph, heading, stamp, money, safe, ink, muted, green, W, H, M, getY, setY } = layout;
  const section = (text, space = 35) => {
    if (getY() + space > H - 20) { doc.addPage(); setY(25); }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(...ink);
    doc.text(safe(text), M, getY()); setY(getY() + 8);
  };
  const hasSource = supplemental.notificationStatus === 'loaded';
  const sourceNote = supplemental.notificationStatus === 'unavailable'
    ? 'Notification data could not be loaded. Available saved audit entries are shown where present; an empty result does not establish that no violations occurred.'
    : supplemental.notificationStatus === 'partial'
      ? `Source: ${supplemental.notificationSource} and saved audit history. Coverage may be incomplete because of a source limit or unreadable timestamps/history.`
      : `Source: ${supplemental.notificationSource}, merged with saved audit history. Dismissed rule violations remain part of the audit.`;

  doc.addPage(); heading('Control Installation Directory');
  section('Control Location Details', 20);
  table(['Controller', 'Controller ID', 'Building', 'Floor', 'Room', 'AC type', 'Registration timestamp', 'Latest status'],
    supplemental.aggregation.map(row => [row.name, row.id, row.building, row.floor, row.room, row.type,
      row.registeredAt ? stamp(new Date(row.registeredAt)) : 'Unavailable', row.status]), { styles: { fontSize: 8, cellPadding: 2.5 } });
  paragraph('Registration timestamps come from the saved controller record. Verified installation history below uses the original event location, installer and completion time.', 8.5);
  section('Verified Installation History');
  if (supplemental.installations.length) {
    table(['Installed at', 'Event', 'Controller', 'Installed by', 'Building', 'Floor', 'Room', 'AC type'],
      supplemental.installations.map(row => [stamp(row.date), row.kind, row.controller, row.installer, row.building, row.floor, row.room, row.type]),
      { styles: { fontSize: 8, cellPadding: 2.5 } });
  } else paragraph(hasSource ? 'No verified installation events match the selected reporting period, control and time filters.' : 'Verified installation history is unavailable or incomplete for this report.');
  paragraph(sourceNote, 8.5);

  doc.addPage(); heading('Rule Violation Report');
  paragraph(`${report.date}. Control scope: ${report.scope}. Time filter: ${report.time}. Times use ${report.timezone}.`, 8.5);
  paragraph(sourceNote, 8.5);
  if (supplemental.violations.length) {
    table(['Recorded at', 'Controller', 'Location', 'Rule', 'Severity', 'Violation details', 'Inbox state'], supplemental.violations.map(row => [
      stamp(row.date), row.controller, `${row.building} / ${row.floor} / ${row.room}`, row.rule, row.severity,
      row.details, row.dismissed ? 'Dismissed; retained in audit' : 'Recorded'
    ]), { styles: { fontSize: 8, cellPadding: 2.5 }, columnStyles: { 0: { cellWidth: 30 }, 1: { cellWidth: 34 }, 2: { cellWidth: 42 }, 3: { cellWidth: 30 }, 4: { cellWidth: 20 }, 6: { cellWidth: 25 } } });
  } else paragraph(hasSource ? 'No rule violations recorded for the selected report filters.' : 'No matching violations could be established from the available sources.');
  paragraph('Battery alerts, routine schedules, maintenance requests and installation notices are not counted as room rule violations. Notification filtering uses the full selected period, including events outside the telemetry sample span.', 8.5);
  section('Energy Consumption Ranking', 70);
  paragraph('Room totals combine the matching controller estimates. Costs use the configured tariff and unrounded kWh; these are research estimates, not utility-meter readings.', 8.5);
  table(['Rank', 'Building', 'Floor', 'Room', 'Estimated energy (kWh)', 'Estimated cost (PHP)', 'Coverage'], supplemental.ranking.map((row,index) => [
    Number.isFinite(row.kwh) ? index + 1 : '-', row.building, row.floor, row.room, reportFormat(row.kwh,4),
    reportFormat(calculateEnergyCost(row.kwh,report.rate)), row.missing ? 'Partial / missing estimate' : 'Available estimate'
  ]));

  doc.addPage(); heading('AC Energy & Utility Cost Analytics');
  const drawIntervalSeries = (title, field, unit, color) => {
    section(title,70);
    const values=report.intervals.map(row=>row[field]), finite=values.filter(Number.isFinite);
    if(!finite.length) { paragraph(`${title} unavailable: the selection has no usable ${field==='cost'?'energy estimate and configured tariff':'model intervals'}.`); return; }
    const left=M+17, top=getY(), width=W-M*2-23, height=43, maximum=Math.max(...finite,0)*1.15 || 1;
    doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(...muted);
    for(let i=0;i<=4;i++) {
      const py=top+height-i*height/4;
      doc.setDrawColor(226,232,240); doc.setLineWidth(.2); doc.line(left,py,left+width,py);
      doc.text(reportFormat(maximum*i/4,1),left-3,py+1,{align:'right'});
    }
    let previous=null;
    values.forEach((value,index)=>{
      const px=left+index/Math.max(1,values.length-1)*width;
      doc.setTextColor(...muted); doc.text(safe(report.intervals[index].label),px,top+height+6,{align:'center'});
      if(!Number.isFinite(value)) { previous=null; return; }
      const point=[px,top+height-value/maximum*height];
      doc.setDrawColor(...color); doc.setFillColor(...color); doc.setLineWidth(.8);
      if(previous) doc.line(previous[0],previous[1],point[0],point[1]);
      doc.circle(point[0],point[1],1,'F'); previous=point;
    });
    doc.setTextColor(...muted); doc.text(unit,M,top+2); setY(top+height+15);
  };
  drawIntervalSeries('Estimated Energy Profile','kwh','kWh',green);
  drawIntervalSeries('Estimated Electricity Cost Profile','cost','PHP',[217,119,6]);
  paragraph('Missing intervals remain gaps. Cost equals estimated energy multiplied by the selected tariff; no previous-period baseline is invented.',8.5);

  doc.addPage(); heading('Initial & Final Control Readings');
  const boundaries = supplemental.aggregation.flatMap(controller => [['First',controller.first],['Last',controller.last]].map(([label,row]) => [
    row.name, label, stamp(row.timestamp), `${row.building} / ${row.floor} / ${row.room}`,
    pdfTargetTemperature(row.setpoint), row.mode, row.fan,
    Number.isFinite(row.battery) ? reportFormat(row.battery,0) : 'Not recorded', reportFormat(row.rssi,0),
    row.power === true ? 'Confirmed ON' : row.power === false ? 'Confirmed OFF' : 'Unknown'
  ]));
  table(['Controller', 'Reading', 'Timestamp', 'Location', 'Target Temperature (C)', 'Operating Mode', 'Blower Fan Mode', 'Battery (%)', 'RSSI (dBm)', 'Physical power'], boundaries,
    { styles: { fontSize: 8, cellPadding: 2.5 }, columnStyles: { 0: { cellWidth: 35 }, 2: { cellWidth: 31 }, 3: { cellWidth: 46 } } });
  paragraph('First/last readings are selected per controller. Targets come from each saved reading, independently of room-sensor measurements and current settings.', 8.5);
  section('Control Aggregation Summary', 45);
  table(['Controller', 'Readings', 'Valid targets', 'Mean target (C)', 'Min target (C)', 'Max target (C)', 'Confirmed ON', 'Confirmed OFF', 'Unknown power'], supplemental.aggregation.map(row => [
    row.name, row.count, row.targetStats.count, pdfTargetTemperature(row.targetStats.mean),
    pdfTargetTemperature(row.targetStats.min), pdfTargetTemperature(row.targetStats.max), row.on, row.off, row.unknown
  ]));
  paragraph('Power counts are feedback samples, not continuous runtime. Commands, schedules and connectivity do not establish physical AC power.', 8.5);

  doc.addPage(); heading('Visual Analytics - Energy Profiles & Status');
  section('Recorded AC Target Temperature Trend', 85);
  const temperatureRows = report.rows.filter(row => Number.isFinite(row.setpoint));
  if (!temperatureRows.length) paragraph('Target temperature trend unavailable: the selected readings contain no recorded AC targets.');
  else {
    const top=getY()+2, left=M+13, width=W-M*2-20, height=55;
    const start=report.rows.reduce((value,row)=>Math.min(value,row.timestamp.getTime()),Infinity), end=report.rows.reduce((value,row)=>Math.max(value,row.timestamp.getTime()),-Infinity);
    const low=Math.floor(supplemental.target.min)-1, high=Math.ceil(supplemental.target.max)+1;
    doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(...muted);
    for(let i=0;i<=4;i++) {
      const py=top+height-i*height/4;
      doc.setDrawColor(226,232,240); doc.setLineWidth(.2); doc.line(left,py,left+width,py);
      doc.text(reportFormat(low+(high-low)*i/4,1),left-3,py+1,{align:'right'});
    }
    const colors=[green,[37,99,235],[217,119,6],[147,51,234],[190,24,93],[71,85,105]];
    supplemental.aggregation.slice(0,6).forEach((controller,index)=>{
      let previous=null;
      doc.setDrawColor(...colors[index]); doc.setFillColor(...colors[index]); doc.setLineWidth(.6);
      for(const row of controller.readings) {
        if(!Number.isFinite(row.setpoint)) { previous=null; continue; }
        const point=[left+(row.timestamp.getTime()-start)/Math.max(1,end-start)*width,top+height-(row.setpoint-low)/(high-low)*height];
        if(previous) doc.line(previous[0],previous[1],point[0],point[1]);
        doc.circle(point[0],point[1],.5,'F'); previous=point;
      }
      const lx=M+(index%3)*(W-M*2)/3, ly=top+height+15+Math.floor(index/3)*8;
      doc.setFillColor(...colors[index]); doc.rect(lx,ly-2,3,2,'F');
      doc.setTextColor(...ink); doc.text(doc.splitTextToSize(safe(controller.name),76).slice(0,1),lx+5,ly);
    });
    doc.setTextColor(...muted); doc.text(stamp(new Date(start)),left,top+height+6);
    doc.text(stamp(new Date(end)),left+width,top+height+6,{align:'right'});
    setY(top+height+33);
    if(supplemental.aggregation.length>6) paragraph('Trend shows the first six controllers; every controller remains in the aggregation summary. Use Export Excel for individual telemetry records.',8.5);
  }
  section('Recorded Power and Controller Availability', 55);
  const feedback=[['Confirmed ON readings',report.rows.filter(row=>row.power===true).length],['Confirmed OFF readings',report.rows.filter(row=>row.power===false).length],['Unknown power readings',report.unknown]];
  const statusCounts=new Map(); report.controllers.forEach(row=>statusCounts.set(row.status,(statusCounts.get(row.status)||0)+1));
  const panelTop=getY(), panelWidth=(W-M*2-12)/2;
  const drawCounts=(entries,x,title)=>{
    const max=Math.max(...entries.map(entry=>entry[1]),1);
    doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.setTextColor(...ink); doc.text(title,x,panelTop);
    entries.slice(0,3).forEach(([label,count],index)=>{
      const py=panelTop+8+index*9;
      doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.text(safe(label),x,py+2);
      doc.setFillColor(...green); doc.rect(x+48,py-2,(panelWidth-63)*count/max,4,'F');
      doc.text(String(count),x+panelWidth,py+2,{align:'right'});
    });
  };
  drawCounts(feedback,M,'Physical-power readings');
  drawCounts([...statusCounts],M+panelWidth+12,'Latest controller connectivity');
  setY(panelTop+39);
  if(statusCounts.size>3) table(['Additional connectivity status','Controllers'],[...statusCounts].slice(3));
  paragraph('Latest connectivity status is taken from each controller\'s final selected record. Offline readings are not automatically treated as incidents, violations or AC-OFF feedback.',8.5);

  doc.addPage(); heading('Thermal Telemetry & Predictive Analytics');
  table(['Prediction metric','Selected value'],[
    ['Model','Histogram Gradient Boosting research estimate - Haier reference'],
    ['Model inputs','AC control settings only'],
    ['Energy basis',report.prediction?.recordedColumns ? 'Recorded columns and timestamps' : report.prediction?.forecast ? 'Saved schedule forecast' : 'Recorded control intervals'],
    ['Estimated energy',Number.isFinite(report.kwh)?reportFormat(report.kwh,4)+' kWh':'Unavailable'],
    ['Estimated electricity cost',money(report.cost)],
    ['Estimated AC unit-hours',reportFormat(report.unitHours)],
    [report.prediction?.forecast ? 'Forecast facility hours' : 'Facility active hours',reportFormat(report.runtime)],
  ],{columnStyles:{0:{cellWidth:75}}});
  for(const note of report.notes.filter(text=>text.startsWith('Assumed conditions:') || text.startsWith('Partial estimate:'))) paragraph(note,8.5);
  if (getY() + 60 > H - 20) { doc.addPage(); heading('Executive Summary'); }
  else section('Executive Summary',60);
  paragraph(`${report.rows.length} selected telemetry readings cover ${report.controllers.length} controllers. ${report.prediction?.forecast?'Forecast':'Estimated'} energy is ${reportFormat(report.kwh,4)} kWh and estimated cost is ${money(report.cost)} at ${reportFormat(report.rate)} PHP/kWh.`);
  paragraph(supplemental.target.count
    ? `Recorded AC target temperature: ${pdfTargetTemperature(supplemental.target.min)} to ${pdfTargetTemperature(supplemental.target.max)} C; mean ${pdfTargetTemperature(supplemental.target.mean)} C (${supplemental.target.count} valid targets in ${report.rows.length} readings).`
    : 'AC target temperature was not recorded for this selection.');
  paragraph(supplemental.temperature.count
    ? `Measured room temperature: ${reportFormat(supplemental.temperature.min,1)} to ${reportFormat(supplemental.temperature.max,1)} C; mean ${reportFormat(supplemental.temperature.mean,1)} C.`
    : 'Measured room temperature was not recorded for this selection.');
  paragraph(`${report.unknown} readings lack confirmed physical AC power.`);
  paragraph(hasSource ? `${supplemental.violations.length} matching rule violations and ${supplemental.installations.length} verified installation events were retrieved for the selected report filters.`
    : `${supplemental.violations.length} matching violation entries are available, but notification coverage is ${supplemental.notificationStatus}; a complete violation total is unavailable.`);
  paragraph('Review the recorded violations and missing inputs alongside the selected forecast assumptions. Use Export Excel for the complete selected telemetry records.',8.5);
}

// Both original public export entry points are retained for the existing buttons.
async function exportExcelLogs() {
  try {
    const report = await prepareLogsReport();
    if (typeof ExcelJS === 'undefined') throw Error('The Excel export library is unavailable. Reload this page and try again.');
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'EcoTrack';
    workbook.created = report.generated;
    workbook.calcProperties.fullCalcOnLoad = true;
    const summary = workbook.addWorksheet('Analytics & Summary', { views: [{ showGridLines: false }] });
    const logs = workbook.addWorksheet('Aircon Telemetry Logs', { views: [{ state: 'frozen', ySplit: 4, xSplit: 2, showGridLines: false }] });
    const ink = 'FF17382F', muted = 'FF64748B', line = 'FFE2E8F0';
    const styleRow = (sheet, number, values, header = false) => {
      const row = sheet.getRow(number);
      row.values = values;
      row.height = header ? 30 : 24;
      row.eachCell({ includeEmpty: true }, cell => {
        cell.font = { name: 'Arial', size: 10, color: { argb: header ? 'FFFFFFFF' : ink }, bold: header };
        cell.alignment = { vertical: 'middle', horizontal: header ? 'center' : typeof cell.value === 'number' || typeof cell.value === 'object' ? 'right' : 'left', indent: header ? 0 : 1, wrapText: true };
        if (header) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ink } };
        else if (number % 2 === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F8F7' } };
        cell.border = { bottom: { style: 'hair', color: { argb: line } } };
      });
      return row;
    };
    const title = (sheet, text, end) => {
      sheet.mergeCells(`A2:${end}2`);
      const cell = sheet.getCell('A2');
      cell.value = text;
      cell.font = { name: 'Arial', size: 16, bold: true, color: { argb: ink } };
      sheet.getRow(2).height = 30;
      sheet.getRow(2).border = { bottom: { style: 'thin', color: { argb: ink } } };
    };
    const amount = '#,##0.00';
    const numeric = value => Number.isFinite(value) ? value : 'Unavailable';
    summary.columns = [{ width: 34 }, { width: 26 }, { width: 15 }, { width: 18 }, { width: 20 }, { width: 54 }];
    summary.properties.tabColor = { argb: ink };
    title(summary, 'EcoTrack - Aircon energy report' + (report.synthetic ? ' (TEST DATA)' : ''), 'F');
    const metadata = [
      ['Reporting period', report.date], ['Controller scope', report.scope], ['Time filter', report.time],
      ['Timezone', report.timezone], ['Generated', reportExcelDate(report.generated)], ['Tariff (PHP / kWh)', numeric(report.rate)],
      ['Utility provider', report.provider]
    ];
    metadata.forEach((data, i) => {
      styleRow(summary, i + 4, data);
      summary.mergeCells(`B${i + 4}:F${i + 4}`);
      summary.getCell(`B${i + 4}`).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
      summary.getCell(`A${i + 4}`).font = { name: 'Arial', size: 10, bold: true, color: { argb: muted } };
    });
    summary.getCell('B8').numFmt = 'mmm d, yyyy h:mm AM/PM';
    summary.getCell('B9').numFmt = '0.00';
    styleRow(summary, 12, ['Metric', 'Value', 'Unit', 'Basis'], true);
    summary.mergeCells('D12:F12');
    const energyTitle = report.prediction?.forecast ? 'Forecast energy' : 'Estimated energy';
    const costTitle = report.prediction?.forecast ? 'Forecast cost' : 'Estimated cost';
    const firstController = 23, lastController = 22 + report.controllers.length;
    const energyFormula = Number.isFinite(report.kwh)
      ? { formula: `SUM(D${firstController}:D${lastController})`, result: report.kwh } : 'Unavailable';
    const costFormula = Number.isFinite(report.cost) ? { formula: 'B13*$B$9', result: report.cost } : 'Unavailable';
    const metrics = [[energyTitle, energyFormula, 'kWh', report.prediction?.forecast ? 'Saved schedule' : 'Recorded runtime'],
      [costTitle, costFormula, 'PHP', 'Energy x tariff'],
      [report.prediction?.forecast ? 'Forecast facility active hours' : 'Facility active hours', numeric(report.runtime), 'hours', 'Overlapping units count once'],
      ['Estimated AC unit-hours', numeric(report.unitHours), 'unit-hours', 'Sum across estimated units'],
      ['Telemetry records', report.rows.length, 'readings', 'All selected readings'],
      ['Controllers in selected logs', report.controllers.length, 'controllers', 'Unique controller IDs'],
      ['Unknown physical power', report.unknown, 'readings', 'Unconfirmed feedback'],
      ['Previous-period energy', numeric(report.previous), 'kWh', 'Comparable recorded data only']];
    metrics.forEach((values, i) => {
      styleRow(summary, 13 + i, values);
      summary.mergeCells(`D${13 + i}:F${13 + i}`);
      summary.getCell(`B${13 + i}`).numFmt = i === 1 ? amount : i >= 4 && i <= 6 ? '#,##0' : '#,##0.00';
    });
    styleRow(summary, 22, ['Controller', 'Location', 'Readings', 'Energy (kWh)', 'Cost (PHP)', 'Estimate coverage'], true);
    report.controllers.forEach((controller, index) => {
      const r = firstController + index;
      styleRow(summary, r, [controller.name, `${controller.building} / ${controller.floor} / ${controller.room}`, controller.count,
        numeric(controller.kwh), Number.isFinite(controller.cost) ? { formula: `D${r}*$B$9`, result: controller.cost } : 'Unavailable',
        controller.reason || `${controller.basis}; ${reportFormat(controller.hours)} unit-hours`]);
      summary.getRow(r).height = 42;
      summary.getCell(`D${r}`).numFmt = '#,##0.0000';
      summary.getCell(`E${r}`).numFmt = amount;
    });
    let r = lastController + 3;
    styleRow(summary, r++, ['Controller', 'Building', 'Floor', 'Room', 'Latest status', 'Controller registration'], true);
    report.controllers.forEach(controller => {
      styleRow(summary, r, [controller.name, controller.building, controller.floor, controller.room, controller.status, controller.registered]);
      summary.getRow(r++).height = 34;
    });
    r += 2;
    styleRow(summary, r, ['Interval', 'Energy (kWh)', 'Cost (PHP)', 'Estimate status'], true);
    summary.mergeCells(`D${r}:F${r}`);
    r++;
    report.intervals.forEach(interval => {
      styleRow(summary, r, [interval.label, numeric(interval.kwh), Number.isFinite(interval.cost)
        ? { formula: `B${r}*$B$9`, result: interval.cost } : 'Unavailable', Number.isFinite(interval.kwh) ? 'Estimated' : 'No estimated interval']);
      summary.mergeCells(`D${r}:F${r}`);
      summary.getCell(`B${r}`).numFmt = '#,##0.0000';
      summary.getCell(`C${r++}`).numFmt = amount;
    });
    r += 2;
    styleRow(summary, r, ['Assumptions and coverage'], true);
    summary.mergeCells(`A${r}:F${r}`);
    r++;
    report.notes.forEach(note => {
      summary.mergeCells(`A${r}:F${r}`);
      const cell = summary.getCell(`A${r}`);
      cell.value = note;
      cell.font = { name: 'Arial', size: 10, color: { argb: muted } };
      cell.alignment = { wrapText: true, vertical: 'middle' };
      summary.getRow(r++).height = 32;
    });
    title(logs, 'EcoTrack - Daily logs' + (report.synthetic ? ' (TEST DATA)' : ''), 'M');
    logs.mergeCells('A3:M3');
    logs.getCell('A3').value = `${report.date}. ${report.scope}. ${report.time}. Timezone: ${report.timezone}. Source: selected local telemetry and saved control snapshots.`;
    logs.getCell('A3').font = { name: 'Arial', size: 10, color: { argb: muted } };
    logs.getRow(3).height = 26;
    const headers = ['Timestamp', 'Control Name', 'Building', 'Floor', 'Room', 'Attached Aircon Type', 'Target Temperature (C)', 'Operating Mode',
      'Blower Fan Mode', 'Special Functions', 'Battery (%)', 'RSSI (dBm)', 'Status'];
    const widths = [25, 30, 24, 16, 18, 28, 22, 18, 18, 68, 17, 17, 18];
    logs.columns = widths.map(width => ({ width }));
    styleRow(logs, 4, headers, true);
    report.rows.forEach((row, i) => {
      styleRow(logs, i + 5, [reportExcelDate(row.timestamp), row.name, row.building, row.floor, row.room, row.type, numeric(row.setpoint), row.mode,
        row.fan, row.special, numeric(row.battery), numeric(row.rssi), row.status]);
      logs.getRow(i + 5).height = 54;
      logs.getCell(`A${i + 5}`).numFmt = 'mmm d, yyyy h:mm:ss AM/PM';
      for (const col of ['G', 'K', 'L']) logs.getCell(`${col}${i + 5}`).numFmt = col === 'G' ? '0.0' : '0';
    });
    logs.autoFilter = { from: 'A4', to: `M${report.rows.length + 4}` };
    for (const sheet of [summary, logs]) {
      sheet.pageSetup = { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0,
        printTitlesRow: sheet === logs ? '1:4' : undefined, margins: { left: .3, right: .3, top: .4, bottom: .4, header: .2, footer: .2 } };
      sheet.headerFooter.oddFooter = '&LEcoTrack&C' + (report.synthetic ? 'TEST DATA' : report.date) + '&RPage &P of &N';
    }
    summary.pageSetup.printArea = `A1:F${r - 1}`;
    logs.pageSetup.printArea = `A1:M${report.rows.length + 4}`;
    const buffer = await workbook.xlsx.writeBuffer();
    const url = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `EcoTrack_Aircon_Analytics_${report.period}_${report.date.replace(/[^a-z0-9-]/gi, '_')}.xlsx`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (error) { showReportError(error); }
}

async function exportLogs() {
  try {
    const reportKey = getEnergySelectionKey();
    const report = await prepareLogsReport({ allowEmpty: window.EcoTrackFutureCost?.hasPlan() === true });
    const Pdf = window.jspdf?.jsPDF || window.jsPDF;
    if (!Pdf) throw Error('The PDF export library is unavailable. Reload this page and try again.');
    const doc = new Pdf({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    if (typeof doc.autoTable !== 'function') throw Error('The PDF table library is unavailable. Reload this page and try again.');
    const supplemental = await preparePdfSupplement(report);
    const futureCost = await window.EcoTrackFutureCost?.capture();
    if (getEnergySelectionKey() !== reportKey) throw Error('Selection changed. Export the current selection again.');
    const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 14;
    const ink = [23, 56, 47], muted = [100, 116, 139], green = [16, 132, 98];
    const safe = value => String(value ?? 'Unavailable').replace(/₱/g, 'PHP ').replace(/°/g, ' deg ').replace(/[·•—–]/g, '-');
    const money = value => Number.isFinite(value) ? `PHP ${reportFormat(value)}` : 'Unavailable';
    const stamp = value => Number.isFinite(value?.getTime()) ? value.toLocaleString('en-US', { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : 'Unavailable';
    let y = 0;
    const heading = text => {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.setTextColor(...ink);
      doc.text(safe(text), M, 24); y = 33;
    };
    const table = (head, body, options = {}) => {
      doc.autoTable({ startY: y, margin: { top: 22, bottom: 17, left: M, right: M },
        head: [head.map(safe)], body: body.map(row => row.map(safe)), theme: 'striped',
        styles: { font: 'helvetica', fontSize: 9, cellPadding: 3, textColor: ink, overflow: 'linebreak', valign: 'middle', lineWidth: 0 },
        headStyles: { fillColor: ink, textColor: [255, 255, 255], fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [245, 248, 247] }, rowPageBreak: 'avoid', ...options });
      y = doc.lastAutoTable.finalY + 9;
    };
    const paragraph = (text, size = 9) => {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(size); doc.setTextColor(...muted);
      const lines = doc.splitTextToSize(safe(text), W - M * 2);
      const height = lines.length * 4.5;
      if (y + height > H - 20) { doc.addPage(); y = 25; }
      doc.text(lines, M, y); y += height + 5;
    };
    // Original standalone cover: branding panel and selected report parameters.
    const coverDark = [11, 41, 29], coverAccent = [16, 185, 129], coverX = 110;
    doc.setFillColor(...coverDark); doc.rect(0, 0, 95, H, 'F');
    doc.setFillColor(...coverAccent); doc.rect(0, H - 8, 95, 8, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(26); doc.setTextColor(255, 255, 255);
    doc.text('EcoTrack', 18, 50);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...coverAccent);
    doc.text('AIRCON ENERGY ANALYTICS', 18, 57);
    doc.setDrawColor(...coverAccent); doc.setLineWidth(.4); doc.line(18, 62, 75, 62);
    doc.setFontSize(9.5); doc.setTextColor(200, 200, 200);
    doc.text(doc.splitTextToSize('Automated air conditioning power consumption forecasting, thermal monitoring telemetry, and flexible electricity tariff audit.', 60), 18, 70);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...coverAccent);
    doc.text(report.synthetic ? 'TEST DATA' : 'RESEARCH ESTIMATES', 18, H - 38);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(200, 200, 200);
    doc.text(doc.splitTextToSize(report.synthetic ? 'Contains synthetic demonstration records. Energy values are model estimates.' : 'Energy values are model estimates and are not utility-meter readings.', 60), 18, H - 30);

    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(...coverAccent);
    doc.text('EXECUTIVE UTILITY AUDIT REPORT', coverX, 38);
    doc.setFontSize(24); doc.setTextColor(...coverDark);
    doc.text('Aircon Energy Analytics', coverX, 48);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5); doc.setTextColor(...muted);
    doc.text(doc.splitTextToSize('Telemetry audit of selected controllers, recorded AC controls and estimated electricity expenditure.', W - coverX - M), coverX, 56);
    doc.autoTable({ startY: 68, margin: { left: coverX, right: M, top: 20, bottom: 24 }, theme: 'plain',
      styles: { font: 'helvetica', fontSize: 9, cellPadding: 3.5, textColor: [55, 65, 81], lineColor: [243, 244, 246], lineWidth: .2, overflow: 'linebreak' },
      body: [
        ['Report Scope', 'Aircon Energy Analytics & Fleet Audit'],
        ['Observation Interval', report.period.charAt(0).toUpperCase() + report.period.slice(1) + ' Report'],
        ['Date Range Scope', report.date],
        ['Time Filter', `${report.time} | ${report.timezone}`],
        ['Active Tariff Rate', Number.isFinite(report.rate) ? `PHP ${reportFormat(report.rate)} / kWh` : 'Unavailable'],
        ['Utility Provider', report.provider],
        ['Target Aircon Scope', report.scope],
        ['Total Audit Logs', `${report.rows.length} telemetry readings`],
        ['Generated At', stamp(report.generated)],
        ['Estimate Basis', report.prediction?.forecast ? 'Saved schedule forecast' : 'Recorded operating intervals']
      ].map(row => row.map(safe)),
      columnStyles: { 0: { fontStyle: 'bold', cellWidth: 45, textColor: muted }, 1: { textColor: [17, 24, 39] } }, rowPageBreak: 'avoid'
    });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...muted);
    doc.text('Detailed telemetry is provided through Export Excel.', coverX, H - 14);

    doc.addPage(); heading('Aircon energy report' + (report.synthetic ? ' | TEST DATA' : ''));
    paragraph(`${report.date} | ${report.scope} | ${report.time} | ${report.timezone}`);
    const cards = [
      [report.prediction?.forecast ? 'FORECAST ENERGY' : 'ESTIMATED ENERGY', Number.isFinite(report.kwh) ? `${reportFormat(report.kwh)} kWh` : 'Unavailable'],
      [report.prediction?.forecast ? 'FORECAST COST' : 'ESTIMATED COST', money(report.cost)],
      [report.prediction?.forecast ? 'FORECAST FACILITY HOURS' : 'FACILITY ACTIVE HOURS', Number.isFinite(report.runtime) ? `${reportFormat(report.runtime)} hours` : 'Unavailable']
    ];
    const cardW = (W - M * 2 - 12) / 3;
    cards.forEach(([label, value], i) => {
      const x = M + i * (cardW + 6);
      doc.setFillColor(245, 248, 247); doc.roundedRect(x, y, cardW, 25, 2, 2, 'F');
      doc.setFillColor(...green); doc.rect(x, y, 1, 25, 'F');
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...muted); doc.text(label, x + 5, y + 7);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(17); doc.setTextColor(...ink); doc.text(value, x + 5, y + 18);
    });
    y += 34;
    table(['Monitoring Summary', 'Selected value', 'Report parameter', 'Selected value'], [
      ['Telemetry readings', report.rows.length, 'Controllers', report.controllers.length],
      ['Tariff (PHP / kWh)', reportFormat(report.rate), 'Utility provider', report.provider],
      ['Estimated AC unit-hours', reportFormat(report.unitHours), 'Unknown physical power', `${report.unknown} readings`],
      ['Generated', stamp(report.generated), 'Previous-period energy', Number.isFinite(report.previous) ? `${reportFormat(report.previous)} kWh` : 'Unavailable']
    ], { columnStyles: { 0: { cellWidth: 53 }, 1: { cellWidth: 61 }, 2: { cellWidth: 57 } } });

    doc.addPage(); heading('Controller estimates and control settings');
    table(['Controller', 'Location', 'Readings', 'Energy (kWh)', 'Cost (PHP)', 'Unit-hours', 'Estimate coverage'], report.controllers.map(row => [
      row.name, `${row.building} / ${row.floor} / ${row.room}`, row.count, reportFormat(row.kwh, 4), reportFormat(row.cost), reportFormat(row.hours), row.reason || row.basis
    ]), { columnStyles: { 0: { cellWidth: 38 }, 1: { cellWidth: 53 }, 6: { cellWidth: 60 } } });
    table(['Controller', 'AC type', 'Latest status', 'Target Temperature (C)', 'Controller registration'], supplemental.aggregation.map(row => [row.name, row.type, row.status, pdfTargetTemperature(row.setpoint), row.registeredAt ? stamp(new Date(row.registeredAt)) : 'Unavailable']));

    if (report.intervals.some(interval => Number.isFinite(interval.kwh))) {
      doc.addPage(); heading('Energy and cost by interval');
      paragraph('Energy totals use the same selected model intervals as the dashboard. Cost equals estimated kWh multiplied by the configured tariff.');
      table(['Interval', 'Estimated energy (kWh)', 'Estimated cost (PHP)', 'Coverage'], report.intervals.filter(interval => Number.isFinite(interval.kwh)).map(interval => [
        interval.label, reportFormat(interval.kwh, 4), reportFormat(interval.cost), report.prediction?.forecast ? 'Saved schedule forecast' : 'Recorded operating intervals'
      ]));
      // Vector bars remain sharp when printed and are omitted when no estimate exists.
      const available = report.controllers.filter(row => Number.isFinite(row.kwh));
      const max = Math.max(...available.map(row => row.kwh), 0);
      if (available.length && available.length <= 8 && y + 15 + available.length * 13 < H - 22) {
        paragraph('Estimated energy by controller (kWh)', 10);
        available.forEach(row => {
          doc.setFontSize(9); doc.setTextColor(...ink);
          doc.text(doc.splitTextToSize(safe(row.name), 60), M, y + 4);
          doc.setFillColor(...green); doc.rect(M + 65, y, max > 0 ? row.kwh / max * 140 : 0, 5, 'F');
          doc.text(reportFormat(row.kwh), W - M, y + 4, { align: 'right' }); y += 13;
        });
      }
    }
    renderPdfSupplement(doc, report, supplemental, { table, paragraph, heading, stamp, money, safe, ink, muted, green, W, H, M,
      getY: () => y, setY: value => { y = value; } });
    window.EcoTrackFutureCost?.appendPdf(doc, futureCost);
    const pages = doc.internal.getNumberOfPages();
    for (let page = 2; page <= pages; page++) {
      doc.setPage(page);
      doc.setDrawColor(...green); doc.setLineWidth(.6); doc.line(M, 12, W - M, 12);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...ink); doc.text('ECOTRACK', M, 9);
      doc.setFont('helvetica', 'normal'); doc.setTextColor(...muted);
      doc.text(safe(report.date + (report.synthetic ? ' | TEST DATA' : '')), W - M, 9, { align: 'right' });
      doc.setDrawColor(226, 232, 240); doc.setLineWidth(.2); doc.line(M, H - 12, W - M, H - 12);
      doc.setFontSize(7.5); doc.text('Research estimate | ' + safe(report.scope), M, H - 7);
      doc.text(`Page ${page} of ${pages}`, W - M, H - 7, { align: 'right' });
    }
    doc.setProperties({ title: 'EcoTrack Aircon Energy Report', subject: report.date + ' - ' + report.scope, author: 'EcoTrack', creator: 'EcoTrack' });
    doc.save(`EcoTrack_Aircon_Energy_Analytics_${report.period}_${report.date.replace(/[^a-z0-9-]/gi, '_')}.pdf`);
    if (window.EcoToast) window.EcoToast.success('PDF report exported successfully.');
  } catch (error) { showReportError(error); }
}

function controllerFutureCostContext() {
  const profiles=window.EcoTrackAirconSystem?.AirconProfileManager?.getAll?.() || [];
  const devices=globalNodeRecords.filter(node=>node.device_mode!=='monitoring' && (!currentNodeFilter || [node.id,node.db_id,node.node_id,node.name].includes(currentNodeFilter))).map(node=>{
    const id=node.db_id || node.id,keys=[id,node.node_id,node.name].filter(Boolean);
    const matches=profiles.filter(profile=>profile.controller_node_id ? profile.controller_node_id===id : keys.includes(profile.node_id));
    const profile=matches.length===1?matches[0]:null;
    let snapshot=profile?.control_snapshot;
    if(typeof snapshot==='string'){try{snapshot=JSON.parse(snapshot);}catch(_){snapshot=null;}}
    const saved=window.EcoTrackAirconState?.selectSettings?.(snapshot)?.state ||
      snapshot?.desired_state || snapshot?.reported_state || snapshot?.configured_state ||
      profile?.state || getSavedForecastSettings(nodeDataLogs.filter(log=>[id,node.id].includes(log.nodeId || log.node_id))) || {};
    return {id,name:node.name || profile?.name || id,settings:{...saved}};
  });
  return {devices,tariff:getActiveTariffRate(),scope:currentNodeFilter?(controlNameMap[currentNodeFilter] || currentNodeFilter):'All selected controller AC units',
    reference:'Saved or recorded AC controls; entered overrides apply to this plan only',
    predict:(settings,options)=>{
      if(!window.EcoTrackEnergyPrediction?.predictRecorded) throw Error('The controller model is unavailable. Reload this page.');
      return window.EcoTrackEnergyPrediction.predictRecorded(settings,options);
    }};
}
