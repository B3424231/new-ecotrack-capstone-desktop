// ===== ECOTRACK SHARED UTILITIES =====
const API_BASE = 'http://localhost:5000/api';


// ===== SHARED STATE =====
const appState = {
  currentTemp: 0,
  currentPressure: 0,
  batteryVoltage: 3.8,
  batteryUsable: true,
  rssi: 0,
  isConnected: false,
  historicalData: { temps: [], pressures: [], timestamps: [] },
  isSleeping: true,
  lastUpdate: Date.now(),
  logMessages: [],
  maxLogs: 50
};

// ===== API CALLS =====
async function fetchAPI(endpoint, options = {}) {
  try {
    const url = `${API_BASE}${endpoint}`;
    if (window.EcoNetwork) {
      return await window.EcoNetwork.fetchJson(url, options);
    }
    const response = await fetch(url, options);
    if (response.ok) {
      return await response.json();
    }
  } catch (error) {
    console.warn(`[shared.js] API Error on ${endpoint}:`, error.message);
  }
  return null;
}

async function postAPI(endpoint, data, options = {}) {
  try {
    const url = `${API_BASE}${endpoint}`;
    const fetchOpts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      body: JSON.stringify(data),
      ...options
    };
    if (window.EcoNetwork) {
      return await window.EcoNetwork.fetchJson(url, fetchOpts);
    }
    const response = await fetch(url, fetchOpts);
    if (response.ok) {
      return await response.json();
    }
  } catch (error) {
    console.warn(`[shared.js] API Error on POST ${endpoint}:`, error.message);
  }
  return null;
}

// ===== CONTROL SIMULATION =====
// Mock data removed in favor of live telemetry.

// Page loader removed.

// ===== UTILITY FUNCTIONS =====
function estimateACDial(temp) {
  if (temp < 20) return 'Off';
  if (temp < 24) return 'Eco';
  if (temp < 28) return 'Active Cooling';
  return 'Cold';
}

function getACDescription(acMode) {
  const descriptions = {
    'Off': 'No active cooling',
    'Eco': 'Light cooling mode',
    'Active Cooling': 'Standard cooling',
    'Cold': 'Maximum cooling'
  };
  return descriptions[acMode] || 'Unknown';
}

function calculateEfficiency(temp) {
  const optimal = 24;
  const deviation = Math.abs(temp - optimal);
  return Math.max(0, 100 - (deviation * 5));
}

function updateRSSIBars(rssi) {
  const bars = document.querySelectorAll('#rssiBar div');
  const signal = Math.max(0, Math.min(100, (rssi + 100) * 2));
  const activeCount = Math.ceil((signal / 100) * 5);

  bars.forEach((bar, i) => {
    if (i < activeCount) {
      bar.className = 'w-2 h-6 bg-cyan-500';
    } else {
      bar.className = 'w-2 h-6 bg-slate-700';
    }
  });
}

function updateConnectionStatus(isConnected) {
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const sidebarStatus = document.getElementById('sidebarStatus');
  const sidebarStatusText = document.getElementById('sidebarStatusText');

  if (isConnected) {
    statusDot && (statusDot.className = 'w-3 h-3 bg-green-500 rounded-full animate-pulse');
    statusText && (statusText.textContent = 'Online');
    sidebarStatus && (sidebarStatus.className = 'w-3 h-3 bg-green-500 rounded-full animate-pulse');
    sidebarStatusText && (sidebarStatusText.textContent = 'Online');
  } else {
    statusDot && (statusDot.className = 'w-3 h-3 bg-red-500 rounded-full');
    statusText && (statusText.textContent = 'Offline');
    sidebarStatus && (sidebarStatus.className = 'w-3 h-3 bg-red-500 rounded-full');
    sidebarStatusText && (sidebarStatusText.textContent = 'Offline');
  }
}

function addLog(message) {
  const timestamp = new Date().toLocaleTimeString();
  const logEntry = `[${timestamp}] ${message}`;

  appState.logMessages.push(logEntry);
  if (appState.logMessages.length > appState.maxLogs) {
    appState.logMessages.shift();
  }

  updateLogDisplay();
}

function updateLogDisplay() {
  const logConsole = document.getElementById('logConsole');
  if (logConsole) {
    logConsole.innerHTML = appState.logMessages
      .map(msg => `<div>${msg}</div>`)
      .join('');
    logConsole.scrollTop = logConsole.scrollHeight;
  }
}

