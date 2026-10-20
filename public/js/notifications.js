// ===== NOTIFICATIONS PAGE LOGIC =====
const sb = window.supabaseClient || window.sb;
const pb = window.pb || (typeof PocketBase === 'function' ? new PocketBase() : null);
const installationNotifications = window.EcoTrackInstallations;
const notificationReadStateKey = 'ecoTrackNotificationReadState';

function updateInstallationAvailability(records) {
  const notice = document.getElementById('installationAvailabilityNotice');
  if (!notice) return;
  const unavailable = records.some(record => record.type === 'controller_installation' &&
    (!rooms[record.installation?.room_id] || !installationNotifications?.toMessage(record)));
  notice.classList.toggle('hidden', !unavailable);
  notice.textContent = unavailable ? 'Some installation records have unavailable room or installation details. Their saved history has been retained.' : '';
}

let selectedRoomId = null;
let messages = [];
let messagesCurrentPage = 1;
const MESSAGES_PAGE_SIZE = 20;
let isNotifying = false;
let lastTriggeredIds = new Set();
let buildings = {};
let floors = {};
let rooms = {};
let currentViewMessageId = null;
let currentNotificationFilter = 'all';
let pendingDeleteMessageId = null;
let isInitializing = false;
let notificationLoadRequest = 0;
let notificationInboxMutationPending = false;

function advanceNotificationInboxRevision() {
  window._notificationInboxRevision = (window._notificationInboxRevision || 0) + 1;
  try { localStorage.setItem('ecoTrackNotificationInboxRevision', String(Date.now()) + '-' + Math.random()); } catch (_) {}
}

function beginNotificationInboxMutation() {
  if (notificationInboxMutationPending) return false;
  notificationInboxMutationPending = true;
  window._notificationInboxMutations = (window._notificationInboxMutations || 0) + 1;
  notificationLoadRequest += 1;
  advanceNotificationInboxRevision();
  return true;
}

function endNotificationInboxMutation() {
  notificationInboxMutationPending = false;
  window._notificationInboxMutations = Math.max(0, (window._notificationInboxMutations || 1) - 1);
  advanceNotificationInboxRevision();
  window.syncNotificationBadges?.();
}

function assertInboxDismissalReceipt(records, ids) {
  const returned = new Set(Array.isArray(records) ? records.filter(row => row?.is_dismissed_from_inbox === true).map(row => String(row.id)) : []);
  if (!Array.isArray(records) || records.length !== ids.length || returned.size !== ids.length || ids.some(id => !returned.has(String(id)))) {
    throw new Error('The server did not confirm every requested notification dismissal');
  }
}

async function persistNotificationInboxDismissal(targets) {
  const ids = [...new Set(targets.map(message => message.pbId || message.id).filter(id => id && !String(id).startsWith('v_hist_')))];
  if (!ids.length) return;
  if (window.electron && typeof window.electron.invoke === 'function') {
    const result = await window.electron.invoke('notifications-update', { ids, updates: { is_dismissed_from_inbox: true } });
    if (!result?.success) throw new Error(result?.error || 'Dismissal failed');
    assertInboxDismissalReceipt(result.data, ids);
    return;
  }
  const client = window.supabaseClient || window.sb || sb;
  if (!client) throw new Error('Database service unavailable');
  const result = await client.from('notifications').update({ is_dismissed_from_inbox: true, updated: new Date().toISOString() }).in('id', ids).select('id,is_dismissed_from_inbox');
  if (result.error) throw result.error;
  assertInboxDismissalReceipt(result.data, ids);
}

// ===== 12-HOUR TIME FORMATTING HELPERS =====
function formatTime12Hour(timeStr) {
  if (!timeStr) return '';
  const str = String(timeStr).trim();

  // If already formatted with AM/PM
  const ampmMatch = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i.exec(str);
  if (ampmMatch) {
    let hours = parseInt(ampmMatch[1], 10);
    const minutes = ampmMatch[2];
    const seconds = ampmMatch[3];
    const period = ampmMatch[4].toUpperCase();
    if (hours === 0) hours = 12;
    else if (hours > 12) hours = hours % 12 || 12;
    const formattedHours = String(hours).padStart(2, '0');
    return seconds !== undefined
      ? `${formattedHours}:${minutes}:${seconds} ${period}`
      : `${formattedHours}:${minutes} ${period}`;
  }

  // 24-hour time string: HH:MM or HH:MM:SS
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(str);
  if (match) {
    let hours = parseInt(match[1], 10);
    const minutes = match[2];
    const seconds = match[3];
    const period = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    if (hours === 0) hours = 12;
    const formattedHours = String(hours).padStart(2, '0');
    return seconds !== undefined
      ? `${formattedHours}:${minutes}:${seconds} ${period}`
      : `${formattedHours}:${minutes} ${period}`;
  }

  // Fallback for ISO date string or Date-parseable string
  const d = new Date(str);
  if (!isNaN(d.getTime())) {
    const hasSeconds = str.includes(':') && str.split(':').length > 2;
    return d.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: hasSeconds ? '2-digit' : undefined,
      hour12: true
    });
  }

  return str;
}

function parseTimeToMinutes(timeStr) {
  if (!timeStr) return null;
  const str = String(timeStr).trim();
  const match12 = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i.exec(str);
  if (match12) {
    let hours = parseInt(match12[1], 10);
    const minutes = parseInt(match12[2], 10);
    const period = match12[4].toUpperCase();
    if (period === 'PM' && hours < 12) hours += 12;
    if (period === 'AM' && hours === 12) hours = 0;
    return hours * 60 + minutes;
  }
  const match24 = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(str);
  if (match24) {
    const hours = parseInt(match24[1], 10);
    const minutes = parseInt(match24[2], 10);
    return hours * 60 + minutes;
  }
  return null;
}

function notificationLocation(room) {
  if (!room) return 'Location unavailable';
  const floor = floors[room.floor_id] || {};
  const building = buildings[floor.building_id || room.building_id] || {};
  return [building.name || room.building_name, floor.name || room.floor_name, room.name].filter(Boolean).join(' • ') || 'Location unavailable';
}

function notificationNodeMatches(node, identifier) {
  const target = String(identifier || '').trim().toLowerCase();
  const aliases = typeof node === 'string' ? [node] : [node.id,node.name,node.pb_id,node.node_id,node.device_id,node.hardware_id];
  return !!target && aliases.some(value => value && String(value).toLowerCase() === target);
}

function notificationControllerName(node) {
  const name = String(typeof node === 'string' ? node : node?.name || '').trim();
  return name && !/^(?:AC-)?esp32s3-[a-f0-9]{12}$/i.test(name) &&
    !(typeof node === 'object' && name === String(node.pb_id || '')) ? name : 'Unnamed controller';
}

function notificationAirconType(node) {
  const equipment=window.EcoTrackMaintenance?.resolveReportEquipment?.({node_id:node.pb_id || node.node_id || node.id,aircon_type:node.aircon_type});
  return equipment?.airconType || String(node.aircon_type || 'Type unavailable')
    .replace(/^.+?\s+[-–—]\s+(?=(?:split|window|cassette|ducted?|portable|floor|ceiling|central|wall|tower|multi[- ]split)\b)/i, '');
}

// ===== TARGET CONTROL / NODE EXTRACTION HELPER =====
function notificationRoomId(explicitRoomId, nodeId) {
  if (rooms[explicitRoomId]) return explicitRoomId;
  const identity = String(nodeId || '').trim().toLowerCase();
  if (!identity) return '';
  const matches = Object.entries(rooms).filter(([, room]) => (room.nodes || []).some(node =>
    (typeof node === 'string' ? [node] : [node.pb_id, node.node_id, node.device_id, node.id, node.name])
      .some(value => value && String(value).toLowerCase() === identity)));
  return matches.length === 1 ? matches[0][0] : '';
}

