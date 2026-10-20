// ===== GLOBAL NOTIFICATION & RULES MONITORING SYSTEM =====
// This script is included on all EcoTrack pages to provide background rule monitoring and alert notifications.

let globalTriggeredCount = 0;
let globalNotificationBadgeRequest = 0;
let _cachedRules = null;
let _cachedRuleNodes = null;
let _lastRulesFetchTime = 0;
const _ruleViolationTracking = {};
const _recentTriggeredKeys = new Set();

window.invalidateRulesCache = function() {
  _cachedRules = null;
  _cachedRuleNodes = null;
  _lastRulesFetchTime = 0;
};
window.addEventListener('rules:updated', () => {
  if (typeof window.invalidateRulesCache === 'function') {
    window.invalidateRulesCache();
  }
});

// Update badge on all pages
async function updateGlobalNotificationBadge() {
  const request = ++globalNotificationBadgeRequest;
  if (window._notificationInboxMutations) return;
  const revision = window._notificationInboxRevision || 0;
  const storedRevision = localStorage.getItem('ecoTrackNotificationInboxRevision');
  const isCurrent = () => request === globalNotificationBadgeRequest && !window._notificationInboxMutations &&
    revision === (window._notificationInboxRevision || 0) && storedRevision === localStorage.getItem('ecoTrackNotificationInboxRevision');
  const isNotifEnabled = localStorage.getItem('ecoTrack_notifications_enabled') !== 'false';

  if (!isNotifEnabled) {
    const badge = document.getElementById('notificationBadge');
    if (badge) {
      badge.classList.add('hidden');
      badge.style.display = 'none';
    }
    const headerBadge = document.getElementById('headerNotificationBadge');
    if (headerBadge) {
      headerBadge.classList.add('hidden');
      headerBadge.style.display = 'none';
    }
    const analyticsBadge = document.getElementById('analyticsAlertsBadge');
    if (analyticsBadge) {
      analyticsBadge.classList.add('hidden');
      analyticsBadge.style.display = 'none';
    }
    return;
  }

  try {
    const readState = JSON.parse(localStorage.getItem('ecoTrackNotificationReadState') || '{}');
    
    let records = [];
    let ipcLoaded = false;
    if (window.electron && typeof window.electron.invoke === 'function') {
      try {
        const res = await window.electron.invoke('notifications-fetch-all');
        if (res && res.success && res.data) {
          records = res.data;
          ipcLoaded = true;
        }
      } catch (ipcErr) {
        console.warn('IPC notifications-fetch-all error in badge:', ipcErr);
      }
    }

    if (!ipcLoaded) {
      const sb = window.supabaseClient || window.sb;
      if (sb) {
        try {
          const { data, error } = await sb
            .from('notifications')
            .select('*')
            .order('created', { ascending: false });
          if (!error && data) {
            records = data;
          }
        } catch (e) {
          // Supabase query error
        }
      }
    }
    
    if (!isCurrent()) return;
    // Re-check after async query
    if (localStorage.getItem('ecoTrack_notifications_enabled') === 'false') {
      const badge = document.getElementById('notificationBadge');
      if (badge) { badge.classList.add('hidden'); badge.style.display = 'none'; }
      const headerBadge = document.getElementById('headerNotificationBadge');
      if (headerBadge) { headerBadge.classList.add('hidden'); headerBadge.style.display = 'none'; }
      const analyticsBadge = document.getElementById('analyticsAlertsBadge');
      if (analyticsBadge) { analyticsBadge.classList.add('hidden'); analyticsBadge.style.display = 'none'; }
      return;
    }

    globalTriggeredCount = records.filter(notification => 
      notification.triggered &&
      notification.is_dismissed_from_inbox !== true &&
      !(notification.content && String(notification.content).startsWith('__INBOX_DISMISSED__|||')) &&
      !readState[String(notification.id || notification.pbId || notification.id_internal || '')]
    ).length;
    
    // Update sidebar bell badge
    const badge = document.getElementById('notificationBadge');
    if (badge) {
      if (globalTriggeredCount > 0) {
        badge.classList.remove('hidden');
        badge.style.display = 'flex';
        badge.textContent = globalTriggeredCount;
      } else {
        badge.classList.add('hidden');
        badge.style.display = 'none';
      }
    }

    // Update header notification badge if present (e.g., in Admin Profile header)
    const headerBadge = document.getElementById('headerNotificationBadge');
    if (headerBadge) {
      if (globalTriggeredCount > 0) {
        headerBadge.classList.remove('hidden');
        headerBadge.style.display = 'flex';
        headerBadge.textContent = globalTriggeredCount > 99 ? '99+' : globalTriggeredCount;
      } else {
        headerBadge.classList.add('hidden');
        headerBadge.style.display = 'none';
      }
    }

    // Update analytics page alerts badge if it exists
    const analyticsBadge = document.getElementById('analyticsAlertsBadge');
    if (analyticsBadge) {
      analyticsBadge.textContent = globalTriggeredCount;
      if (globalTriggeredCount > 0) {
        analyticsBadge.classList.remove('hidden');
        analyticsBadge.style.display = 'flex';
      } else {
        analyticsBadge.classList.add('hidden');
        analyticsBadge.style.display = 'none';
      }
    }
  } catch (error) {
    console.error('Could not load notification badge count:', error);
  }
}

// Dismiss notification dialog
function dismissGlobalNotification() {
  const dialog = document.getElementById('globalNotificationDialog');
  if (dialog) {
    dialog.style.display = 'none';
  }
  const pending = sessionStorage.getItem('pendingNav');
  if (pending) {
    try {
      const parsed = JSON.parse(pending);
      if (parsed.notif) {
        const readState = JSON.parse(localStorage.getItem('ecoTrackNotificationReadState') || '{}');
        readState[String(parsed.notif)] = true;
        localStorage.setItem('ecoTrackNotificationReadState', JSON.stringify(readState));
        updateGlobalNotificationBadge();
      }
    } catch (_) {}
  }
}

