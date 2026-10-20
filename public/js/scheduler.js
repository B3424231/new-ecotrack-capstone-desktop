// ===== SCHEDULER PAGE LOGIC =====
const sb = window.supabaseClient || window.sb;
const schedulerControllerMode = () => !window.EcoTrackMode || window.EcoTrackMode.mode === 'controller';
const schedulerEscape = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
function getSchedulerDeviceState(hardware) {
  if (!hardware || !Number.isFinite(Date.parse(hardware.last_seen || '')) && !Number.isFinite(Date.parse(hardware.sleeping_until || ''))) return 'unknown';
  return window.EcoTrackHardwareCloud?.describe(hardware) || 'unknown';
}
function schedulerDeviceStatePresentation(status) {
  const value = String(status || '').toLowerCase();
  const state = value === 'connected' ? 'online' : ['online', 'offline', 'sleeping'].includes(value) ? value : 'unknown';
  return { state, label: { online: 'Online', offline: 'Offline', sleeping: 'Sleeping', unknown: 'Not reported' }[state] };
}
function updateSchedulerDeviceBadge(node) {
  const label = document.getElementById(`status-${node.id}`);
  if (!label) return;
  const presentation = schedulerDeviceStatePresentation(node.status);
  label.textContent = presentation.label;
  label.closest('[data-device-state]')?.setAttribute('data-device-state', presentation.state);
}

let selectedRoomId = null;
let buildings = {};
let floors = {};
let savedRooms = {};
let schedulerCurrentPage = 1;
const SCHEDULER_PAGE_SIZE = 20;
let currentRoomNodes = [];
let activeTimePickerTargetId = null;
let activeTimePickerTrigger = null;
const scheduleDrafts = new Map();
const scheduleDeliveries = new Map();
function reconcileScheduleDelivery(command) {
  const entry = [...scheduleDeliveries.values()].find(item => item.commandId === command.id && item.databaseNodeId === command.node_id);
  if (!entry) return;
  if (command.status === 'completed') {
    const receipt = command.result;
    entry.label = receipt?.success && receipt.command_id === entry.commandId && receipt.interval_ms === entry.seconds * 1000 &&
      receipt.wake_time === entry.wakeTime && receipt.sleep_time === entry.sleepTime ? 'Applied' : 'Failed';
  } else if (['failed', 'expired', 'superseded'].includes(command.status)) entry.label = 'Failed';
  else return;
  const button = document.getElementById(`apply-${entry.nodeId}`) || entry.button;
  if (button) button.textContent = entry.label;
}

let schedulerLoadVersion = 0;
let schedulerAirconRecords = null;
let schedulerAirconRefreshVersion = 0;
function renderSchedulerLoading() {
  for (const id of ['roomsList', 'schedulerTableBody']) {
    const element = document.getElementById(id); if (!element) continue;
    delete element.dataset.ecoLoaded;
    element.setAttribute('aria-busy', 'true');
  }
  window.EcoTrackSkeletons?.renderRoomListSkeleton('roomsList', { count: 3 });
  window.EcoTrackSkeletons?.renderTableSkeleton('schedulerTableBody', { rows: 4, cols: schedulerControllerMode() ? 11 : 8 });
}
function rememberScheduleDraft(event) {
  const match = /^(?:wake|sleep|interval-val|interval-unit)-(.+)$/.exec(event.target.id || '');
  if (!match) return;
  const id = match[1];
  scheduleDrafts.set(id, {
    wakeTime: document.getElementById(`wake-${id}`)?.value,
    sleepTime: document.getElementById(`sleep-${id}`)?.value,
    intervalVal: document.getElementById(`interval-val-${id}`)?.value,
    intervalUnit: document.getElementById(`interval-unit-${id}`)?.value,
    editedAt: Date.now()
  });
  updateNodeSleepNote(id);
}
document.addEventListener('input', rememberScheduleDraft);
document.addEventListener('change', rememberScheduleDraft);

function getSchedulerControlSnapshot(node) {
  const identities = [node.id, node.name, node.pb_id].filter(Boolean);
  const records = schedulerAirconRecords?.filter(ac => [ac.node_id, ac.controller_node_id]
    .some(id => id && identities.includes(id))) || [];
  if (records.length > 1 || (schedulerAirconRecords !== null && !records.length)) return null;
  const profiles = window.EcoTrackAirconSystem?.AirconProfileManager?.getAll?.() || [];
  const matches = profiles.filter(ac => [ac.node_id, ac.controller_node_id].some(id => identities.includes(id)));
  const local = matches.length === 1 ? matches[0] : null;
  const observation = window.EcoTrackAirconState?.remoteObservation(node.cloud_state?.latest_ir, node.cloud_state?.last_seen, local?.control_snapshot) || {};
  if (!records.length) return {...local?.control_snapshot,...observation};
  const ac = records[0];
  const snapshot = {desired_state: ac.desired_state, reported_state: ac.reported_state,
    commanded_at: ac.commanded_at, reported_at: ac.reported_at};
  const localTime = Date.parse(local?.control_snapshot?.commanded_at || '');
  const savedTime = Date.parse(ac.commanded_at || '');
  const sameController = local && (local.aircon_id === ac.id || local.device_id === ac.asset_tag);
  if (sameController && Number.isFinite(localTime) &&
      (!Number.isFinite(savedTime) || localTime > savedTime)) return {...local.control_snapshot,...observation};
  // The schedule column shows selected settings even before the first command is sent.
  // Keep configuration separate from desired commands and measured device feedback.
  if (sameController && !ac.desired_state && !ac.reported_state) snapshot.configured_state = local.state;
  return {...snapshot,...observation};
}

function schedulerSelectedSettings(node) {
  return window.EcoTrackAirconState?.selectSettings(getSchedulerControlSnapshot(node)) || {state:null,source:'unknown'};
}
function getSchedulerTargetTemperature(node) {
  const {state}=schedulerSelectedSettings(node);
  return Number.isFinite(state?.temp)?state.temp+' °C':'—';
}
function getSchedulerPowerMode(node) {
  const {state}=schedulerSelectedSettings(node);
  return state?.power===true||state?.power==='on'?'ON':state?.power===false||state?.power==='off'?'OFF':'—';
}
function getSchedulerControlMode(node) {
  const {state}=schedulerSelectedSettings(node);
  const mode=String(state?.mode||'').trim().toLowerCase(),fan=String(state?.fan||'').trim().toLowerCase();
  const parts=[];
  if(['cool','dry','fan','auto','heat'].includes(mode))parts.push(mode.toUpperCase());
  if(['low','medium','high','max','auto','quiet','silent','turbo'].includes(fan))parts.push(fan.toUpperCase()+' FAN');
  if(state?.turbo===true)parts.push('TURBO');
  return parts.join(' / ')||'—';
}

function refreshSchedulerHardware(payload) {
  const cached = window.EcoTrackAirconSystem?.NodeService?.getDevices?.() || [];
  const nodes = [...Object.values(savedRooms).flatMap(room => room.nodes || []), ...currentRoomNodes];
  for (const node of nodes) {
    const fresh = payload?.nodes?.find(item => item.db_id === node.pb_id || item.node_id === node.id) ||
      cached.find(item => item.db_id === node.pb_id || item.node_id === node.id);
    if (!fresh || (payload?.node_id && fresh.db_id !== payload.node_id)) continue;
    if (Date.parse(fresh.cloud_state?.last_seen || '') < Date.parse(node.cloud_state?.last_seen || '')) continue;
    node.cloud_state = fresh.cloud_state;
    node.status = getSchedulerDeviceState(fresh.cloud_state);
    updateSchedulerDeviceBadge(node);
    const temperature = document.getElementById(`temperature-${node.id}`);
    if (temperature) temperature.textContent = getSchedulerTargetTemperature(node);
  }
  refreshSchedulerControlModes();
}

function refreshSchedulerControlModes() {
  const nodes = Object.values(savedRooms).flatMap(room => room.nodes || []);
  document.querySelectorAll('[data-scheduler-control-mode]').forEach(label => {
    const id = decodeURIComponent(label.dataset.schedulerControlMode);
    const node = nodes.find(item => item.id === id) || currentRoomNodes.find(item => item.id === id);
    if (node) label.textContent = getSchedulerControlMode(node);
  });
  for (const [selector,key,format] of [['[data-scheduler-target-temp]','schedulerTargetTemp',getSchedulerTargetTemperature],['[data-scheduler-power-mode]','schedulerPowerMode',getSchedulerPowerMode]]) {
    document.querySelectorAll(selector).forEach(label => {
      const id = decodeURIComponent(label.dataset[key]);
      const node = nodes.find(item => item.id === id) || currentRoomNodes.find(item => item.id === id);
      if (node) label.textContent = format(node);
    });
  }
}