function extractTargetNodes(content, roomRef, explicitNodeId = null) {
  let actualContent = content ? String(content).trim() : '';
  let specificNode = explicitNodeId || null;

  // 1. Explicit pipe prefix: "node-X|||actual message"
  if (actualContent && actualContent.includes('|||')) {
    const parts = actualContent.split('|||');
    specificNode = parts[0].trim();
    actualContent = parts.slice(1).join('|||').trim();
  }

  // 2. Parenthetical or bracketed pattern: "(node-6 - room 1)", "(node-6)", "[node-6 - room 1]"
  if (!specificNode && actualContent) {
    const parenMatch = /\(\s*([a-zA-Z0-9_\-]+)\s*(?:-|–|—|,|\/)\s*[^)]+\)/i.exec(actualContent) ||
                       /\(\s*(node[-\s_]?\d+|control[-\s_]?\d+|AC[-\s_]?\d+)\s*\)/i.exec(actualContent) ||
                       /\[\s*([a-zA-Z0-9_\-]+)\s*(?:-|–|—|,|\/)\s*[^\]]+\]/i.exec(actualContent);
    if (parenMatch) {
      specificNode = parenMatch[1].trim();
    }
  }

  const roomNodes = Array.isArray(roomRef?.nodes) ? roomRef.nodes : [];

  // 3. Match against known nodes in current room
  if (!specificNode && actualContent && roomNodes.length > 0) {
    const matchedRoomNodes = [];
    for (const n of roomNodes) {
      const nodeName = typeof n === 'string' ? n : (n.name || n.id || '');
      const nodeId = typeof n === 'string' ? n : (n.id || n.name || '');
      if (!nodeName && !nodeId) continue;

      const escName = (nodeName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const escId = (nodeId || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      const regexName = new RegExp('(^|[^a-zA-Z0-9_-])' + escName + '([^a-zA-Z0-9_-]|$)', 'i');
      const regexId = escId && escId !== escName ? new RegExp('(^|[^a-zA-Z0-9_-])' + escId + '([^a-zA-Z0-9_-]|$)', 'i') : null;

      if (regexName.test(actualContent) || (regexId && regexId.test(actualContent))) {
        matchedRoomNodes.push(nodeName || nodeId);
      }
    }

    if (matchedRoomNodes.length > 0) {
      return {
        specificNodeId: matchedRoomNodes[0],
        nodeNames: matchedRoomNodes,
        actualContent: actualContent
      };
    }
  }

  // 4. Match against all registered nodes globally across rooms
  if (!specificNode && actualContent && typeof rooms === 'object') {
    for (const r of Object.values(rooms || {})) {
      if (!Array.isArray(r?.nodes)) continue;
      for (const n of r.nodes) {
        const nodeName = typeof n === 'string' ? n : (n.name || n.id || '');
        if (!nodeName) continue;
        const esc = nodeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp('(^|[^a-zA-Z0-9_-])' + esc + '([^a-zA-Z0-9_-]|$)', 'i');
        if (re.test(actualContent)) {
          specificNode = nodeName;
          break;
        }
      }
      if (specificNode) break;
    }
  }

  // 5. Generic control regex fallback: "node-X" or "control-X"
  if (!specificNode && actualContent) {
    const genericMatch = /(?:^|[^a-zA-Z0-9_-])(node[-\s_]?\d+|control[-\s_]?\d+)(?:[^a-zA-Z0-9_-]|$)/i.exec(actualContent);
    if (genericMatch) {
      specificNode = genericMatch[1].trim();
    }
  }

  // If a specific node was found, look up its proper object and friendly display name
  if (specificNode) {
    const allNodes = [...roomNodes, ...Object.values(rooms || {}).flatMap(room => room.nodes || [])];
    const matches = allNodes.filter(node => notificationNodeMatches(node, specificNode));
    const unique = new Map(matches.map(node => [typeof node==='string' ? node : node.pb_id || node.node_id || node.id,node]));
    const nodeObj = unique.size===1 ? [...unique.values()][0] : null;
    const service = window.EcoTrackAirconSystem?.NodeService;
    const directId = /^(?:esp32s3-[a-f0-9]{12}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/i.test(specificNode);
    const current = nodeObj ? service?.getNode?.(nodeObj.pb_id || specificNode) : !matches.length && directId ? service?.getNode?.(specificNode) : null;
    const friendlyName = current ? notificationControllerName(current) : nodeObj ? notificationControllerName(nodeObj) : 'Controller unavailable';
    return {
      specificNodeId: specificNode,
      nodeNames: [friendlyName],
      actualContent: actualContent
    };
  }

  // Room-wide message (no single node targeted)
  return {
    specificNodeId: null,
    nodeNames: [],
    actualContent: actualContent
  };
}

async function setupNotificationsPage() {
  if (isInitializing) return;
  isInitializing = true;
  try {
    await initializeNotifications();
    if (typeof resetNotificationCount === 'function') {
      resetNotificationCount();
    }
  } finally {
    isInitializing = false;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupNotificationsPage);
} else {
  // Use a microtask so the DOM is fully ready even if readyState is 'interactive'
  Promise.resolve().then(setupNotificationsPage);
}

window.addEventListener('page:init', () => {
  if (/(?:Notification|notifications)\.html$/i.test(window.location.pathname) || window.location.hash.includes('notifications')) {
    setupNotificationsPage();
  }
});

async function initializeNotifications() {
  if (window.EcoDataBus) {
    if (!window.EcoDataBus.getCached('notifications:data') && window.EcoTrackSkeletons) {
      window.EcoTrackSkeletons.renderRoomListSkeleton('roomsList', { count: 5 });
      window.EcoTrackSkeletons.renderTableSkeleton('messagesTableBody', { rows: 5, cols: 7, colWidths: ['w-16', 'w-20', 'w-24', 'w-32', 'w-48', 'w-20', 'w-20'] });
    }

    await window.EcoDataBus.query('notifications:data', async () => {
      await loadRooms();
      await loadNotificationMessages();
      return { rooms, messages };
    });
  } else {
    // Load rooms from database first
    await loadRooms();

    // Load messages from Supabase
    await loadNotificationMessages();
  }

  // 1. Read URL query parameters (?room=..., ?notif=..., ?id=..., ?highlight=...)
  const urlParams = new URLSearchParams(window.location.search);
  const targetRoomParam = urlParams.get('room') || urlParams.get('roomId');
  const targetNotifParam = urlParams.get('notif') || urlParams.get('id') || urlParams.get('highlight');
  const targetControlParam = urlParams.get('control');

  // 2. Read sessionStorage pendingNav or localStorage fallback
  let pendingNav = null;
  const pendingNavStr = sessionStorage.getItem('pendingNav');
  if (pendingNavStr) {
    try {
      pendingNav = JSON.parse(pendingNavStr);
      sessionStorage.removeItem('pendingNav');
    } catch (_) {}
  }
  if (!pendingNav) {
    const localNavStr = localStorage.getItem('ecoTrack_pendingNotificationNav');
    if (localNavStr) {
      try {
        const parsed = JSON.parse(localNavStr);
        if (!parsed.timestamp || (Date.now() - parsed.timestamp < 300000)) {
          pendingNav = parsed;
        }
        localStorage.removeItem('ecoTrack_pendingNotificationNav');
      } catch (_) {}
    }
  }

  const roomToSelectId = targetRoomParam || pendingNav?.room;
  const notifToHighlightId = targetNotifParam || pendingNav?.notif || pendingNav?.highlight;
  const controlToHighlight = targetControlParam || pendingNav?.control;
  const messageSnippet = pendingNav?.message || pendingNav?.content || '';

  let targetRoom = null;
  if (roomToSelectId && rooms[roomToSelectId]) {
    targetRoom = rooms[roomToSelectId];
  } else if (roomToSelectId) {
    targetRoom = Object.values(rooms).find(r => 
      String(r.id) === String(roomToSelectId) || 
      (r.name && r.name.toLowerCase() === String(roomToSelectId).toLowerCase())
    );
  }

  if (!targetRoom && notifToHighlightId) {
    const cleanId = String(notifToHighlightId).trim();
    const foundMsg = messages.find(m => String(m.id) === cleanId || String(m.pbId) === cleanId);
    if (foundMsg && foundMsg.room && rooms[foundMsg.room]) {
      targetRoom = rooms[foundMsg.room];
    }
  }

  if (!targetRoom && controlToHighlight) {
    const cleanControl = String(controlToHighlight).toLowerCase().trim();
    for (const r of Object.values(rooms)) {
      if (r.nodes?.some(n => {
        if (typeof n === 'string') return n.toLowerCase() === cleanControl;
        return (n.name && n.name.toLowerCase() === cleanControl) || (n.id && String(n.id).toLowerCase() === cleanControl);
      })) {
        targetRoom = r;
        break;
      }
    }
  }

  if (!targetRoom && messageSnippet) {
    const cleanSnippet = messageSnippet.split('|||').pop().trim();
    const foundMsg = messages.find(m => m.content && (m.content.includes(cleanSnippet.substring(0, 25)) || cleanSnippet.includes(m.content.substring(0, 25))));
    if (foundMsg && foundMsg.room && rooms[foundMsg.room]) {
      targetRoom = rooms[foundMsg.room];
    }
  }

  if (!targetRoom) {
    // Auto-select the room with unread notifications, or the first room
    const roomWithUnread = Object.values(rooms).find(r => 
      messages.some(m => m.room === r.id && !m.read && m.triggered)
    );

    if (roomWithUnread) {
      targetRoom = roomWithUnread;
    } else if (Object.keys(rooms).length > 0) {
      targetRoom = Object.values(rooms)[0];
    }
  }

  if (targetRoom) {
    selectRoom(targetRoom);
  }
  
  // Setup event listeners
  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', refreshMessages);
  const notifyBtn = document.getElementById('notifyToggleBtn');
  if (notifyBtn) notifyBtn.addEventListener('click', toggleNotifications);
  const filterAllBtn = document.getElementById('notificationFilterAllBtn');
  const filterUnreadBtn = document.getElementById('notificationFilterUnreadBtn');
  const filterReadBtn = document.getElementById('notificationFilterReadBtn');
  if (filterAllBtn) filterAllBtn.addEventListener('click', () => setNotificationFilter('all'));
  if (filterUnreadBtn) filterUnreadBtn.addEventListener('click', () => setNotificationFilter('unread'));
  if (filterReadBtn) filterReadBtn.addEventListener('click', () => setNotificationFilter('read'));
  const clearAllMessagesBtn = document.getElementById('clearAllMessagesBtn');
  document.getElementById('notificationFilterScheduleBtn')?.addEventListener('click', () => setNotificationFilter('schedule'));
  if (clearAllMessagesBtn) clearAllMessagesBtn.addEventListener('click', openClearAllModal);

  
  // Clear All confirmation modal listeners
  const confirmClearAllBtn = document.getElementById('confirmClearAllBtn');
  if (confirmClearAllBtn) confirmClearAllBtn.addEventListener('click', () => {
    closeClearAllModal();
    clearAllMessages();
  });
  const cancelClearAllBtn = document.getElementById('cancelClearAllBtn');
  if (cancelClearAllBtn) cancelClearAllBtn.addEventListener('click', closeClearAllModal);
  const clearAllModal = document.getElementById('clearAllModal');
  if (clearAllModal) clearAllModal.addEventListener('click', (e) => {
    if (e.target.id === 'clearAllModal') closeClearAllModal();
  });
  document.getElementById('closeViewMessageModal').addEventListener('click', closeViewMessageModal);
  const dismissViewModalBtn = document.getElementById('dismissViewModalBtn');
  if (dismissViewModalBtn) dismissViewModalBtn.addEventListener('click', closeViewMessageModal);
  document.getElementById('closeViewModalBtn').addEventListener('click', () => {
    if (currentViewMessageId) {
      deleteMessage(currentViewMessageId);
    }
  });

  const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
  if (confirmDeleteBtn) confirmDeleteBtn.addEventListener('click', confirmDeleteMessage);
  
  const cancelDeleteBtn = document.getElementById('cancelDeleteBtn');
  if (cancelDeleteBtn) cancelDeleteBtn.addEventListener('click', cancelDeleteMessage);
  
  const confirmDeleteModal = document.getElementById('confirmDeleteModal');
  if (confirmDeleteModal) confirmDeleteModal.addEventListener('click', (e) => {
    if (e.target.id === 'confirmDeleteModal') cancelDeleteMessage();
  });
  
  // Global notification dialog listeners
  if (document.getElementById('goToNotificationsBtn')) {
    document.getElementById('goToNotificationsBtn').addEventListener('click', () => {
      window.location.href = 'Notification.html';
    });
  }
  
  // Close modals when clicking outside
  document.getElementById('viewMessageModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'viewMessageModal') {
      closeViewMessageModal();
    }
  });

  // Global ESC key dismiss for all Notification modals
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeViewMessageModal();
      closeDeleteModal();
      closeClearAllModal();
    }
  });
  
  // Start checking for triggered notifications
  startNotificationCheck();
  
  // Auto-focus, highlight, and open target notification
  if (notifToHighlightId || controlToHighlight || messageSnippet) {
    setTimeout(() => {
      focusAndOpenNotification(notifToHighlightId, {
        control: controlToHighlight,
        message: messageSnippet,
        room: roomToSelectId || targetRoom?.id
      });
    }, 250);
  }
}