// Universal notification navigation helper: restores Electron window on Windows,
// persists navigation context, and either directs to Notification.html or opens the modal dynamically
function navigateToNotification(navContext = {}) {
  if (navContext.report_id) {
    window.location.href = `staff.html?verifyReport=${encodeURIComponent(navContext.report_id)}`;
    return;
  }
  // 1. Restore & focus Electron window via IPC
  try {
    if (window.electron && typeof window.electron.send === 'function') {
      window.electron.send('focus-window');
    }
  } catch (_) {}

  try {
    window.focus();
  } catch (_) {}

  const roomId = navContext.room_id || navContext.room || '';
  const notifId = navContext.id || navContext.notif_id || navContext.notif || '';
  const control = navContext.sensor_name || navContext.control || '';
  const message = navContext.message || navContext.content || '';

  const navPayload = {
    room: roomId,
    notif: notifId,
    highlight: notifId,
    control: control,
    message: message,
    timestamp: Date.now()
  };

  try {
    sessionStorage.setItem('pendingNav', JSON.stringify(navPayload));
  } catch (_) {}

  try {
    localStorage.setItem('ecoTrack_pendingNotificationNav', JSON.stringify(navPayload));
  } catch (_) {}

  // 2. Check if we are ALREADY on Notification.html
  const currentPath = (window.location.pathname || '').toLowerCase();
  const isAlreadyOnNotifPage = currentPath.endsWith('notification.html') ||
                               (typeof window.focusAndOpenNotification === 'function');

  if (isAlreadyOnNotifPage && typeof window.focusAndOpenNotification === 'function') {
    window.focusAndOpenNotification(notifId, navPayload);
    return;
  }

  // 3. Otherwise navigate to Notification.html with query parameters
  let destUrl = 'Notification.html';
  const qParams = [];
  if (roomId) qParams.push(`room=${encodeURIComponent(roomId)}`);
  if (notifId) qParams.push(`notif=${encodeURIComponent(notifId)}`);
  if (control) qParams.push(`control=${encodeURIComponent(control)}`);
  if (qParams.length) destUrl += `?${qParams.join('&')}`;

  window.location.href = destUrl;
}

window.navigateToNotification = navigateToNotification;

// Function to trigger global notification from any page
function triggerGlobalNotification(message, notifContext = {}) {
  // Check if notifications are disabled/muted by user BEFORE doing anything
  if (localStorage.getItem('ecoTrack_notifications_enabled') === 'false') {
    return;
  }

  updateGlobalNotificationBadge(); // Re-sync from DB
  
  // Clean message for display if it includes node prefix
  let displayMessage = message;
  let controlPrefix = '';
  if (displayMessage && displayMessage.includes('|||')) {
    const parts = displayMessage.split('|||');
    controlPrefix = parts[0];
    displayMessage = parts.slice(1).join('|||');
  }

  const roomId = notifContext.room_id || notifContext.room || '';
  const notifId = notifContext.id || notifContext.notif_id || '';
  const controlName = notifContext.control_name || notifContext.sensor_name || controlPrefix;

  // Store in pendingNav so clicking redirect takes user directly to this notification record
  const navData = {
    room: roomId,
    notif: notifId,
    highlight: notifId,
    control: controlName,
    message: displayMessage,
    content: message,
    report_id: notifContext.report_id,
    timestamp: Date.now()
  };
  try { sessionStorage.setItem('pendingNav', JSON.stringify(navData)); } catch (_) {}
  try { localStorage.setItem('ecoTrack_pendingNotificationNav', JSON.stringify(navData)); } catch (_) {}

  // Update redirect link on the global notification popup dialog
  const dialog = document.getElementById('globalNotificationDialog');
  const messageEl = document.getElementById('globalNotificationMessage');
  
  if (dialog) {
    const viewLinks = dialog.querySelectorAll('a[href*="Notification.html"], #goToNotificationsBtn');
    viewLinks.forEach(link => {
      link.onclick = (e) => {
        e.preventDefault();
        navigateToNotification({
          id: notifId,
          room_id: roomId,
          control_name: controlName,
          sensor_name: controlName,
          report_id: notifContext.report_id,
          message: displayMessage,
          content: message
        });
      };
    });
  }

  // Strip redundant leading status emojis (⏰, 🌙, ⚠️, 📅, 🌡️, 🔋) so only the notification title has the icon
  const cleanBodyMessage = (displayMessage || '').replace(/^[⏰🌙⚠️🌡️🔋📅\s]+/, '').trim();

  if (dialog && messageEl) {
    messageEl.textContent = cleanBodyMessage;
    const titleEl = dialog.querySelector('h3');
    if (titleEl) {
      if (displayMessage.includes('Wake Up')) {
        titleEl.textContent = '⏰ Control Wake Up!';
      } else if (displayMessage.includes('Sleep Schedule') || displayMessage.includes('Sleep')) {
        titleEl.textContent = '🌙 Control Sleep Mode!';
      } else {
        titleEl.textContent = 'New Notification!';
      }
    }
    const dialogCard = dialog.querySelector('div');
    if (dialogCard) {
      dialogCard.style.pointerEvents = 'auto';
    }
    dialog.style.backgroundColor = 'transparent';
    dialog.style.pointerEvents = 'none';
    dialog.style.display = 'flex';
  }

  // Native browser desktop notification with click redirect
  if (typeof Notification !== 'undefined') {
    if (Notification.permission === 'granted') {
      try {
        let notifTitle = '⚠️ EcoTrack Threshold Alert';
        if (displayMessage.includes('Wake Up')) notifTitle = '⏰ EcoTrack Control Wake Up';
        else if (displayMessage.includes('Sleep Schedule') || displayMessage.includes('Sleep')) notifTitle = '🌙 EcoTrack Control Sleep Schedule';
        else if (notifContext.report_id) notifTitle = 'EcoTrack Maintenance Verification Required';

        const browserNotif = new Notification(notifTitle, {
          body: cleanBodyMessage,
          icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="%2310b981" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>'
        });
        browserNotif.onclick = () => {
          navigateToNotification({
            id: notifId,
            room_id: roomId,
            control_name: controlName,
            sensor_name: controlName,
            report_id: notifContext.report_id,
            message: cleanBodyMessage,
            content: message
          });
        };
      } catch (_) {}
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission();
    }
  }

  // Dispatch global event and immediately re-evaluate rule violation benchmarks so every triggered alert is counted
  try {
    window.dispatchEvent(new CustomEvent('notification:triggered', {
      detail: { roomId, notifId, controlName, message: displayMessage }
    }));
    if (typeof window.initRuleComplianceBenchmarking === 'function') {
      window.initRuleComplianceBenchmarking();
    }
    if (typeof window.renderComplianceChart === 'function') {
      window.renderComplianceChart();
    }
  } catch (_) {}
}

// Get current triggered count
function getTriggeredNotificationCount() {
  return globalTriggeredCount;
}

// Ensure resetting just forces a sync
function resetNotificationCount() {
  updateGlobalNotificationBadge();
}

window.syncNotificationBadges = updateGlobalNotificationBadge;

// ===== AUTOMATED BACKGROUND RULE EVALUATION ENGINE =====