async function checkBackendConnection() {
  let backendOk = false, supabaseOk = false;
  try {
    const backendUrl = window.ECOTRACK_CONFIG?.backendUrl || window.BACKEND_URL || 'http://localhost:5000';
    backendOk = (await fetch(`${backendUrl}/api/health`)).ok;
  } catch (_) {}
  if (window.supabaseClient && window.ECOTRACK_CONFIG?.isSupabaseConfigured()) {
    try {
      await window.ecotrackAuthReady;
      const { error } = await window.supabaseClient.from('nodes').select('id', { count: 'exact', head: true });
      supabaseOk = !error;
    } catch (_) {}
  }
  const connected = backendOk && supabaseOk, status = `${backendOk}:${supabaseOk}`;
  if (appState.connectionHealth !== status) addLog(connected ? 'System Online: Connected to SQLite backend and Supabase'
    : `System connection: SQLite backend ${backendOk ? 'online' : 'offline'}, Supabase ${supabaseOk ? 'online' : 'offline'}`);
  appState.connectionHealth = status;
  appState.isConnected = connected;
  updateConnectionStatus(connected);
}

// ===== SESSION TIMEOUT & INACTIVITY WATCHER =====
let _sessionTimeoutTimer = null;
let _sessionWarningTimer = null;

function getSessionTimeoutMs() {
  const user = JSON.parse(localStorage.getItem('ecoTrack_profile_user') || '{}');
  const timeoutSetting = localStorage.getItem('ecoTrack_session_timeout') || user.session_timeout || '30 minutes';
  
  if (timeoutSetting === '15 minutes') return 15 * 60 * 1000;
  if (timeoutSetting === '30 minutes') return 30 * 60 * 1000;
  if (timeoutSetting === '60 minutes') return 60 * 60 * 1000;
  if (timeoutSetting === 'Never') return 0; // Disabled
  return 30 * 60 * 1000; // Default: 30 minutes
}

function resetSessionTimeoutTimer() {
  // Do not run timeout on login page
  const path = window.location.pathname.toLowerCase();
  if (path.endsWith('login.html') || path.endsWith('/login')) {
    return;
  }

  const timeoutMs = getSessionTimeoutMs();
  if (timeoutMs === 0) {
    if (_sessionTimeoutTimer) clearTimeout(_sessionTimeoutTimer);
    if (_sessionWarningTimer) clearTimeout(_sessionWarningTimer);
    return;
  }

  if (_sessionTimeoutTimer) clearTimeout(_sessionTimeoutTimer);
  if (_sessionWarningTimer) clearTimeout(_sessionWarningTimer);

  // Warning 1 minute before timeout
  const warningMs = Math.max(10000, timeoutMs - 60000);
  _sessionWarningTimer = setTimeout(() => {
    if (typeof showEcoTrackToast === 'function') {
      showEcoTrackToast('⚠️ Your session will expire in 1 minute due to inactivity.', 'warning');
    }
  }, warningMs);

  _sessionTimeoutTimer = setTimeout(() => {
    console.warn('[EcoTrack] Session timed out due to inactivity.');
    try {
      sessionStorage.clear();
    } catch (e) {}
    window.location.href = 'login.html?timeout=true';
  }, timeoutMs);
}

function initSessionTimeoutWatcher() {
  const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'];
  events.forEach(event => {
    window.addEventListener(event, resetSessionTimeoutTimer, { passive: true });
  });
  resetSessionTimeoutTimer();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSessionTimeoutWatcher);
} else {
  initSessionTimeoutWatcher();
}

// Fix keyboard focus routing bug in Chromium/Electron/WebViews on alt-tab window focus
window.addEventListener('focus', () => {
  const active = document.activeElement;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
    active.blur();
    active.focus();
  }
});

// ===== RULE VIOLATION AUDIT HISTORY (Persistent Store) =====
// Ensures that rule violations in Rule Management (benchmarking, rankings, history board)
// are permanently preserved even when a user clears or erases notifications from the Notification page inbox.
const ECOTRACK_VIOLATION_AUDIT_KEY = 'ecoTrack_violation_audit_history';