// Function to focus, scroll into view, highlight, and open modal for a specific notification
async function focusAndOpenNotification(targetId, context = {}) {
  // If no targetId and no context, nothing to do
  if (!targetId && !context.control && !context.message && !context.room) return;

  const cleanTargetId = targetId ? String(targetId).trim() : '';
  const hasTargetId = Boolean(cleanTargetId && cleanTargetId !== 'null' && cleanTargetId !== 'undefined');

  // 1. Search existing messages array
  let msg = null;
  if (hasTargetId) {
    msg = messages.find(m => String(m.id) === cleanTargetId || String(m.pbId) === cleanTargetId);
  }

  // 2. If not found by ID, try finding by message content snippet or control name
  if (!msg && !hasTargetId && context.message) {
    const snippet = context.message.split('|||').pop().trim();
    msg = messages.find(m => m.content && (m.content.includes(snippet.substring(0, 25)) || snippet.includes(m.content.substring(0, 25))));
  }
  if (!msg && !hasTargetId && context.control) {
    const cleanControl = String(context.control).toLowerCase().trim();
    msg = messages.find(m => {
      if (m.node && String(m.node).toLowerCase().includes(cleanControl)) return true;
      if (m.content && m.content.toLowerCase().includes(cleanControl)) return true;
      return false;
    });
  }

  // 3. If still not found and Supabase is available, re-fetch latest records
  if (!msg && (sb || typeof window.electron?.invoke === 'function')) {
    try {
      if (await loadNotificationMessages() === false) {
        showNotification('Could not refresh notifications. Please try again.');
        return false;
      }
      if (hasTargetId) {
        msg = messages.find(m => String(m.id) === cleanTargetId || String(m.pbId) === cleanTargetId);
      }
      if (!msg && !hasTargetId && context.message) {
        const snippet = context.message.split('|||').pop().trim();
        msg = messages.find(m => m.content && (m.content.includes(snippet.substring(0, 25)) || snippet.includes(m.content.substring(0, 25))));
      }
    } catch (_) {}
  }

  // 4. Resolve and switch room if needed
  const targetRoomId = (msg && msg.room) || context.room || (context.room_id) || selectedRoomId;
  if (targetRoomId && targetRoomId !== selectedRoomId) {
    const rObj = rooms[targetRoomId] || Object.values(rooms).find(r => 
      String(r.id) === String(targetRoomId) || 
      (r.name && r.name.toLowerCase() === String(targetRoomId).toLowerCase())
    );
    if (rObj) {
      selectRoom(rObj);
    }
  }

  // A stale link is not a persisted notification. Never recreate it from its URL text.
  if (!msg && (hasTargetId || context.message || context.control)) {
    showNotification('This notification is no longer available.');
    return false;
  }
  if (!msg && targetRoomId) {
    const roomAlerts = messages.filter(m => m.room === targetRoomId && m.triggered);
    if (roomAlerts.length > 0) {
      msg = roomAlerts[roomAlerts.length - 1];
    }
  }

  // 6. Ensure filter is set to 'all' so rows are present in the DOM
  setNotificationFilter('all');

  const effectiveId = msg?.id || cleanTargetId;
  setTimeout(() => {
    if (effectiveId) {
      const row = document.querySelector(`tr[data-id="${effectiveId}"]`) ||
                  (msg?.id ? document.querySelector(`tr[data-id="${msg.id}"]`) : null);
      if (row) {
        row.classList.add('bg-emerald-50', 'dark:bg-emerald-950/40', 'border-2', 'border-[#10b981]', 'shadow-lg', 'highlighted-alert');
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }

    if (msg) {
      markMessageAsRead(msg.id);
      openViewMessageModal(msg);
    }
  }, 200);
}

window.focusAndOpenNotification = focusAndOpenNotification;

// Global click handler to dismiss alert highlight
document.addEventListener('click', (e) => {
  const row = e.target.closest('tr.highlighted-alert');
  if (row) {
    row.classList.remove('bg-emerald-50', 'dark:bg-emerald-950/40', 'border-2', 'border-[#10b981]', 'shadow-lg', 'highlighted-alert');
  }
});

async function loadRooms() {
  const roomsList = document.getElementById('roomsList');
  
  try {
    let roomRecords = [];
    let floorRecords = [];
    let buildingRecords = [];
    let nodeRecords = [];

    let ipcLoaded = false;
    if (window.electron && typeof window.electron.invoke === 'function') {
      try {
        const sRes = await window.electron.invoke('scheduler-fetch-data');
        if (sRes && sRes.success) {
          roomRecords = sRes.rooms || [];
          floorRecords = sRes.floors || [];
          buildingRecords = sRes.buildings || [];
          nodeRecords = sRes.nodes || [];
          ipcLoaded = true;
        }
      } catch (ipcErr) {
        console.warn('IPC scheduler-fetch-data error in loadRooms:', ipcErr);
      }
    }

    if (!ipcLoaded && sb) {
      const [rRes, fRes, bRes, nRes] = await Promise.all([
        sb.from('rooms').select('*').order('created'),
        sb.from('floors').select('*').order('created'),
        sb.from('buildings').select('*').order('created'),
        sb.from('nodes').select('*')
      ]);
      const failed = [rRes, fRes, bRes, nRes].find(result => result.error);
      if (failed) throw new Error(failed.error.message);
      roomRecords = rRes.data || [];
      floorRecords = fRes.data || [];
      buildingRecords = bRes.data || [];
      nodeRecords = nRes.data || [];
    }
    
    rooms = {};
    buildings = {};
    floors = {};
    
    buildingRecords.forEach(b => buildings[b.id] = b);
    floorRecords.forEach(f => floors[f.id] = f);
    
    roomRecords.forEach(record => {
      const roomNodes = nodeRecords
        .filter(n => n.room_id === record.id)
        .map(n => ({
          id: n.name,
          pb_id: n.id,
          node_id:n.node_id, device_id:n.device_id, hardware_id:n.hardware_id,
          name: n.name,
          aircon_type: n.aircon_type || 'Split Type (Inverter)',
          status: n.status || 'offline',
          temp: n.temp || 0,
          pressure: n.pressure || 0,
          battery: n.battery || 0,
          rssi: n.rssi || 0
        }));
      rooms[record.id] = { ...record, nodeLimit: record.node_limit || 5, nodes: roomNodes };
    });
  } catch (error) {
    console.warn('Supabase load error (rooms):', error);
  }
  
  renderHierarchy();
}

function renderHierarchy() {
  window.ensureLocationHierarchy(buildings, floors, rooms);
  const roomsList = document.getElementById('roomsList');
  roomsList.innerHTML = '';
  
  if (Object.keys(buildings).length === 0 && Object.keys(rooms).length === 0) {
    roomsList.innerHTML = '<div class="text-sm text-gray-500 text-center mt-4">No locations available.</div>';
    return;
  }
  
  const buildingFloors = {};
  Object.values(buildings).forEach(b => buildingFloors[b.id] = []);
  Object.values(floors).forEach(f => {
    if (buildingFloors[f.building_id]) buildingFloors[f.building_id].push(f);
  });
  
  const floorRooms = {};
  Object.values(floors).forEach(f => floorRooms[f.id] = []);
  Object.values(rooms).forEach(r => {
    if (r.floor_id && floorRooms[r.floor_id]) floorRooms[r.floor_id].push(r);
  });
  
  Object.values(buildings).forEach(building => {
    const bDiv = document.createElement('div');
    bDiv.className = 'mb-2';
    bDiv.classList.add('eco-location-building-group');
    
    const bHeader = document.createElement('div');
    bHeader.className = 'flex items-center gap-2 bg-[#10b981]/10 px-3 py-2 rounded-t border-b border-[#10b981]/30 dark:border-[#10b981]/20 cursor-pointer hover:bg-[#10b981]/20 transition-colors';
    bHeader.classList.add('eco-location-building');
    bHeader.innerHTML = `
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" class="text-[#10b981]">
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <polyline points="9 22 9 12 15 12 15 22" />
      </svg>
      <span class="font-bold text-[#18392B] dark:text-[#a7f3d0] text-sm">${building.name}</span>
    `;
    
    const floorsContainer = document.createElement('div');
    floorsContainer.className = 'bg-white dark:bg-slate-900 border-x border-b border-gray-200 dark:border-white/5 rounded-b p-2 flex flex-col gap-2';
    floorsContainer.classList.add('eco-location-floors');
    
    bHeader.addEventListener('click', () => {
      floorsContainer.style.display = floorsContainer.style.display === 'none' ? 'flex' : 'none';
    });
    
    const myFloors = buildingFloors[building.id] || [];
    if (myFloors.length === 0) floorsContainer.innerHTML = '<div class="text-xs text-gray-400 dark:text-gray-500 p-2 text-center">No floors</div>';
    
    myFloors.forEach(floor => {
      const fDiv = document.createElement('div');
      fDiv.className = 'border border-gray-100 dark:border-white/5 rounded bg-gray-50 dark:bg-slate-950/40';
      fDiv.classList.add('eco-location-floor');
      
      const fHeader = document.createElement('div');
      fHeader.className = 'flex items-center px-2 py-1 border-b border-gray-100 dark:border-white/5 cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-800/60';
      fHeader.classList.add('eco-location-floor-heading');
      fHeader.innerHTML = `
        <span class="text-xs font-semibold text-gray-700 dark:text-gray-200 flex items-center gap-1">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" class="text-gray-400 dark:text-gray-500">
             <rect x="4" y="4" width="16" height="16" rx="2" ry="2" />
             <line x1="4" y1="12" x2="20" y2="12" />
          </svg>${floor.name}
        </span>
      `;
      
      const roomsContainer = document.createElement('div');
      roomsContainer.className = 'p-1 flex flex-col gap-1';
      roomsContainer.classList.add('eco-location-rooms');
      
      fHeader.addEventListener('click', () => {
        roomsContainer.style.display = roomsContainer.style.display === 'none' ? 'flex' : 'none';
      });
      
      const myRooms = floorRooms[floor.id] || [];
      if (myRooms.length === 0) roomsContainer.innerHTML = '<div class="text-[10px] text-gray-400 dark:text-gray-500 p-1 text-center">No rooms</div>';
      
      myRooms.forEach(room => {
        const roomItem = document.createElement('div');
        const occupancy = room.nodeLimit > 0 ? Math.min((room.nodes.length / room.nodeLimit) * 100, 100) : 0;
        roomItem.className = 'room-item bg-white dark:bg-slate-900 border border-gray-200 dark:border-white/10 p-2.5 rounded-xl cursor-pointer relative hover:border-[#10b981] transition-all shadow-xs';
        roomItem.classList.add('eco-location-room');
        roomItem.setAttribute('data-room', room.id);
        roomItem.innerHTML = `
          <div class="flex items-center justify-between gap-2">
            <div class="min-w-0 flex-1">
              <p class="text-xs font-bold text-[#18392B] dark:text-[#a7f3d0] truncate">${room.name}</p>
              <p class="text-[10px] text-gray-500 dark:text-gray-400 font-medium">${room.nodes.length} AC device node${room.nodes.length === 1 ? '' : 's'}</p>
            </div>
            <span id="roomBadge-${room.id}" class="hidden min-w-[22px] h-[22px] px-1.5 bg-rose-500 text-white text-[11px] font-black rounded-full flex items-center justify-center shadow-xs shrink-0" style="color: #ffffff !important; background-color: #ef4444 !important;">0</span>
          </div>
        `;
        roomItem.addEventListener('click', (e) => {
          e.stopPropagation();
          selectRoom(room);
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

function selectRoom(room) {
  if (!room) return;
  const resolvedRoom = typeof room === 'string' ? (rooms[room] || { id: room }) : (rooms[room.id] || room);
  selectedRoomId = String(resolvedRoom.id || '').trim();
  messagesCurrentPage = 1;
  
  // Update selection styling
  document.querySelectorAll('.room-item').forEach(item => {
    item.classList.remove('border-[#10b981]', 'border-[#18392B]', 'bg-emerald-50', 'bg-green-50', 'bg-emerald-50/60', 'shadow-md', 'dark:border-[#10b981]', 'dark:bg-emerald-950/25');
    item.classList.add('border-gray-200', 'dark:border-white/10', 'bg-white', 'dark:bg-slate-900');
    item.setAttribute('aria-selected', 'false');
  });
  
  const roomEl = document.querySelector(`[data-room="${resolvedRoom.id}"]`);
  if (roomEl) {
    roomEl.classList.remove('border-gray-200', 'dark:border-white/10', 'bg-white', 'dark:bg-slate-900');
    roomEl.classList.add('border-[#10b981]', 'bg-emerald-50/60', 'shadow-sm', 'dark:border-[#10b981]', 'dark:bg-emerald-950/25');
    roomEl.setAttribute('aria-selected', 'true');
  }
  
  
  // Show messages table when room is selected
  const tableContainer = document.getElementById('messagesTableContainer');
  if (tableContainer) {
    tableContainer.classList.remove('hidden');
  }

  // Render what we already have immediately so the table is never blank
  updateMessagesTable();

  // Share the guarded loader so room selection cannot restore dismissed alerts.
  return loadNotificationMessages().catch(error => console.warn('Background notification refresh failed:', error));

}

async function loadNotificationMessages() {
  if (notificationInboxMutationPending) return;
  const request = ++notificationLoadRequest;
  const revision = window._notificationInboxRevision || 0;
  const storedRevision = localStorage.getItem('ecoTrackNotificationInboxRevision');
  const isCurrent = () => request === notificationLoadRequest && !notificationInboxMutationPending &&
    revision === (window._notificationInboxRevision || 0) && storedRevision === localStorage.getItem('ecoTrackNotificationInboxRevision');
  const readState = loadReadStateMap();

  try {
    let records = null;
    let fetchError = null;
    let ipcLoaded = false;
    if (window.electron && typeof window.electron.invoke === 'function') {
      try {
        const res = await window.electron.invoke('notifications-fetch-all');
        if (res?.success && Array.isArray(res.data)) {
          records = res.data;
          ipcLoaded = true;
        } else fetchError = res?.error || 'Notification read was not confirmed';
      } catch (ipcErr) {
        console.warn('IPC notifications-fetch-all error, fallback to sb:', ipcErr);
        fetchError = ipcErr.message;
      }
    }
    if (!ipcLoaded && sb) {
      const { data, error } = await sb.from('notifications').select('*').order('created', { ascending: false });
      if (error) fetchError = error.message;
      else if (Array.isArray(data)) records = data;
    }
    if (!Array.isArray(records)) throw new Error(fetchError || 'Database service unavailable');

    if (!isCurrent()) return;
    // Sync all violation records to persistent audit store
    if (typeof saveViolationToAuditHistory === 'function') {
      (records || []).forEach(r => {
        if (isRuleViolationNotification(r)) {
          saveViolationToAuditHistory(r);
        }
      });
    }

    const activeRecords = (records || []).filter(r => !isInboxDismissedNotification(r));
    // Retained violation audit belongs in history. It must not recreate inbox rows
    // that no longer exist remotely and cannot receive a dismissal update.
    updateInstallationAvailability(activeRecords);
    messages = activeRecords.map(r => {
      if (r.type === 'controller_installation') return installationNotifications?.toMessage(r, readState) || null;
      let roomId = String(r.room_id || r.roomId || r.room || '').trim();
      
      // If roomId is missing or not in loaded rooms, infer room by matching node name inside content
      const rawContent = r.content || r.message || r.name || '';
      const target = extractTargetNodes(rawContent, rooms[roomId], r.node_id || r.node || r.control);
      let specificNode = target.specificNodeId;

      roomId = notificationRoomId(roomId, specificNode);

      const createdDate = r.created ? new Date(r.created) : new Date();
      const rawTime = r.time || (r.created ? createdDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }) : '');
      const timeVal = formatTime12Hour(rawTime);
      const dateVal = r.date || createdDate.toISOString().split('T')[0];
      const contentVal = rawContent || 'Notification Alert';

      return {
        pbId: r.id,
        id: r.id,
        time: timeVal,
        date: dateVal,
        content: contentVal,
        type: r.type || 'standard',
        room_id: r.room_id,
        rule_id: r.rule_id,
        report_id: r.report_id,
        room: roomId,
        node: specificNode,
        nodes: target.nodeNames,
        triggered: r.triggered ?? true,
        read: Boolean(readState[r.id] || readState[r.pbId] || readState[String(r.pbId || r.id_internal || r.id || '')]),
      };
    }).filter(Boolean);
  } catch (error) {
    console.warn('Supabase load error (notifications):', error);
    if (!isCurrent()) return;
    // Keep the last confirmed inbox during a failed read; an error is not an empty result.
    return false;
  }
  
  if (!isCurrent()) return;
  // Always re-render so the table reflects the latest state
  updateMessagesTable();
  return true;
}

function loadReadStateMap() {
  try {
    return JSON.parse(localStorage.getItem(notificationReadStateKey) || '{}') || {};
  } catch (error) {
    return {};
  }
}

function saveReadStateMap(stateMap) {
  localStorage.setItem(notificationReadStateKey, JSON.stringify(stateMap));
  if (typeof window.syncNotificationBadges === 'function') window.syncNotificationBadges();
}

function getNotificationStateKey(message) {
  return String(message?.pbId || message?.id_internal || message?.id || '');
}

function markMessageAsRead(messageId) {
  const message = messages.find(item => item.id === messageId);
  if (!message || message.read) return;

  message.read = true;
  const stateMap = loadReadStateMap();
  stateMap[getNotificationStateKey(message)] = true;
  saveReadStateMap(stateMap);
  updateMessagesTable();
}

function setNotificationFilter(filter) {
  currentNotificationFilter = filter;
  messagesCurrentPage = 1;

  document.querySelectorAll('.notification-filter-btn').forEach(button => {
    const isActive = button.dataset.filter === filter;
    const textSpan = button.querySelector('.filter-btn-text');
    if (isActive) {
      button.className = 'notification-filter-btn active h-10 px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wider bg-[#10b981] hover:bg-emerald-600 text-white shadow-md shadow-emerald-500/25 transition-all cursor-pointer border-[2px] border-[#10b981] inline-flex items-center justify-center whitespace-nowrap gap-2';
      button.style.color = '#ffffff';
      button.style.backgroundColor = '#10b981';
      if (textSpan) textSpan.style.color = '#ffffff';
    } else {
      button.className = 'notification-filter-btn h-10 px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wider bg-white dark:bg-slate-900 border-[2px] border-gray-200 dark:border-white/10 hover:border-[#10b981] text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-slate-800 transition-all cursor-pointer shadow-xs inline-flex items-center justify-center whitespace-nowrap gap-2';
      button.style.color = '';
      button.style.backgroundColor = '';
      if (textSpan) textSpan.style.color = '';
    }
  });

  updateMessagesTable();
}

function _isMessageDue(message) {
  if (!message?.date || !message?.time) return false;
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  if (message.date < today) return true;
  if (message.date > today) return false;

  const nowTotal = now.getHours() * 60 + now.getMinutes();
  const msgTotal = parseTimeToMinutes(message.time);
  if (msgTotal === null) return true;
  return msgTotal <= nowTotal;
}




function showNotification(message, duration = 3000) {
  const notification = document.createElement('div');
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background-color: rgba(15, 23, 42, 0.95);
    border: 2px solid rgb(34, 211, 238);
    color: white;
    padding: 15px 20px;
    border-radius: 8px;
    font-size: 14px;
    z-index: 100;
    animation: slideIn 0.3s ease-in-out;
  `;
  notification.textContent = message;
  document.body.appendChild(notification);
  
  setTimeout(() => {
    notification.style.animation = 'slideOut 0.3s ease-in-out';
    setTimeout(() => notification.remove(), 300);
  }, duration);
}

// ===== MESSAGES & NOTIFICATIONS =====
function isMessageForRoom(msg, targetRoomId) {
  if (!msg || !targetRoomId) return false;
  if (msg.type === 'controller_installation') return String(msg.installation?.room_id || '') === String(targetRoomId);
  const msgRoom = msg.room || msg.room_id || msg.roomId;
  if (msgRoom === targetRoomId) return true;

  const room = rooms[targetRoomId] || Object.values(rooms || {}).find(r => r.id === targetRoomId || r.name === targetRoomId);
  if (!room) return false;

  if (msgRoom === room.id || msgRoom === room.name) return true;
  if (room.name && String(msgRoom).trim().toLowerCase() === String(room.name).trim().toLowerCase()) return true;

  if (Array.isArray(room.nodes) && room.nodes.length > 0) {
    let specificNode = msg.node;
    if (!specificNode && msg.content && msg.content.includes('|||')) {
      specificNode = msg.content.split('|||')[0].trim();
    }
    if (specificNode) {
      const match = room.nodes.some(n => {
        if (!n) return false;
        if (typeof n === 'string') return n.toLowerCase() === specificNode.toLowerCase();
        return (n.name && n.name.toLowerCase() === specificNode.toLowerCase()) ||
               (n.id && n.id.toLowerCase() === specificNode.toLowerCase()) ||
               (n.pb_id && n.pb_id === specificNode);
      });
      if (match) return true;
    }
  }

  return false;
}

function updateRoomBadges() {
  Object.keys(rooms).forEach(roomId => {
    // Count unread triggered messages for this room
    const unreadCount = messages.filter(m => isMessageForRoom(m, roomId) && !m.read && m.triggered).length;
    const badgeEl = document.getElementById(`roomBadge-${roomId}`);
    if (badgeEl) {
      if (unreadCount > 0) {
        badgeEl.textContent = unreadCount;
        badgeEl.classList.remove('hidden');
      } else {
        badgeEl.classList.add('hidden');
      }
    }
  });
}

function updateMessagesTable() {
  updateRoomBadges();
  
  const tbody = document.getElementById('messagesTableBody');
  const dot = document.getElementById('unreadFilterDot');

  if (!selectedRoomId) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="px-4 py-16 text-center">
          <div class="flex flex-col items-center justify-center max-w-sm mx-auto">
            <div class="w-14 h-14 rounded-2xl bg-emerald-500/10 dark:bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 flex items-center justify-center mb-3 shadow-xs">
              <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
              </svg>
            </div>
            <h4 class="font-bold text-sm text-slate-800 dark:text-white mb-1">Select a Room</h4>
            <p class="text-xs text-slate-500 dark:text-gray-400 leading-relaxed">
              Choose a room from the sidebar to inspect its notifications.
            </p>
          </div>
        </td>
      </tr>
    `;
    if (dot) dot.classList.add('hidden');
    return;
  }

  // Dynamically show/hide the Unread filter indicator dot
  const roomUnreadCount = messages.filter(m => isMessageForRoom(m, selectedRoomId) && !m.read && m.triggered).length;
  if (dot) {
    if (roomUnreadCount > 0) {
      dot.classList.remove('hidden');
    } else {
      dot.classList.add('hidden');
    }
  }

  console.log('UpdateMessagesTable - all messages:', messages.length, messages);
  const filtered = messages.filter(msg => {
    if (!isMessageForRoom(msg, selectedRoomId)) return false;
    if (currentNotificationFilter === 'read') return Boolean(msg.read);
    if (currentNotificationFilter === 'unread') return !msg.read;
    if (currentNotificationFilter === 'schedule') return msg.type !== 'controller_installation' && /wake|sleep|schedule|interval/i.test(msg.content || '');
    return true;
  });

  const totalMessages = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalMessages / MESSAGES_PAGE_SIZE));
  if (messagesCurrentPage > totalPages) messagesCurrentPage = totalPages;
  if (messagesCurrentPage < 1) messagesCurrentPage = 1;

  const startIdx = (messagesCurrentPage - 1) * MESSAGES_PAGE_SIZE;
  const endIdx = Math.min(startIdx + MESSAGES_PAGE_SIZE, totalMessages);
  const pageItems = filtered.slice(startIdx, endIdx);

  const pageInfo = document.getElementById('messagesPageInfo');
  const prevBtn = document.getElementById('messagesPrevBtn');
  const nextBtn = document.getElementById('messagesNextBtn');
  const pagesText = document.getElementById('messagesPaginationPages');

  if (pageInfo) {
    pageInfo.textContent = totalMessages === 0
      ? 'Showing 0 of 0 messages'
      : `Showing ${startIdx + 1}–${endIdx} of ${totalMessages} messages`;
  }
  if (pagesText) pagesText.textContent = `Page ${messagesCurrentPage} of ${totalPages}`;
  if (prevBtn) {
    prevBtn.disabled = messagesCurrentPage <= 1;
    if (!prevBtn.dataset.bound) {
      prevBtn.dataset.bound = 'true';
      prevBtn.addEventListener('click', () => {
        if (messagesCurrentPage > 1) {
          messagesCurrentPage--;
          updateMessagesTable();
        }
      });
    }
  }
  if (nextBtn) {
    nextBtn.disabled = messagesCurrentPage >= totalPages;
    if (!nextBtn.dataset.bound) {
      nextBtn.dataset.bound = 'true';
      nextBtn.addEventListener('click', () => {
        messagesCurrentPage++;
        updateMessagesTable();
      });
    }
  }

  if (filtered.length === 0) {
    const isUnread = currentNotificationFilter === 'unread';
    const isRead = currentNotificationFilter === 'read';
    const emptyTitle = isRead
      ? 'No Read Messages'
      : isUnread
        ? 'No Unread Notifications'
        : 'No Notifications in This Room';
    const emptySub = isRead
      ? 'Messages marked as read will appear here.'
      : isUnread
        ? 'All alerts and notifications for this room have been acknowledged.'
        : 'Automatic alerts and schedule updates for this room will appear here.';

    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="px-4 py-14 text-center">
          <div class="flex flex-col items-center justify-center max-w-sm mx-auto">
            <div class="w-14 h-14 rounded-2xl bg-teal-500/10 dark:bg-teal-500/15 text-teal-600 dark:text-teal-400 border border-teal-500/30 flex items-center justify-center mb-3 shadow-xs">
              <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
              </svg>
            </div>
            <h4 class="font-bold text-sm text-slate-800 dark:text-white mb-1">${emptyTitle}</h4>
            <p class="text-xs text-slate-500 dark:text-gray-400 mb-4 leading-relaxed">${emptySub}</p>
          </div>
        </td>
      </tr>
    `;
    return;
  }
  
  tbody.innerHTML = '';
  pageItems.forEach(msg => {
    const room = rooms[msg.room];
    const installation = msg.type === 'controller_installation';
    const target = installation ? { specificNodeId: msg.node, actualContent: msg.content, nodeNames: [msg.installation.controller_name] } : extractTargetNodes(msg.content, room, msg.node);
    const specificNodeId = target.specificNodeId;
    const actualContent = target.actualContent;
    const nodeNames = target.nodeNames;
    
    let acType = 'Mixed/Various';
    if (specificNodeId) {
      // Find node globally to get its aircon_type
      for (const r of Object.values(rooms)) {
        const found = r.nodes?.find(n => (typeof n === 'string' ? n.toLowerCase() === specificNodeId.toLowerCase() : (n.id?.toLowerCase() === specificNodeId.toLowerCase() || n.name?.toLowerCase() === specificNodeId.toLowerCase() || n.pb_id === specificNodeId)));
        if (found) { acType = notificationAirconType(found); break; }
      }
    } else if (msg.room_id && rooms[msg.room_id] && rooms[msg.room_id].nodes && rooms[msg.room_id].nodes.length === 1) {
      acType = notificationAirconType(rooms[msg.room_id].nodes[0]);
    } else {
      acType = 'Split Type (Inverter)';
    }
    
    if (installation) acType = msg.installation.aircon_type || 'Unavailable';
    const nodeLabel = installationNotifications.escapeHtml(nodeNames.length ? nodeNames.join(', ') : '—');
    const row = document.createElement('tr');
    row.className = `bg-white dark:bg-transparent border-b border-gray-100 dark:border-white/5 hover:bg-emerald-50/40 dark:hover:bg-slate-800/60 text-sm transition-colors cursor-pointer`;
    row.setAttribute('data-id', msg.id);
    row.innerHTML = `
      <td class="px-6 py-4 align-middle whitespace-nowrap">
        <div class="flex flex-col gap-1.5">
          <span class="font-bold text-[#18392B] dark:text-white text-sm">${formatTime12Hour(msg.time)}</span>
          <span class="inline-flex items-center px-2 py-0.5 rounded-full text-[9px] font-bold tracking-widest uppercase ${msg.triggered ? 'bg-emerald-100 dark:bg-emerald-950/70 text-emerald-800 dark:text-emerald-400 dark:border dark:border-emerald-800/40' : 'bg-cyan-100 dark:bg-cyan-950/70 text-cyan-800 dark:text-cyan-400 dark:border dark:border-cyan-800/40'} w-fit">
            ${installation ? 'Installation' : msg.triggered ? 'Triggered' : 'Scheduled'}
          </span>
        </div>
      </td>
      <td class="px-6 py-4 align-middle whitespace-nowrap">
        <div class="flex items-center gap-2 text-gray-600 dark:text-gray-300 font-medium text-sm">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" class="text-gray-400 dark:text-gray-400 shrink-0">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
            <line x1="16" y1="2" x2="16" y2="6"/>
            <line x1="8" y1="2" x2="8" y2="6"/>
            <line x1="3" y1="10" x2="21" y2="10"/>
          </svg>
          ${msg.date}
        </div>
      </td>
      <td class="px-6 py-4 align-middle">
        <div class="flex flex-col">
          <div class="font-bold text-[#18392B] dark:text-gray-100 text-sm">${nodeLabel}</div>
          <div class="text-gray-400 dark:text-gray-400 text-xs mt-0.5">${nodeNames.length ? `${nodeNames.length} node${nodeNames.length > 1 ? 's' : ''}` : 'Room-wide broadcast'}</div>
        </div>
      </td>
      <td class="px-6 py-4 align-middle text-[#18392B] dark:text-gray-200 text-sm font-semibold whitespace-nowrap">
        ${installation ? installationNotifications.escapeHtml(acType) : acType}
      </td>
      <td class="px-6 py-4 align-middle">
        <div class="text-gray-800 dark:text-gray-200 text-sm font-medium leading-relaxed">
          ${installation ? '<span class="text-emerald-600 text-xs font-bold">Installation · </span>' : /wake|sleep|schedule|interval/i.test(msg.content || '') ? '<span class="text-emerald-600 text-xs font-bold">Schedule · </span>' : ''}${installation ? installationNotifications.escapeHtml(actualContent.substring(0, 160)) : actualContent.substring(0, 96)}${actualContent.length > (installation ? 160 : 96) ? '...' : ''}
        </div>
      </td>
      <td class="px-6 py-4 align-middle text-center">
        <span class="inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-bold tracking-wider uppercase ${msg.read ? 'bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-white/10' : 'bg-red-100 dark:bg-red-950/70 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800/40'}">
          ${msg.read ? 'Read' : 'Unread'}
        </span>
      </td>
      <td class="px-6 py-4 align-middle">
        <button class="deleteTableBtn flex items-center gap-1.5 px-3.5 py-1.5 bg-white dark:bg-slate-900 border border-red-200 dark:border-red-900/40 text-red-500 dark:text-red-400 rounded-lg text-xs font-bold hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors cursor-pointer" data-id="${msg.id}">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 6h18" />
            <path d="M8 6V4h8v2" />
            <path d="M6 6l1 14h10l1-14" />
          </svg>
          Remove
        </button>
      </td>
    `;
    
    // Make row clickable to view details
    row.addEventListener('click', (e) => {
      // Don't open modal if clicking the delete button
      if (e.target.closest('.deleteTableBtn')) {
        return;
      }
      markMessageAsRead(msg.id);
      if (msg.type === 'maintenance_verification' && msg.report_id) {
        window.location.href = `staff.html?verifyReport=${encodeURIComponent(msg.report_id)}`;
        return;
      }
      openViewMessageModal(msg);
    });
    
    row.querySelector('.deleteTableBtn').addEventListener('click', () => deleteMessage(msg.id));
    tbody.appendChild(row);
  });
}

function refreshMessages() {
  const refreshBtn = document.getElementById('refreshBtn');
  const icon = refreshBtn.querySelector('svg');
  
  // Add spin animation
  icon.classList.add('spin-icon');
  
  // Remove animation class after it completes
  setTimeout(() => {
    icon.classList.remove('spin-icon');
  }, 1000);
  
  updateMessagesTable();
  showNotification('✓ Messages refreshed');
}

function deleteMessage(id) {
  pendingDeleteMessageId = id;
  const modal = document.getElementById('confirmDeleteModal');
  if (modal) {
    modal.classList.remove('hidden');
    setTimeout(() => {
      modal.querySelector('div').classList.remove('scale-100', 'scale-95');
      modal.querySelector('div').classList.add('scale-100');
    }, 10);
  }
}

function isInboxDismissedNotification(notification) {
  if (notification && typeof notification === 'object') {
    return notification.is_dismissed_from_inbox === true || isInboxDismissedNotification(notification.content || notification.message);
  }
  return typeof notification === 'string' && notification.startsWith('__INBOX_DISMISSED__|||');
}

function isRuleViolationNotification(notif) {
  if (notif?.type === 'controller_installation') return false;
  if (!notif) return false;
  const content = String(notif.content || notif.message || notif.title || '').toLowerCase();
  // Strictly exclude routine schedule alerts (wake up, sleep time, schedules) and battery alerts
  if (
    content.includes('wake') ||
    content.includes('sleep') ||
    content.includes('schedule') ||
    content.includes('scheduled') ||
    content.includes('scheduler') ||
    content.includes('interval') ||
    content.includes('cycle') ||
    content.includes('battery')
  ) {
    return false;
  }

  // If tied to a rule, it is a rule violation alert
  if (notif.rule_id) {
    return true;
  }

  const isViolationText = (
    content.includes('temperature') ||
    content.includes('temp ') ||
    content.includes('threshold') ||
    content.includes('breach') ||
    content.includes('went above') ||
    content.includes('went below') ||
    content.includes('condition:')
  );
  return isViolationText && Boolean(notif.triggered);
}

async function confirmDeleteMessage() {
  if (!pendingDeleteMessageId || !beginNotificationInboxMutation()) return;
  const id = pendingDeleteMessageId;
  const msgToDelete = messages.find(message => message.id === id);
  try {
    if (!msgToDelete) throw new Error('This notification is no longer available. Refresh and try again.');
    await persistNotificationInboxDismissal([msgToDelete]);
    if (isRuleViolationNotification(msgToDelete) && typeof saveViolationToAuditHistory === 'function') {
      saveViolationToAuditHistory({ ...msgToDelete, is_dismissed_from_inbox: true });
    }
    const stateMap = loadReadStateMap();
    const stateKey = getNotificationStateKey(msgToDelete);
    if (stateKey && stateMap[stateKey]) {
      delete stateMap[stateKey];
      saveReadStateMap(stateMap);
    }
    messages = messages.filter(message => message.id !== id && message.pbId !== id);
    window.EcoDataBus?.invalidate('notifications:data');
    window.EcoDataBus?.invalidate('notifications');
    updateMessagesTable();
    const viewModal = document.getElementById('viewMessageModal');
    if (viewModal && viewModal.style.display !== 'none') closeViewMessageModal();
    showNotification('Message deleted');
    cancelDeleteMessage();
    return true;
  } catch (error) {
    console.warn('Notification dismissal failed:', error);
    showNotification('Could not remove notification: ' + error.message);
    return false;
  } finally {
    endNotificationInboxMutation();
  }
}

function cancelDeleteMessage() {
  pendingDeleteMessageId = null;
  const modal = document.getElementById('confirmDeleteModal');
  if (modal) {
    const card = modal.querySelector('div');
    if (card) {
      card.classList.remove('scale-100');
      card.classList.add('scale-95');
    }
    setTimeout(() => {
      modal.classList.add('hidden');
      modal.style.display = 'none';
    }, 150);
  }
}

function closeDeleteModal() {
  cancelDeleteMessage();
}

function openClearAllModal() {
  if (!selectedRoomId) {
    showNotification('Please select a room first');
    return;
  }
  const roomMessages = messages.filter(m => isMessageForRoom(m, selectedRoomId));
  if (roomMessages.length === 0) {
    showNotification('No notifications to clear');
    return;
  }
  const modal = document.getElementById('clearAllModal');
  if (modal) {
    const room = rooms[selectedRoomId] || Object.values(rooms || {}).find(r => r.id === selectedRoomId);
    const roomName = room?.name || 'this room';
    const confirmMsg = document.getElementById('clearAllConfirmMessage');
    if (confirmMsg) {
      confirmMsg.textContent = `Are you sure you want to clear all ${roomMessages.length} notification${roomMessages.length === 1 ? '' : 's'} for ${roomName}? This action cannot be undone.`;
    }
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
    const card = modal.querySelector('div');
    if (card) {
      card.classList.remove('scale-100', 'scale-95');
      card.classList.add('scale-100');
    }
  }
}

function closeClearAllModal() {
  const modal = document.getElementById('clearAllModal');
  if (modal) {
    const card = modal.querySelector('div');
    if (card) {
      card.classList.remove('scale-100');
      card.classList.add('scale-95');
    }
    setTimeout(() => {
      modal.classList.add('hidden');
      modal.style.display = 'none';
    }, 150);
  }
}

async function clearAllMessages() {
  if (!selectedRoomId) { showNotification('Please select a room first'); return; }
  const roomMessages = messages.filter(message => isMessageForRoom(message, selectedRoomId));
  if (!roomMessages.length) { showNotification('No notifications to clear'); return; }
  if (!beginNotificationInboxMutation()) return;
  try {
    // One room-scoped update preserves event keys and audit records for every alert type.
    await persistNotificationInboxDismissal(roomMessages);
    roomMessages.filter(isRuleViolationNotification).forEach(message => {
      window.saveViolationToAuditHistory?.({ ...message, is_dismissed_from_inbox: true });
    });
    const stateMap = loadReadStateMap();
    roomMessages.forEach(message => { delete stateMap[getNotificationStateKey(message)]; });
    saveReadStateMap(stateMap);
    const clearedIds = new Set(roomMessages.map(message => String(message.pbId || message.id)));
    messages = messages.filter(message => !clearedIds.has(String(message.pbId || message.id)));
    messagesCurrentPage = 1;
    window.EcoDataBus?.invalidate('notifications:data');
    window.EcoDataBus?.invalidate('notifications');
    const viewModal = document.getElementById('viewMessageModal');
    if (viewModal && viewModal.style.display !== 'none') closeViewMessageModal();
    updateMessagesTable();
    showNotification('Cleared ' + roomMessages.length + ' notification' + (roomMessages.length === 1 ? '' : 's'));
    return true;
  } catch (error) {
    console.warn('Notification dismissal failed during clear all:', error);
    showNotification('Could not clear notifications: ' + error.message);
    return false;
  } finally {
    endNotificationInboxMutation();
  }
}

// ===== VIEW MESSAGE MODAL =====
function openViewMessageModal(message) {
  markMessageAsRead(message.id);
  if (message.type === 'controller_installation' && message.installation && installationNotifications) {
    document.getElementById('viewMessageCombined').innerHTML = installationNotifications.renderDetails(message.installation);
    currentViewMessageId = message.id;
    document.getElementById('viewMessageModal').style.display = 'flex';
    return;
  }
  
  const roomRef = rooms[message.room] || 
                  Object.values(rooms || {}).find(r => r.id === message.room || r.name === message.room || (r.name && message.room && r.name.toLowerCase() === String(message.room).toLowerCase())) || 
                  rooms[selectedRoomId];
  const roomLabel = notificationLocation(roomRef);
  
  const target = extractTargetNodes(message.content, roomRef, message.node);
  const actualContent = target.actualContent;
  let nodeNames = target.nodeNames || [];

  if (!target.specificNodeId && (!nodeNames || nodeNames.length === 0)) {
    if (message.node) {
      nodeNames = [message.node];
    } else if (Array.isArray(message.nodes) && message.nodes.length > 0) {
      nodeNames = message.nodes;
    }
  }
  
  const controlsText = nodeNames.length ? nodeNames.join(', ') : (roomRef?.nodes?.length ? 'All Controls' : '—');
  
  const formattedHtml = `
    <div class="bg-gray-50/90 dark:bg-[#070d1e] rounded-2xl p-6 border border-gray-200 dark:border-white/10 shadow-sm">
      <div class="flex flex-col gap-4 mb-6 pb-6 border-b border-gray-200 dark:border-white/10 text-sm text-gray-600 dark:text-gray-400">
        <div class="flex items-center gap-4">
          <div class="p-2.5 rounded-xl bg-white dark:bg-[#0c1328] shadow-sm border border-gray-200 dark:border-white/10 text-[#10b981] dark:text-emerald-400">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
          </div>
          <span class="font-medium">Location: <span class="text-[#18392B] dark:text-emerald-300 font-bold ml-1">${installationNotifications.escapeHtml(roomLabel)}</span></span>
        </div>
        <div class="flex items-center gap-4">
          <div class="p-2.5 rounded-xl bg-white dark:bg-[#0c1328] shadow-sm border border-gray-200 dark:border-white/10 text-[#10b981] dark:text-emerald-400">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7v10c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V7l-10-5z" /><path d="M12 12l-8-4.3 8-4.3 8 4.3" /></svg>
          </div>
          <span class="font-medium">Controls: <span class="text-[#18392B] dark:text-gray-200 font-bold ml-1">${installationNotifications.escapeHtml(controlsText)}</span></span>
        </div>
        <div class="flex items-center gap-4">
          <div class="p-2.5 rounded-xl bg-white dark:bg-[#0c1328] shadow-sm border border-gray-200 dark:border-white/10 text-[#10b981] dark:text-emerald-400">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
          </div>
          <span class="font-medium">Scheduled: <span class="text-[#18392B] dark:text-gray-200 font-bold ml-1">${message.date} at ${formatTime12Hour(message.time)}</span></span>
        </div>
      </div>
      
      <div class="bg-white dark:bg-[#0c1328] rounded-xl p-5 border border-gray-200 dark:border-white/10 shadow-sm relative overflow-hidden">
        <div class="absolute top-0 left-0 w-1.5 h-full bg-[#10b981]"></div>
        <h4 class="text-[11px] uppercase font-extrabold tracking-widest text-[#10b981] dark:text-emerald-400 mb-2">Message Content</h4>
        <p class="text-gray-800 dark:text-gray-100 text-sm font-medium leading-relaxed whitespace-pre-wrap">${actualContent || 'No message content'}</p>
      </div>
      ${Boolean(message.rule_id || isRuleViolationNotification(message)) ? `
      <div class="mt-4 pt-4 border-t border-gray-200 dark:border-white/10 flex items-center justify-between flex-wrap gap-2">
        <div class="flex items-center gap-2">
          <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-400 border border-rose-300 dark:border-rose-500/30">
            Rule Alert
          </span>
          <span class="text-xs text-gray-500 dark:text-gray-400 font-medium">Triggered by environmental rules engine</span>
        </div>
        <a href="rules.html" class="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 rounded-xl font-bold text-xs transition-colors cursor-pointer">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          <span>Manage Rules</span>
        </a>
      </div>
      ` : ''}
    </div>
  `;
  
  document.getElementById('viewMessageCombined').innerHTML = formattedHtml;
  currentViewMessageId = message.id;
  document.getElementById('viewMessageModal').style.display = 'flex';
}

function closeViewMessageModal() {
  document.getElementById('viewMessageModal').style.display = 'none';
  currentViewMessageId = null;
}

function toggleNotifications() {
  const btn = document.getElementById('notifyToggleBtn');
  isNotifying = !isNotifying;
  
  if (isNotifying) {
    btn.classList.remove('bg-red-600', 'hover:bg-red-700');
    btn.classList.add('bg-green-600', 'hover:bg-green-700');
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>Stop Notifying
    `;
    showNotification('✓ Notifications activated');
  } else {
    btn.classList.remove('bg-green-600', 'hover:bg-green-700');
    btn.classList.add('bg-red-600', 'hover:bg-red-700');
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>Notify me
    `;
    showNotification('⊗ Notifications deactivated');
  }
}

// ===== GLOBAL NOTIFICATION SYSTEM =====
function startNotificationCheck() {
  setInterval(async () => {
    if (!isNotifying) return;

    await loadNotificationMessages();

    let tableNeedsUpdate = false;
    messages.forEach(msg => {
      if (_isMessageDue(msg) && !msg.triggered) {
        msg.triggered = true;
        tableNeedsUpdate = true;
      }
      if (!msg.triggered || lastTriggeredIds.has(msg.id)) return;
      lastTriggeredIds.add(msg.id);
      triggerGlobalNotification(msg.content);
    });

    // Re-render the table if any message changed trigger state
    if (tableNeedsUpdate) {
      updateMessagesTable();
    }
  }, 10000);
}

function showGlobalNotification(message) {
  if (localStorage.getItem('ecoTrack_notifications_enabled') === 'false') return;
  const dialog = document.getElementById('globalNotificationDialog');
  const messageEl = document.getElementById('globalNotificationMessage');
  
  if (dialog && messageEl) {
    messageEl.textContent = message;
    dialog.style.display = 'flex';
  }
}

function updateNotificationBadge() {
  const isNotifEnabled = localStorage.getItem('ecoTrack_notifications_enabled') !== 'false';
  const badge = document.getElementById('notificationBadge');
  
  if (badge) {
    const count = getTriggeredNotificationCount();
    if (isNotifEnabled && count > 0) {
      badge.classList.remove('hidden');
      badge.style.display = 'flex';
      badge.textContent = count;
    } else {
      badge.classList.add('hidden');
      badge.style.display = 'none';
    }
  }
}

// Auto-refresh notifications table every 2.5 seconds to reflect newly triggered alerts
setInterval(() => {
  if (selectedRoomId) {
    loadNotificationMessages().catch(() => {});
  }
}, 2500);

window.loadNotificationMessages = loadNotificationMessages;
window.setupNotificationsPage = setupNotificationsPage;