async function getActiveRulesAndNodes() {
  const now = Date.now();
  const sb = window.supabaseClient || window.sb;
  if (!sb) return { rules: [], ruleNodes: [], nodes: [], rooms: [], nodeMap: {} };

  if (_cachedRules && (now - _lastRulesFetchTime) < 8000) {
    return {
      rules: _cachedRules,
      ruleNodes: _cachedRuleNodes || [],
      nodes: _cachedNodes || [],
      rooms: _cachedRooms || [],
      nodeMap: _cachedNodeMap || {}
    };
  }

  try {
    let rulesData = [];
    let rnData = [];
    let allNodes = [];
    let allRooms = [];
    let ipcLoaded = false;

    if (window.electron && typeof window.electron.invoke === 'function') {
      try {
        const rData = await window.electron.invoke('rules-fetch-data');
        if (rData && rData.success) {
          rulesData = (rData.rules || []).filter(r => r.enabled !== false && r.enabled !== 'false' && r.enabled !== 0 && r.enabled !== '0');
          rnData = rData.ruleNodes || [];
          allNodes = rData.nodes || [];
          allRooms = rData.rooms || [];
          ipcLoaded = true;
        }
      } catch (ipcErr) {
        console.warn('IPC rules-fetch-data error, fallback to sb:', ipcErr);
      }
    }

    if (!ipcLoaded && sb) {
      const [rulesRes, rnRes, nodesRes, roomsRes] = await Promise.all([
        sb.from('rules').select('*').eq('enabled', true),
        sb.from('rule_nodes').select('*'),
        sb.from('nodes').select('*'),
        sb.from('rooms').select('*')
      ]);
      rulesData = rulesRes.data || [];
      rnData = rnRes.data || [];
      allNodes = nodesRes.data || [];
      allRooms = roomsRes.data || [];
    }

    const nodeMap = {};
    allNodes.forEach(n => {
      if (n.id) nodeMap[n.id] = n;
      if (n.name) nodeMap[n.name] = n;
    });

    const ruleNodes = rnData.map(rn => ({
      ...rn,
      node_name: nodeMap[rn.node_id]?.name || rn.node_id
    }));

    _cachedRules = rulesData;
    _cachedRuleNodes = ruleNodes;
    _cachedNodes = allNodes;
    _cachedRooms = allRooms;
    _cachedNodeMap = nodeMap;
    _lastRulesFetchTime = now;

    return {
      rules: _cachedRules,
      ruleNodes: _cachedRuleNodes,
      nodes: _cachedNodes,
      rooms: _cachedRooms,
      nodeMap: _cachedNodeMap
    };
  } catch (err) {
    console.warn('[EcoTrack Rules Engine] Error loading rules:', err);
    return {
      rules: _cachedRules || [],
      ruleNodes: _cachedRuleNodes || [],
      nodes: _cachedNodes || [],
      rooms: _cachedRooms || [],
      nodeMap: _cachedNodeMap || {}
    };
  }
}