async function refreshSchedulerAirconSettings() {
  if (!sb) return;
  const version = ++schedulerAirconRefreshVersion;
  try {
    const {data, error} = await sb.from('aircons').select('*');
    if (error || version !== schedulerAirconRefreshVersion || !Array.isArray(data)) return;
    schedulerAirconRecords = data;
    refreshSchedulerControlModes();
  } catch (_) {}
}

function normalizeScheduleTime(value) {
  if (typeof value !== 'string') return null;
  const match = /^([01]?\d|2[0-3]):([0-5]\d)(?::00(?:\.0+)?)?$/.exec(value.trim());
  return match ? match[1].padStart(2, '0') + ':' + match[2] : null;
}
function nodeSleepNote(wake, sleep) {
  const wakeTime = normalizeScheduleTime(wake), sleepTime = normalizeScheduleTime(sleep);
  if (!wakeTime || !sleepTime) return 'Choose wake and sleep times before applying.';
  return wakeTime === sleepTime ? 'Equal times keep this controller awake.' : '';
}
function updateNodeSleepNote(nodeId) {
  const note = document.getElementById(`sleep-note-${nodeId}`);
  if (!note) return;
  note.textContent = nodeSleepNote(document.getElementById(`wake-${nodeId}`)?.value, document.getElementById(`sleep-${nodeId}`)?.value);
  note.classList.toggle('hidden', !note.textContent);
}
function formatTimeDisplay(value) {
  const timeValue = normalizeScheduleTime(value);
  if (!timeValue) return value == null || String(value).trim() === '' ? 'Not set' : 'Invalid time';
  const [hour, minutes] = timeValue.split(':');
  const hours = Number(hour);
  return `${String(hours % 12 || 12).padStart(2, '0')}:${minutes} ${hours >= 12 ? 'PM' : 'AM'}`;
}

function composeTimeValue(hourValue, minuteValue, periodValue) {
  let hours = parseInt(hourValue, 10);
  const minutes = String(minuteValue).padStart(2, '0');

  if (periodValue === 'AM') {
    if (hours === 12) hours = 0;
  } else if (hours !== 12) {
    hours += 12;
  }

  return `${String(hours).padStart(2, '0')}:${minutes}`;
}