function getStoredViolationAuditHistory() {
  try {
    const raw = localStorage.getItem(ECOTRACK_VIOLATION_AUDIT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Sanitize: filter out wake, sleep, schedule, interval, and battery notifications
    return parsed.filter(item => {
      if (!item || item.type === 'controller_installation') return false;
      const text = String(item.content || item.message || '').toLowerCase();
      if (
        text.includes('wake') ||
        text.includes('sleep') ||
        text.includes('schedule') ||
        text.includes('scheduled') ||
        text.includes('scheduler') ||
        text.includes('interval') ||
        text.includes('cycle') ||
        text.includes('battery')
      ) {
        return false;
      }
      return true;
    });
  } catch (_) {
    return [];
  }
}

function saveViolationToAuditHistory(notif) {
  if (!notif || notif.type === 'controller_installation') return;
  try {
    const history = getStoredViolationAuditHistory();
    const rawContent = String(notif.rawContent || notif.content || notif.message || '')
      .replace(/^__INBOX_DISMISSED__\|\|\|/, '')
      .trim();
    if (!rawContent) return;

    // Routine schedule alerts, wake/sleep events, and battery notices are notifications only, NOT compliance violations
    const textLower = rawContent.toLowerCase();
    if (
      textLower.includes('wake') ||
      textLower.includes('sleep') ||
      textLower.includes('schedule') ||
      textLower.includes('scheduled') ||
      textLower.includes('scheduler') ||
      textLower.includes('interval') ||
      textLower.includes('cycle') ||
      textLower.includes('battery')
    ) {
      return;
    }

    const notifId = String(notif.id || notif.pbId || '').trim();
    const dateStr = notif.date || (notif.created ? new Date(notif.created).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]);
    const timeStr = notif.time || (notif.created ? new Date(notif.created).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }) : '');
    const roomId = notif.room_id || notif.room || notif.roomId || null;
    const ruleId = notif.rule_id || notif.ruleId || null;

    const existsIndex = history.findIndex(h => {
      if (notifId && h.id && String(h.id) === notifId) return true;
      if (h.content === rawContent && h.date === dateStr && String(h.room_id) === String(roomId)) return true;
      return false;
    });

    const entry = {
      id: notifId || `v_hist_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      pbId: notifId,
      room_id: roomId,
      rule_id: ruleId,
      content: rawContent,
      date: dateStr,
      time: timeStr,
      created: notif.created || new Date().toISOString(),
      triggered: true,
      archived: true,
      node_id: notif.node_id || notif.node || null,
      is_dismissed_from_inbox: notif.is_dismissed_from_inbox === true ||
        String(notif.rawContent || notif.content || '').startsWith('__INBOX_DISMISSED__|||') ||
        (existsIndex >= 0 && history[existsIndex].is_dismissed_from_inbox === true)
    };

    if (existsIndex >= 0) {
      history[existsIndex] = { ...history[existsIndex], ...entry };
    } else {
      history.unshift(entry);
    }

    if (history.length > 5000) {
      history.length = 5000;
    }

    localStorage.setItem(ECOTRACK_VIOLATION_AUDIT_KEY, JSON.stringify(history));
  } catch (err) {
    console.warn('[EcoTrack] Failed to save violation to audit history:', err);
  }
}

function clearStoredViolationAuditHistory() {
  try {
    localStorage.removeItem(ECOTRACK_VIOLATION_AUDIT_KEY);
    localStorage.removeItem('ecoTrack_violationAuditHistory');
  } catch (_) {}
}

function removeViolationFromAuditHistory(notifId) {
  if (!notifId) return;
  try {
    const history = getStoredViolationAuditHistory();
    const updated = history.filter(h => String(h.id) !== String(notifId) && String(h.pbId) !== String(notifId));
    localStorage.setItem(ECOTRACK_VIOLATION_AUDIT_KEY, JSON.stringify(updated));
    localStorage.setItem('ecoTrack_violationAuditHistory', JSON.stringify(updated));
  } catch (_) {}
}

// Auto-purge stale violation history on initialization (requested reset)
try {
  if (!localStorage.getItem('ecoTrack_violationHistoryCleaned_v1')) {
    clearStoredViolationAuditHistory();
    localStorage.setItem('ecoTrack_violationHistoryCleaned_v1', 'true');
  }
} catch (_) {}

window.getStoredViolationAuditHistory = getStoredViolationAuditHistory;
window.saveViolationToAuditHistory = saveViolationToAuditHistory;
window.clearStoredViolationAuditHistory = clearStoredViolationAuditHistory;
window.removeViolationFromAuditHistory = removeViolationFromAuditHistory;

// Keep incomplete location records visible without changing their stored IDs.
window.ensureLocationHierarchy = function(buildings, floors, rooms) {
  const defaultBuilding = () => {
    const id = '__unassigned_building__';
    buildings[id] ||= { id, name: 'Unassigned Locations' };
    return id;
  };
  Object.values(floors).forEach(floor => {
    if (!buildings[floor.building_id]) floor.building_id = defaultBuilding();
  });
  Object.values(rooms).forEach(room => {
    if (floors[room.floor_id]) return;
    const buildingId = buildings[room.building_id] ? room.building_id : defaultBuilding();
    const id = `__general_floor__${buildingId}`;
    floors[id] ||= { id, name: 'Unassigned / General Area', building_id: buildingId };
    room.floor_id = id;
  });
};