// Helper to check if current time is within rule's optional schedule
function notificationRuleClock(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
function isRuleWithinSchedule(rule, now) {
  const { date: dateStr, time: timeStr } = notificationRuleClock(now);

  if (rule.start_date && dateStr < rule.start_date) return false;
  if (rule.end_date && dateStr > rule.end_date) return false;
  if (rule.start_time && rule.end_time && rule.start_time > rule.end_time)
    return timeStr >= rule.start_time || timeStr <= rule.end_time;
  if (rule.start_time && timeStr < rule.start_time) return false;
  if (rule.end_time && timeStr > rule.end_time) return false;
  return true;
}

function notificationSampleFresh(sample, node, nowMs = Date.now()) {
  const observed = Date.parse(sample?.observed_at || sample?.created || sample?.timestamp || '');
  const multiplier = { seconds: 1, minutes: 60, hours: 3600 }[String(node?.interval_unit || '').toLowerCase()];
  const cadence = Number(sample?.interval_seconds ?? node?.expected_interval_seconds ?? (Number(node?.interval_val) * multiplier));
  const lifetime = Number.isFinite(cadence) && cadence >= 1 && cadence <= 86400 ? Math.max(15000, cadence * 3000) : 45000;
  return Number.isFinite(observed) && observed <= nowMs + 5000 && nowMs - observed <= lifetime;
}

// A saved schedule or nodes.status is configuration, not hardware evidence.
function notificationHardwareConnection(state, now = Date.now()) {
  const seen = Date.parse(state?.last_seen || '');
  if (!Number.isFinite(seen) || seen > now + 5000) return 'offline';
  const wake = Date.parse(state?.sleeping_until || '');
  if (Number.isFinite(wake) && wake > now && wake > seen) return 'sleeping';
  return now - seen <= 45000 ? 'online' : 'offline';
}
let notificationHardwareCache = null;
let notificationHardwareFetch = null;
let notificationHardwareFetchedAt = 0;
async function getNotificationHardwareStates() {
  if (notificationHardwareCache && Date.now() - notificationHardwareFetchedAt < 5000)
    return notificationHardwareCache;
  if (notificationHardwareFetch) return notificationHardwareFetch;
  const sb = window.supabaseClient || window.sb;
  if (!sb) return {};
  notificationHardwareFetch = (async () => {
    try {
      let query = sb.from('ecotrack_device_state').select('node_id,device_id,last_seen,sleeping_until');
      let timer;
      if (typeof AbortController === 'function' && typeof query.abortSignal === 'function') {
        const controller = new AbortController(); query = query.abortSignal(controller.signal);
        timer = setTimeout(() => controller.abort(), 4000);
      }
      let response;
      try { response = await query; } finally { if (timer) clearTimeout(timer); }
      if (response.error || !Array.isArray(response.data)) throw response.error || new Error('Invalid hardware state');
      notificationHardwareCache = Object.fromEntries(response.data.map(row => [String(row.node_id), row]));
      notificationHardwareFetchedAt = Date.now();
      return notificationHardwareCache;
    } catch (_) {
      // Fail closed. Old successful state must not produce new alerts after a failed read.
      notificationHardwareCache = null;
      return {};
    } finally { notificationHardwareFetch = null; }
  })();
  return notificationHardwareFetch;
}

/**
 * Evaluates rules against an incoming telemetry packet or latest readings.
 * STRICT RESTRICTION: Controls sitting in the "Available AC Controls" lobby
 * (unassigned, room_id is null/empty) MUST NEVER trigger room alerts.
 * Additionally, if an AC control interface room is empty (0 assigned controls),
 * no rule violations for that room may ever be triggered.
 */
async function evaluateTelemetryAgainstRules(telemetry) {
  if (!telemetry || (!telemetry.name && !telemetry.id)) return;
  const controlName = telemetry.name || telemetry.id;
  const { rules, ruleNodes, nodes, rooms, nodeMap } = await getActiveRulesAndNodes();
  if (!rules.length) return;

  // 1. CONTROL ASSIGNMENT CHECK:
  // Locate node in DB record. If node is not assigned to a room, it is in the "Available AC Controls" lobby!
  const currentNode = nodeMap[telemetry.pb_id] || nodeMap[telemetry.node_id] || nodeMap[telemetry.id] || nodeMap[controlName];
  const evidenceId = currentNode?.id || telemetry.pb_id || telemetry.id || controlName;
  const assignedRoomId = (currentNode && currentNode.room_id)
    ? String(currentNode.room_id).trim()
    : (telemetry.room_id ? String(telemetry.room_id).trim() : '');

  if (!assignedRoomId) {
    // Control is in the Available AC Controls lobby (unassigned).
    // Clean up any stale violation timers and skip evaluation completely!
    for (const r of rules) {
      const vKey = `${r.id}_${evidenceId}`;
      localStorage.removeItem(`ecoTrack_violation_start_${vKey}`);
      localStorage.removeItem(`ecoTrack_alert_triggered_${vKey}`);
    }
    return;
  }

  const now = new Date();
  const nowMs = now.getTime();
  const sb = window.supabaseClient || window.sb;
  const monitoring = telemetry.source === 'monitoring';
  const hardwareStates = monitoring ? {} : await getNotificationHardwareStates();
  const hardware = hardwareStates[String(currentNode?.id || telemetry.node_id || telemetry.pb_id || '')];
  const monitorMatches = monitoring && currentNode?.monitoring_id === telemetry.monitoring_id &&
    ['monitoring', 'both'].includes(currentNode.device_mode) && telemetry.fresh === true &&
    !['offline', 'sleeping'].includes(telemetry.connection_status);
  if (!notificationSampleFresh(telemetry, currentNode, nowMs) ||
      (monitoring ? !monitorMatches : notificationHardwareConnection(hardware, nowMs) !== 'online')) {
    for (const rule of rules) {
      const key = `${rule.id}_${evidenceId}`;
      localStorage.removeItem(`ecoTrack_violation_start_${key}`);
      localStorage.removeItem(`ecoTrack_alert_triggered_${key}`);
    }
    return;
  }

  for (const rule of rules) {
    const clearEvidence = () => {
      localStorage.removeItem(`ecoTrack_violation_start_${rule.id}_${evidenceId}`);
      localStorage.removeItem(`ecoTrack_alert_triggered_${rule.id}_${evidenceId}`);
    };
    // Strictly skip disabled rules
    if (!rule.enabled || rule.enabled === false || rule.enabled === 'false' || rule.enabled === 0 || rule.enabled === '0') {
      const violationKey = `${rule.id}_${evidenceId}`;
      localStorage.removeItem(`ecoTrack_violation_start_${violationKey}`);
      localStorage.removeItem(`ecoTrack_alert_triggered_${violationKey}`);
      continue;
    }

    // Check optional schedule
    if (!isRuleWithinSchedule(rule, now)) {
      clearEvidence();
      continue;
    }

    const ruleRoomId = (rule.room_id || rule.room) ? String(rule.room_id || rule.room).trim() : '';

    // 2. ROOM MATCH RESTRICTION:
    // If the rule is associated with a specific room, this control MUST belong to that room in the AC Control Interface!
    if (ruleRoomId && assignedRoomId !== ruleRoomId) {
      continue;
    }

    // 3. EMPTY ROOM RESTRICTION:
    // If the AC Control Interface is empty for this room (0 controls assigned), rule alerts must NEVER fire!
    if (ruleRoomId) {
      const nodesInRoom = nodes.filter(n => n && n.room_id && String(n.room_id).trim() === ruleRoomId);
      if (nodesInRoom.length === 0) {
        continue;
      }
    }

    // 4. SPECIFIC CONTROL TARGET RESTRICTION:
    const associatedNodes = ruleNodes.filter(rn => rn.rule_id === rule.id);
    const targetNodeNames = associatedNodes.map(rn => rn.node_id || rn.node_name);
    if (rule.node) targetNodeNames.push(rule.node);
    if (Array.isArray(rule.nodes)) targetNodeNames.push(...rule.nodes);

    if (targetNodeNames.length > 0) {
      const matchesControl = targetNodeNames.some(tn => 
        tn === controlName || tn === telemetry.id || tn === telemetry.pb_id ||
        (currentNode && (tn === currentNode.id || tn === currentNode.name))
      );
      if (!matchesControl) continue;
    }

    let isViolated = false;
    let violationReason = '';
    const thresholdVal = Number(rule.value);
    const durationMins = Number(rule.duration) || 0;
    const durationMs = durationMins * 60000;

    if (rule.type === 'temperature') {
      const rawTemp = telemetry.temp ?? telemetry.temperature;
      if (rawTemp === null || rawTemp === undefined || rawTemp === '') { clearEvidence(); continue; }
      let currentTemp = Number(rawTemp);
      if (!Number.isFinite(currentTemp)) { clearEvidence(); continue; }

      let compareVal = thresholdVal;
      if (rule.unit === '°F') {
        compareVal = (thresholdVal - 32) * (5 / 9);
      }

      if (rule.condition === 'above' && currentTemp > compareVal) isViolated = true;
      if (rule.condition === 'below' && currentTemp < compareVal) isViolated = true;
      if (rule.condition === 'equals' && Math.abs(currentTemp - compareVal) < 0.2) isViolated = true;

      if (isViolated) {
        const unit = rule.unit || '°C';
        if (rule.condition === 'above') violationReason = `Temperature went above ${thresholdVal}${unit} (was ${Math.round(currentTemp)}°C)`;
        else if (rule.condition === 'below') violationReason = `Temperature went below ${thresholdVal}${unit} (was ${Math.round(currentTemp)}°C)`;
        else if (rule.condition === 'equals') violationReason = `Temperature equals ${thresholdVal}${unit}`;
      }
    } else if (rule.type === 'battery') {
      if (telemetry.battery === null || telemetry.battery === undefined || telemetry.battery === '') { clearEvidence(); continue; }
      let currentBatt = Number(telemetry.battery);
      if (!Number.isFinite(currentBatt)) { clearEvidence(); continue; }

      if (currentBatt <= 5.0) {
        currentBatt = Math.round((currentBatt / 4.2) * 100);
      }

      if (rule.condition === 'below' && currentBatt < thresholdVal) isViolated = true;
      if (rule.condition === 'equals' && Math.abs(currentBatt - thresholdVal) < 2) isViolated = true;

      if (isViolated) {
        violationReason = `Battery dropped to ${currentBatt}% (threshold ${thresholdVal}%)`;
      }
    }

    const violationKey = `${rule.id}_${evidenceId}`;
    const startKey = `ecoTrack_violation_start_${violationKey}`;
    const alertKey = `ecoTrack_alert_triggered_${violationKey}`;

    if (isViolated) {
      const rawStart = localStorage.getItem(startKey);
      let startTime = rawStart !== null ? Number(rawStart) : null;
      if (startTime === null || isNaN(startTime)) {
        startTime = nowMs;
        localStorage.setItem(startKey, String(startTime));
      }

      const elapsedViolationTime = nowMs - startTime;

      if (elapsedViolationTime >= durationMs) {
        const lastAlertTime = Number(localStorage.getItem(alertKey)) || 0;
        const repeatIntervalMs = Math.max(durationMs, 60 * 1000);

        if (!lastAlertTime || (nowMs - lastAlertTime) >= repeatIntervalMs) {
          localStorage.setItem(alertKey, String(nowMs));

          const dateStr = notificationRuleClock(now).date;
          const timeStr = now.toLocaleTimeString('en-US', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
          const defaultMsg = rule.message || 'Environmental threshold exceeded';
          const fullContent = `${controlName}|||${violationReason ? violationReason + '. ' : ''}${defaultMsg}`;

          try {
            let notifId = null;
            if (window.electron && typeof window.electron.invoke === 'function') {
              try {
                const res = await window.electron.invoke('notification-create', {
                  room_id: assignedRoomId || rule.room_id || null,
                  rule_id: rule.id || null,
                  node_id: currentNode?.id || telemetry.pb_id || null,
                  content: fullContent,
                  time: timeStr,
                  date: dateStr,
                  triggered: true
                });
                if (res && res.success && res.data) notifId = res.data.id;
              } catch (ipcErr) {
                console.warn('IPC notification-create error, fallback to sb:', ipcErr);
              }
            }

            if (!notifId && sb) {
              const { data: insertedData } = await sb.from('notifications').insert([{
                room_id: assignedRoomId || rule.room_id || null,
                rule_id: rule.id || null,
                node_id: currentNode?.id || telemetry.pb_id || null,
                content: fullContent,
                time: timeStr,
                date: dateStr,
                triggered: true
              }]).select().maybeSingle();
              if (insertedData) notifId = insertedData.id;
            }
            console.log(`[EcoTrack Rules Engine] Alert triggered after ${durationMins} min duration for ${controlName}: ${fullContent}`);

            const auditEntry = {
              id: notifId || `v_hist_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
              room_id: assignedRoomId || rule.room_id || null,
              rule_id: rule.id || null,
              content: fullContent,
              time: timeStr,
              date: dateStr,
              triggered: true,
              archived: true,
              created: new Date().toISOString()
            };

            const auditSaveFn = (typeof saveViolationToAuditHistory === 'function' ? saveViolationToAuditHistory : null) ||
                                (typeof window !== 'undefined' && typeof window.saveViolationToAuditHistory === 'function' ? window.saveViolationToAuditHistory : null);
            if (auditSaveFn) {
              auditSaveFn(auditEntry);
            } else {
              try {
                const hist = JSON.parse(localStorage.getItem('ecoTrack_violationAuditHistory') || '[]');
                hist.unshift(auditEntry);
                localStorage.setItem('ecoTrack_violationAuditHistory', JSON.stringify(hist.slice(0, 500)));
              } catch (_) {}
            }

            // Invalidate caches across EcoDataBus so notifications and rules screens refresh
            if (window.EcoDataBus) {
              window.EcoDataBus.invalidate('notifications:data');
              window.EcoDataBus.invalidate('notifications');
              window.EcoDataBus.invalidate('rules:data');
            }

            triggerGlobalNotification(fullContent, {
              id: notifId || auditEntry.id,
              room_id: assignedRoomId || rule.room_id || null,
              control_name: controlName,
              sensor_name: controlName
            });

            if (typeof window.setupNotificationsPage === 'function') {
              window.setupNotificationsPage();
            } else if (typeof window.loadNotificationMessages === 'function') {
              window.loadNotificationMessages();
            }

            if (typeof window.initRuleComplianceBenchmarking === 'function') {
              window.initRuleComplianceBenchmarking();
            }
          } catch (insertErr) {
            console.warn('[EcoTrack Rules Engine] Failed to record triggered notification:', insertErr.message);
          }
        }
      }
    } else {
      localStorage.removeItem(startKey);
      localStorage.removeItem(alertKey);
    }
  }
}

// Global hook for live packet streaming (called from telemetry-new.js)
window.evaluateRulesForTelemetry = evaluateTelemetryAgainstRules;

// Background polling loop across all pages to check latest control telemetry
async function startGlobalRuleChecker() {
  if (startGlobalRuleChecker.running) return;
  startGlobalRuleChecker.running = true;
  const sb = window.supabaseClient || window.sb;

  try {
    // 1. Check if ANY nodes are assigned in the AC Control Interface
    let assignedNodes = [];
    if (window.electron && typeof window.electron.invoke === 'function') {
      try {
        const sRes = await window.electron.invoke('scheduler-fetch-data');
        if (sRes && sRes.success && Array.isArray(sRes.nodes)) {
          assignedNodes = sRes.nodes.filter(n => n.room_id && String(n.room_id).trim() !== '');
        }
      } catch (ipcErr) {
        console.warn('IPC scheduler-fetch-data error in startGlobalRuleChecker:', ipcErr);
      }
    }
    if (!assignedNodes.length && sb) {
      try {
        const { data: nData } = await sb.from('nodes').select('*').not('room_id', 'is', null);
        if (nData) {
          assignedNodes = nData.filter(n => n.room_id && String(n.room_id).trim() !== '');
        }
      } catch (_) {}
    }

    // IF AC CONTROL INTERFACE IS COMPLETELY EMPTY (all nodes in lobby / unassigned):
    // Do not poll or evaluate any rules!
    if (!assignedNodes || assignedNodes.length === 0) {
      return;
    }

    const backendUrl = (window.electron?.env?.BACKEND_URL || 'http://localhost:5000').replace(/\/$/, '');
    async function localRead(path) {
      try {
        const response = await fetch(backendUrl + path, { signal: AbortSignal.timeout(2000), cache: 'no-store' });
        return response.ok ? await response.json() : null;
      } catch (_) { return null; }
    }
    const monitorResponse = await localRead('/api/monitoring/devices');
    const monitors = Array.isArray(monitorResponse?.items) ? monitorResponse.items : [];
    // Query the latest row for each canonical identity, not an arbitrary global page.
    // A legacy display-name alias is accepted only when it identifies one node.
    for (let offset = 0; offset < assignedNodes.length; offset += 6) {
      await Promise.all(assignedNodes.slice(offset, offset + 6).map(async node => {
        let sample = {}, source = 'controller', monitor;
        if (['monitoring', 'both'].includes(node.device_mode)) {
          monitor = monitors.find(item => item.id === node.monitoring_id && item.active);
          const latest = monitor?.latest;
          sample = latest ? { ...latest,
            temp: latest.temperature_quality === 'ok' && latest.clock_quality === 'synchronized' ? latest.outlet_temperature_c : null,
            temperature: latest.temperature_quality === 'ok' && latest.clock_quality === 'synchronized' ? latest.outlet_temperature_c : null,
            // Voltage is not a measured battery percentage.
            battery: null } : {};
          source = 'monitoring';
        } else {
          const aliases = [node.id];
          if (node.name && assignedNodes.filter(item => item.name === node.name).length === 1) aliases.push(node.name);
          const filter = [...new Set(aliases.filter(Boolean))].flatMap(id =>
            ['node_id', 'sensor_name'].map(field => `${field} = ${JSON.stringify(id)}`)).join(' || ');
          const params = new URLSearchParams({ filter, perPage: '1', sort: '-created' });
          const response = await localRead('/api/telemetry?' + params);
          const rows = Array.isArray(response) ? response : response?.items;
          if (Array.isArray(rows)) sample = rows[0] || {};
        }
        await evaluateTelemetryAgainstRules({ ...sample, source,
          id: node.id, name: node.name || node.id, node_id: node.id, pb_id: node.id, room_id: node.room_id,
          monitoring_id: monitor?.id, fresh: monitor?.fresh === true,
          temp: sample.temp ?? sample.temperature ?? null, temperature: sample.temperature ?? sample.temp ?? null,
          battery: sample.battery ?? null, pressure: sample.differential_pressure_pa ?? null, rssi: sample.rssi_dbm ?? sample.rssi ?? null
        });
      }));
    }
  } catch (_) {} finally { startGlobalRuleChecker.running = false; }
}

// ===== CONTROL WAKE UP & SLEEP SCHEDULE MONITOR =====
let _cachedNodesForSchedule = null;
let _cachedRoomsForSchedule = null;
let _lastScheduleFetchTime = 0;

function to24HourHHMM(timeVal) {
  if (!timeVal) return null;
  const str = String(timeVal).trim();
  if (str === '') return null;

  // Check 12-hour AM/PM: e.g. "06:00 AM", "6:00 AM", "10:00 PM", "12:43 PM"
  const ampmMatch = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)$/i.exec(str);
  if (ampmMatch) {
    let hours = parseInt(ampmMatch[1], 10);
    const minutes = ampmMatch[2];
    const period = ampmMatch[3].toUpperCase();
    if (period === 'AM' && hours === 12) hours = 0;
    else if (period === 'PM' && hours !== 12) hours += 12;
    return `${String(hours).padStart(2, '0')}:${minutes}`;
  }

  // Check 24-hour: e.g. "06:00", "6:00", "22:00", "12:43"
  const h24Match = /^(\d{1,2}):(\d{2})/.exec(str);
  if (h24Match) {
    const hours = parseInt(h24Match[1], 10);
    const minutes = h24Match[2];
    if (hours >= 0 && hours < 24) {
      return `${String(hours).padStart(2, '0')}:${minutes}`;
    }
  }

  return null;
}

function formatScheduleTimeDisplay(value, fallback = '06:00 AM') {
  if (!value) return fallback;
  const norm = to24HourHHMM(value) || value;
  const match = /^([0-2]?\d):([0-5]\d)$/.exec(String(norm || ''));
  if (!match) return String(value || fallback);
  let hours = parseInt(match[1], 10);
  const minutes = match[2];
  const period = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  if (hours === 0) hours = 12;
  return `${String(hours).padStart(2, '0')}:${minutes} ${period}`;
}

async function checkControlSchedules(forceRefresh = false) {
  const sb = window.supabaseClient || window.sb;
  if (!sb || localStorage.getItem('ecoTrack_notifications_enabled') === 'false') return;

  const now = new Date();
  const currentHH = String(now.getHours()).padStart(2, '0');
  const currentMM = String(now.getMinutes()).padStart(2, '0');
  const currentHHMM = `${currentHH}:${currentMM}`;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const todayDateStr = now.toISOString().split('T')[0];
  const nowMs = now.getTime();

  try {
    // Refresh nodes and rooms if forced or cache expired (every 15 seconds)
    if (forceRefresh || !_cachedNodesForSchedule || (nowMs - _lastScheduleFetchTime) > 15000) {
      let fetchedNodes = [];
      let fetchedRooms = [];
      if (window.electron && typeof window.electron.invoke === 'function') {
        try {
          const sRes = await window.electron.invoke('scheduler-fetch-data');
          if (sRes && sRes.success) {
            fetchedNodes = sRes.nodes || [];
            fetchedRooms = sRes.rooms || [];
          }
        } catch (ipcErr) {
          console.warn('IPC scheduler-fetch-data error in checkControlSchedules:', ipcErr);
        }
      }
      if (!fetchedNodes.length && sb) {
        const [nodesRes, roomsRes] = await Promise.all([
          sb.from('nodes').select('*'),
          sb.from('rooms').select('*')
        ]);
        fetchedNodes = nodesRes.data || [];
        fetchedRooms = roomsRes.data || [];
      }
      _cachedNodesForSchedule = fetchedNodes;
      _cachedRoomsForSchedule = fetchedRooms;
      _lastScheduleFetchTime = nowMs;
    }

    const roomMap = {};
    (_cachedRoomsForSchedule || []).forEach(rm => { roomMap[rm.id] = rm.name; });

    // Fetch existing notifications for today to prevent duplicates across multiple browser tabs or sessions
    let todayNotifs = [];
    if (window.electron && typeof window.electron.invoke === 'function') {
      try {
        const res = await window.electron.invoke('notifications-fetch-today', todayDateStr);
        if (res && res.success && res.data) todayNotifs = res.data;
      } catch (_) {}
    } else if (sb) {
      try {
        const { data: existingData } = await sb
          .from('notifications')
          .select('id, content, date, time')
          .eq('date', todayDateStr);
        if (existingData) todayNotifs = existingData;
      } catch (_) {}
    }

    const hardwareStates = await getNotificationHardwareStates();
    for (const node of _cachedNodesForSchedule || []) {
      const connection = notificationHardwareConnection(hardwareStates[String(node.id)], nowMs);
      if (connection === 'offline') continue;
      // Skip controls that are not assigned to a room
      if (!node.room_id || !roomMap[node.room_id]) {
        continue;
      }
      const nodeName = node.name || node.id;
      const roomName = roomMap[node.room_id];

      const normWake = to24HourHHMM(node.wake_time);
      const normSleep = to24HourHHMM(node.sleep_time);
      if (!normWake || !normSleep || normWake === normSleep) continue;

      const [wH, wM] = normWake.split(':').map(Number);
      const wakeMinutes = wH * 60 + wM;

      const [sH, sM] = normSleep.split(':').map(Number);
      const sleepMinutes = sH * 60 + sM;

      const wakeDisplay = formatScheduleTimeDisplay(normWake, '06:00 AM');
      const sleepDisplay = formatScheduleTimeDisplay(normSleep, '10:00 PM');

      // 1. Check Wake Up Trigger:
      // Announce a wake only inside the configured active window and after a fresh heartbeat.
      const isWakeDue = connection === 'online' && (wakeMinutes < sleepMinutes
        ? nowMinutes >= wakeMinutes && nowMinutes < sleepMinutes
        : nowMinutes >= wakeMinutes || nowMinutes < sleepMinutes);
      if (isWakeDue) {
        const wakeKey = `ecoTrack_notif_wake_${node.id || nodeName}_${todayDateStr}_${normWake}`;
        const hasLocalWake = localStorage.getItem(wakeKey);
        const hasDbWake = todayNotifs.some(n =>
          n.content &&
          n.content.includes(nodeName) &&
          n.content.includes('Control Wake Up')
        );

        if (!hasLocalWake && !hasDbWake) {
          localStorage.setItem(wakeKey, 'pending_' + Date.now());

          const notifId = `notif_wake_${(node.id || nodeName).replace(/[^a-zA-Z0-9]/g, '')}_${Date.now()}`;
          const messageText = `Control Wake Up: Control ${nodeName} in ${roomName} is online during its wake schedule (${wakeDisplay}).`;
          const fullContent = `${nodeName}|||${messageText}`;

          try {
            let insertedId = notifId;
            if (window.electron && typeof window.electron.invoke === 'function') {
              const res = await window.electron.invoke('notification-create', {
                room_id: node.room_id || null,
                content: fullContent,
                time: wakeDisplay,
                date: todayDateStr,
                triggered: true
              });
              if (!res?.success) throw new Error(res?.error || 'Notification was not saved.');
              if (res.data?.id) insertedId = res.data.id;
            } else if (sb) {
              const { data, error } = await sb.from('notifications').insert([{
                room_id: node.room_id || null,
                content: fullContent,
                time: wakeDisplay,
                date: todayDateStr,
                triggered: true
              }]).select().maybeSingle();
              if (error) throw error;
              if (data && data.id) insertedId = data.id;
            }

            localStorage.setItem(wakeKey, 'true');

            triggerGlobalNotification(fullContent, {
              id: insertedId,
              room_id: node.room_id,
              control_name: nodeName,
              sensor_name: nodeName
            });

            if (typeof window.loadNotificationMessages === 'function') {
              window.loadNotificationMessages();
            }
          } catch (e) {
            localStorage.removeItem(wakeKey);
            console.warn('[Schedule Wake Notification Error]:', e.message);
          }
        } else if (!hasLocalWake && hasDbWake) {
          localStorage.setItem(wakeKey, 'true');
        }
      }

      // 2. Check Sleep Time Trigger:
      // The controller must have reported sleeping_until; the clock alone cannot prove sleep.
      const isSleepDue = connection === 'sleeping' && (sleepMinutes > wakeMinutes
        ? nowMinutes >= sleepMinutes || nowMinutes < wakeMinutes
        : nowMinutes >= sleepMinutes && nowMinutes < wakeMinutes);

      if (isSleepDue) {
        const sleepKey = `ecoTrack_notif_sleep_${node.id || nodeName}_${todayDateStr}_${normSleep}`;
        const hasLocalSleep = localStorage.getItem(sleepKey);
        const hasDbSleep = todayNotifs.some(n =>
          n.content &&
          n.content.includes(nodeName) &&
          n.content.includes('Control Sleep Schedule')
        );

        if (!hasLocalSleep && !hasDbSleep) {
          localStorage.setItem(sleepKey, 'pending_' + Date.now());

          const notifId = `notif_sleep_${(node.id || nodeName).replace(/[^a-zA-Z0-9]/g, '')}_${Date.now()}`;
          const messageText = `Control Sleep Schedule: Control ${nodeName} in ${roomName} has reported scheduled sleep (${sleepDisplay}).`;
          const fullContent = `${nodeName}|||${messageText}`;

          try {
            let insertedId = notifId;
            if (window.electron && typeof window.electron.invoke === 'function') {
              const res = await window.electron.invoke('notification-create', {
                room_id: node.room_id || null,
                content: fullContent,
                time: sleepDisplay,
                date: todayDateStr,
                triggered: true
              });
              if (!res?.success) throw new Error(res?.error || 'Notification was not saved.');
              if (res.data?.id) insertedId = res.data.id;
            } else if (sb) {
              const { data, error } = await sb.from('notifications').insert([{
                room_id: node.room_id || null,
                content: fullContent,
                time: sleepDisplay,
                date: todayDateStr,
                triggered: true
              }]).select().maybeSingle();
              if (error) throw error;
              if (data && data.id) insertedId = data.id;
            }

            localStorage.setItem(sleepKey, 'true');

            triggerGlobalNotification(fullContent, {
              id: insertedId,
              room_id: node.room_id,
              control_name: nodeName,
              sensor_name: nodeName
            });

            if (typeof window.loadNotificationMessages === 'function') {
              window.loadNotificationMessages();
            }
          } catch (e) {
            localStorage.removeItem(sleepKey);
            console.warn('[Schedule Sleep Notification Error]:', e.message);
          }
        } else if (!hasLocalSleep && hasDbSleep) {
          localStorage.setItem(sleepKey, 'true');
        }
      }
    }
  } catch (err) {
    console.warn('[Control Schedule Monitor] Error checking schedules:', err);
  }
}

function invalidateScheduleCache(nodeId = null) {
  _cachedNodesForSchedule = null;
  _cachedRoomsForSchedule = null;
  _lastScheduleFetchTime = 0;
  if (nodeId) {
    try {
      const now = new Date();
      const todayDateStr = now.toISOString().split('T')[0];
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && (k.includes(nodeId) || k.includes('ecoTrack_notif_')) && k.includes(todayDateStr)) {
          localStorage.removeItem(k);
        }
      }
    } catch (_) {}
  }
}

// Function to trigger immediate notification when schedule is updated on scheduler page
async function notifyScheduleChange(nodeName, roomName, wakeTime, sleepTime, roomId) {
  const sb = window.supabaseClient || window.sb;
  const now = new Date();
  const todayDateStr = now.toISOString().split('T')[0];
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  const messageText = `Schedule Applied: Node ${nodeName} in ${roomName || 'Room'} set to Wake at ${formatScheduleTimeDisplay(wakeTime, '06:00 AM')}, Sleep at ${formatScheduleTimeDisplay(sleepTime, '10:00 PM')}.`;
  const fullContent = `${nodeName}|||${messageText}`;

  let notifId = null;
  const payload = {
    room_id: roomId || null,
    content: fullContent,
    time: timeStr,
    date: todayDateStr,
    triggered: true
  };

  if (window.electron && typeof window.electron.invoke === 'function') {
    try {
      const res = await window.electron.invoke('notification-create', payload);
      if (res && res.success && res.data) {
        notifId = res.data.id;
      }
    } catch (ipcErr) {
      console.warn('IPC notification-create error in notifyScheduleChange:', ipcErr);
    }
  }

  if (!notifId && sb) {
    try {
      const { data } = await sb.from('notifications').insert([payload]).select().maybeSingle();
      if (data && data.id) notifId = data.id;
    } catch (err) {
      console.warn('[Schedule Change Notification Error]:', err.message);
    }
  }

  triggerGlobalNotification(fullContent, {
    id: notifId,
    room_id: roomId,
    control_name: nodeName,
    sensor_name: nodeName
  });

  if (typeof window.loadNotificationMessages === 'function') {
    window.loadNotificationMessages();
  }
}

window.notifyScheduleChange = notifyScheduleChange;
window.checkControlSchedules = checkControlSchedules;
window.invalidateScheduleCache = invalidateScheduleCache;

// Shared persistence path for system alerts. event_key makes polling idempotent
// even when several dashboard windows observe the same mobile submission.
window.createSystemNotification = async function(payload) {
  const now = new Date();
  const notification = {
    ...payload, triggered: true,
    date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
    time: now.toLocaleTimeString('en-US', { hour12: true }), created: now.toISOString()
  };
  let record;
  if (window.electron?.invoke) {
    const result = await window.electron.invoke('notification-create', notification);
    if (!result?.success) {
      if (result?.code === '23505') return null;
      throw new Error(result?.error || 'Could not save notification');
    }
    record = result.data;
  } else {
    const client = window.supabaseClient || window.sb;
    if (!client) throw new Error('Database service unavailable');
    for (const [field, table] of [['room_id', 'rooms'], ['node_id', 'nodes']]) {
      if (!notification[field]) continue;
      let resolved;
      for (const column of ['id', 'name']) {
        const result = await client.from(table).select('id').eq(column, notification[field]).maybeSingle();
        if (result.error) throw result.error;
        if (result.data) { resolved = result.data.id; break; }
      }
      if (!resolved) throw new Error(`Unknown ${field}: ${notification[field]}`);
      notification[field] = resolved;
    }
    const result = await client.from('notifications').insert(notification).select().single();
    if (result.error?.code === '23505') return null;
    if (result.error) throw result.error;
    record = result.data;
  }
  window.EcoDataBus?.invalidate('notifications:data');
  window.dispatchEvent(new CustomEvent('ecotrack:notification-created', { detail: record }));
  updateGlobalNotificationBadge();
  window.loadNotificationMessages?.();
  return record;
};

let maintenancePollRunning = false;
const observedMaintenanceSubmissions = new Set();
async function checkMaintenanceVerificationSubmissions() {
  if (maintenancePollRunning) return;
  maintenancePollRunning = true;
  try {
    let reports;
    if (window.electron?.invoke) {
      const result = await window.electron.invoke('maintenance-fetch-reports');
      if (!result?.success) throw new Error(result?.error || 'Could not fetch reports');
      reports = result.data || [];
    } else {
      const client = window.supabaseClient || window.sb;
      if (!client) return;
      const result = await client.from('maintenance_reports').select('*');
      if (result.error) throw result.error;
      reports = result.data || [];
    }
    for (const report of reports) {
      const status = String(report.status || '').trim().toLowerCase();
      let timeline = report.timeline || [];
      if (typeof timeline === 'string') { try { timeline = JSON.parse(timeline); } catch (_) { timeline = []; } }
      if (!Array.isArray(timeline)) timeline = [];
      const submission = timeline.find(entry => /submitted for admin verification/i.test(typeof entry === 'string' ? entry : entry.title || entry.message || entry.description || ''));
      const pending = ['pending verification', 'for verification', 'awaiting admin verification'].includes(status);
      const signedOff = timeline.some(entry => /verified.*(?:admin|supervisor)|(?:admin|supervisor).*verified|signed off/i.test(typeof entry === 'string' ? entry : entry.title || ''));
      const tasksVerified = Array.isArray(report.tasks) && report.tasks.length > 0 && report.tasks.every(task => task.verified === true);
      if (report.verified === true || tasksVerified || status === 'verified' || (!pending && (!submission || signedOff))) continue;
      const signature = JSON.stringify(submission || report.submitted_at || report.created || report.created_date || report.id);
      let hash = 2166136261;
      for (const character of signature) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
      const key = `maintenance_verification:${report.id}:${hash >>> 0}`;
      if (observedMaintenanceSubmissions.has(key)) continue;
      const equipment=window.EcoTrackMaintenance?.resolveReportEquipment?.(report);
      const targetName=equipment?.controllerName || 'Controller unavailable';
      const location=equipment?.location || report.room_name || report.room || 'Location unavailable';
      const record = await window.createSystemNotification({
        type: 'maintenance_verification', event_key: key, report_id: report.id,
        room_id: report.room_id || null,
        content: `Verification Required: Technician ${report.staff_name || report.staffName || 'Unassigned'} submitted maintenance for ${targetName}${equipment?.airconName && equipment.airconName !== 'Aircon name unavailable' ? ' ('+equipment.airconName+')' : ''} in ${location}. Report: ${report.id}.`
      });
      observedMaintenanceSubmissions.add(key);
      if (record) triggerGlobalNotification(record.content, record);
    }
  } catch (error) {
    console.warn('[Maintenance verification monitor]', error.message);
  } finally {
    maintenancePollRunning = false;
  }
}
window.checkMaintenanceVerificationSubmissions = checkMaintenanceVerificationSubmissions;

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  updateGlobalNotificationBadge();
  checkMaintenanceVerificationSubmissions();
  
  // Setup dismiss button listener
  const dismissBtn = document.getElementById('dismissNotificationBtn');
  if (dismissBtn) {
    dismissBtn.addEventListener('click', dismissGlobalNotification);
  }
  
  // Listen for storage changes from other pages/tabs
  window.addEventListener('storage', (e) => {
    if (e.key === 'ecoTrackNotificationReadState' || e.key === 'triggeredNotifications' || e.key === 'ecoTrackNotificationInboxRevision' || e.key === 'ecoTrack_notifications_enabled') {
      updateGlobalNotificationBadge();
    }
  });

  window.addEventListener('notifications:toggled', (e) => {
    if (e.detail && e.detail.enabled === false) {
      const dialog = document.getElementById('globalNotificationDialog');
      if (dialog) dialog.style.display = 'none';
    }
    updateGlobalNotificationBadge();
  });

  // Run initial background rule check & schedule checks
  setTimeout(() => {
    startGlobalRuleChecker();
    checkControlSchedules();
  }, 2000);

  setInterval(startGlobalRuleChecker, 6000);
  setInterval(checkControlSchedules, 10000); // Check control schedules every 10 seconds
  const maintenanceTimer = setInterval(checkMaintenanceVerificationSubmissions, 10000);
  window.addEventListener('pagehide', () => clearInterval(maintenanceTimer), { once: true });
  window.addEventListener('ecotrack:reports-updated', checkMaintenanceVerificationSubmissions);
});