function ensureTimePickerModal() {
  if (document.getElementById('timePickerModal')) return;

  const modal = document.createElement('div');
  modal.id = 'timePickerModal';
  modal.className = 'fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center animate-in fade-in duration-200';
  modal.style.display = 'none';
  modal.innerHTML = `
    <div class="bg-white dark:bg-[#0c1328] border-[3px] border-[#10b981] dark:border-[#10b981]/40 rounded-[1.5rem] p-7 w-full max-w-sm relative shadow-2xl">
      <button id="timePickerCloseBtn" class="absolute top-6 right-6 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors border-0 bg-transparent cursor-pointer">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
      
      <div class="mb-6">
        <p class="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-1">Custom Time</p>
        <h3 id="timePickerTitle" class="text-2xl font-bold text-[#18392B] dark:text-cyan-400">Wake Time</h3>
        <p id="timePickerPreview" class="text-sm font-semibold text-[#18392B] dark:text-gray-300 mt-1">06:00 AM</p>
      </div>

      <div class="grid grid-cols-3 gap-3 mb-8">
        <label class="flex flex-col">
          <span class="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2 pl-1">Hour</span>
          <select id="timePickerHour" class="bg-white dark:bg-slate-950/40 border-2 border-gray-200 dark:border-white/10 focus:border-[#10b981] hover:border-gray-300 dark:hover:border-white/20 rounded-xl text-xl font-bold text-[#18392B] dark:text-gray-100 px-2 py-3 appearance-none outline-none cursor-pointer text-center transition-colors shadow-sm"></select>
        </label>
        <label class="flex flex-col">
          <span class="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2 pl-1">Minute</span>
          <select id="timePickerMinute" class="bg-white dark:bg-slate-950/40 border-2 border-gray-200 dark:border-white/10 focus:border-[#10b981] hover:border-gray-300 dark:hover:border-white/20 rounded-xl text-xl font-bold text-[#18392B] dark:text-gray-100 px-2 py-3 appearance-none outline-none cursor-pointer text-center transition-colors shadow-sm"></select>
        </label>
        <label class="flex flex-col">
          <span class="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2 pl-1">Period</span>
          <select id="timePickerPeriod" class="bg-white dark:bg-slate-950/40 border-2 border-gray-200 dark:border-white/10 focus:border-[#10b981] hover:border-gray-300 dark:hover:border-white/20 rounded-xl text-xl font-bold text-[#18392B] dark:text-gray-100 px-2 py-3 appearance-none outline-none cursor-pointer text-center transition-colors shadow-sm"></select>
        </label>
      </div>

      <div class="flex gap-4">
        <button id="timePickerCancelBtn" class="flex-1 bg-white dark:bg-slate-900 border border-[#10b981] dark:border-[#10b981]/40 text-[#10b981] dark:text-emerald-400 font-bold rounded-xl py-3 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors border-0 cursor-pointer">
          Cancel
        </button>
        <button id="timePickerSaveBtn" class="flex-1 bg-[#10b981] text-white hover:bg-emerald-400 font-bold rounded-xl py-3 shadow-md hover:shadow-lg transition-all border-0 cursor-pointer">
          Save Time
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const hourSelect = modal.querySelector('#timePickerHour');
  const minuteSelect = modal.querySelector('#timePickerMinute');
  const periodSelect = modal.querySelector('#timePickerPeriod');

  for (let hour = 1; hour <= 12; hour += 1) {
    const option = document.createElement('option');
    option.value = String(hour);
    option.textContent = String(hour).padStart(2, '0');
    hourSelect.appendChild(option);
  }

  for (let minute = 0; minute < 60; minute += 1) {
    const option = document.createElement('option');
    option.value = String(minute).padStart(2, '0');
    option.textContent = String(minute).padStart(2, '0');
    minuteSelect.appendChild(option);
  }

  ['AM', 'PM'].forEach(period => {
    const option = document.createElement('option');
    option.value = period;
    option.textContent = period;
    periodSelect.appendChild(option);
  });

  const updatePreview = () => {
    const preview = document.getElementById('timePickerPreview');
    if (!preview) return;
    preview.textContent = formatTimeDisplay(composeTimeValue(hourSelect.value, minuteSelect.value, periodSelect.value));
  };

  hourSelect.addEventListener('change', updatePreview);
  minuteSelect.addEventListener('change', updatePreview);
  periodSelect.addEventListener('change', updatePreview);

  modal.addEventListener('click', (event) => {
    if (event.target.id === 'timePickerModal') {
      closeTimePicker();
    }
  });

  modal.querySelector('#timePickerCloseBtn').addEventListener('click', closeTimePicker);
  modal.querySelector('#timePickerCancelBtn').addEventListener('click', closeTimePicker);
  modal.querySelector('#timePickerSaveBtn').addEventListener('click', saveTimePicker);
}

function openTimePicker(targetInputId, triggerElement) {
  const modal = document.getElementById('timePickerModal');
  const hourSelect = document.getElementById('timePickerHour');
  const minuteSelect = document.getElementById('timePickerMinute');
  const periodSelect = document.getElementById('timePickerPeriod');
  const title = document.getElementById('timePickerTitle');
  const preview = document.getElementById('timePickerPreview');
  const targetInput = document.getElementById(targetInputId);

  if (!modal || !hourSelect || !minuteSelect || !periodSelect || !targetInput) return;

  const currentValue = normalizeScheduleTime(targetInput.value) || '05:00';
  const match = /^([0-2]?\d):([0-5]\d)$/.exec(currentValue) || ['05:00', '05', '00'];
  const hour24 = parseInt(match[1], 10);
  const minute = match[2];
  const period = hour24 >= 12 ? 'PM' : 'AM';
  let hour12 = hour24 % 12;
  if (hour12 === 0) hour12 = 12;

  activeTimePickerTargetId = targetInputId;
  activeTimePickerTrigger = triggerElement || document.querySelector(`[data-time-target="${targetInputId}"]`);

  hourSelect.value = String(hour12);
  minuteSelect.value = minute;
  periodSelect.value = period;

  if (title && activeTimePickerTrigger) {
    title.textContent = activeTimePickerTrigger.dataset.timeLabel || 'Select Time';
  }
  if (preview) {
    preview.textContent = formatTimeDisplay(currentValue);
  }

  modal.style.display = 'flex';
}

function closeTimePicker() {
  const modal = document.getElementById('timePickerModal');
  if (modal) modal.style.display = 'none';
  activeTimePickerTargetId = null;
  activeTimePickerTrigger = null;
}

function saveTimePicker() {
  if (!activeTimePickerTargetId) return;

  const hourSelect = document.getElementById('timePickerHour');
  const minuteSelect = document.getElementById('timePickerMinute');
  const periodSelect = document.getElementById('timePickerPeriod');
  const targetInput = document.getElementById(activeTimePickerTargetId);
  if (!hourSelect || !minuteSelect || !periodSelect || !targetInput) return;

  const timeValue = composeTimeValue(hourSelect.value, minuteSelect.value, periodSelect.value);
  targetInput.value = timeValue;
  targetInput.dispatchEvent(new Event('change', { bubbles: true }));

  if (activeTimePickerTrigger) {
    const valueNode = activeTimePickerTrigger.querySelector('.sched-time-trigger-value');
    if (valueNode) valueNode.textContent = formatTimeDisplay(timeValue);
  }

  // Update in-memory node models immediately
  const isWake = activeTimePickerTargetId.startsWith('wake-');
  const isSleep = activeTimePickerTargetId.startsWith('sleep-');
  const nodeId = isWake ? activeTimePickerTargetId.replace('wake-', '') : (isSleep ? activeTimePickerTargetId.replace('sleep-', '') : null);

  if (nodeId) {
    for (const rId in savedRooms) {
      const room = savedRooms[rId];
      if (room && room.nodes) {
        const found = room.nodes.find(n => n.id === nodeId || n.name === nodeId);
        if (found) {
          if (isWake) found.wakeTime = timeValue;
          if (isSleep) found.sleepTime = timeValue;
        }
      }
    }
    if (currentRoomNodes) {
      const foundCurrent = currentRoomNodes.find(n => n.id === nodeId || n.name === nodeId);
      if (foundCurrent) {
        if (isWake) foundCurrent.wakeTime = timeValue;
        if (isSleep) foundCurrent.sleepTime = timeValue;
      }
    }
  }

  closeTimePicker();
}

async function loadSchedulerWithSWR(forceRefresh = false) {
  if (!schedulerControllerMode() && window.EcoDeviceScheduler) return window.EcoDeviceScheduler.load(forceRefresh);
  const loadVersion = ++schedulerLoadVersion;
  const roomsList = document.getElementById('roomsList');
  const schedulerTableBody = document.getElementById('schedulerTableBody');
  const hasCached = !!(window.EcoDataBus && window.EcoDataBus.getCached('scheduler:data'));

  if (!hasCached || forceRefresh) renderSchedulerLoading();

  const fetchSchedulerData = async (signal) => {
    let roomRecords = [];
    let floorRecords = [];
    let buildingRecords = [];
    let nodeRecords = [];
    let airconRecords = [];
    let ipcLoaded = false;

    // Try privileged Electron IPC handler first to avoid Supabase RLS 42501 restrictions
    if (window.electron && typeof window.electron.invoke === 'function') {
      try {
        const schedRes = await window.electron.invoke('scheduler-fetch-data');
        if (schedRes && schedRes.success) {
          roomRecords = schedRes.rooms || [];
          floorRecords = schedRes.floors || [];
          buildingRecords = schedRes.buildings || [];
          nodeRecords = schedRes.nodes || [];
          airconRecords = schedRes.aircons || [];
          ipcLoaded = true;
        }
      } catch (err) {
        console.warn('IPC scheduler-fetch-data error, fallback to sb:', err);
      }
    }

    if (!ipcLoaded && sb) {
      const [rRes, fRes, bRes, nRes, aRes] = await Promise.all([
        sb.from('rooms').select('*').order('created'),
        sb.from('floors').select('*').order('created'),
        sb.from('buildings').select('*').order('created'),
        sb.from('nodes').select('*'),
        sb.from('aircons').select('*')
      ]);
      const failed = [rRes, fRes, bRes, nRes, aRes].find(result => result.error);
      if (failed) throw new Error(failed.error.message);
      roomRecords = rRes.data || [];
      floorRecords = fRes.data || [];
      buildingRecords = bRes.data || [];
      nodeRecords = nRes.data || [];
      airconRecords = (aRes && aRes.data) || [];
    }
    if (!ipcLoaded && !sb) throw new Error('Database service unavailable');

    let telemetryRecords = [];
    if (sb) {
      try {
        const { data: sbTelem } = await sb.from('telemetry').select('*').order('created', { ascending: false }).limit(60);
        if (sbTelem && sbTelem.length) telemetryRecords = sbTelem;
      } catch (e) {
        console.warn('Failed to fetch Supabase telemetry for scheduler:', e);
      }
    }
    const cloudStates = window.EcoTrackHardwareCloud ? await window.EcoTrackHardwareCloud.listStatus() : [];
    return { roomRecords, floorRecords, buildingRecords, nodeRecords, airconRecords, telemetryRecords, cloudStates };

  };

  try {
    let data;
    if (window.EcoDataBus) {
      data = await window.EcoDataBus.query('scheduler:data', fetchSchedulerData, {
        forceRefresh,
        ttl: 45000
      });
    } else {
      data = await fetchSchedulerData();
    }

    if (loadVersion !== schedulerLoadVersion) return;
    const { roomRecords = [], floorRecords = [], buildingRecords = [], nodeRecords = [], airconRecords = [], telemetryRecords = [], cloudStates = [] } = data || {};
    const pendingIds = new Set(window.EcoTrackHardwareCloud?.pendingRegistrations?.() || []);
    const visibleNodes = nodeRecords.filter(node => node.device_mode!=='monitoring').filter(node => !pendingIds.has(String(node.id)) || airconRecords.some(ac => ac.controller_node_id === node.id || ac.node_id === node.id));
    const hardwareByNode = new Map(cloudStates.map(state => [state.node_id, state]));
    const knownRooms = new Set(roomRecords.map(room => room.id));
    const roomViews = [...roomRecords];
    if (visibleNodes.some(node => !knownRooms.has(node.room_id))) roomViews.push({ id: '__unassigned_controllers__', name: 'Unassigned controllers', floor_id: null, building_id: null });

    schedulerAirconRecords = airconRecords;
    buildings = {};
    floors = {};
    savedRooms = {};

    const telemetryByNodeId = {};
    telemetryRecords.forEach(t => {
      if (t.node_id && !telemetryByNodeId[t.node_id]) telemetryByNodeId[t.node_id] = t;
      if (t.sensor_name && !telemetryByNodeId[t.sensor_name]) telemetryByNodeId[t.sensor_name] = t;
    });

    buildingRecords.forEach(b => buildings[b.id] = { ...b });
    floorRecords.forEach(f => floors[f.id] = { ...f });

    roomViews.forEach(record => {
      // A controller appears once, using its real database room link.
      const roomNodesMap = new Map();
      visibleNodes.forEach(node => {
        const belongs = record.id === '__unassigned_controllers__' ? !knownRooms.has(node.room_id) : node.room_id === record.id;
        if (belongs) roomNodesMap.set(node.id, node);
      });

      // 3. Map into Scheduler node format with matched Aircon profiles matching Aircon Control and Control Dashboard
      const allAircons = (window.EcoTrackAirconSystem?.AirconProfileManager?.getAll?.()) || [];

      const roomNodes = Array.from(roomNodesMap.values()).map(n => {
        const latestTelemetry = telemetryByNodeId[n.name] || telemetryByNodeId[n.id] || {};
        const numeric = value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
        const tVal = numeric(latestTelemetry.temperature ?? n.temp);
        const pVal = numeric(latestTelemetry.pressure);
        const hardware = hardwareByNode.get(n.id);
        const stateRaw = getSchedulerDeviceState(hardware);
        const isOnline = stateRaw === 'online';

        // Match node with canonical Aircon profile to ensure 100% naming consistency across pages
        const cleanRoom = (record.name || '').trim().replace(/\b\w/g, l => l.toUpperCase());
        const matchedAc = allAircons.find(a => 
          a.node_id === n.name || 
          a.node_id === n.id || a.controller_node_id === n.id ||
          (a.device_id && (n.name === a.device_id || n.aircon_id === a.device_id))
        ) || airconRecords.find(a =>
          a.node_id === n.name ||
          a.node_id === n.id ||
          a.controller_node_id === n.name ||
          a.controller_node_id === n.id ||
          a.asset_tag === n.name ||
          (a.asset_tag && (n.aircon_id === a.asset_tag || n.name === a.asset_tag))
        );

        const acTag = matchedAc ? (matchedAc.device_id || matchedAc.asset_tag) : null;
        const acName = matchedAc?.name || 'Aircon name unavailable';
        const acType = (matchedAc && (matchedAc.model || matchedAc.aircon_type)) || n.aircon_type || 'Split Type (Inverter)';
        const acBrand = (matchedAc && matchedAc.brand) || n.brand || 'Unspecified';

        return {
          id: hardware?.device_id || n.name || n.id,
          pb_id: n.id,
          cloud_state: hardware || null,
          ip_address: n.ip_address || null,
          room_name: record.name,
          floor_name: floors[record.floor_id]?.name || 'Unassigned',
          building_name: buildings[floors[record.floor_id]?.building_id]?.name || 'Unassigned',
          name: n.name || n.id,
          device_name: n.device_name || n.name || null,
          ac_name: acName,
          ac_tag: acTag,
          ac_type: acType,
          ac_brand: acBrand,
          status: stateRaw,
          temp: tVal,
          pressure: pVal,
          wakeTime: n.wake_time ?? '',
          sleepTime: n.sleep_time ?? '',
          intervalVal: Number(n.interval_val ?? 15),
          intervalUnit: n.interval_unit || 'Minutes',
          aircon_type: acType,
          ...(() => {
            const draft = scheduleDrafts.get(n.name || n.id);
            if (!draft) return {};
            const { wakeTime, sleepTime, intervalVal, intervalUnit } = draft;
            return { wakeTime, sleepTime, intervalVal, intervalUnit };
          })()
        };
      });

      savedRooms[record.id] = {
        id: record.id,
        name: record.name,
        floor_id: record.floor_id,
        building_id: record.building_id,
        nodeLimit: record.node_limit || 20,
        nodes: roomNodes
      };
    });

    renderSchedulerLocationCabinet();
  } catch (error) {
    console.warn('PocketBase/Supabase load error on Scheduler:', error);
    renderSchedulerErrorState(error.message);
  }
}

function renderSchedulerLocationCabinet() {
  const roomsList = document.getElementById('roomsList');
    const locatedRooms = Object.fromEntries(Object.entries(savedRooms).filter(([, room]) => !room.ungrouped));
    window.ensureLocationHierarchy(buildings, floors, locatedRooms);
    if (roomsList) {
      roomsList.classList.add('eco-content-fade-in');
      roomsList.innerHTML = '';
      
      if (Object.keys(buildings).length === 0 && Object.keys(savedRooms).length === 0) {
        roomsList.innerHTML = '<div class="text-sm text-gray-500 text-center mt-4">No locations available.</div>';
      } else {
        const buildingFloors = {};
        Object.values(buildings).forEach(b => buildingFloors[b.id] = []);
        Object.values(floors).forEach(f => {
          if (buildingFloors[f.building_id]) buildingFloors[f.building_id].push(f);
        });
        
        const floorRooms = {};
        Object.values(floors).forEach(f => floorRooms[f.id] = []);
        Object.values(locatedRooms).forEach(r => {
          if (r.floor_id && floorRooms[r.floor_id]) floorRooms[r.floor_id].push(r);
        });
        
        Object.values(buildings).forEach(building => {
          const bDiv = document.createElement('div');
          bDiv.className = 'mb-2';
          bDiv.classList.add('eco-location-building-group');
          
          const bHeader = document.createElement('div');
          bHeader.className = 'flex items-center gap-2 bg-[#10b981]/10 px-3 py-2 rounded-t border-b border-[#10b981]/30 cursor-pointer hover:bg-[#10b981]/20 transition-colors';
          bHeader.classList.add('eco-location-building');
          bHeader.innerHTML = `
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" class="text-[#10b981]">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
            <span class="font-bold text-[#18392B] dark:text-cyan-400 text-sm">${schedulerEscape(building.name)}</span>
          `;
          
          const floorsContainer = document.createElement('div');
          floorsContainer.className = 'bg-white dark:bg-[#0c1328]/40 border-x border-b border-gray-200 dark:border-white/5 rounded-b p-2 flex flex-col gap-2';
          floorsContainer.classList.add('eco-location-floors');
          
          bHeader.addEventListener('click', () => {
            floorsContainer.style.display = floorsContainer.style.display === 'none' ? 'flex' : 'none';
          });
          
          const myFloors = buildingFloors[building.id] || [];
          if (myFloors.length === 0) floorsContainer.innerHTML = '<div class="text-xs text-gray-400 p-2 text-center">No floors</div>';
          
          myFloors.forEach(floor => {
            const fDiv = document.createElement('div');
            fDiv.className = 'border border-gray-100 dark:border-white/5 rounded bg-gray-50 dark:bg-slate-900/60';
            fDiv.classList.add('eco-location-floor');
            
            const fHeader = document.createElement('div');
            fHeader.className = 'flex items-center px-2 py-1 border-b border-gray-100 dark:border-white/5 cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-800';
            fHeader.classList.add('eco-location-floor-heading');
            fHeader.innerHTML = `
              <span class="text-xs font-semibold text-gray-700 dark:text-gray-200 flex items-center gap-1">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" class="text-gray-400">
                   <rect x="4" y="4" width="16" height="16" rx="2" ry="2" />
                   <line x1="4" y1="12" x2="20" y2="12" />
                </svg>${schedulerEscape(floor.name)}
              </span>
            `;
            
            const roomsContainer = document.createElement('div');
            roomsContainer.className = 'p-1 flex flex-col gap-1';
            roomsContainer.classList.add('eco-location-rooms');
            
            fHeader.addEventListener('click', () => {
              roomsContainer.style.display = roomsContainer.style.display === 'none' ? 'flex' : 'none';
            });
            
            const myRooms = floorRooms[floor.id] || [];
            if (myRooms.length === 0) roomsContainer.innerHTML = '<div class="text-[10px] text-gray-400 p-1 text-center">No rooms</div>';
            
            myRooms.forEach(room => {
              const roomItem = document.createElement('div');
              roomItem.className = 'room-item bg-white dark:bg-slate-950/40 border border-gray-200 dark:border-white/10 p-2 rounded cursor-pointer relative hover:border-[#10b981] dark:hover:border-[#10b981]/60 transition-colors';
              roomItem.classList.add('eco-location-room');
              roomItem.setAttribute('data-room', room.id);
              roomItem.innerHTML = `
                <div class="flex items-center justify-between gap-2">
                  <div class="min-w-0 flex-1">
                    <p class="text-xs font-bold text-[#18392B] dark:text-gray-200 truncate">${schedulerEscape(room.name)}</p>
                    <p class="text-[10px] text-gray-500 dark:text-gray-400 font-medium">${room.nodes.length} AC device node${room.nodes.length === 1 ? '' : 's'}</p>
                  </div>
                </div>
              `;
              roomItem.addEventListener('click', (e) => {
                e.stopPropagation();
                selectRoom(room.id, room, savedRooms);
              });
              roomsContainer.appendChild(roomItem);
            });
            
            fDiv.appendChild(fHeader);
            fDiv.appendChild(roomsContainer);
            floorsContainer.appendChild(fDiv);
          });
          
          bDiv.appendChild(bHeader);
          bDiv.appendChild(floorsContainer);
          roomsList.appendChild(bDiv);
        });
      }

      Object.values(savedRooms).filter(room => room.ungrouped).forEach(room => {
        const item = document.createElement('button'); item.type = 'button';
        item.className = 'eco-location-room room-item'; item.setAttribute('data-room', room.id);
        item.innerHTML = `<span>${schedulerEscape(room.name)}</span><small>${room.nodes.length} AC device node${room.nodes.length === 1 ? '' : 's'}</small>`;
        item.addEventListener('click', () => selectRoom(room.id, room, savedRooms)); roomsList.appendChild(item);
      });
      if (Object.keys(savedRooms).length > 0) {
        const targetRoomId = (selectedRoomId && savedRooms[selectedRoomId]) ? selectedRoomId : Object.keys(savedRooms)[0];
        selectRoom(targetRoomId, savedRooms[targetRoomId], savedRooms);
      } else {
        selectedRoomId = null;
        renderNoRoomsEmptyState();
      }
    } else {
      if (Object.keys(savedRooms).length > 0) {
        const targetRoomId = (selectedRoomId && savedRooms[selectedRoomId]) ? selectedRoomId : Object.keys(savedRooms)[0];
        selectRoom(targetRoomId, savedRooms[targetRoomId], savedRooms);
      } else {
        selectedRoomId = null;
        renderNoRoomsEmptyState();
      }
    }
}

document.addEventListener('DOMContentLoaded', async () => {
  ensureTimePickerModal();
  document.addEventListener('click', event => {
    const trigger = event.target.closest('.sched-time-trigger');
    if (trigger?.dataset.timeTarget) openTimePicker(trigger.dataset.timeTarget, trigger);
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeTimePicker(); });
  await loadSchedulerWithSWR();
  if (!schedulerControllerMode()) return;

  // Multi-tier real-time reactivity
  if (window.EcoDataBus) {
    window.EcoDataBus.on('data:invalidated', (payload) => {
      if (payload?.key === 'aircons') refreshSchedulerAirconSettings();
      if (payload && (payload.key === 'scheduler:data' || payload.key === 'nodes' || payload.key === 'rooms')) {
        loadSchedulerWithSWR(true);
      }
    });
  }

  // Cross-tab broadcast listener
  try {
    if (window.BroadcastChannel) {
      const bc = new BroadcastChannel('ecotrack_aircon_channel');
      bc.onmessage = (msg) => {
        if (msg && msg.data && (msg.data.event === 'node:updated' || msg.data.event === 'devices:synced' || msg.data.event === 'scheduler:refresh')) {
          loadSchedulerWithSWR(true);
        }
      };
    }
  } catch (_) {}

  // In-window AirconSystem events
  if (window.EcoTrackAirconSystem?.AirconEvents) {
    window.EcoTrackAirconSystem.AirconEvents.on('hardware:updated', refreshSchedulerHardware);
    window.EcoTrackAirconSystem.AirconEvents.on('aircon:state_changed', refreshSchedulerControlModes);
    window.EcoTrackAirconSystem.AirconEvents.on('node:updated', () => loadSchedulerWithSWR(true));
    window.EcoTrackAirconSystem.AirconEvents.on('devices:synced', () => loadSchedulerWithSWR(true));
    window.EcoTrackAirconSystem.AirconEvents.on('aircon:saved', () => loadSchedulerWithSWR(true));
    window.EcoTrackAirconSystem.AirconEvents.on('aircons:synced', () => loadSchedulerWithSWR(true));
  }

  // Local storage changes across browser windows
  window.addEventListener('storage', (e) => {
    if (e.key === 'ecoTrack_nodes' || e.key === 'ecoTrack_aircons') {
      try {
        const identity = value => JSON.parse(value || '[]').map(row => [row.db_id,row.node_id,row.device_id,row.controller_node_id,row.room_id,row.name,row.brand]);
        if (JSON.stringify(identity(e.oldValue)) === JSON.stringify(identity(e.newValue))) { refreshSchedulerHardware(); return; }
      } catch (_) {}
      loadSchedulerWithSWR(true);
    }
  });

  // Supabase real-time subscription for nodes table
  if (sb && typeof sb.channel === 'function') {
    try {
      sb.channel('realtime_scheduler_nodes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'nodes' }, payload => {
          if (!window.EcoTrackAirconSystem?.isConnectionOnlyNodeEvent(payload)) loadSchedulerWithSWR(true);
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'aircons' }, () => loadSchedulerWithSWR(true))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'ecotrack_device_state' }, payload => window.EcoTrackAirconSystem?.receiveHardwareEvent(payload))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'ecotrack_device_commands' }, payload => reconcileScheduleDelivery(payload.new || {}))
        .subscribe();
    } catch (_) {}
  }

  // Start background live telemetry sync so temperature matches live dashboard
  setInterval(refreshSchedulerTelemetry, 2500);
});

let schedulerReceiptRead = null;
function refreshSchedulerCommandReceipts() {
  if (schedulerReceiptRead) return schedulerReceiptRead;
  const client = window.supabaseClient || window.sb;
  const queued = [...scheduleDeliveries.values()].filter(entry => entry.label === 'Queued');
  if (!client || !queued.length) return Promise.resolve();
  const ids = [...new Set(queued.map(entry => entry.commandId))];
  schedulerReceiptRead = (async () => {
    const response = await client.from('ecotrack_device_commands').select('*').in('id', ids);
    if (response.error) throw response.error;
    for (const command of response.data || []) reconcileScheduleDelivery(command);
  })().catch(error => console.warn('Schedule receipt refresh failed:', error.message))
    .finally(() => { schedulerReceiptRead = null; });
  return schedulerReceiptRead;
}

async function refreshSchedulerTelemetry() {
  if (document.visibilityState === 'hidden') return;
  await refreshSchedulerCommandReceipts();
  refreshSchedulerControlModes();
  const client = window.supabaseClient || window.sb;
  if (!client) return;
  let states = [];
  let measurements = [];
  try {
    const [telemetry, hardware] = await Promise.all([
      client.from('telemetry').select('*').order('created', { ascending: false }).limit(40),
      window.EcoTrackHardwareCloud.listStatus()
    ]);
    if (telemetry.error) throw telemetry.error;
    measurements = telemetry.data || [];
    states = hardware;
  } catch (error) { console.warn('Scheduler refresh failed:', error.message); }
  const hardwareByNode = new Map(states.map(state => [state.node_id, state]));
  for (const room of Object.values(savedRooms)) for (const node of room.nodes || []) {
    node.cloud_state = hardwareByNode.get(node.pb_id) || node.cloud_state;
    node.status = getSchedulerDeviceState(node.cloud_state);
    const latest = measurements.find(row => [node.id, node.name, node.pb_id].includes(row.node_id) || [node.id, node.name].includes(row.sensor_name));
    if (latest) node.temp = latest.temperature === null || latest.temperature === undefined ? null : Number(latest.temperature);
    updateSchedulerDeviceBadge(node);
    const temperature = document.getElementById(`temperature-${node.id}`);
    if (temperature) temperature.textContent = getSchedulerTargetTemperature(node);
  }
}

function selectRoom(roomId, room, allRooms) {
  // Remove previous selection
  document.querySelectorAll('.room-item').forEach(item => {
    item.classList.remove('border-[#18392B]', 'bg-green-50', 'shadow-md', 'dark:border-[#10b981]', 'dark:bg-emerald-950/20');
    item.classList.add('border-gray-200', 'bg-white', 'dark:border-white/10', 'dark:bg-slate-950/40');
    item.setAttribute('aria-selected', 'false');
  });

  // Add selection to clicked room
  const roomElement = document.querySelector(`[data-room="${roomId}"]`);
  if (roomElement) {
    roomElement.classList.remove('border-gray-200', 'bg-white', 'dark:border-white/10', 'dark:bg-slate-950/40');
    roomElement.classList.add('border-[#18392B]', 'bg-green-50', 'shadow-md', 'dark:border-[#10b981]', 'dark:bg-emerald-950/20');
    roomElement.setAttribute('aria-selected', 'true');
  }

  // Update selected room
  selectedRoomId = roomId;
  schedulerCurrentPage = 1;

  // Update table title
  document.getElementById('tableTitle').innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" class="text-cyan-400"><path d="M12 2L2 7v10c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V7l-10-5z"/><path d="M12 12l-8-4.3 8-4.3 8 4.3"/></svg>${schedulerEscape(room.name)} - AC Device Schedules`;

  // Load nodes for this room in the table
  loadRoomNodes(room.nodes);
}

function resetSchedulerPagination() {
  const pageInfo = document.getElementById('schedulerPageInfo');
  const prevBtn = document.getElementById('schedulerPrevBtn');
  const nextBtn = document.getElementById('schedulerNextBtn');
  const pagesText = document.getElementById('schedulerPaginationPages');

  if (pageInfo) pageInfo.textContent = 'Showing 0 of 0 devices';
  if (pagesText) pagesText.textContent = 'Page 1 of 1';
  if (prevBtn) prevBtn.disabled = true;
  if (nextBtn) nextBtn.disabled = true;
}

function renderNoRoomsEmptyState() {
  const mode = window.EcoTrackMode?.mode || 'controller';
  const deviceName = mode === 'monitoring' ? 'AC sensor devices' : mode === 'both' ? 'AC devices' : 'AC controllers';
  const manageLabel = mode === 'monitoring' ? 'Manage AC Sensor Devices' : mode === 'both' ? 'Manage AC Devices' : 'Manage AC Controllers';
  const schedulerTableBody = document.getElementById('schedulerTableBody');
  const tableTitle = document.getElementById('tableTitle');
  if (tableTitle) {
    tableTitle.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" class="text-cyan-400"><path d="M12 2L2 7v10c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V7l-10-5z"/><path d="M12 12l-8-4.3 8-4.3 8 4.3"/></svg>AC Device Schedules`;
  }
  resetSchedulerPagination();
  if (!schedulerTableBody) return;
  const scrollContainer = schedulerTableBody.closest('.overflow-x-auto');
  if (scrollContainer) scrollContainer.scrollLeft = 0;
  schedulerTableBody.innerHTML = `
    <tr class="text-center bg-white dark:bg-[#0c1328]/40">
      <td colspan="${schedulerControllerMode() ? 11 : 8}" class="px-4 py-16 text-center">
        <div class="flex flex-col items-center justify-center max-w-sm mx-auto">
          <div class="w-14 h-14 rounded-2xl bg-teal-500/10 dark:bg-teal-500/15 text-teal-600 dark:text-teal-400 border border-teal-500/30 flex items-center justify-center mb-3 shadow-xs">
            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </div>
          <h4 class="font-bold text-sm text-slate-800 dark:text-white mb-1">No AC Device Schedules Found</h4>
          <p class="text-xs text-slate-500 dark:text-gray-400 mb-4 leading-relaxed">
            No ${deviceName} are configured for scheduling. Register and assign a device to start setting automated schedules.
          </p>
          <a href="nodes.html" class="px-4 py-2 rounded-xl bg-teal-500/15 hover:bg-teal-500/25 text-teal-600 dark:text-teal-400 border border-teal-500/30 text-xs font-bold inline-flex items-center gap-1.5 transition-all">
            ${manageLabel} &rarr;
          </a>
        </div>
      </td>
    </tr>
  `;
}

function renderSchedulerErrorState(errorMessage) {
  const schedulerTableBody = document.getElementById('schedulerTableBody');
  const roomsList = document.getElementById('roomsList');
  if (roomsList?.querySelector('.eco-skeleton')) { roomsList.textContent = 'Locations unavailable'; roomsList.setAttribute('aria-busy', 'false'); }
  resetSchedulerPagination();
  if (!schedulerTableBody) return;
  schedulerTableBody.innerHTML = `
    <tr class="text-center bg-white dark:bg-[#0c1328]/40">
      <td colspan="${schedulerControllerMode() ? 11 : 8}" class="px-4 py-16 text-center">
        <div class="flex flex-col items-center justify-center max-w-sm mx-auto">
          <div class="w-14 h-14 rounded-2xl bg-rose-500/10 dark:bg-rose-500/15 text-rose-600 dark:text-rose-400 border border-rose-500/30 flex items-center justify-center mb-3 shadow-xs">
            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <h4 class="font-bold text-sm text-slate-800 dark:text-white mb-1">Failed to Load Schedules</h4>
          <p class="text-xs text-slate-500 dark:text-gray-400 mb-4 leading-relaxed">
            ${errorMessage || 'A connection error occurred while loading schedule data.'}
          </p>
          <button type="button" onclick="loadSchedulerWithSWR(true)" class="px-4 py-2 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 text-rose-600 dark:text-rose-400 border border-rose-500/30 text-xs font-bold inline-flex items-center gap-1.5 transition-all cursor-pointer">
            Retry Loading
          </button>
        </div>
      </td>
    </tr>
  `;
}

function loadRoomNodes(nodes) {
  currentRoomNodes = nodes || [];
  const schedulerTableBody = document.getElementById('schedulerTableBody');

  const totalNodes = currentRoomNodes.length;
  const totalPages = Math.max(1, Math.ceil(totalNodes / SCHEDULER_PAGE_SIZE));
  if (schedulerCurrentPage > totalPages) schedulerCurrentPage = totalPages;
  if (schedulerCurrentPage < 1) schedulerCurrentPage = 1;

  const startIdx = (schedulerCurrentPage - 1) * SCHEDULER_PAGE_SIZE;
  const endIdx = Math.min(startIdx + SCHEDULER_PAGE_SIZE, totalNodes);
  const pageNodes = currentRoomNodes.slice(startIdx, endIdx);

  const pageInfo = document.getElementById('schedulerPageInfo');
  const prevBtn = document.getElementById('schedulerPrevBtn');
  const nextBtn = document.getElementById('schedulerNextBtn');
  const pagesText = document.getElementById('schedulerPaginationPages');

  if (pageInfo) {
    pageInfo.textContent = totalNodes === 0
      ? 'Showing 0 of 0 devices'
      : `Showing ${startIdx + 1}–${endIdx} of ${totalNodes} devices`;
  }
  if (pagesText) pagesText.textContent = `Page ${schedulerCurrentPage} of ${totalPages}`;
  if (prevBtn) {
    prevBtn.disabled = schedulerCurrentPage <= 1;
    if (!prevBtn.dataset.bound) {
      prevBtn.dataset.bound = 'true';
      prevBtn.addEventListener('click', () => {
        if (schedulerCurrentPage > 1) {
          schedulerCurrentPage--;
          loadRoomNodes(currentRoomNodes);
        }
      });
    }
  }
  if (nextBtn) {
    nextBtn.disabled = schedulerCurrentPage >= totalPages;
    if (!nextBtn.dataset.bound) {
      nextBtn.dataset.bound = 'true';
      nextBtn.addEventListener('click', () => {
        schedulerCurrentPage++;
        loadRoomNodes(currentRoomNodes);
      });
    }
  }

  if (!nodes || nodes.length === 0) {
    const mode = window.EcoTrackMode?.mode || 'controller';
    const deviceTitle = mode === 'monitoring' ? 'AC Sensor Devices' : mode === 'both' ? 'AC Devices' : 'AC Controllers';
    const deviceName = mode === 'monitoring' ? 'AC sensor device' : mode === 'both' ? 'AC device' : 'AC controller';
    schedulerTableBody.innerHTML = `
      <tr class="text-center bg-white dark:bg-[#0c1328]/40">
        <td colspan="${schedulerControllerMode() ? 11 : 8}" class="px-4 py-16 text-center">
          <div class="flex flex-col items-center justify-center max-w-sm mx-auto">
            <div class="w-14 h-14 rounded-2xl bg-teal-500/10 dark:bg-teal-500/15 text-teal-600 dark:text-teal-400 border border-teal-500/30 flex items-center justify-center mb-3 shadow-xs">
              <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8">
                <rect x="4" y="4" width="16" height="16" rx="2"/>
                <rect x="9" y="9" width="6" height="6"/>
                <line x1="9" y1="1" x2="9" y2="4"/>
                <line x1="15" y1="1" x2="15" y2="4"/>
                <line x1="9" y1="20" x2="9" y2="23"/>
                <line x1="15" y1="20" x2="15" y2="23"/>
                <line x1="20" y1="9" x2="23" y2="9"/>
                <line x1="20" y1="14" x2="23" y2="14"/>
                <line x1="1" y1="9" x2="4" y2="9"/>
                <line x1="1" y1="14" x2="4" y2="14"/>
              </svg>
            </div>
            <h4 class="font-bold text-sm text-slate-800 dark:text-white mb-1">No ${deviceTitle} in This Room</h4>
            <p class="text-xs text-slate-500 dark:text-gray-400 mb-4 leading-relaxed">
              Assign an ${deviceName} to this room to start setting automated schedules.
            </p>
            <a href="nodes.html" class="px-4 py-2 rounded-xl bg-teal-500/15 hover:bg-teal-500/25 text-teal-600 dark:text-teal-400 border border-teal-500/30 text-xs font-bold inline-flex items-center gap-1.5 transition-all">
              Manage ${deviceTitle} &rarr;
            </a>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  let tableRows = '';
  pageNodes.forEach(node => {
    tableRows += createTableRow(node);
  });

  schedulerTableBody.innerHTML = tableRows;

  // Add event listeners for newly added apply buttons
  document.querySelectorAll('.apply-schedule-btn').forEach(button => {
    button.addEventListener('click', (e) => {
      const nodeId = e.currentTarget.dataset.nodeId;
      applyNodeSchedule(nodeId, e.currentTarget);
    });
  });

  // Attach live input & change listeners for data interval value and unit
  document.querySelectorAll('input[id^="interval-val-"]').forEach(input => {
    input.addEventListener('input', (e) => {
      const nId = e.currentTarget.dataset.nodeId;
      const val = parseInt(e.currentTarget.value) || 15;
      if (nId) {
        for (const rId in savedRooms) {
          const room = savedRooms[rId];
          const found = room?.nodes?.find(n => n.id === nId || n.name === nId);
          if (found) found.intervalVal = val;
        }
        if (currentRoomNodes) {
          const foundCurrent = currentRoomNodes.find(n => n.id === nId || n.name === nId);
          if (foundCurrent) foundCurrent.intervalVal = val;
        }
      }
    });
  });

  document.querySelectorAll('select[id^="interval-unit-"]').forEach(select => {
    select.addEventListener('change', (e) => {
      const nId = e.currentTarget.dataset.nodeId;
      const unit = e.currentTarget.value || 'Minutes';
      if (nId) {
        for (const rId in savedRooms) {
          const room = savedRooms[rId];
          const found = room?.nodes?.find(n => n.id === nId || n.name === nId);
          if (found) found.intervalUnit = unit;
        }
        if (currentRoomNodes) {
          const foundCurrent = currentRoomNodes.find(n => n.id === nId || n.name === nId);
          if (foundCurrent) foundCurrent.intervalUnit = unit;
        }
      }
    });
  });
}

function createTableRow(node) {
  const temp = node.temp !== null && node.temp !== undefined && Number.isFinite(Number(node.temp)) ? Number(node.temp) : null;
  const deviceState = schedulerDeviceStatePresentation(node.status);
  const acType = node.ac_type || node.aircon_type || 'Split Type (Inverter)';
  const savedName = typeof node.ac_name === 'string' ? node.ac_name.trim() : '';
  const controllerName = savedName && !/^(?:EcoTrack[-_])?esp32s3[-_:][0-9a-f]{12}$/i.test(savedName)
    ? savedName : 'Aircon name unavailable';
  const escapedControllerName = controllerName.replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const acTag = node.ac_tag || 'No AC assigned';
  
  return `
    <tr class="sched-table-row bg-white dark:bg-[#0c1328]/40 hover:bg-gray-50 dark:hover:bg-slate-900 transition-colors border-b border-gray-100 dark:border-white/5">
      <!-- AC CONTROL NAME -->
      <td class="px-6 py-4">
        <div class="flex items-center gap-3">
          <div class="sched-icon-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="2" x2="12" y2="22"></line>
              <line x1="2" y1="12" x2="22" y2="12"></line>
              <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line>
              <line x1="4.93" y1="19.07" x2="19.07" y2="4.93"></line>
            </svg>
          </div>
          <div>
            <div class="sched-controller-name font-bold text-[#18392B] dark:text-cyan-400 text-sm">${escapedControllerName}</div>
            <div class="flex items-center gap-1.5 mt-0.5 text-xs text-gray-500 dark:text-gray-400 font-medium">
              <span class="px-1.5 py-0.5 rounded font-mono text-[10px] font-bold bg-cyan-500/10 text-cyan-600 dark:text-cyan-300 border border-cyan-500/20">${schedulerEscape(node.deviceLabel || acTag)}</span>
            </div>
          </div>
        </div>
      </td>

      <td class="px-6 py-4 sched-device-name"><span class="font-semibold text-sm">${schedulerEscape((Object.hasOwn(node, 'device_name') ? node.device_name : node.name) || 'Unavailable')}</span>${node.monitor_name ? `<small class="block mt-1 text-xs">Sensor: ${schedulerEscape(node.monitor_name)}</small>` : ''}</td>

      <!-- AIRCON TYPE -->
      <td class="px-6 py-4">
        <span class="font-bold text-[#18392B] dark:text-gray-200 text-sm whitespace-nowrap">${schedulerEscape(acType)}</span>
      </td>

      <!-- TEMPERATURE -->
      <td class="px-6 py-4" data-controller-schedule-field>
        <div class="flex items-center gap-2">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#10b981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"></path>
          </svg>
          <span id="temperature-${node.id}" data-scheduler-target-temp="${encodeURIComponent(node.id)}" class="font-bold text-[#18392B] dark:text-cyan-400 text-sm">${getSchedulerTargetTemperature(node)}</span>
        </div>
      </td>

      <!-- CONTROL MODE -->
      <td class="px-6 py-4" data-controller-schedule-field>
        <div class="flex items-center gap-2">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#22d3ee" stroke-width="2">
            <circle cx="12" cy="12" r="5"></circle>
            <line x1="12" y1="1" x2="12" y2="3"></line>
            <line x1="12" y1="21" x2="12" y2="23"></line>
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
          </svg>
          <span data-scheduler-control-mode="${encodeURIComponent(node.id)}" class="font-bold text-[#18392B] dark:text-teal-300 text-sm">${getSchedulerControlMode(node)}</span>
        </div>
      </td>

      <td class="px-6 py-4" data-controller-schedule-field><span data-scheduler-power-mode="${encodeURIComponent(node.id)}" class="font-bold text-sm">${getSchedulerPowerMode(node)}</span></td>

      <!-- CURRENT STATE -->
      <td class="px-6 py-4">
        <div class="scheduler-device-state" data-device-state="${deviceState.state}" title="ESP32 connection status">
          <span class="scheduler-device-state-dot" aria-hidden="true"></span>
          <span id="status-${node.id}">${deviceState.label}</span>
        </div>
        ${node.connectionDetail ? `<p class="device-scheduler-note">${schedulerEscape(node.connectionDetail)}</p>` : ''}
      </td>

      <!-- WAKE TIME -->
      <td class="sched-time-cell px-6 py-4">
        <button type="button" class="sched-time-trigger" data-time-target="wake-${node.id}" data-time-label="Wake Time" aria-label="Edit wake time">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="sched-time-trigger-icon">
            <circle cx="12" cy="12" r="4"></circle>
            <path d="M12 2v2"></path>
            <path d="M12 20v2"></path>
            <path d="m4.93 4.93 1.41 1.41"></path>
            <path d="m17.66 17.66 1.41 1.41"></path>
            <path d="M2 12h2"></path>
            <path d="M20 12h2"></path>
            <path d="m6.34 17.66-1.41 1.41"></path>
            <path d="m19.07 4.93-1.41 1.41"></path>
          </svg>
          <div class="sched-time-trigger-content">
            <span class="sched-time-trigger-label">WAKE TIME</span>
            <span class="sched-time-trigger-value" id="wake-display-${node.id}">${formatTimeDisplay(node.wakeTime ?? '')}</span>
          </div>
        </button>
        <input type="hidden" id="wake-${node.id}" value="${normalizeScheduleTime(node.wakeTime) || ''}">
      </td>

      <!-- SLEEP TIME -->
      <td class="sched-time-cell px-6 py-4">
        <button type="button" class="sched-time-trigger sleep" data-time-target="sleep-${node.id}" data-time-label="Sleep Time" aria-label="Edit sleep time">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="sched-time-trigger-icon">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
          </svg>
          <div class="sched-time-trigger-content">
            <span class="sched-time-trigger-label">SLEEP TIME</span>
            <span class="sched-time-trigger-value" id="sleep-display-${node.id}">${formatTimeDisplay(node.sleepTime ?? '')}</span>
          </div>
        </button>
        <input type="hidden" id="sleep-${node.id}" value="${normalizeScheduleTime(node.sleepTime) || ''}">
      </td>

      <!-- SEND INTERVAL -->
      <td class="px-6 py-4">
        <div class="sched-interval-box flex items-center gap-1 border-[1px] border-[#10b981] dark:border-[#10b981]/40 rounded-[14px] bg-white dark:bg-slate-900 shadow-sm hover:shadow-md transition-shadow">
          <div class="text-[#334155] dark:text-gray-300 shrink-0">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
            </svg>
          </div>
          <div class="flex flex-col justify-center">
            <span class="text-[10px] font-bold text-gray-400 tracking-widest uppercase">EVERY</span>
            <div class="flex items-center gap-2">
              <input type="number" id="interval-val-${node.id}" value="${node.intervalVal ?? ''}" min="${schedulerControllerMode() ? '1' : '0.0166666667'}" step="${schedulerControllerMode() ? '1' : 'any'}" placeholder="Not set" aria-label="Send interval value" class="w-8 text-lg font-bold text-[#18392B] dark:text-gray-100 bg-transparent border-b-2 border-gray-200 dark:border-white/10 focus:border-[#10b981] focus:outline-none p-0 text-center transition-colors" data-node-id="${node.id}">
              <select id="interval-unit-${node.id}" aria-label="Send interval unit" data-select-size="compact" class="appearance-none border-[1.5px] border-[#10b981] dark:border-[#10b981]/40 rounded-lg px-2 py-0.5 text-sm font-bold text-[#18392B] dark:text-cyan-400 bg-white dark:bg-slate-900 cursor-pointer outline-none focus:ring-2 focus:ring-[#10b981]/20 transition-shadow" style="padding-right: 1.5rem; background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%2318392B%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 0.25rem center; background-size: 1em;" data-node-id="${node.id}">
                ${schedulerControllerMode() ? `<option value="Seconds" ${node.intervalUnit === 'Seconds' ? 'selected' : ''}>Seconds</option>` : ''}
                <option value="Minutes" ${!node.intervalUnit || node.intervalUnit === 'Minutes' ? 'selected' : ''}>Minutes</option>
                <option value="Hours" ${node.intervalUnit === 'Hours' ? 'selected' : ''}>Hours</option>
              </select>
            </div>
          </div>
        </div>
      </td>

      <!-- ACTIONS (APPLY BUTTON & AIRCON CONTROL LINK) -->
      <td class="px-6 py-4">
        <div class="flex items-center gap-2">
          <button id="apply-${node.id}" data-node-id="${node.id}" class="apply-schedule-btn bg-[#18392B] dark:bg-[#10b981] hover:bg-[#10b981] dark:hover:bg-[#059669] hover:text-[#18392B] dark:hover:text-white text-white px-3.5 py-2 rounded-lg font-bold text-xs transition-colors shadow-md border border-[#10b981] dark:border-[#10b981]/40 cursor-pointer">
            ${scheduleDeliveries.get(node.id)?.label || 'Apply'}
          </button>
          <a data-controller-schedule-field href="${node.ac_tag ? 'control.html?id=' + encodeURIComponent(node.ac_tag) : 'nodes.html'}" title="Open in Aircon Control Panel" class="p-2 rounded-lg bg-teal-500/10 hover:bg-teal-500/20 text-teal-600 dark:text-teal-400 border border-teal-500/30 transition-colors flex items-center justify-center cursor-pointer">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2">
              <line x1="4" y1="21" x2="4" y2="14" />
              <line x1="4" y1="10" x2="4" y2="3" />
              <line x1="12" y1="21" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12" y2="3" />
              <line x1="20" y1="21" x2="20" y2="16" />
              <line x1="20" y1="12" x2="20" y2="3" />
              <line x1="1" y1="14" x2="7" y2="14" />
              <line x1="9" y1="8" x2="15" y2="8" />
              <line x1="17" y1="16" x2="23" y2="16" />
            </svg>
          </a>
        </div>
        ${!schedulerControllerMode() ? `<p hidden class="device-scheduler-status" id="delivery-${node.id}" role="status"></p>` : ''}
      </td>
    </tr>
  `;
}

async function applyNodeSchedule(nodeId, buttonElement, { controllerOnly = false } = {}) {
  if (!schedulerControllerMode() && !controllerOnly && window.EcoDeviceScheduler) return window.EcoDeviceScheduler.apply(nodeId, buttonElement);
  const wakeTime = normalizeScheduleTime(document.getElementById(`wake-${nodeId}`)?.value);
  const sleepTime = normalizeScheduleTime(document.getElementById(`sleep-${nodeId}`)?.value);
  const intervalVal = Number(document.getElementById(`interval-val-${nodeId}`)?.value);
  const intervalUnit = document.getElementById(`interval-unit-${nodeId}`)?.value;
  const multiplier = { Seconds: 1, Minutes: 60, Hours: 3600 }[intervalUnit];
  const seconds = Math.round(intervalVal * multiplier);
  if (!wakeTime || !sleepTime) {
    const field = !wakeTime ? 'wake' : 'sleep';
    window.EcoToast?.error(`Choose a valid ${field} time before applying this controller schedule.`);
    document.querySelector?.(`[data-time-target="${field}-${nodeId}"]`)?.focus();
    return;
  }
  if ((schedulerControllerMode() && !Number.isInteger(intervalVal)) || Math.abs(intervalVal * multiplier - seconds) > 0.00001 || !Number.isInteger(seconds) || seconds < 1 || seconds > 86400) {
    window.EcoToast?.error('The report interval must be a whole number between 1 second and 24 hours. Check the value and unit.');
    document.getElementById(`interval-val-${nodeId}`)?.focus?.();
    return;
  }
  if (buttonElement) { buttonElement.disabled = true; buttonElement.textContent = 'Saving...'; }
  try {
    const command = await window.EcoTrackHardwareCloud.request(nodeId, 'configure', { interval_seconds: seconds, interval_val: intervalVal, interval_unit: intervalUnit, wake_time: wakeTime, sleep_time: sleepTime }, { wait: false });
    scheduleDeliveries.set(nodeId, { nodeId, databaseNodeId: command.node_id, commandId: command.id, seconds, wakeTime, sleepTime, label: 'Queued', button: buttonElement });
    scheduleDrafts.delete(nodeId);
    const wakeInput = document.getElementById(`wake-${nodeId}`), sleepInput = document.getElementById(`sleep-${nodeId}`);
    if (wakeInput) wakeInput.value = wakeTime;
    if (sleepInput) sleepInput.value = sleepTime;
    updateNodeSleepNote(nodeId);
    for (const room of Object.values(savedRooms)) for (const node of room.nodes || []) {
      if (node.id === nodeId || node.name === nodeId) Object.assign(node, { wakeTime, sleepTime, intervalVal, intervalUnit });
    }
    const nodes = window.EcoTrackAirconSystem?.NodeService?.getNodes?.() || [];
    const node = nodes.find(item => [item.node_id,item.db_id,item.pb_id].includes(nodeId));
    if (node) {
      Object.assign(node, { wake_time: wakeTime, sleep_time: sleepTime, interval_val: intervalVal, interval_unit: intervalUnit });
      localStorage.setItem('ecoTrack_nodes', JSON.stringify(nodes));
    }
    window.EcoDataBus?.invalidate('nodes'); window.EcoDataBus?.invalidate('scheduler:data');
    window.EcoToast?.success('Schedule saved in Supabase. Device application is queued; a sleeping device receives it after waking.');
    if (buttonElement) {
      buttonElement.textContent = 'Queued';
      buttonElement.dataset ||= {};
      buttonElement.dataset.commandId = command.id;
    }
    if (window.EcoTrackHardwareCloud.waitForResult) {
      void window.EcoTrackHardwareCloud.waitForResult(command, { timeoutMs: 25000 }).then(receipt => {
        if (buttonElement?.dataset.commandId !== command.id || scheduleDeliveries.get(nodeId)?.commandId !== command.id) return;
        if (receipt.interval_ms !== seconds * 1000 || receipt.wake_time !== wakeTime || receipt.sleep_time !== sleepTime) throw new Error('Device schedule acknowledgement does not match the request.');
        scheduleDeliveries.get(nodeId).label = 'Applied';
        (document.getElementById(`apply-${nodeId}`) || buttonElement).textContent = 'Applied';
        window.EcoToast?.success('ESP32 confirmed that the schedule was applied.');
        window.dispatchEvent(new CustomEvent('ecotrack:schedule-applied', { detail: receipt }));
      }).catch(error => {
        if (buttonElement?.dataset.commandId !== command.id || scheduleDeliveries.get(nodeId)?.commandId !== command.id || scheduleDeliveries.get(nodeId)?.label === 'Applied') return;
        const label = error.code === 'ACK_TIMEOUT' ? 'Queued' : 'Failed';
        scheduleDeliveries.get(nodeId).label = label;
        (document.getElementById(`apply-${nodeId}`) || buttonElement).textContent = label;
        buttonElement.title = error.message;
        if (error.code !== 'ACK_TIMEOUT') window.EcoToast?.error(error.message);
      });
    }
    // A queue write is not proof that the device has applied it.
    window.dispatchEvent(new CustomEvent('ecotrack:schedule-queued', { detail: command }));
    return command;
  } catch (error) {
    window.EcoToast?.error(error.message);
    if (buttonElement) buttonElement.textContent = 'Apply';
    return null;
  } finally { if (buttonElement) buttonElement.disabled = false; }
}

// Custom Warning Modal
function showWarningModal(message) {
  const modalHTML = `
    <div id="collision-modal" class="fixed inset-0 bg-slate-900/80 backdrop-blur-sm z-50 flex items-center justify-center animate-in fade-in duration-200">
      <div class="bg-slate-800 border border-amber-500/50 rounded-xl shadow-2xl p-6 max-w-md w-full mx-4 transform transition-all">
        <div class="flex items-center gap-3 mb-4 text-amber-400">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <h3 class="text-xl font-bold">Collision Warning</h3>
        </div>
        <p class="text-slate-300 mb-6 leading-relaxed">${message}</p>
        <div class="flex justify-end">
          <button onclick="document.getElementById('collision-modal').remove()" class="px-5 py-2 bg-slate-700 hover:bg-slate-600 text-white font-semibold rounded transition-colors border border-slate-600">
            Got it
          </button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', modalHTML);
}




