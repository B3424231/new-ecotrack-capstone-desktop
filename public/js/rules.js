// ===== RULES ENGINE LOGIC =====

// Auto-purge stale violation history on initialization (requested reset)
try {
  if (!localStorage.getItem('ecoTrack_violationHistoryCleaned_v1')) {
    if (typeof clearStoredViolationAuditHistory === 'function') {
      clearStoredViolationAuditHistory();
    } else {
      localStorage.removeItem('ecoTrack_violation_audit_history');
      localStorage.removeItem('ecoTrack_violationAuditHistory');
    }
    localStorage.setItem('ecoTrack_violationHistoryCleaned_v1', 'true');
  }
} catch (_) {}

// Initialize Database Clients
let sb = window.supabaseClient || window.sb;
const pb = window.pb || (typeof PocketBase === 'function' ? new PocketBase() : null);

let rules = [];
let editingRuleId = null;
let ruleSavePending = false;
const ruleTogglePending = new Set();

async function persistRuleEnabled(ids, enabled) {
  const api = window.EcoTrackRulePersistence;
  if (!api) throw new Error('Reload this page before saving rule changes.');
  if (window.electron?.invoke) {
    const result = await window.electron.invoke('rule-toggle', {ids, enabled});
    if (!result?.success) throw new Error(result?.error || 'Rule status could not be saved.');
    return api.assertToggle(result.data, ids, enabled);
  }
  return api.setEnabled(window.supabaseClient || window.sb, ids, enabled);
}
let rooms = {};
let nodes = {};
let buildings = {};
let floors = {};
let currentFilter = 'all';
let pendingDeleteRuleId = null;
let pendingDeleteAllRules = false;
let autoEvalTimerId = null;
let ruleComplianceChart = null;
const triggeredNotificationKeys = new Set();
let currentRankingsData = { rooms: [], floors: [], buildings: [] };
let currentRankingTab = 'rooms';
let currentViolationHistory = [];
let violationHistoryCurrentPage = 1;
const violationHistoryPageSize = 20;
let rulesCurrentPage = 1;
const RULES_PAGE_SIZE = 20;
let currentRankingPage = 1;
const RANKING_PAGE_SIZE = 20;
let violationHistorySearchQuery = '';
let violationHistorySeverityFilter = 'all';
let rulesPageHasContent = false;
let rulesInitialLoadingTimer = null;

function showRulesInitialLoading() {
  const skeletons = window.EcoTrackSkeletons;
  const loading = document.getElementById('rulesLoadingState');
  if (rulesPageHasContent || rulesInitialLoadingTimer || !skeletons || !loading) return;
  loading.classList.remove('hidden');
  loading.setAttribute('aria-busy', 'true');
  const content = document.getElementById('ruleBenchmarkingSection');
  content?.classList.add('hidden');
  content?.setAttribute('aria-busy', 'true');
  // Match the shared loading deadline, including the first location request.
  rulesInitialLoadingTimer = setTimeout(() => showRulesInitialLoadError(
    new Error('Rules are taking too long to load. Check your connection and retry.')), 20000);
  skeletons.renderStatsSkeleton('rulesLoadingStats', { count: 4 });
  skeletons.renderChartSkeleton('rulesLoadingChart', { height: 260 });
  skeletons.renderTableSkeleton('rulesLoadingRankings', { rows: 5, cols: 6 });
  skeletons.renderTableSkeleton('rulesLoadingHistory', { rows: 5, cols: 10 });
  skeletons.renderTableSkeleton('rulesTableBody', { rows: 5, cols: 11 });
}

function finishRulesInitialLoading() {
  rulesPageHasContent = true;
  clearTimeout(rulesInitialLoadingTimer);
  rulesInitialLoadingTimer = null;
  const loading = document.getElementById('rulesLoadingState');
  if (loading) {
    loading.classList.add('hidden');
    loading.setAttribute('aria-busy', 'false');
    loading.replaceChildren();
  }
  const content = document.getElementById('ruleBenchmarkingSection');
  content?.classList.remove('hidden');
  content?.setAttribute('aria-busy', 'false');
}

function showRulesInitialLoadError(error) {
  if (rulesPageHasContent) return;
  clearTimeout(rulesInitialLoadingTimer);
  rulesInitialLoadingTimer = null;
  window.EcoTrackSkeletons?.renderLoadingError('rulesLoadingState', error);
  window.EcoTrackSkeletons?.renderLoadingError('rulesTableBody', error);
}

document.addEventListener('DOMContentLoaded', async () => {
  try { await initializeRulesPage(); } catch (error) { showRulesInitialLoadError(error); }
});

window.addEventListener('page:init', async () => {
  if (document.getElementById('rulesTableBody')) {
    try { await initializeRulesPage(); } catch (error) { showRulesInitialLoadError(error); }
  }
});

function formatTime12h(timeStr) {
  if (!timeStr) return '';
  const parts = timeStr.split(':');
  if (parts.length < 2) return timeStr;
  let hour = parseInt(parts[0], 10);
  const minute = parts[1];
  const ampm = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12;
  hour = hour ? hour : 12;
  return `${String(hour).padStart(2, '0')}:${minute} ${ampm}`;
}

async function initializeRulesPage() {
  if (!sb) sb = window.supabaseClient || window.sb;
  showRulesInitialLoading();
  // Load rooms and nodes
  await loadRoomsAndNodes();
  
  // Setup event listeners
  const viewActiveRulesBtn = document.getElementById('viewActiveRulesBtn');
  if (viewActiveRulesBtn) viewActiveRulesBtn.addEventListener('click', openActiveRulesModal);

  const headerAddRuleBtn = document.getElementById('headerAddRuleBtn');
  if (headerAddRuleBtn) headerAddRuleBtn.addEventListener('click', openRuleModal);

  const closeActiveRulesModalEl = document.getElementById('closeActiveRulesModal');
  if (closeActiveRulesModalEl) closeActiveRulesModalEl.addEventListener('click', closeActiveRulesModal);

  const activeRulesModal = document.getElementById('activeRulesModal');
  if (activeRulesModal) {
    activeRulesModal.addEventListener('click', (e) => {
      if (e.target.id === 'activeRulesModal') {
        closeActiveRulesModal();
      }
    });
  }

  const addRuleBtn = document.getElementById('addRuleBtn');
  if (addRuleBtn) addRuleBtn.addEventListener('click', openRuleModal);
  
  const closeRuleModalEl = document.getElementById('closeRuleModal');
  if (closeRuleModalEl) closeRuleModalEl.addEventListener('click', closeRuleModal);
  
  const closeRuleModalBtn = document.getElementById('closeRuleModalBtn');
  if (closeRuleModalBtn) closeRuleModalBtn.addEventListener('click', closeRuleModal);
  
  const saveRuleBtn = document.getElementById('saveRuleBtn');
  if (saveRuleBtn) saveRuleBtn.addEventListener('click', saveRule);
  
  const ruleType = document.getElementById('ruleType');
  if (ruleType) ruleType.addEventListener('change', onRuleTypeChange);
  
  const ruleBuilding = document.getElementById('ruleBuilding');
  if (ruleBuilding) ruleBuilding.addEventListener('change', onBuildingSelected);
  
  const ruleFloor = document.getElementById('ruleFloor');
  if (ruleFloor) ruleFloor.addEventListener('change', onFloorSelected);
  
  const ruleRoom = document.getElementById('ruleRoom');
  if (ruleRoom) ruleRoom.addEventListener('change', onRoomSelected);

  const clearRulesBtn = document.getElementById('clearRulesBtn');
  if (clearRulesBtn) clearRulesBtn.addEventListener('click', requestClearAllRules);

  const deactivateAllRulesBtn = document.getElementById('deactivateAllRulesBtn');
  if (deactivateAllRulesBtn) deactivateAllRulesBtn.addEventListener('click', deactivateAllRules);
  
  // Filter buttons setup
  document.querySelectorAll('.ruleFilterBtn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.ruleFilterBtn').forEach(b => {
        b.className = 'ruleFilterBtn px-4 py-1.5 border border-[#10b981] dark:border-[#10b981]/40 text-gray-500 dark:text-gray-400 hover:border-[#10b981] rounded-[10px] text-xs font-bold transition-colors cursor-pointer';
      });
      e.target.className = 'ruleFilterBtn px-4 py-1.5 bg-[#18392B] dark:bg-[#10b981] text-white border border-[#18392B] dark:border-[#10b981]/20 rounded-[10px] text-xs font-bold transition-colors cursor-pointer';
      currentFilter = e.target.dataset.filter || 'all';
      rulesCurrentPage = 1;
      displayRules();
    });
  });

  // Setup Active Rules Modal Pagination Buttons
  const rPrevBtn = document.getElementById('rulesPrevPageBtn');
  if (rPrevBtn) {
    rPrevBtn.addEventListener('click', () => {
      if (rulesCurrentPage > 1) {
        rulesCurrentPage--;
        displayRules();
      }
    });
  }
  const rNextBtn = document.getElementById('rulesNextPageBtn');
  if (rNextBtn) {
    rNextBtn.addEventListener('click', () => {
      rulesCurrentPage++;
      displayRules();
    });
  }
  
  // Close modal when clicking outside
  const ruleModal = document.getElementById('ruleModal');
  if (ruleModal) {
    ruleModal.addEventListener('click', (e) => {
      if (e.target.id === 'ruleModal') {
        closeRuleModal();
      }
    });
  }
  
  // Setup confirmation modal listeners
  const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
  if (confirmDeleteBtn) confirmDeleteBtn.addEventListener('click', confirmDelete);
  
  const cancelDeleteBtn = document.getElementById('cancelDeleteBtn');
  if (cancelDeleteBtn) cancelDeleteBtn.addEventListener('click', cancelDelete);
  
  const confirmDeleteModal = document.getElementById('confirmDeleteModal');
  if (confirmDeleteModal) {
    confirmDeleteModal.addEventListener('click', (e) => {
      if (e.target.id === 'confirmDeleteModal') {
        cancelDelete();
      }
    });
  }

  // Close action menus when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.action-menu') && !e.target.closest('.actionDropdownBtn')) {
      document.querySelectorAll('.action-menu').forEach(menu => {
        menu.classList.add('hidden');
      });
    }
  });

  // Setup Violation Rankings Tab Switcher (Rooms, Floors, Buildings)
  const tabRooms = document.getElementById('tabRankingRooms');
  const tabFloors = document.getElementById('tabRankingFloors');
  const tabBuildings = document.getElementById('tabRankingBuildings');

  if (tabRooms) {
    tabRooms.addEventListener('click', () => {
      currentRankingTab = 'rooms';
      currentRankingPage = 1;
      renderViolationRankings();
    });
  }
  if (tabFloors) {
    tabFloors.addEventListener('click', () => {
      currentRankingTab = 'floors';
      currentRankingPage = 1;
      renderViolationRankings();
    });
  }
  if (tabBuildings) {
    tabBuildings.addEventListener('click', () => {
      currentRankingTab = 'buildings';
      currentRankingPage = 1;
      renderViolationRankings();
    });
  }

  // Setup Violation History Search & Filter
  const vSearch = document.getElementById('violationHistorySearch');
  if (vSearch) {
    vSearch.addEventListener('input', (e) => {
      violationHistorySearchQuery = e.target.value;
      violationHistoryCurrentPage = 1;
      renderViolationHistoryTable();
    });
  }

  const vSeverity = document.getElementById('violationHistorySeverityFilter');
  if (vSeverity) {
    vSeverity.addEventListener('change', (e) => {
      violationHistorySeverityFilter = e.target.value;
      violationHistoryCurrentPage = 1;
      renderViolationHistoryTable();
    });
  }

  // Setup Violation History Pagination Buttons
  const vPrevBtn = document.getElementById('violationPrevPageBtn');
  if (vPrevBtn) {
    vPrevBtn.addEventListener('click', () => {
      if (violationHistoryCurrentPage > 1) {
        violationHistoryCurrentPage--;
        renderViolationHistoryTable();
      }
    });
  }

  const vNextBtn = document.getElementById('violationNextPageBtn');
  if (vNextBtn) {
    vNextBtn.addEventListener('click', () => {
      violationHistoryCurrentPage++;
      renderViolationHistoryTable();
    });
  }

  // Setup Violation Details Modal
  const closeVModal = document.getElementById('closeViolationDetailModal');
  if (closeVModal) closeVModal.addEventListener('click', closeViolationDetailModal);

  const closeVModalBtn = document.getElementById('closeViolationDetailModalBtn');
  if (closeVModalBtn) closeVModalBtn.addEventListener('click', closeViolationDetailModal);

  const vModal = document.getElementById('violationDetailModal');
  if (vModal) {
    vModal.addEventListener('click', (e) => {
      if (e.target.id === 'violationDetailModal') {
        closeViolationDetailModal();
      }
    });
  }

  // Setup Clear Violation History Modal & Button
  const clearVHistBtn = document.getElementById('clearViolationHistoryBtn');
  if (clearVHistBtn) {
    clearVHistBtn.addEventListener('click', showClearViolationHistoryModal);
  }

  const cancelClearVHistBtn = document.getElementById('cancelClearViolationHistoryBtn');
  if (cancelClearVHistBtn) {
    cancelClearVHistBtn.addEventListener('click', hideClearViolationHistoryModal);
  }

  const confirmClearVHistBtn = document.getElementById('confirmClearViolationHistoryBtn');
  if (confirmClearVHistBtn) {
    confirmClearVHistBtn.addEventListener('click', executeClearViolationHistory);
  }

  const clearVModal = document.getElementById('confirmClearViolationHistoryModal');
  if (clearVModal) {
    clearVModal.addEventListener('click', (e) => {
      if (e.target.id === 'confirmClearViolationHistoryModal') {
        hideClearViolationHistoryModal();
      }
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const confirmDeleteModal = document.getElementById('confirmDeleteModal');
      if (confirmDeleteModal && !confirmDeleteModal.classList.contains('hidden') && confirmDeleteModal.style.display !== 'none') {
        cancelDelete();
        return;
      }
      const clearModal = document.getElementById('confirmClearViolationHistoryModal');
      if (clearModal && !clearModal.classList.contains('hidden') && clearModal.style.display !== 'none') {
        hideClearViolationHistoryModal();
        return;
      }
      const ruleModal = document.getElementById('ruleModal');
      if (ruleModal && ruleModal.style.display !== 'none') {
        closeRuleModal();
        return;
      }
      const activeRulesModal = document.getElementById('activeRulesModal');
      if (activeRulesModal && activeRulesModal.style.display !== 'none') {
        closeActiveRulesModal();
        return;
      }
      closeViolationDetailModal();
    }
  });

  window.addEventListener('theme:changed', () => {
    if (typeof initRuleComplianceBenchmarking === 'function') {
      initRuleComplianceBenchmarking();
    }
  });

  // Close action menus when scrolling table or window
  window.addEventListener('scroll', () => {
    document.querySelectorAll('.action-menu').forEach(menu => {
      menu.classList.add('hidden');
    });
  }, true);

  // Data fetching via EcoDataBus with Stale-While-Revalidate caching
  async function loadRulesWithSWR(forceRefresh = false) {
    if (window.EcoDataBus) {
      if (!window.EcoDataBus.getCached('rules:data') && window.EcoTrackSkeletons) {
        showRulesInitialLoading();
      }

      await window.EcoDataBus.query('rules:data', async () => {
        await loadRulesFromDB();
        return rules;
      }, { forceRefresh });
    } else {
      await loadRulesFromDB();
      displayRules();
      await initRuleComplianceBenchmarking();
    }
  }

  if (window.EcoDataBus) {
    window.EcoDataBus.onQuery('rules:data', {
      onStart: ({ isBackground }) => {
        if (!isBackground && window.EcoTrackSkeletons) {
          showRulesInitialLoading();
        }
      },
      onSuccess: async (payload) => {
        if (payload && Array.isArray(payload.data)) {
          rules = payload.data;
        }
        displayRules();
        await initRuleComplianceBenchmarking();
        const rBody = document.getElementById('rulesTableBody');
        const vBody = document.getElementById('violationHistoryTableBody');
        if (rBody) { rBody.classList.remove('eco-content-fade-in'); void rBody.offsetWidth; rBody.classList.add('eco-content-fade-in'); }
        if (vBody) { vBody.classList.remove('eco-content-fade-in'); void vBody.offsetWidth; vBody.classList.add('eco-content-fade-in'); }
      },
      onError: ({ error }) => showRulesInitialLoadError(error)
    });

    window.EcoDataBus.on('data:invalidated', (p) => {
      if (p && p.key === 'rules:data') {
        loadRulesWithSWR(true);
      }
    });
  }

  await loadRulesWithSWR();

  // Background polling for benchmark stats updates
  if (!window._ruleBenchmarkInterval) {
    window._ruleBenchmarkInterval = setInterval(() => {
      initRuleComplianceBenchmarking();
    }, 20000);
  }

  window.addEventListener('themeChanged', () => {
    initRuleComplianceBenchmarking();
  });

  window.addEventListener('notification:triggered', () => {
    initRuleComplianceBenchmarking();
  });

  // Automatic background rule monitoring is handled globally by global-notifications.js
  if (autoEvalTimerId) {
    clearInterval(autoEvalTimerId);
    autoEvalTimerId = null;
  }
}

// ===== AUTOMATIC RULES EVALUATION ENGINE (Delegates to Global Engine) =====
async function syncTriggeredNotifications() {
  if (typeof startGlobalRuleChecker === 'function') {
    await startGlobalRuleChecker();
  }
}

function sendBrowserNotification(type, message, roomName, roomId, notifId) {
  const title = `${type === 'temperature' ? '🌡️' : '🔋'} ${type.charAt(0).toUpperCase() + type.slice(1)} Rule Alert`;
  const cleanMsg = (message || '').replace(/^[⏰🌙⚠️🌡️🔋📅\s]+/, '').trim();
  const options = {
    body: `${cleanMsg}\n${roomName}`,
    icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="%2310b981" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>'
  };

  const createNotification = () => {
    const n = new Notification(title, options);
    n.onclick = function() {
      if (typeof window.navigateToNotification === 'function') {
        window.navigateToNotification({
          id: notifId,
          room_id: roomId,
          message: message
        });
      } else {
        try {
          if (window.electron && typeof window.electron.send === 'function') {
            window.electron.send('focus-window');
          }
        } catch (_) {}
        try { window.focus(); } catch (_) {}

        const navPayload = {
          room: roomId,
          notif: notifId,
          highlight: notifId,
          message: message,
          timestamp: Date.now()
        };
        try { sessionStorage.setItem('pendingNav', JSON.stringify(navPayload)); } catch (_) {}
        try { localStorage.setItem('ecoTrack_pendingNotificationNav', JSON.stringify(navPayload)); } catch (_) {}

        if (window.location.pathname.toLowerCase().endsWith('notification.html') && typeof window.focusAndOpenNotification === 'function') {
          window.focusAndOpenNotification(notifId, navPayload);
        } else {
          let destUrl = 'Notification.html';
          const qParams = [];
          if (roomId) qParams.push(`room=${encodeURIComponent(roomId)}`);
          if (notifId) qParams.push(`notif=${encodeURIComponent(notifId)}`);
          if (qParams.length) destUrl += `?${qParams.join('&')}`;
          window.location.href = destUrl;
        }
      }
    };
  };

  if (typeof Notification !== 'undefined') {
    if (Notification.permission === 'granted') {
      createNotification();
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then(permission => {
        if (permission === 'granted') {
          createNotification();
        }
      });
    }
  }
}

// ===== DATA LOADING & CRUD =====
async function loadRoomsAndNodes() {
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
        console.warn('IPC scheduler-fetch-data error in loadRoomsAndNodes:', ipcErr);
      }
    }

    if (!ipcLoaded && sb) {
      const [rRes, fRes, bRes, nRes] = await Promise.all([
        sb.from('rooms').select('*').order('created', { ascending: false }),
        sb.from('floors').select('*').order('created'),
        sb.from('buildings').select('*').order('created'),
        sb.from('nodes').select('*')
      ]);
      roomRecords = rRes.data || [];
      floorRecords = fRes.data || [];
      buildingRecords = bRes.data || [];
      nodeRecords = nRes.data || [];
    }
    
    rooms = {};
    nodes = {};
    buildings = {};
    floors = {};
    
    buildingRecords.forEach(b => {
      buildings[b.id] = { id: b.id, name: b.name };
    });
    
    floorRecords.forEach(f => {
      floors[f.id] = { id: f.id, name: f.name, building_id: f.building_id };
    });
    
    roomRecords.forEach(record => {
      // Exclude any anomalous records or entries matching hardware nodes rather than physical rooms
      const normRecordName = (record.name || '').trim().toLowerCase();
      if (!record.id || !record.name || normRecordName.startsWith('node-') || String(record.id).startsWith('node_')) {
        return;
      }

      const roomNodes = nodeRecords
        .filter(n => n.room_id === record.id)
        .map(n => ({
          id: n.name, // Hardware ID
          pb_id: n.id,
          name: n.name,
          room: record.id,
          roomName: record.name
        }));
      
      let floorName = 'N/A';
      let buildingName = 'N/A';
      let floorId = record.floor_id || '';
      let buildingId = '';
      
      if (floorId && floors[floorId]) {
        floorName = floors[floorId].name;
        buildingId = floors[floorId].building_id || '';
        if (buildingId && buildings[buildingId]) {
          buildingName = buildings[buildingId].name;
        }
      }
        
      rooms[record.id] = {
        id: record.id,
        name: record.name,
        floor_id: floorId,
        floorName: floorName,
        building_id: buildingId,
        buildingName: buildingName,
        nodes: roomNodes
      };
      
      roomNodes.forEach(node => {
        const nodeObj = {
          ...node,
          floorName: floorName,
          buildingName: buildingName
        };
        nodes[node.id] = nodeObj;
        if (node.name) nodes[node.name] = nodeObj;
        if (node.pb_id) nodes[node.pb_id] = nodeObj;
      });
    });
  } catch (error) {
    console.warn('Supabase load error (rooms/nodes):', error);
  }
}

function getRoom(idOrName) {
  if (!idOrName) return null;
  const key = String(idOrName).trim();
  if (rooms[key]) return rooms[key];
  const lower = key.toLowerCase();
  for (const rId in rooms) {
    const r = rooms[rId];
    if (r && r.name && r.name.toLowerCase() === lower) {
      return r;
    }
  }
  return null;
}

async function loadRulesFromDB() {
  try {
    let records = [];
    let ruleNodes = [];

    let ipcLoaded = false;
    if (window.electron && typeof window.electron.invoke === 'function') {
      try {
        const rData = await window.electron.invoke('rules-fetch-data');
        if (rData && rData.success) {
          records = rData.rules || [];
          ruleNodes = rData.ruleNodes || [];
          ipcLoaded = true;
        }
      } catch (ipcErr) {
        console.warn('IPC rules-fetch-data error in loadRulesFromDB:', ipcErr);
      }
    }

    if (!ipcLoaded && sb) {
      const [rulesRes, rnRes] = await Promise.all([
        sb.from('rules').select('*').order('created', { ascending: false }),
        sb.from('rule_nodes').select('*, node:nodes(*)')
      ]);
      records = rulesRes.data || [];
      ruleNodes = rnRes.data || [];
    }
    
    rules = records.map(r => {
      const associatedNodes = ruleNodes.filter(rn => rn.rule_id === r.id);
      const nodesForRule = associatedNodes.map(rn => {
        if (rn.node && rn.node.name) {
          return rn.node.name; // Hardware ID
        }
        return rn.node_id;
      });

      const ruleObj = {
        ...r,
        id: r.id,
        pbId: r.id,
        nodes: nodesForRule,
        enabled: r.enabled !== false,
        room: r.room_id || ''
      };

      const roomObj = getRoom(ruleObj.room);
      if (roomObj) {
        ruleObj.roomName = roomObj.name;
        ruleObj.buildingName = roomObj.buildingName || 'N/A';
        ruleObj.floorName = roomObj.floorName || 'N/A';
      } else {
        ruleObj.buildingName = 'N/A';
        ruleObj.floorName = 'N/A';
      }

      if (ruleObj.type === 'battery' && ruleObj.nodes.length > 0) {
        ruleObj.node = ruleObj.nodes[0];
        if (nodes[ruleObj.node]) {
          ruleObj.nodeName = nodes[ruleObj.node].name;
          ruleObj.roomName = nodes[ruleObj.node].roomName;
          ruleObj.buildingName = nodes[ruleObj.node].buildingName || 'N/A';
          ruleObj.floorName = nodes[ruleObj.node].floorName || 'N/A';
        }
      } else if (ruleObj.type === 'temperature') {
        ruleObj.nodeNames = ruleObj.nodes.map(nodeId => {
          return nodes[nodeId] ? nodes[nodeId].name : nodeId;
        });
      }

      return ruleObj;
    });
  } catch (error) {
    console.warn('Supabase load error (rules):', error);
    rules = [];
  }
}

function onRuleTypeChange(e) {
  const type = e.target.value;
  const unitSelect = document.getElementById('ruleUnit');
  
  // Show/hide relevant sections
  document.getElementById('locationSelection').classList.toggle('hidden', !type);
  document.getElementById('roomNodesSelection').classList.toggle('hidden', type !== 'temperature');
  document.getElementById('nodeSelection').classList.toggle('hidden', type !== 'battery');
  document.getElementById('durationSection').classList.toggle('hidden', type !== 'temperature');
  
  // Update condition options
  const conditionSelect = document.getElementById('ruleCondition');
  
  if (type === 'temperature') {
    conditionSelect.innerHTML = `
      <option value="">Select condition...</option>
      <option value="above">Above (>)</option>
      <option value="below">Below (<)</option>
    `;
    unitSelect.innerHTML = `
      <option value="">Select unit...</option>
      <option value="°C">Celsius (°C)</option>
      <option value="°F">Fahrenheit (°F)</option>
    `;
  } else if (type === 'battery') {
    conditionSelect.innerHTML = `
      <option value="">Select condition...</option>
      <option value="below">Below (<)</option>
      <option value="equals">Equals (==)</option>
    `;
    unitSelect.innerHTML = `
      <option value="">Select unit...</option>
      <option value="%">Percentage (%)</option>
    `;
  } else {
    conditionSelect.innerHTML = '<option value="">Select condition...</option>';
    unitSelect.innerHTML = '<option value="">Select unit...</option>';
  }
}

function onBuildingSelected() {
  const buildingId = document.getElementById('ruleBuilding').value;
  const floorSelect = document.getElementById('ruleFloor');
  const roomSelect = document.getElementById('ruleRoom');
  const roomNodeSelect = document.getElementById('ruleRoomNode');
  const nodeSelect = document.getElementById('ruleNode');
  
  floorSelect.innerHTML = '<option value="">Choose a floor...</option>';
  roomSelect.innerHTML = '<option value="">Choose a room...</option>';
  if (roomNodeSelect) roomNodeSelect.innerHTML = '<option value="">Choose node(s)...</option>';
  if (nodeSelect) nodeSelect.innerHTML = '<option value="">Choose an AC control...</option>';
  
  if (!buildingId) return;
  const seenFloorIds = new Set();
  const seenFloorNames = new Set();

  Object.values(floors).forEach(floor => {
    if (!floor || floor.building_id !== buildingId) return;
    if (seenFloorIds.has(floor.id)) return;
    const normName = (floor.name || '').trim().toLowerCase();
    if (!normName || seenFloorNames.has(normName)) return;

    seenFloorIds.add(floor.id);
    seenFloorNames.add(normName);

    const option = document.createElement('option');
    option.value = floor.id;
    option.textContent = floor.name;
    floorSelect.appendChild(option);
  });
}

function onFloorSelected() {
  const floorId = document.getElementById('ruleFloor').value;
  const roomSelect = document.getElementById('ruleRoom');
  const roomNodeSelect = document.getElementById('ruleRoomNode');
  const nodeSelect = document.getElementById('ruleNode');
  
  roomSelect.innerHTML = '<option value="">Choose a room...</option>';
  if (roomNodeSelect) roomNodeSelect.innerHTML = '<option value="">Choose node(s)...</option>';
  if (nodeSelect) nodeSelect.innerHTML = '<option value="">Choose an AC control...</option>';
  
  if (!floorId) return;
  const seenRoomIds = new Set();
  const seenRoomNames = new Set();

  Object.values(rooms).forEach(room => {
    if (!room || room.floor_id !== floorId) return;
    if (seenRoomIds.has(room.id)) return;
    const normName = (room.name || '').trim().toLowerCase();
    if (!normName || seenRoomNames.has(normName)) return;

    // Filter out any hardware nodes or anomalous non-rooms
    if (nodes[room.id] || nodes[room.name] || normName.startsWith('node-') || String(room.id).startsWith('node_')) {
      return;
    }

    seenRoomIds.add(room.id);
    seenRoomNames.add(normName);

    const option = document.createElement('option');
    option.value = room.id;
    option.textContent = room.name;
    roomSelect.appendChild(option);
  });
}

function onRoomSelected(e) {
  const roomId = e ? (e.target ? e.target.value : e) : document.getElementById('ruleRoom').value;
  const roomNodeSelect = document.getElementById('ruleRoomNode');
  const batteryNodeSelect = document.getElementById('ruleNode');
  
  if (roomNodeSelect) roomNodeSelect.innerHTML = '<option value="">Choose node(s)...</option>';
  if (batteryNodeSelect) batteryNodeSelect.innerHTML = '<option value="">Choose an AC control...</option>';
  
  if (!roomId) return;
  
  const room = getRoom(roomId);
  if (room && room.nodes && Array.isArray(room.nodes)) {
    const seenNodeKeys = new Set();
    room.nodes.forEach(node => {
      const nodeKey = node.id || node.name;
      if (!nodeKey || seenNodeKeys.has(nodeKey)) return;
      seenNodeKeys.add(nodeKey);

      if (roomNodeSelect) {
        const option = document.createElement('option');
        option.value = nodeKey;
        option.textContent = node.name || nodeKey;
        roomNodeSelect.appendChild(option);
      }
      if (batteryNodeSelect) {
        const option = document.createElement('option');
        option.value = nodeKey;
        option.textContent = node.name || nodeKey;
        batteryNodeSelect.appendChild(option);
      }
    });
  }
}

function updateRoomNodesSelection() {
  const roomId = document.getElementById('ruleRoom').value;
  onRoomSelected(roomId);
}

function openActiveRulesModal() {
  const modal = document.getElementById('activeRulesModal');
  if (modal) {
    modal.style.display = 'flex';
    displayRules();
  }
}

function closeActiveRulesModal() {
  const modal = document.getElementById('activeRulesModal');
  if (modal) {
    modal.style.display = 'none';
  }
}

function openRuleModal() {
  editingRuleId = null;
  document.getElementById('modalTitle').textContent = 'Add New Rule';
  document.getElementById('ruleType').value = '';
  document.getElementById('ruleBuilding').value = '';
  document.getElementById('ruleFloor').value = '';
  document.getElementById('ruleRoom').value = '';
  document.getElementById('ruleRoomNode').value = '';
  document.getElementById('ruleNode').value = '';
  document.getElementById('ruleCondition').value = '';
  document.getElementById('ruleValue').value = '';
  document.getElementById('ruleUnit').value = '';
  document.getElementById('ruleDuration').value = '5';
  document.getElementById('ruleStartDate').value = '';
  document.getElementById('ruleStartTime').value = '';
  document.getElementById('ruleEndDate').value = '';
  document.getElementById('ruleEndTime').value = '';
  document.getElementById('ruleEnabled').checked = true;
  
  // Populate building select with deduplication
  const buildingSelect = document.getElementById('ruleBuilding');
  buildingSelect.innerHTML = '<option value="">Choose a building...</option>';
  const seenBldIds = new Set();
  const seenBldNames = new Set();
  Object.values(buildings).forEach(bld => {
    if (!bld || seenBldIds.has(bld.id)) return;
    const normName = (bld.name || '').trim().toLowerCase();
    if (!normName || seenBldNames.has(normName)) return;

    seenBldIds.add(bld.id);
    seenBldNames.add(normName);

    const option = document.createElement('option');
    option.value = bld.id;
    option.textContent = bld.name;
    buildingSelect.appendChild(option);
  });

  document.getElementById('ruleFloor').innerHTML = '<option value="">Choose a floor...</option>';
  document.getElementById('ruleRoom').innerHTML = '<option value="">Choose a room...</option>';
  const roomNodeSelect = document.getElementById('ruleRoomNode');
  if (roomNodeSelect) roomNodeSelect.innerHTML = '<option value="">Choose node(s)...</option>';
  const nodeSelect = document.getElementById('ruleNode');
  if (nodeSelect) nodeSelect.innerHTML = '<option value="">Choose an AC control...</option>';
  
  document.getElementById('locationSelection').classList.add('hidden');
  document.getElementById('roomNodesSelection').classList.add('hidden');
  document.getElementById('nodeSelection').classList.add('hidden');
  document.getElementById('durationSection').classList.add('hidden');
  
  document.getElementById('ruleModal').style.display = 'flex';
}

function closeRuleModal() {
  document.getElementById('ruleModal').style.display = 'none';
  editingRuleId = null;
  document.getElementById('modalTitle').textContent = 'Add New Rule';
  document.getElementById('ruleType').value = '';
  document.getElementById('ruleBuilding').value = '';
  document.getElementById('ruleFloor').value = '';
  document.getElementById('ruleRoom').value = '';
  document.getElementById('ruleRoomNode').value = '';
  document.getElementById('ruleNode').value = '';
  document.getElementById('ruleCondition').value = '';
  document.getElementById('ruleValue').value = '';
  document.getElementById('ruleUnit').value = '';
  document.getElementById('ruleDuration').value = '5';
  document.getElementById('ruleStartDate').value = '';
  document.getElementById('ruleStartTime').value = '';
  document.getElementById('ruleEndDate').value = '';
  document.getElementById('ruleEndTime').value = '';
  document.getElementById('ruleEnabled').checked = true;
}

async function saveRule() {
  if (ruleSavePending) return;
  const type = document.getElementById('ruleType').value;
  const condition = document.getElementById('ruleCondition').value;
  const value = parseFloat(document.getElementById('ruleValue').value);
  const unit = document.getElementById('ruleUnit').value;
  const enabled = document.getElementById('ruleEnabled').checked;
  const duration = parseInt(document.getElementById('ruleDuration').value, 10) || 5;
  const startDate = document.getElementById('ruleStartDate').value || null;
  const startTime = document.getElementById('ruleStartTime').value || null;
  const endDate = document.getElementById('ruleEndDate').value || null;
  const endTime = document.getElementById('ruleEndTime').value || null;

  if (!type) {
    showNotification('⚠️ Please select a rule type');
    return;
  }
  if (!condition) {
    showNotification('⚠️ Please select a condition');
    return;
  }
  if (isNaN(value)) {
    showNotification('⚠️ Please enter a valid threshold value');
    return;
  }

  const buildingId = document.getElementById('ruleBuilding').value;
  const floorId = document.getElementById('ruleFloor').value;
  const rawRoomId = document.getElementById('ruleRoom').value;
  const canonicalRoom = getRoom(rawRoomId);
  const roomId = canonicalRoom ? canonicalRoom.id : rawRoomId;

  let selectedNodes = [];
  let singleNode = '';

  if (type === 'temperature') {
    if (!roomId) {
      showNotification('⚠️ Please select a room');
      return;
    }
    const nodeSelect = document.getElementById('ruleRoomNode');
    if (nodeSelect) {
      selectedNodes = Array.from(nodeSelect.selectedOptions).map(opt => opt.value).filter(Boolean);
    }
    // If no specific nodes highlighted in multi-select, default to all controls in the room
    if (selectedNodes.length === 0 && canonicalRoom && Array.isArray(canonicalRoom.nodes)) {
      selectedNodes = canonicalRoom.nodes.map(n => n.id || n.name).filter(Boolean);
    }
  } else if (type === 'battery') {
    singleNode = document.getElementById('ruleNode').value;
    if (!singleNode) {
      showNotification('⚠️ Please select an AC control');
      return;
    }
    selectedNodes = [singleNode];
  }

  const currentEditingId = editingRuleId;
  const ruleData = {
    id: currentEditingId || ('rul_' + Date.now()),
    type,
    condition,
    value,
    unit,
    duration,
    enabled,
    startDate,
    startTime,
    endDate,
    endTime,
    room: roomId,
    nodes: selectedNodes,
    node: singleNode
  };

  ruleSavePending = true;
  try {
    const dbData = {
      type: ruleData.type,
      condition: ruleData.condition,
      value: ruleData.value,
      unit: ruleData.unit,
      duration: ruleData.duration,
      enabled: ruleData.enabled,
      start_date: ruleData.startDate,
      start_time: ruleData.startTime,
      end_date: ruleData.endDate,
      end_time: ruleData.endTime,
      room_id: ruleData.room || null
    };
    delete dbData.startDate;
    delete dbData.startTime;
    delete dbData.endDate;
    delete dbData.endTime;
    
    // Clean up memory-only fields
    delete dbData.room;
    delete dbData.roomName;
    delete dbData.nodes;
    delete dbData.nodeNames;
    delete dbData.node;
    delete dbData.nodeName;
    delete dbData.buildingName;
    delete dbData.floorName;
    
    dbData.room_id = ruleData.room || null;

    let ruleId = null;
    let targetNodes = [];
    if (ruleData.type === 'temperature' && ruleData.nodes) {
      targetNodes = ruleData.nodes;
    } else if (ruleData.type === 'battery' && ruleData.node) {
      targetNodes = [ruleData.node];
    }
    const targetNodeDbIds = targetNodes.map(hwId => nodes[hwId]?.pb_id || hwId).filter(Boolean);

    const ruleToEdit = currentEditingId ? rules.find(r => r.id === currentEditingId) : null;
    const targetId = ruleToEdit?.pbId || ruleToEdit?.id || currentEditingId;

    const persistence = window.EcoTrackRulePersistence;
    if (!persistence) throw new Error('Reload this page before saving rule changes.');
    if (window.electron && typeof window.electron.invoke === 'function') {
        const res = await window.electron.invoke('rule-save', {
          rule: dbData,
          targetNodes: targetNodeDbIds,
          isEdit: Boolean(currentEditingId),
          editId: targetId
        });
        if (!res?.success) throw new Error(res?.error || 'Rule could not be saved.');
        const receipt = persistence.assertSave({rule_id:res.ruleId,target_nodes:res.targetNodes}, currentEditingId ? targetId : null, targetNodeDbIds);
        ruleId = receipt.rule_id;
    } else {
      const receipt = await persistence.save(window.supabaseClient || window.sb, dbData, targetNodeDbIds, currentEditingId ? targetId : null);
      ruleId = receipt.rule_id;
    }
    ruleData.id = ruleId;
    ruleData.pbId = ruleId;

    const roomObj = getRoom(ruleData.room);
    if (roomObj) {
      ruleData.roomName = roomObj.name;
      ruleData.buildingName = roomObj.buildingName || 'N/A';
      ruleData.floorName = roomObj.floorName || 'N/A';
    } else {
      ruleData.buildingName = 'N/A';
      ruleData.floorName = 'N/A';
    }

    if (ruleData.type === 'temperature' && Array.isArray(ruleData.nodes)) {
      ruleData.nodeNames = ruleData.nodes.map(nId => nodes[nId]?.name || nId);
    } else if (ruleData.type === 'battery' && ruleData.node) {
      ruleData.nodeName = nodes[ruleData.node]?.name || ruleData.node;
    }

    if (currentEditingId) {
      const index = rules.findIndex(r => r.id === currentEditingId);
      if (index !== -1) {
        rules[index] = ruleData;
      }
      showNotification('✓ Rule updated successfully');
    } else {
      rules.push(ruleData);
      showNotification('✓ Rule added successfully');
    }
    
    closeRuleModal();
    window.EcoDataBus?.invalidate('rules:data');
    window.dispatchEvent(new CustomEvent('rules:updated', { detail: { ruleId, enabled: ruleData.enabled } }));
    if (typeof window.invalidateRulesCache === 'function') {
      window.invalidateRulesCache();
    }
    displayRules();
    initRuleComplianceBenchmarking();
    
    // Immediately evaluate rule if enabled
    if (ruleData.enabled) {
      syncTriggeredNotifications(true, true);
    }
  } catch (error) {
    console.error('Failed to save rule to Supabase:', error);
    showNotification('⚠️ Rule was not saved: ' + error.message);
  } finally { ruleSavePending = false; }
}

function editRule(ruleId) {
  const rule = rules.find(r => r.id === ruleId);
  if (!rule) return;
  
  editingRuleId = ruleId;
  document.getElementById('modalTitle').textContent = 'Edit Rule';
  
  onRuleTypeChange({ target: { value: rule.type } });
  document.getElementById('ruleType').value = rule.type;
  document.getElementById('ruleCondition').value = rule.condition;
  document.getElementById('ruleValue').value = rule.value;
  document.getElementById('ruleUnit').value = rule.unit || '';
  document.getElementById('ruleDuration').value = rule.duration || 5;
  document.getElementById('ruleStartDate').value = rule.startDate || '';
  document.getElementById('ruleStartTime').value = rule.startTime || '';
  document.getElementById('ruleEndDate').value = rule.endDate || '';
  document.getElementById('ruleEndTime').value = rule.endTime || '';
  document.getElementById('ruleEnabled').checked = rule.enabled !== false;
  
  if (rule.type === 'temperature') {
    document.getElementById('locationSelection').classList.remove('hidden');
    document.getElementById('roomNodesSelection').classList.remove('hidden');
    document.getElementById('nodeSelection').classList.add('hidden');
    
    const roomData = getRoom(rule.room);
    if (roomData) {
      const buildingSelect = document.getElementById('ruleBuilding');
      buildingSelect.innerHTML = '<option value="">Choose a building...</option>';
      const seenBldIds = new Set();
      const seenBldNames = new Set();
      Object.values(buildings).forEach(b => {
        if (!b || seenBldIds.has(b.id)) return;
        const normName = (b.name || '').trim().toLowerCase();
        if (!normName || seenBldNames.has(normName)) return;
        seenBldIds.add(b.id);
        seenBldNames.add(normName);
        const option = document.createElement('option');
        option.value = b.id;
        option.textContent = b.name;
        buildingSelect.appendChild(option);
      });
      const buildingId = roomData.building_id || '';
      buildingSelect.value = buildingId;
      
      if (buildingId) {
        onBuildingSelected();
        const floorId = roomData.floor_id || '';
        document.getElementById('ruleFloor').value = floorId;
        
        if (floorId) {
          onFloorSelected();
          document.getElementById('ruleRoom').value = roomData.id;
          onRoomSelected(roomData.id);
        }
      }
    } else {
      document.getElementById('ruleRoom').value = rule.room || '';
      updateRoomNodesSelection();
    }
    
    setTimeout(() => {
      const ruleNodeSelect = document.getElementById('ruleRoomNode');
      if (ruleNodeSelect) {
        Array.from(ruleNodeSelect.options).forEach(option => {
          option.selected = rule.nodes && rule.nodes.includes(option.value);
        });
      }
    }, 10);
  } else if (rule.type === 'battery') {
    document.getElementById('nodeSelection').classList.remove('hidden');
    document.getElementById('locationSelection').classList.remove('hidden');
    document.getElementById('roomNodesSelection').classList.add('hidden');
    
    const nodeData = rule.node ? nodes[rule.node] : null;
    const roomData = nodeData && nodeData.room ? getRoom(nodeData.room) : getRoom(rule.room);
    if (roomData) {
      const buildingSelect = document.getElementById('ruleBuilding');
      buildingSelect.innerHTML = '<option value="">Choose a building...</option>';
      const seenBldIds = new Set();
      const seenBldNames = new Set();
      Object.values(buildings).forEach(b => {
        if (!b || seenBldIds.has(b.id)) return;
        const normName = (b.name || '').trim().toLowerCase();
        if (!normName || seenBldNames.has(normName)) return;
        seenBldIds.add(b.id);
        seenBldNames.add(normName);
        const option = document.createElement('option');
        option.value = b.id;
        option.textContent = b.name;
        buildingSelect.appendChild(option);
      });
      const buildingId = roomData.building_id || '';
      buildingSelect.value = buildingId;
      
      if (buildingId) {
        onBuildingSelected();
        const floorId = roomData.floor_id || '';
        document.getElementById('ruleFloor').value = floorId;
        
        if (floorId) {
          onFloorSelected();
          document.getElementById('ruleRoom').value = roomData.id;
          onRoomSelected(roomData.id);
        }
      }
    }
    
    setTimeout(() => {
      document.getElementById('ruleNode').value = rule.node || '';
    }, 10);
  }
  
  document.getElementById('ruleModal').style.display = 'flex';
}

function deleteRule(ruleId) {
  pendingDeleteRuleId = ruleId;
  pendingDeleteAllRules = false;
  setDeleteModalText('Confirm Deletion', 'Are you sure you want to delete this rule? This action cannot be undone.', 'Delete Rule');
  showDeleteConfirmModal();
}

function requestClearAllRules() {
  if (!rules.length) {
    showNotification('⚠️ No rules to clear');
    return;
  }
  pendingDeleteAllRules = true;
  pendingDeleteRuleId = null;
  setDeleteModalText('Clear All Rules', 'Are you sure you want to clear all active rules? This action cannot be undone.', 'Clear All');
  showDeleteConfirmModal();
}

function setDeleteModalText(title, message, confirmText) {
  const titleEl = document.querySelector('#confirmDeleteModal h3');
  const messageEl = document.getElementById('deleteConfirmMessage');
  const confirmBtn = document.getElementById('confirmDeleteBtn');
  if (titleEl) titleEl.textContent = title;
  if (messageEl) messageEl.textContent = message;
  if (confirmBtn) confirmBtn.textContent = confirmText;
}

function showDeleteConfirmModal() {
  const modal = document.getElementById('confirmDeleteModal');
  if (modal) {
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
    modal.style.zIndex = '99999';
    setTimeout(() => {
      modal.classList.add('opacity-100');
    }, 10);
  }
}

function hideDeleteConfirmModal() {
  const modal = document.getElementById('confirmDeleteModal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('opacity-100');
    modal.style.display = 'none';
  }
}

async function confirmDelete() {
  if (pendingDeleteAllRules) {
    const ids = rules.map(r => r.pbId || r.id).filter(Boolean);

    // Optimistically wipe rules array and update UI immediately
    rules = [];
    displayRules();
    initRuleComplianceBenchmarking();
    hideDeleteConfirmModal();
    pendingDeleteAllRules = false;

    // Delete in DB across IPC / Supabase
    let deletedSuccess = false;
    if (window.electron && typeof window.electron.invoke === 'function' && ids.length) {
      try {
        const res = await window.electron.invoke('rule-delete', ids);
        if (res && res.success) deletedSuccess = true;
      } catch (ipcErr) {
        console.warn('IPC rule-delete error, fallback to sb:', ipcErr);
      }
    }

    if (!deletedSuccess && sb && ids.length) {
      try {
        await sb.from('rule_nodes').delete().in('rule_id', ids);
        await sb.from('rules').delete().in('id', ids);
        deletedSuccess = true;
      } catch (e) {
        console.warn('Failed to clear rules from Supabase:', e);
      }
    }

    // Clean tracking cache
    if (window.violationTracking) {
      window.violationTracking = {};
    }
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && (k.startsWith('ecoTrack_violation_start_') || k.startsWith('ecoTrack_alert_triggered_'))) {
          localStorage.removeItem(k);
        }
      }
    } catch (_) {}

    window.EcoDataBus?.invalidate('rules:data');
    window.dispatchEvent(new CustomEvent('rules:updated'));
    if (typeof window.invalidateRulesCache === 'function') {
      window.invalidateRulesCache();
    }

    showNotification('✓ All rules cleared successfully');
    return;
  }

  if (pendingDeleteRuleId) {
    const target = rules.find(r => r.id === pendingDeleteRuleId);
    const targetId = target?.pbId || target?.id || pendingDeleteRuleId;
    const ruleType = target?.type || 'Rule';

    // Optimistically remove from array and update UI immediately
    rules = rules.filter(r => r.id !== pendingDeleteRuleId && r.pbId !== pendingDeleteRuleId);
    displayRules();
    initRuleComplianceBenchmarking();
    hideDeleteConfirmModal();

    let deletedSuccess = false;
    if (window.electron && typeof window.electron.invoke === 'function' && targetId) {
      try {
        const res = await window.electron.invoke('rule-delete', [targetId]);
        if (res && res.success) deletedSuccess = true;
      } catch (ipcErr) {
        console.warn('IPC rule-delete error, fallback to sb:', ipcErr);
      }
    }

    if (!deletedSuccess && sb && targetId) {
      try {
        await sb.from('rule_nodes').delete().eq('rule_id', targetId);
        await sb.from('rules').delete().eq('id', targetId);
        deletedSuccess = true;
      } catch (err) {
        console.warn('Failed to delete rule from Supabase:', err);
      }
    }

    // Clean tracking cache
    if (window.violationTracking) {
      Object.keys(window.violationTracking).forEach(k => {
        if (k.startsWith(`${pendingDeleteRuleId}_`) || (targetId && k.startsWith(`${targetId}_`))) {
          delete window.violationTracking[k];
        }
      });
    }
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && (k.includes(pendingDeleteRuleId) || (targetId && k.includes(targetId)))) {
          localStorage.removeItem(k);
        }
      }
    } catch (_) {}

    pendingDeleteRuleId = null;
    window.EcoDataBus?.invalidate('rules:data');
    window.dispatchEvent(new CustomEvent('rules:updated'));
    if (typeof window.invalidateRulesCache === 'function') {
      window.invalidateRulesCache();
    }
    showNotification(`✓ ${ruleType} rule deleted`);
    return;
  }
  
  hideDeleteConfirmModal();
}

async function deactivateAllRules() {
  if (!rules.length) {
    showNotification('⚠️ No rules to deactivate');
    return;
  }

  const ids = rules.map(r => r.pbId || r.id).filter(Boolean);
  if (ids.some(id => ruleTogglePending.has(id))) return;
  ids.forEach(id => ruleTogglePending.add(id));
  try { await persistRuleEnabled(ids, false); }
  catch (error) { showNotification('⚠️ Rules were not deactivated: ' + error.message); return; }
  finally { ids.forEach(id => ruleTogglePending.delete(id)); }
  rules.forEach(r => { if (ids.includes(r.pbId || r.id)) r.enabled = false; });
  displayRules();
  initRuleComplianceBenchmarking();

  // Clear violation tracking & localStorage timers
  if (window.violationTracking) {
    window.violationTracking = {};
  }
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && (k.startsWith('ecoTrack_violation_start_') || k.startsWith('ecoTrack_alert_triggered_'))) {
        localStorage.removeItem(k);
      }
    }
  } catch (_) {}

  // Invalidate caches and broadcast update
  window.EcoDataBus?.invalidate('rules:data');
  window.dispatchEvent(new CustomEvent('rules:updated'));
  if (typeof window.invalidateRulesCache === 'function') {
    window.invalidateRulesCache();
  }

  showNotification('⚠️ All rules deactivated — monitoring paused');
}

function cancelDelete() {
  pendingDeleteRuleId = null;
  pendingDeleteAllRules = false;
  hideDeleteConfirmModal();
}

function showClearViolationHistoryModal() {
  const modal = document.getElementById('confirmClearViolationHistoryModal');
  if (modal) {
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
    modal.style.zIndex = '99999';
    setTimeout(() => {
      modal.classList.add('opacity-100');
    }, 10);
  }
}

function hideClearViolationHistoryModal() {
  const modal = document.getElementById('confirmClearViolationHistoryModal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('opacity-100');
    modal.style.display = 'none';
  }
}

async function executeClearViolationHistory() {
  hideClearViolationHistoryModal();

  try {
    // 1. Clear local audit storage
    if (typeof clearStoredViolationAuditHistory === 'function') {
      clearStoredViolationAuditHistory();
    } else {
      try {
        localStorage.removeItem('ecoTrack_violation_audit_history');
        localStorage.removeItem('ecoTrack_violationAuditHistory');
      } catch (_) {}
    }

    // 2. Clear violation tracking in memory & localStorage
    if (window.violationTracking) {
      window.violationTracking = {};
    }
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && (k.startsWith('ecoTrack_violation_start_') || k.startsWith('ecoTrack_alert_triggered_'))) {
          localStorage.removeItem(k);
        }
      }
    } catch (_) {}

    // 3. Mark cleaned flag
    try {
      localStorage.setItem('ecoTrack_violationHistoryCleaned_v1', 'true');
    } catch (_) {}

    // 4. Delete violation notifications from Supabase if any exist
    if (window.electron && typeof window.electron.invoke === 'function') {
      try {
        const notifRes = await window.electron.invoke('notifications-fetch-all');
        if (notifRes && notifRes.success && Array.isArray(notifRes.data)) {
          const violationIds = notifRes.data
            .filter(n => n.type !== 'controller_installation' && n.triggered !== false && !isRoutineScheduleNotification(n))
            .map(n => n.id)
            .filter(Boolean);
          if (violationIds.length > 0) {
            await window.electron.invoke('notifications-delete', violationIds);
          }
        }
      } catch (ipcErr) {
        console.warn('IPC notification delete error:', ipcErr);
      }
    } else if (sb) {
      try {
        const { data: nData } = await sb.from('notifications').select('id, content, message, triggered, type');
        if (Array.isArray(nData) && nData.length > 0) {
          const violationIds = nData
            .filter(n => n.type !== 'controller_installation' && n.triggered !== false && !isRoutineScheduleNotification(n))
            .map(n => n.id)
            .filter(Boolean);
          if (violationIds.length > 0) {
            await sb.from('notifications').delete().in('id', violationIds);
          }
        }
      } catch (err) {
        console.warn('Supabase notification delete error:', err);
      }
    }

    // 5. Clear in-memory violation collections
    currentViolationHistory = [];
    currentRankingsData = { rooms: [], floors: [], buildings: [] };

    // 6. Re-render table and rankings
    violationHistoryCurrentPage = 1;
    renderViolationHistoryTable();
    renderViolationRankings();

    // 7. Update summary cards (Total Violations, Non-Compliant Rooms, Violating AC Controls)
    const avgEl = document.getElementById('totalViolations');
    const nonCompliantEl = document.getElementById('nonCompliantRooms');
    const violatingEl = document.getElementById('violatingNodes');
    if (avgEl) avgEl.textContent = '0';
    if (nonCompliantEl) nonCompliantEl.textContent = '0';
    if (violatingEl) violatingEl.textContent = '0';

    // 8. Re-evaluate chart & benchmarking
    await initRuleComplianceBenchmarking();

    // 9. Invalidate caches and broadcast update
    window.EcoDataBus?.invalidate('notifications');
    window.EcoDataBus?.invalidate('notifications:data');
    window.EcoDataBus?.invalidate('rules:data');
    window.dispatchEvent(new CustomEvent('rules:updated'));

    showNotification('✓ Violation history erased successfully');
  } catch (err) {
    console.error('Error clearing violation history:', err);
    showNotification('⚠️ Failed to erase violation history');
  }
}

async function deleteSingleViolationRecord(eventId) {
  if (!eventId) return;

  const item = currentViolationHistory.find(e => String(e.id) === String(eventId));
  if (!item) return;

  const rawId = item.rawId || item.rawNotif?.id || item.id;

  // 1. Remove from localStorage audit store
  if (typeof removeViolationFromAuditHistory === 'function') {
    removeViolationFromAuditHistory(rawId);
    removeViolationFromAuditHistory(item.id);
  } else {
    try {
      const raw = localStorage.getItem('ecoTrack_violation_audit_history') || localStorage.getItem('ecoTrack_violationAuditHistory');
      if (raw) {
        const hist = JSON.parse(raw);
        const filtered = hist.filter(h => String(h.id) !== String(rawId) && String(h.id) !== String(item.id));
        localStorage.setItem('ecoTrack_violation_audit_history', JSON.stringify(filtered));
        localStorage.setItem('ecoTrack_violationAuditHistory', JSON.stringify(filtered));
      }
    } catch (_) {}
  }

  // 2. Remove from Supabase if real DB record
  if (rawId && !String(rawId).startsWith('active-') && !String(rawId).startsWith('evt-') && !String(rawId).startsWith('v_hist_')) {
    if (window.electron && typeof window.electron.invoke === 'function') {
      try {
        await window.electron.invoke('notifications-delete', [rawId]);
      } catch (ipcErr) {
        console.warn('IPC notification delete error:', ipcErr);
      }
    } else if (sb) {
      try {
        await sb.from('notifications').delete().eq('id', rawId);
      } catch (err) {
        console.warn('Supabase notification delete error:', err);
      }
    }
  }

  // 3. Remove from memory
  currentViolationHistory = currentViolationHistory.filter(e => String(e.id) !== String(eventId));

  // 4. Close modal and re-render
  closeViolationDetailModal();
  renderViolationHistoryTable();

  // 5. Invalidate caches and refresh benchmarking
  window.EcoDataBus?.invalidate('notifications');
  window.EcoDataBus?.invalidate('rules:data');
  window.dispatchEvent(new CustomEvent('rules:updated'));
  await initRuleComplianceBenchmarking();

  showNotification('✓ Violation record deleted');
}

async function toggleRuleEnabled(ruleId) {
  const rule = rules.find(r => r.id === ruleId || r.pbId === ruleId);
  if (!rule) return;

  const isCurrentlyActive = rule.enabled !== false && rule.enabled !== 'false' && rule.enabled !== 0 && rule.enabled !== '0';
  const newEnabled = !isCurrentlyActive;
  const targetId = rule.pbId || rule.id;
  if (ruleTogglePending.has(targetId)) return;
  ruleTogglePending.add(targetId);
  try { await persistRuleEnabled([targetId], newEnabled); }
  catch (error) { showNotification('⚠️ Rule status was not changed: ' + error.message); return; }
  finally { ruleTogglePending.delete(targetId); }
  const currentRule = rules.find(item => item.id === ruleId || item.pbId === targetId);
  if (currentRule) currentRule.enabled = newEnabled;
  displayRules();

  // Clean tracking cache and localStorage if disabled
  if (!newEnabled) {
    if (window.violationTracking) {
      Object.keys(window.violationTracking).forEach(k => {
        if (k.startsWith(`${rule.id}_`) || (targetId && k.startsWith(`${targetId}_`))) {
          delete window.violationTracking[k];
        }
      });
    }
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && (k.includes(rule.id) || (targetId && k.includes(targetId)))) {
          localStorage.removeItem(k);
        }
      }
    } catch (_) {}
  }

  // Invalidate query caches and notify global notifications engine
  window.EcoDataBus?.invalidate('rules:data');
  window.dispatchEvent(new CustomEvent('rules:updated', { detail: { ruleId, enabled: newEnabled } }));
  if (typeof window.invalidateRulesCache === 'function') {
    window.invalidateRulesCache();
  }

  // Refresh compliance benchmarks
  initRuleComplianceBenchmarking();

  if (newEnabled) {
    syncTriggeredNotifications(true, true);
    showNotification(`✓ Rule "${rule.type}" enabled — monitoring active`);
  } else {
    showNotification(`⚠️ Rule "${rule.type}" disabled — monitoring paused`);
  }
}

function displayRules() {
  const totalCountEl = document.getElementById('totalRulesCount');
  if (totalCountEl) totalCountEl.textContent = rules.length;

  const tbody = document.getElementById('rulesTableBody');
  if (!tbody) return;
  
  // Filter rules
  const isRuleDisabled = (r) => r.enabled === false || r.enabled === 'false' || r.enabled === 0 || r.enabled === '0';
  let filteredRules = rules;
  if (currentFilter === 'all') {
    filteredRules = rules;
  } else if (currentFilter === 'disabled') {
    filteredRules = rules.filter(isRuleDisabled);
  } else {
    filteredRules = rules.filter(r => r.type === currentFilter);
  }

  const totalRules = filteredRules.length;
  const totalPages = Math.max(1, Math.ceil(totalRules / RULES_PAGE_SIZE));
  if (rulesCurrentPage > totalPages) rulesCurrentPage = totalPages;
  if (rulesCurrentPage < 1) rulesCurrentPage = 1;

  const startIndex = (rulesCurrentPage - 1) * RULES_PAGE_SIZE;
  const endIndex = Math.min(startIndex + RULES_PAGE_SIZE, totalRules);
  const pageRules = filteredRules.slice(startIndex, endIndex);

  const pageInfo = document.getElementById('rulesPageInfo');
  const prevBtn = document.getElementById('rulesPrevPageBtn');
  const nextBtn = document.getElementById('rulesNextPageBtn');
  const pagesContainer = document.getElementById('rulesPaginationPages');

  if (pageInfo) {
    pageInfo.textContent = totalRules === 0
      ? 'Showing 0 to 0 of 0 rules'
      : `Showing ${startIndex + 1} to ${endIndex} of ${totalRules} rules (Page ${rulesCurrentPage} of ${totalPages})`;
  }
  if (prevBtn) prevBtn.disabled = rulesCurrentPage <= 1;
  if (nextBtn) nextBtn.disabled = rulesCurrentPage >= totalPages;

  if (pagesContainer) {
    let pagesHtml = '';
    const maxButtons = 5;
    let startPage = Math.max(1, rulesCurrentPage - Math.floor(maxButtons / 2));
    let endPage = Math.min(totalPages, startPage + maxButtons - 1);
    if (endPage - startPage + 1 < maxButtons) {
      startPage = Math.max(1, endPage - maxButtons + 1);
    }
    if (startPage > 1) {
      pagesHtml += `<button type="button" class="rule-page-btn px-2.5 py-1 text-xs font-bold rounded-lg border border-gray-200 dark:border-white/10 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-800 cursor-pointer" data-page="1">1</button>`;
      if (startPage > 2) pagesHtml += `<span class="px-1 text-gray-400">...</span>`;
    }
    for (let p = startPage; p <= endPage; p++) {
      const isActive = p === rulesCurrentPage;
      pagesHtml += `
        <button type="button" class="rule-page-btn px-2.5 py-1 text-xs font-bold rounded-lg border transition-all cursor-pointer ${isActive ? 'bg-[#10b981] text-white border-[#10b981] shadow-xs' : 'border-gray-200 dark:border-white/10 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-800'}" data-page="${p}">${p}</button>
      `;
    }
    if (endPage < totalPages) {
      if (endPage < totalPages - 1) pagesHtml += `<span class="px-1 text-gray-400">...</span>`;
      pagesHtml += `<button type="button" class="rule-page-btn px-2.5 py-1 text-xs font-bold rounded-lg border border-gray-200 dark:border-white/10 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-800 cursor-pointer" data-page="${totalPages}">${totalPages}</button>`;
    }
    pagesContainer.innerHTML = pagesHtml;
    pagesContainer.querySelectorAll('.rule-page-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        rulesCurrentPage = parseInt(btn.dataset.page);
        displayRules();
      });
    });
  }
  
  if (filteredRules.length === 0) {
    const isZeroTotal = rules.length === 0;
    tbody.innerHTML = `
      <tr class="text-center">
        <td colspan="11" class="px-4 py-16 text-center">
          <div class="flex flex-col items-center justify-center max-w-sm mx-auto">
            <div class="w-14 h-14 rounded-2xl bg-teal-500/10 dark:bg-teal-500/15 text-teal-600 dark:text-teal-400 border border-teal-500/30 flex items-center justify-center mb-3 shadow-xs">
              <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                <circle cx="12" cy="11" r="3"/>
              </svg>
            </div>
            <h4 class="font-bold text-sm text-slate-800 dark:text-white mb-1">
              ${isZeroTotal ? 'No Automation Rules Configured' : 'No Rules Match Selected Filters'}
            </h4>
            <p class="text-xs text-slate-500 dark:text-gray-400 mb-4 leading-relaxed">
              ${isZeroTotal ? 'Create automated compliance policies such as high-temperature thresholds, auto-shutdowns, and battery level alerts.' : 'Adjust search filters or reset to display all facility rules.'}
            </p>
            ${isZeroTotal ? `
              <button type="button" onclick="openRuleModal()" class="eco-primary-action px-4 py-2 rounded-xl bg-gradient-to-r from-teal-500 to-emerald-500 hover:from-teal-400 hover:to-emerald-400 text-slate-950 font-bold text-xs shadow-md inline-flex items-center gap-1.5 transition-all cursor-pointer">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                Create Automation Rule
              </button>
            ` : `
              <button type="button" onclick="const searchIn = document.getElementById('ruleSearchInput'); if (searchIn) searchIn.value=''; if (typeof filterRules === 'function') filterRules();" class="px-4 py-2 rounded-xl bg-teal-500/15 hover:bg-teal-500/25 text-teal-600 dark:text-teal-400 border border-teal-500/30 text-xs font-bold transition-all cursor-pointer">
                Clear Filters
              </button>
            `}
          </div>
        </td>
      </tr>
    `;
    return;
  }
  
  tbody.innerHTML = '';
  pageRules.forEach((rule, idx) => {
    const index = startIndex + idx;
    const row = document.createElement('tr');
    row.className = 'rule-table-row text-sm transition-colors border-b border-gray-100 dark:border-white/5 hover:bg-emerald-50/30 dark:hover:bg-slate-800/50';
    
    const typeLabel = rule.type === 'temperature' ? 'Temperature' : 'Battery';
    let roomLabel = '';
    let nodeLabel = '';
    
    if (rule.type === 'temperature') {
      let friendlyNodeNames = '';
      if (Array.isArray(rule.nodeNames) && rule.nodeNames.length) {
        const cleanNames = rule.nodeNames.filter(n => !n.startsWith('nd_'));
        friendlyNodeNames = cleanNames.length ? cleanNames.join(', ') : rule.nodeNames.join(', ');
      } else if (rule.nodes && Array.isArray(rule.nodes)) {
        const cleanNames = rule.nodes.filter(n => !n.startsWith('nd_'));
        friendlyNodeNames = cleanNames.length ? cleanNames.join(', ') : rule.nodes.join(', ');
      }
      
      let friendlyRoomName = 'Unknown Room';
      if (rule.room && typeof rooms !== 'undefined' && rooms[rule.room]) {
        friendlyRoomName = rooms[rule.room].name;
      } else if (rule.roomName && typeof rooms !== 'undefined') {
        if (rooms[rule.roomName]) {
          friendlyRoomName = rooms[rule.roomName].name;
        } else if (!rule.roomName.startsWith('rm_')) {
          friendlyRoomName = rule.roomName;
        }
      }

      roomLabel = friendlyRoomName;
      nodeLabel = friendlyNodeNames || 'All ACs';
    } else {
      let friendlyRoomName = 'Unknown Room';
      if (rule.room && typeof rooms !== 'undefined' && rooms[rule.room]) {
        friendlyRoomName = rooms[rule.room].name;
      } else if (rule.roomName && typeof rooms !== 'undefined') {
        if (rooms[rule.roomName]) {
          friendlyRoomName = rooms[rule.roomName].name;
        } else if (!rule.roomName.startsWith('rm_')) {
          friendlyRoomName = rule.roomName;
        }
      }
      
      let friendlyNodeName = 'Unknown Control';
      if (rule.nodeName && !rule.nodeName.startsWith('nd_')) {
        friendlyNodeName = rule.nodeName;
      }

      roomLabel = friendlyRoomName;
      nodeLabel = friendlyNodeName;
    }
    
    const conditionText = {
      'above': 'Above (>)',
      'below': 'Below (<)',
      'equals': 'Equals (==)'
    }[rule.condition] || rule.condition;
    
    const isRuleActive = rule.enabled !== false && rule.enabled !== 'false' && rule.enabled !== 0 && rule.enabled !== '0';
    
    const statusBadge = `
      <button type="button" class="ruleStatusToggleBtn inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-bold tracking-wider uppercase cursor-pointer transition-all hover:scale-105 active:scale-95 shadow-xs border ${isRuleActive ? 'bg-emerald-100 dark:bg-emerald-950/60 text-[#10b981] dark:text-emerald-400 border-emerald-300 dark:border-emerald-800/40 hover:bg-emerald-200 dark:hover:bg-emerald-900/60' : 'bg-gray-100 dark:bg-slate-800 text-gray-500 dark:text-gray-400 border-gray-200 dark:border-white/10 hover:bg-gray-200 dark:hover:bg-slate-700'}" title="Click to ${isRuleActive ? 'disable' : 'enable'} this rule" data-id="${rule.id}">
        <span class="w-1.5 h-1.5 rounded-full ${isRuleActive ? 'bg-[#10b981] animate-pulse' : 'bg-gray-400'}"></span>
        <span>${isRuleActive ? 'Active' : 'Disabled'}</span>
      </button>
    `;
    
    let conditionPill = '';
    if (rule.condition === 'above') {
      conditionPill = '<span class="px-2.5 py-0.5 bg-emerald-50 dark:bg-emerald-950/40 text-[#10b981] dark:text-emerald-400 rounded-md text-xs font-bold border border-emerald-200 dark:border-emerald-800/30">Above</span>';
    } else if (rule.condition === 'below') {
      conditionPill = '<span class="px-2.5 py-0.5 bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 rounded-md text-xs font-bold border border-blue-200 dark:border-blue-800/30">Below</span>';
    } else {
      conditionPill = `<span class="px-2.5 py-0.5 bg-gray-50 dark:bg-slate-800 text-gray-600 dark:text-gray-300 rounded-md text-xs font-bold border border-gray-200 dark:border-white/10">${conditionText}</span>`;
    }

    let buildingLabel = rule.buildingName || 'N/A';
    let floorLabel = rule.floorName || 'N/A';
    if (rule.room && rooms[rule.room]) {
      buildingLabel = rooms[rule.room].buildingName || buildingLabel;
      floorLabel = rooms[rule.room].floorName || floorLabel;
    }

    row.innerHTML = `
      <td class="px-5 py-4 align-middle text-center font-bold text-gray-400 text-xs">${index + 1}</td>
      <td class="px-5 py-4 align-middle">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-xl bg-[#18392B] dark:bg-emerald-950/60 text-[#10b981] dark:text-emerald-400 flex items-center justify-center shrink-0 shadow-sm border border-[#10b981]/20">
            ${rule.type === 'temperature' ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/><path d="M11.5 7v4"/></svg>' : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="6" width="18" height="12" rx="2" ry="2"/><line x1="23" y1="13" x2="23" y2="11"/></svg>'}
          </div>
          <div>
            <div class="font-bold text-[#18392B] dark:text-white text-sm">${typeLabel}</div>
            <div class="text-[11px] text-gray-400 font-medium">${rule.type === 'temperature' ? 'Threshold alert' : 'Battery alert (Notification only)'}</div>
          </div>
        </div>
      </td>
      <td class="px-5 py-4 align-middle font-medium text-gray-700 dark:text-gray-200 text-sm">${buildingLabel}</td>
      <td class="px-5 py-4 align-middle font-medium text-gray-700 dark:text-gray-200 text-sm">${floorLabel}</td>
      <td class="px-5 py-4 align-middle font-medium text-gray-700 dark:text-gray-200 text-sm">${roomLabel}</td>
      <td class="px-5 py-4 align-middle font-medium text-gray-500 dark:text-gray-400 text-xs">${nodeLabel}</td>
      <td class="px-5 py-4 align-middle">${conditionPill}</td>
      <td class="px-5 py-4 align-middle font-bold text-[#18392B] dark:text-emerald-300 text-sm">${rule.value} ${rule.unit}</td>
      <td class="px-5 py-4 align-middle">
        ${rule.type === 'temperature' && rule.duration ? `<span class="font-semibold text-gray-600 dark:text-gray-300 text-xs">${rule.duration} min</span>` : '<span class="font-semibold text-emerald-600 dark:text-emerald-400 text-xs">Instant</span>'}
      </td>
      <td class="px-5 py-4 align-middle text-center">${statusBadge}</td>
      <td class="px-5 py-4 align-middle text-right pr-6 relative">
        <button class="actionDropdownBtn p-2 text-[#18392B] dark:text-emerald-400 hover:text-[#10b981] hover:bg-gray-100 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer" data-id="${rule.id}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="1.5"></circle>
            <circle cx="12" cy="5" r="1.5"></circle>
            <circle cx="12" cy="19" r="1.5"></circle>
          </svg>
        </button>
        
        <div id="actionMenu-${rule.id}" class="action-menu hidden absolute right-4 top-10 w-36 bg-white dark:bg-slate-900 border border-gray-200 dark:border-white/10 rounded-xl z-50 overflow-hidden text-left shadow-2xl">
          <button class="editRuleBtn w-full px-4 py-2.5 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-slate-800 hover:text-[#10b981] font-semibold text-left transition-colors flex items-center gap-2 cursor-pointer border-0 bg-transparent" data-id="${rule.id}">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
            Edit
          </button>
          <button class="toggleRuleBtn w-full px-4 py-2.5 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-slate-800 hover:text-[#10b981] font-semibold text-left transition-colors flex items-center gap-2 cursor-pointer border-0 bg-transparent" data-id="${rule.id}">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path><line x1="12" y1="2" x2="12" y2="12"></line></svg>
            ${isRuleActive ? 'Disable' : 'Enable'}
          </button>
          <div class="h-px bg-gray-100 dark:bg-slate-800 my-0.5"></div>
          <button class="deleteRuleBtn w-full px-4 py-2.5 text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 hover:text-red-600 font-semibold text-left transition-colors flex items-center gap-2 cursor-pointer border-0 bg-transparent" data-id="${rule.id}">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            Delete
          </button>
        </div>
      </td>
    `;
    
    // Status button click listener for direct 1-click toggle
    const statusBtn = row.querySelector('.ruleStatusToggleBtn');
    if (statusBtn) {
      statusBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleRuleEnabled(rule.id);
      });
    }

    const actionBtn = row.querySelector('.actionDropdownBtn');
    const actionMenu = row.querySelector('.action-menu');

    row.querySelector('.editRuleBtn').addEventListener('click', () => {
      actionMenu.classList.add('hidden');
      editRule(rule.id);
    });
    row.querySelector('.toggleRuleBtn').addEventListener('click', () => {
      actionMenu.classList.add('hidden');
      toggleRuleEnabled(rule.id);
    });
    row.querySelector('.deleteRuleBtn').addEventListener('click', () => {
      actionMenu.classList.add('hidden');
      deleteRule(rule.id);
    });
    actionBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = actionMenu.classList.contains('hidden');
      document.querySelectorAll('.action-menu').forEach(menu => {
        menu.classList.add('hidden');
      });
      if (willOpen) {
        // Smart vertical positioning to prevent cutoff by table overflow container
        const scrollContainer = actionMenu.closest('.overflow-x-auto') || actionMenu.closest('.overflow-auto') || tbody.closest('.overflow-x-auto') || tbody.closest('.overflow-auto') || actionMenu.closest('#activeRulesModal');
        const isBottomRow = (idx >= pageRules.length - 2 && pageRules.length > 1) || (index >= filteredRules.length - 2 && filteredRules.length > 1);

        let openUpward = isBottomRow;
        if (scrollContainer) {
          const btnRect = actionBtn.getBoundingClientRect();
          const containerRect = scrollContainer.getBoundingClientRect();
          const spaceBelow = containerRect.bottom - btnRect.bottom;
          const spaceAbove = btnRect.top - containerRect.top;
          const menuHeight = 140;

          if ((spaceBelow < menuHeight || isBottomRow) && spaceAbove >= spaceBelow) {
            openUpward = true;
          }
        }

        if (openUpward) {
          actionMenu.classList.remove('top-10');
          actionMenu.classList.add('bottom-10');
          actionMenu.style.top = 'auto';
          actionMenu.style.bottom = '2.5rem';
        } else {
          actionMenu.classList.remove('bottom-10');
          actionMenu.classList.add('top-10');
          actionMenu.style.bottom = 'auto';
          actionMenu.style.top = '2.5rem';
        }
        actionMenu.style.zIndex = '9999';
        actionMenu.classList.remove('hidden');
      }
    });
    tbody.appendChild(row);
  });
}

function getDefaultMessage(type, condition, value) {
  if (type === 'temperature') {
    return `Alert: Temperature ${condition} ${value}°C for {duration} minutes in {room}`;
  } else if (type === 'battery') {
    return `Alert: Battery level ${condition} ${value}% for {node}`;
  }
  return 'Notification triggered';
}

function showNotification(message, duration = 3000) {
  const notification = document.createElement('div');
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background-color: rgba(15, 23, 42, 0.95);
    border: 2px solid rgb(16, 185, 129);
    color: white;
    padding: 12px 20px;
    border-radius: 12px;
    font-size: 13px;
    font-weight: bold;
    z-index: 1000;
    box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);
    animation: slideIn 0.3s ease-in-out;
  `;
  notification.textContent = message;
  document.body.appendChild(notification);
  
  setTimeout(() => {
    notification.style.animation = 'slideOut 0.3s ease-in-out';
    setTimeout(() => notification.remove(), 300);
  }, duration);
}

window.syncTriggeredNotifications = syncTriggeredNotifications;
window.initRuleComplianceBenchmarking = initRuleComplianceBenchmarking;
window.openActiveRulesModal = openActiveRulesModal;
window.closeActiveRulesModal = closeActiveRulesModal;

// ===== RULE COMPLIANCE BENCHMARKING ENGINE =====
async function initRuleComplianceBenchmarking() {
  const ctx = document.getElementById('ruleComplianceChart');
  if (!ctx) return;

  let roomsList = [];
  let rulesList = [];
  let telemetryItems = [];

  try {
    let roomsResult = [];
    let rulesResult = [];
    let nodesResult = [];
    let floorsResult = [];
    let buildingsResult = [];
    let ruleNodesResult = [];
    let notificationsResult = [];

    let ipcRulesLoaded = false;
    if (window.electron && typeof window.electron.invoke === 'function') {
      try {
        const [rData, notifRes] = await Promise.all([
          window.electron.invoke('rules-fetch-data'),
          window.electron.invoke('notifications-fetch-all')
        ]);
        if (rData && rData.success) {
          rulesResult = rData.rules || [];
          roomsResult = rData.rooms || [];
          nodesResult = rData.nodes || [];
          floorsResult = rData.floors || [];
          buildingsResult = rData.buildings || [];
          ruleNodesResult = rData.ruleNodes || [];
          ipcRulesLoaded = true;
        }
        if (notifRes && notifRes.success) {
          notificationsResult = notifRes.data || [];
        }
      } catch (ipcErr) {
        console.warn('IPC rules benchmark fetch error, fallback to sb:', ipcErr);
      }
    }

    if (!ipcRulesLoaded && sb) {
      const [rRes, rulRes, nRes, fRes, bRes, notifRes] = await Promise.all([
        sb.from('rooms').select('*').order('created', { ascending: false }),
        sb.from('rules').select('*').order('created', { ascending: false }),
        sb.from('nodes').select('*'),
        sb.from('floors').select('*'),
        sb.from('buildings').select('*'),
        sb.from('notifications').select('*').order('created', { ascending: false })
      ]);
      roomsResult = rRes.data || [];
      rulesResult = rulRes.data || [];
      nodesResult = nRes.data || [];
      floorsResult = fRes.data || [];
      buildingsResult = bRes.data || [];
      notificationsResult = notifRes?.data || [];
    }

    roomsList = (roomsResult && roomsResult.length > 0) ? roomsResult : Object.values(rooms);
    rulesList = (rulesResult && rulesResult.length > 0) ? rulesResult : (rules || []);
    const allNodes = (nodesResult && nodesResult.length > 0) ? nodesResult : [];
    const rawNotifs = (notificationsResult || []).filter(notif => notif.type !== 'controller_installation');
    let notificationsList = rawNotifs.map(notif => {
      let content = notif.content || '';
      if (typeof content === 'string' && content.startsWith('__INBOX_DISMISSED__|||')) {
        content = content.replace('__INBOX_DISMISSED__|||', '');
      }
      return {
        ...notif,
        content: content
      };
    });

    // Merge persistent Violation Audit History from localStorage so Rule Management
    // data remains fully preserved even if notifications are deleted from the Notification page
    const getAuditFn = (typeof getStoredViolationAuditHistory === 'function' ? getStoredViolationAuditHistory : null) ||
                       (typeof window !== 'undefined' && typeof window.getStoredViolationAuditHistory === 'function' ? window.getStoredViolationAuditHistory : null);
    let auditViolations = [];
    if (getAuditFn) {
      auditViolations = getAuditFn();
    } else {
      try {
        auditViolations = JSON.parse(localStorage.getItem('ecoTrack_violation_audit_history') || localStorage.getItem('ecoTrack_violationAuditHistory') || '[]');
      } catch (_) {}
    }
    if (Array.isArray(auditViolations)) {
      auditViolations.forEach(av => {
        const exists = notificationsList.some(n =>
          (n.id && av.id && String(n.id) === String(av.id)) ||
          (n.date === av.date && n.time === av.time && String(n.room_id) === String(av.room_id) && n.content === av.content)
        );
        if (!exists) {
          notificationsList.push(av);
        }
      });
    }

    // Attempt to fetch latest telemetry from PocketBase if available
    if (pb && pb.collection) {
      try {
        const result = await pb.collection('telemetry').getList(1, 1000, { sort: '-created' });
        if (result && result.items) {
          telemetryItems = result.items;
        }
      } catch (_) {}
    }

    // Create hierarchy mappings
    const buildingsMap = {};
    if (buildingsResult) buildingsResult.forEach(b => { buildingsMap[b.id] = b.name; });

    const floorsMap = {};
    if (floorsResult) floorsResult.forEach(f => { floorsMap[f.id] = { name: f.name, building_id: f.building_id }; });

    function formatTitleCase(str) {
      if (!str) return '';
      return String(str)
        .replace(/[_-]+/g, ' ')
        .replace(/\b([a-z])/g, (_, c) => c.toUpperCase())
        .trim();
    }

    roomsList.forEach(r => {
      r.nodes = allNodes.filter(n => n.room_id === r.id);

      const floor = floorsMap[r.floor_id];
      const rawBuilding = (floor && buildingsMap[floor.building_id]) || r.building_name || r.building || (buildingsResult && buildingsResult[0]?.name) || 'Main Campus';
      const rawFloor = (floor && floor.name) || r.floor_name || r.floor || 'First Floor';
      const rawRoom = r.name || r.room_name || r.id || 'Room';

      const bName = formatTitleCase(rawBuilding);
      const fName = formatTitleCase(rawFloor);
      const rName = formatTitleCase(rawRoom);

      r.buildingName = bName;
      r.floorName = fName;
      r.roomName = rName;
      r.fullName = `${bName} › ${fName} › ${rName}`;

      if (rawBuilding === 'Unknown Building' && rawFloor === 'Unknown Floor') {
        r.ladderLabel = [rName];
      } else if (rawBuilding === 'Unknown Building') {
        r.ladderLabel = [rName, fName];
      } else {
        r.ladderLabel = [rName, `${bName} • ${fName}`];
      }
    });

    // Fetch rule_nodes from IPC result or Supabase
    try {
      let ruleNodes = ruleNodesResult || [];
      if (!ipcRulesLoaded && sb) {
        const { data: rnData } = await sb.from('rule_nodes').select('*');
        if (rnData) ruleNodes = rnData;
      }
      rulesList.forEach(r => {
        const rnForRule = ruleNodes.filter(rn => rn.rule_id === r.id);
        r.nodeIds = rnForRule.map(rn => rn.node_id);
        r.nodes = rnForRule.map(rn => {
          const matched = allNodes.find(n => n.id === rn.node_id || n.name === rn.node_id);
          return matched ? (matched.name || matched.id) : rn.node_id;
        });
      });
    } catch (_) {
      rulesList.forEach(r => { r.nodeIds = r.nodeIds || []; r.nodes = r.nodes || []; });
    }

    // Build latest reading lookup
    const latestByNode = {};
    telemetryItems.forEach(item => {
      if (item.node_id) latestByNode[item.node_id] = item;
    });

    // Fallback to Supabase live nodes table data
    allNodes.forEach(n => {
      const currentReading = {
        node_id: n.name || n.id,
        temperature: n.temp ?? n.temperature ?? 0,
        temp: n.temp ?? n.temperature ?? 0,
        battery: n.battery ?? 100,
        pressure: n.pressure ?? 0,
        status: n.status || 'online'
      };
      if (n.name && !latestByNode[n.name]) latestByNode[n.name] = currentReading;
      if (n.id && !latestByNode[n.id]) latestByNode[n.id] = currentReading;
    });

    // Filter ONLY actively enabled rules!
    // A rule that is disabled in the rules modal must NEVER evaluate violations,
    // count breaches against live telemetry, or trigger violation records.
    const activeEnabledRules = rulesList.filter(r => isRuleActiveAndEnabled(r));
    const disabledRuleIds = new Set(rulesList.filter(r => !isRuleActiveAndEnabled(r)).map(r => String(r.id)));

    // Include all active enabled rules (both temperature and battery thresholds)
    const complianceViolationRules = activeEnabledRules;
    const batteryRuleIds = new Set(rulesList.filter(r => r.type === 'battery').map(r => String(r.id)));

    const roomLabels = [];
    const complianceValues = [];
    const barColors = [];
    const borderColors = [];
    const roomMeta = [];

    let totalCompliance = 0;
    let nonCompliantRooms = 0;
    let violatingNodesTotal = 0;
    let roomsNoRules = 0;

    roomsList.forEach(room => {
      const parsedNodes = parseRoomNodes(room.nodes);
      let roomHasRules = false;
      let nodesEvaluated = 0;
      let nodesViolating = 0;
      const violatingNodeKeys = new Set();

      // Collect all configured rule IDs (active and historical) and node identifiers for this room
      const allRoomRuleIds = new Set(rulesList.filter(r => r.room_id === room.id || r.room === room.id).map(r => String(r.id)));
      const roomRuleIds = new Set(complianceViolationRules.filter(r => r.room_id === room.id || r.room === room.id).map(r => String(r.id)));
      const roomNodeKeys = new Set();
      parsedNodes.forEach(node => {
        const nName = typeof node === 'string' ? node : node.name;
        const nId = typeof node === 'object' ? node.id : node;
        if (nName) roomNodeKeys.add(String(nName).toLowerCase());
        if (nId) roomNodeKeys.add(String(nId).toLowerCase());
      });

      // Check if room has any rules in database (active or configured)
      const hasAnyRuleInDB = rulesList.some(r =>
        (r.room_id && String(r.room_id) === String(room.id)) ||
        (r.room && String(r.room) === String(room.id)) ||
        (r.nodeIds && r.nodeIds.some(nid => roomNodeKeys.has(String(nid).toLowerCase()))) ||
        (r.nodes && r.nodes.some(nid => roomNodeKeys.has(String(nid).toLowerCase())))
      );
      room.hasAnyRuleInDB = hasAnyRuleInDB;

      parsedNodes.forEach(node => {
        const nodeId = typeof node === 'string' ? node : (node.name || node.id);
        const nodePbId = typeof node === 'object' ? node.id : node;
        if (!nodeId) return;

        const nodeRules = getApplicableRules(complianceViolationRules, room.id, nodeId, nodePbId);
        if (nodeRules.length > 0) roomHasRules = true;

        const telemetry = latestByNode[nodeId] || latestByNode[nodePbId];
        if (!telemetry || nodeRules.length === 0) return;

        nodesEvaluated += 1;
        const violated = nodeRules.some(rule => isRuleViolated(rule, telemetry));
        if (violated) {
          nodesViolating += 1;
          violatingNodeKeys.add(String(nodeId).toLowerCase());
        }
      });

      // Count all triggered notifications for this room (each notification = 1 violation)
      // Note: Battery alerts and routine schedule notices (wake/sleep) are NOT room violations.
      // Historical violations must be preserved even if the specific rule is currently disabled.
      const roomTriggeredNotifs = notificationsList.filter(notif => {
        if (notif.triggered === false) return false;

        // Battery alerts are device notifications only, NOT room violations
        if (isBatteryNotification(notif, batteryRuleIds)) return false;

        // Routine schedule alerts (wake up, sleep time, schedules) are NOT room violations
        if (isRoutineScheduleNotification(notif)) return false;

        // Must match this room
        const matchesRoom = (
          (notif.room_id && String(notif.room_id) === String(room.id)) ||
          (notif.roomId && String(notif.roomId) === String(room.id)) ||
          (notif.room && String(notif.room) === String(room.id))
        );

        // 1. Direct rule ID match for this room (matches all configured rules for this room, active or disabled)
        if (notif.rule_id && allRoomRuleIds.has(String(notif.rule_id))) return true;

        // 2. Direct room match: ONLY if content is an environmental threshold breach
        if (matchesRoom) {
          const text = String(notif.content || notif.message || '').toLowerCase();
          const isViolationContent = (
            text.includes('temperature') ||
            text.includes('temp ') ||
            text.includes('threshold') ||
            text.includes('breach') ||
            text.includes('went above') ||
            text.includes('went below') ||
            text.includes('condition:')
          );
          if (isViolationContent) return true;
        }

        // 3. Node ID match for a node in this room (only if explicit violation content)
        const notifNode = notif.node_id || notif.node || notif.control;
        if (notifNode && roomNodeKeys.has(String(notifNode).toLowerCase())) {
          const text = String(notif.content || notif.message || '').toLowerCase();
          const isViolationContent = (
            text.includes('temperature') ||
            text.includes('temp ') ||
            text.includes('threshold') ||
            text.includes('breach') ||
            text.includes('went above') ||
            text.includes('went below') ||
            text.includes('condition:')
          );
          if (isViolationContent) return true;
        }

        return false;
      });

      const triggeredNotifCount = roomTriggeredNotifs.length;

      // Extract unique nodes that triggered notifications
      roomTriggeredNotifs.forEach(notif => {
        const text = String(notif.content || notif.message || '');
        if (text.includes('|||')) {
          const prefixNode = text.split('|||')[0].trim().toLowerCase();
          if (prefixNode && roomNodeKeys.has(prefixNode)) {
            violatingNodeKeys.add(prefixNode);
          }
        }
        const textLower = text.toLowerCase();
        for (const nKey of roomNodeKeys) {
          if (nKey && textLower.includes(nKey)) {
            violatingNodeKeys.add(nKey);
          }
        }
        const notifNode = notif.node_id || notif.node || notif.control;
        if (notifNode && roomNodeKeys.has(String(notifNode).toLowerCase())) {
          violatingNodeKeys.add(String(notifNode).toLowerCase());
        }
      });

      // Every notification triggered counts as a violation (preserve historical count + active)
      const violations = Math.max(triggeredNotifCount, nodesViolating);

      room.violations = violations;
      room.triggeredNotifCount = triggeredNotifCount;
      room.nodesEvaluated = nodesEvaluated;
      room.nodesViolating = nodesViolating;
      room.violatingNodeKeys = violatingNodeKeys;
      room.roomHasRules = roomHasRules;
      room.nodes = parsedNodes;

      if (!roomHasRules && !hasAnyRuleInDB) {
        roomsNoRules += 1;
      }

      // Only exclude rooms with completely no rules, no hardware nodes, and no violations
      if (!roomHasRules && !hasAnyRuleInDB && (!room.nodes || room.nodes.length === 0) && triggeredNotifCount === 0) {
        return;
      }

      totalCompliance += violations;
      if (violations > 0) nonCompliantRooms += 1;
      violatingNodesTotal += violatingNodeKeys.size > 0 ? violatingNodeKeys.size : nodesViolating;

      roomLabels.push(room.ladderLabel || [room.roomName || room.name || room.id]);
      complianceValues.push(violations);

      let color = 'rgba(244, 63, 94, 0.88)'; // Rose for >2
      let borderCol = '#e11d48';
      if (violations === 0) {
        color = 'rgba(16, 185, 129, 0.88)'; // Emerald for 0
        borderCol = '#059669';
      } else if (violations <= 2) {
        color = 'rgba(245, 158, 11, 0.88)'; // Amber for 1-2
        borderCol = '#d97706';
      }

      barColors.push(color);
      borderColors.push(borderCol);

      roomMeta.push({
        violations,
        triggeredNotifs: triggeredNotifCount,
        nodesEvaluated,
        nodesViolating,
        hasRules: roomHasRules || hasAnyRuleInDB,
        buildingName: room.buildingName,
        floorName: room.floorName,
        roomName: room.roomName,
        fullName: room.fullName
      });
    });

    // 1. Compile Room Rankings
    const roomRankings = [];
    roomsList.forEach(room => {
      const violations = room.violations ?? 0;
      if (!room.roomHasRules && !room.hasAnyRuleInDB && (!room.nodes || room.nodes.length === 0) && violations === 0) return;
      roomRankings.push({
        id: room.id,
        name: room.roomName || room.name || 'Room',
        buildingName: room.buildingName || 'Main Campus',
        floorName: room.floorName || 'First Floor',
        fullName: room.fullName || `${room.buildingName} › ${room.floorName} › ${room.roomName}`,
        violations: violations,
        nodesCount: (room.nodes || []).length,
        violatingNodesCount: room.violatingNodeKeys ? room.violatingNodeKeys.size : 0,
        status: violations > 2 ? 'Critical' : violations > 0 ? 'Moderate' : 'Compliant'
      });
    });
    roomRankings.sort((a, b) => b.violations - a.violations || a.name.localeCompare(b.name));

    // 2. Compile Floor Rankings
    const floorMap = {};
    roomsList.forEach(room => {
      const bName = room.buildingName || 'Main Campus';
      const fName = room.floorName || 'First Floor';
      const floorKey = `${bName}__${fName}`;
      if (!floorMap[floorKey]) {
        floorMap[floorKey] = {
          id: floorKey,
          name: fName,
          buildingName: bName,
          violations: 0,
          roomsCount: 0,
          nonCompliantRooms: 0
        };
      }
      const violations = room.violations ?? 0;
      floorMap[floorKey].violations += violations;
      floorMap[floorKey].roomsCount += 1;
      if (violations > 0) floorMap[floorKey].nonCompliantRooms += 1;
    });
    const floorRankings = Object.values(floorMap);
    floorRankings.sort((a, b) => b.violations - a.violations || a.name.localeCompare(b.name));

    // 3. Compile Building Rankings
    const bldgMap = {};
    roomsList.forEach(room => {
      const bName = room.buildingName || 'Main Campus';
      if (!bldgMap[bName]) {
        bldgMap[bName] = {
          id: bName,
          name: bName,
          violations: 0,
          floors: new Set(),
          roomsCount: 0,
          nonCompliantRooms: 0
        };
      }
      const violations = room.violations ?? 0;
      bldgMap[bName].violations += violations;
      bldgMap[bName].floors.add(room.floorName || 'First Floor');
      bldgMap[bName].roomsCount += 1;
      if (violations > 0) bldgMap[bName].nonCompliantRooms += 1;
    });
    const buildingRankings = Object.values(bldgMap).map(b => ({
      ...b,
      floorsCount: b.floors.size
    }));
    buildingRankings.sort((a, b) => b.violations - a.violations || a.name.localeCompare(b.name));

    currentRankingsData = {
      rooms: roomRankings,
      floors: floorRankings,
      buildings: buildingRankings
    };

    // 4. Compile Violation History Events
    const historyEvents = [];
    const seenEventKeys = new Set();

    notificationsList.forEach(notif => {
      if (notif.triggered === false) return;
      if (isBatteryNotification(notif, batteryRuleIds)) return;
      if (isRoutineScheduleNotification(notif)) return;

      // Note: Historical violation records are preserved in the Violation History Board
      // even if the rule is currently disabled. Disabling pauses new evaluations, but does not wipe history.

      // If notification has no rule_id, verify it is truly an environmental violation
      const text = String(notif.content || notif.message || '');
      const textLower = text.toLowerCase();
      if (!notif.rule_id) {
        const isViolationText = (
          textLower.includes('temperature') ||
          textLower.includes('temp ') ||
          textLower.includes('threshold') ||
          textLower.includes('breach') ||
          textLower.includes('went above') ||
          textLower.includes('went below') ||
          textLower.includes('condition:')
        );
        if (!isViolationText) return;
      }

      let matchedRoom = null;
      if (notif.room_id) matchedRoom = roomsList.find(r => String(r.id) === String(notif.room_id));
      if (!matchedRoom && notif.roomId) matchedRoom = roomsList.find(r => String(r.id) === String(notif.roomId));
      if (!matchedRoom && notif.room) matchedRoom = roomsList.find(r => String(r.id) === String(notif.room));

      let nodeName = notif.node_id || notif.node || notif.control || null;
      let cleanText = text;
      if (text.includes('|||')) {
        const parts = text.split('|||');
        if (!nodeName && parts[0].trim()) {
          nodeName = parts[0].trim();
        }
        cleanText = parts.slice(1).join('|||').trim();
      }

      if (!matchedRoom && text) {
        matchedRoom = roomsList.find(r => {
          const rName = String(r.roomName || r.name || '').toLowerCase();
          return rName && text.toLowerCase().includes(rName);
        });
      }

      if (!matchedRoom && nodeName) {
        const matchedNode = allNodes.find(n =>
          (n.name && String(n.name).toLowerCase() === String(nodeName).toLowerCase()) ||
          (n.id && String(n.id).toLowerCase() === String(nodeName).toLowerCase())
        );
        if (matchedNode && matchedNode.room_id) {
          matchedRoom = roomsList.find(r => String(r.id) === String(matchedNode.room_id));
        }
      }

      let matchedRule = null;
      if (notif.rule_id) matchedRule = rulesList.find(r => String(r.id) === String(notif.rule_id));

      if (!nodeName) {
        const matchNode = cleanText.match(/control\s+([A-Za-z0-9_\-]+)/i) || cleanText.match(/node\s+([A-Za-z0-9_\-]+)/i) || cleanText.match(/AC\s+([A-Za-z0-9_\-]+)/i);
        if (matchNode) nodeName = matchNode[1];
      }
      if (!nodeName && matchedRoom && matchedRoom.nodes && matchedRoom.nodes.length > 0) {
        const fn = matchedRoom.nodes[0];
        nodeName = typeof fn === 'string' ? fn : (fn.name || fn.id);
      }
      nodeName = nodeName || 'AC Control Unit';

      let recordedVal = null;
      const actualMatch = cleanText.match(/(?:was|actual[:\s]*)\s*(\d+(?:\.\d+)?)\s*(?:°C|C)?/i);
      if (actualMatch) {
        recordedVal = `${actualMatch[1]}°C`;
      } else {
        const valMatch = cleanText.match(/(\d+(?:\.\d+)?)\s*(?:°C|C)/i);
        if (valMatch) {
          recordedVal = `${valMatch[1]}°C`;
        } else if (matchedRoom && latestByNode[nodeName]) {
          recordedVal = `${Math.round(latestByNode[nodeName].temperature ?? latestByNode[nodeName].temp)}°C`;
        } else {
          recordedVal = 'Exceeded';
        }
      }

      let conditionText = 'Threshold Exceeded';
      if (matchedRule) {
        conditionText = `${matchedRule.condition === 'above' ? '>' : matchedRule.condition === 'below' ? '<' : '=='} ${matchedRule.value}${matchedRule.unit || '°C'}`;
      } else {
        const condMatch = cleanText.match(/\(Condition:\s*([^)]+)\)/i);
        if (condMatch) {
          conditionText = condMatch[1];
        } else {
          const wentMatch = cleanText.match(/(?:went|is)\s+(above|below)\s+(\d+(?:\.\d+)?\s*°?C?)/i);
          if (wentMatch) {
            const sym = wentMatch[1].toLowerCase() === 'above' ? '>' : '<';
            const val = wentMatch[2].includes('°C') ? wentMatch[2] : `${wentMatch[2]}°C`;
            conditionText = `${sym} ${val}`;
          }
        }
      }

      const buildingName = (matchedRoom && matchedRoom.buildingName) || 'Main Campus';
      const floorName = (matchedRoom && matchedRoom.floorName) || 'First Floor';
      const roomName = (matchedRoom && (matchedRoom.roomName || matchedRoom.name)) || 'Monitored Room';

      let timestampStr = '';
      let timestampEpoch = 0;
      if (notif.created) {
        const d = new Date(notif.created);
        timestampEpoch = d.getTime();
        timestampStr = formatDateClean(d);
      } else if (notif.date && notif.time) {
        timestampStr = `${notif.date} • ${notif.time}`;
        timestampEpoch = new Date(`${notif.date} ${notif.time}`).getTime() || Date.now();
      } else {
        timestampStr = formatDateClean(new Date());
        timestampEpoch = Date.now();
      }

      const eventKey = `${notif.id || ''}_${timestampEpoch}_${roomName}_${nodeName}`;
      if (!seenEventKeys.has(eventKey)) {
        seenEventKeys.add(eventKey);
        historyEvents.push({
          id: notif.id ? `evt-${notif.id}` : `evt-${historyEvents.length + 1}`,
          rawId: notif.id,
          timestamp: timestampStr,
          timestampEpoch: timestampEpoch,
          buildingName: buildingName,
          floorName: floorName,
          roomName: roomName,
          nodeName: nodeName,
          ruleCondition: conditionText,
          recordedValue: recordedVal,
          content: cleanText,
          severity: (recordedVal && parseFloat(recordedVal) >= 30) ? 'Critical' : 'Moderate',
          rule: matchedRule,
          room: matchedRoom,
          rawNotif: notif
        });
      }
    });

    // Also sync all existing valid violations into the persistent audit store
    if (typeof saveViolationToAuditHistory === 'function') {
      notificationsList.forEach(n => {
        if (
          n.triggered !== false &&
          !isBatteryNotification(n, batteryRuleIds) &&
          !isRoutineScheduleNotification(n)
        ) {
          saveViolationToAuditHistory(n);
        }
      });
    }

    // If there are actively violating nodes with no history event yet, synthesize an active breach event
    roomsList.forEach(room => {
      if (room.nodesViolating > 0 && room.violatingNodeKeys) {
        room.violatingNodeKeys.forEach(nKey => {
          const hasEvent = historyEvents.some(e => e.roomName === (room.roomName || room.name) && String(e.nodeName).toLowerCase() === nKey);
          if (!hasEvent) {
            const now = new Date();
            const telemetry = latestByNode[nKey] || {};
            const recordedVal = `${Math.round(telemetry.temp ?? telemetry.temperature ?? 0)}°C`;
            const activeEvent = {
              id: `active-${room.id}-${nKey}`,
              rawId: null,
              timestamp: formatDateClean(now),
              timestampEpoch: now.getTime(),
              buildingName: room.buildingName || 'Main Campus',
              floorName: room.floorName || 'First Floor',
              roomName: room.roomName || room.name || 'Room',
              nodeName: nKey,
              ruleCondition: 'Active Breach',
              recordedValue: recordedVal,
              content: `Live telemetry exceeded rule threshold (${recordedVal})`,
              severity: (parseFloat(recordedVal) >= 30) ? 'Critical' : 'Moderate',
              rule: null,
              room: room,
              rawNotif: null
            };
            historyEvents.unshift(activeEvent);
            if (typeof saveViolationToAuditHistory === 'function') {
              saveViolationToAuditHistory({
                id: activeEvent.id,
                room_id: room.id,
                content: activeEvent.content,
                date: now.toISOString().split('T')[0],
                time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }),
                triggered: true
              });
            }
          }
        });
      }
    });

    historyEvents.sort((a, b) => b.timestampEpoch - a.timestampEpoch);
    currentViolationHistory = historyEvents;

    // Render Rankings & History Board
    renderViolationRankings();
    renderViolationHistoryTable();

    // Update Summary Metric Cards (Positioned at TOP of Rule Violation Benchmarking)
    const avgEl = document.getElementById('totalViolations');
    const nonCompliantEl = document.getElementById('nonCompliantRooms');
    const violatingEl = document.getElementById('violatingNodes');
    const noRulesEl = document.getElementById('roomsNoRules');
    const countBadge = document.getElementById('monitoredRoomsCountBadge');

    if (avgEl) avgEl.textContent = totalCompliance;
    if (nonCompliantEl) nonCompliantEl.textContent = nonCompliantRooms;
    if (violatingEl) violatingEl.textContent = violatingNodesTotal;
    if (noRulesEl) noRulesEl.textContent = roomsNoRules;
    if (countBadge) {
      countBadge.textContent = `${roomLabels.length} Monitored Room${roomLabels.length === 1 ? '' : 's'}`;
    }

    // Reveal the existing canvas before Chart.js measures its available width.
    finishRulesInitialLoading();
    const chartWrapper = document.getElementById('ruleComplianceChartWrapper') || ctx.parentElement;
    const emptyStateEl = document.getElementById('ruleComplianceEmptyState');

    if (roomLabels.length === 0) {
      if (chartWrapper) {
        chartWrapper.classList.add('hidden');
        chartWrapper.style.display = 'none';
      }
      if (emptyStateEl) {
        emptyStateEl.classList.remove('hidden');
        emptyStateEl.classList.add('flex');
        emptyStateEl.style.display = 'flex';
        const emptyTitle = document.getElementById('ruleComplianceEmptyTitle');
        const emptyDesc = document.getElementById('ruleComplianceEmptyDesc');
        if (emptyTitle && emptyDesc) {
          if (complianceViolationRules.length === 0) {
            emptyTitle.textContent = 'No Automation Rules Configured';
            emptyDesc.textContent = 'All AC control nodes are operating normally. Configure rules on campus rooms to monitor thresholds and track real-time violations.';
          } else {
            emptyTitle.textContent = 'No Active Violations';
            emptyDesc.textContent = 'All AC control nodes across configured rooms are operating within compliant rule parameters.';
          }
        }
      }
      if (ctx) ctx.style.display = 'none';
      if (ruleComplianceChart) { ruleComplianceChart.destroy(); ruleComplianceChart = null; }
      return;
    } else {
      if (chartWrapper) {
        chartWrapper.classList.remove('hidden');
        chartWrapper.style.display = 'block';
      }
      if (emptyStateEl) {
        emptyStateEl.classList.add('hidden');
        emptyStateEl.classList.remove('flex');
        emptyStateEl.style.display = 'none';
      }
      if (ctx) ctx.style.display = 'block';
    }

    if (chartWrapper) {
      let computedHeight = 135;
      if (roomLabels.length === 1) {
        computedHeight = 125;
      } else if (roomLabels.length === 2) {
        computedHeight = 175;
      } else {
        computedHeight = Math.min(650, Math.max(140, roomLabels.length * 52 + 50));
      }
      chartWrapper.style.height = `${computedHeight}px`;
    }

    const isDark = localStorage.getItem('ecoTrackTheme') === 'dark' || document.documentElement.classList.contains('dark');
    const maxVal = Math.max(0, ...complianceValues);

    if (typeof Chart === 'function') {
      if (ruleComplianceChart) ruleComplianceChart.destroy();
      ruleComplianceChart = new Chart(ctx.getContext('2d'), {
        type: 'bar',
        data: {
          labels: roomLabels,
          datasets: [{
            label: 'Total Violations',
            data: complianceValues,
            backgroundColor: barColors,
            borderColor: borderColors,
            borderWidth: 1.5,
            borderRadius: 8,
            borderSkipped: false,
            minBarLength: 6,
            maxBarThickness: 24
          }]
        },
        options: {
          indexAxis: 'y',
          responsive: true,
          maintainAspectRatio: false,
          layout: {
            padding: { left: 6, right: 20, top: 6, bottom: 6 }
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: isDark ? 'rgba(12, 19, 40, 0.95)' : 'rgba(255, 255, 255, 0.96)',
              titleColor: isDark ? '#38bdf8' : '#0f172a',
              bodyColor: isDark ? '#cbd5e1' : '#334155',
              borderColor: isDark ? 'rgba(56, 189, 248, 0.25)' : 'rgba(0, 0, 0, 0.1)',
              borderWidth: 1,
              cornerRadius: 8,
              padding: 12
            }
          },
          scales: {
            x: {
              beginAtZero: true,
              suggestedMax: Math.max(3, maxVal + 1),
              ticks: {
                color: isDark ? '#94a3b8' : '#64748b',
                font: { size: 11, weight: '600' },
                stepSize: 1,
                precision: 0
              },
              grid: {
                color: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.05)',
                drawBorder: false
              },
              title: {
                display: true,
                text: 'Violations Count',
                color: isDark ? '#64748b' : '#94a3b8',
                font: { size: 11, weight: '600' }
              }
            },
            y: {
              ticks: {
                color: isDark ? '#f1f5f9' : '#1e293b',
                font: { size: 12, weight: '700' }
              },
              grid: { display: false }
            }
          }
        }
      });
    }
  } catch (error) {
    console.warn('Rule compliance load error:', error);
    showRulesInitialLoadError(error);
  }
}

// ===== VIOLATION RANKINGS & HISTORY BOARD HELPERS =====
function formatDateClean(dateObj) {
  if (!dateObj || !(dateObj instanceof Date) || isNaN(dateObj.getTime())) {
    dateObj = new Date();
  }
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[dateObj.getMonth()];
  const day = String(dateObj.getDate()).padStart(2, '0');
  const year = dateObj.getFullYear();
  let hours = dateObj.getHours();
  const mins = String(dateObj.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `${month} ${day}, ${year} • ${hours}:${mins} ${ampm}`;
}

function renderViolationRankings() {
  const container = document.getElementById('violationRankingsContainer');
  if (!container) return;

  const subtitleBadge = document.getElementById('rankingsSubtitleBadge');
  if (subtitleBadge) {
    if (currentRankingTab === 'rooms') subtitleBadge.textContent = 'Ranked by Room Breaches';
    else if (currentRankingTab === 'floors') subtitleBadge.textContent = 'Ranked by Floor Breaches';
    else if (currentRankingTab === 'buildings') subtitleBadge.textContent = 'Ranked by Building Breaches';
  }

  // Update tab buttons style
  document.querySelectorAll('.ranking-tab-btn').forEach(btn => {
    if (btn.dataset.tab === currentRankingTab) {
      btn.className = 'ranking-tab-btn active px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all duration-200 cursor-pointer flex items-center gap-1.5 bg-[#10b981] text-white shadow-sm';
    } else {
      btn.className = 'ranking-tab-btn px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all duration-200 cursor-pointer flex items-center gap-1.5 text-gray-600 dark:text-gray-300 hover:text-black dark:hover:text-white';
    }
  });

  const items = currentRankingsData[currentRankingTab] || [];

  if (items.length === 0) {
    container.innerHTML = `
      <div class="flex flex-col items-center justify-center py-10 text-center">
        <div class="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-500 mb-2">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
        </div>
        <h5 class="font-bold text-gray-800 dark:text-gray-200 text-sm">No Violations Recorded</h5>
        <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">All monitored ${currentRankingTab} are currently compliant.</p>
      </div>
    `;
    return;
  }

  const maxViolations = Math.max(1, ...items.map(i => i.violations || 0));

  const totalRankingItems = items.length;
  const totalRankingPages = Math.max(1, Math.ceil(totalRankingItems / RANKING_PAGE_SIZE));
  if (currentRankingPage > totalRankingPages) currentRankingPage = totalRankingPages;
  if (currentRankingPage < 1) currentRankingPage = 1;

  const rankStart = (currentRankingPage - 1) * RANKING_PAGE_SIZE;
  const rankEnd = Math.min(rankStart + RANKING_PAGE_SIZE, totalRankingItems);
  const pageRankItems = items.slice(rankStart, rankEnd);

  let html = `
    <table class="eco-data-table w-full text-left border-collapse">
      <thead class="bg-[#0b291d] dark:bg-[#081a14] text-white dark:text-[#a7f3d0] sticky top-0 z-10 text-[11px] font-bold uppercase tracking-wider">
        <tr>
          <th scope="col" class="px-4 py-3.5 text-center w-16">RANK</th>
          <th scope="col" class="px-4 py-3.5">${currentRankingTab === 'rooms' ? 'ROOM & LOCATION' : currentRankingTab === 'floors' ? 'FLOOR & BUILDING' : 'BUILDING'}</th>
          <th scope="col" class="px-4 py-3.5 text-center">VIOLATIONS</th>
          <th scope="col" class="px-4 py-3.5">${currentRankingTab === 'rooms' ? 'ACTIVE CONTROLS' : 'COVERAGE'}</th>
          <th scope="col" class="px-4 py-3.5 min-w-[200px]">BREACH LEVEL & DENSITY</th>
          <th scope="col" class="px-4 py-3.5 text-right pr-4">STATUS</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-gray-100 dark:divide-white/5 text-gray-800 dark:text-gray-200 text-xs">
  `;

  pageRankItems.forEach((item, idx) => {
    const index = rankStart + idx;
    const rank = index + 1;
    let medalClass = 'ranking-medal ranking-medal-default';
    let medalText = `#${rank}`;
    if (rank === 1) {
      medalClass = 'ranking-medal ranking-medal-1';
      medalText = '🥇 1';
    } else if (rank === 2) {
      medalClass = 'ranking-medal ranking-medal-2';
      medalText = '🥈 2';
    } else if (rank === 3) {
      medalClass = 'ranking-medal ranking-medal-3';
      medalText = '🥉 3';
    }

    const violations = item.violations || 0;
    const pct = Math.min(100, Math.round((violations / maxViolations) * 100));

    let statusPill = '';
    let barColor = 'bg-emerald-500';
    let violationBadgeColor = 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 border-emerald-300 dark:border-emerald-500/30';

    if (violations > 2) {
      statusPill = '<span class="px-2.5 py-1 rounded-full text-[11px] font-bold bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-400 border border-rose-300 dark:border-rose-500/30">⚠️ Critical</span>';
      barColor = 'bg-rose-500';
      violationBadgeColor = 'bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-400 border-rose-300 dark:border-rose-500/30';
    } else if (violations > 0) {
      statusPill = '<span class="px-2.5 py-1 rounded-full text-[11px] font-bold bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400 border border-amber-300 dark:border-amber-500/30">⚡ Moderate</span>';
      barColor = 'bg-amber-500';
      violationBadgeColor = 'bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-500/30';
    } else {
      statusPill = '<span class="px-2.5 py-1 rounded-full text-[11px] font-bold bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-400 border border-emerald-300 dark:border-emerald-500/30">✅ Compliant</span>';
      barColor = 'bg-emerald-500';
    }

    let colTitle = '';
    let colCoverage = '';

    if (currentRankingTab === 'rooms') {
      colTitle = `
        <div>
          <span class="font-bold text-sm text-gray-900 dark:text-white block">${item.name}</span>
          <span class="text-[11px] text-gray-500 dark:text-gray-400">${item.buildingName} • ${item.floorName}</span>
        </div>
      `;
      colCoverage = `
        <div class="flex items-center gap-1.5">
          <span class="font-bold text-gray-700 dark:text-gray-300">${item.nodesCount || 1} node${(item.nodesCount || 1) === 1 ? '' : 's'}</span>
          ${item.violatingNodesCount > 0 ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-600 dark:text-rose-400 font-semibold border border-rose-500/20">${item.violatingNodesCount} drifting</span>` : ''}
        </div>
      `;
    } else if (currentRankingTab === 'floors') {
      colTitle = `
        <div>
          <span class="font-bold text-sm text-gray-900 dark:text-white block">${item.name}</span>
          <span class="text-[11px] text-gray-500 dark:text-gray-400">${item.buildingName}</span>
        </div>
      `;
      colCoverage = `
        <span class="font-bold text-gray-700 dark:text-gray-300">${item.nonCompliantRooms} of ${item.roomsCount} room${item.roomsCount === 1 ? '' : 's'} affected</span>
      `;
    } else {
      colTitle = `
        <div>
          <span class="font-bold text-sm text-gray-900 dark:text-white block">${item.name}</span>
          <span class="text-[11px] text-gray-500 dark:text-gray-400">${item.floorsCount} Monitored Floor${item.floorsCount === 1 ? '' : 's'}</span>
        </div>
      `;
      colCoverage = `
        <span class="font-bold text-gray-700 dark:text-gray-300">${item.nonCompliantRooms} of ${item.roomsCount} room${item.roomsCount === 1 ? '' : 's'} affected</span>
      `;
    }

    html += `
      <tr class="violation-row-hover hover:bg-gray-50/60 dark:hover:bg-slate-800/40 transition-colors">
        <td class="px-4 py-3 text-center">
          <span class="${medalClass}">${medalText}</span>
        </td>
        <td class="px-4 py-3">
          ${colTitle}
        </td>
        <td class="px-4 py-3 text-center">
          <span class="inline-flex items-center justify-center font-mono font-extrabold text-xs px-2.5 py-1 rounded-full border ${violationBadgeColor}">
            ${violations} Breach${violations === 1 ? '' : 'es'}
          </span>
        </td>
        <td class="px-4 py-3">
          ${colCoverage}
        </td>
        <td class="px-4 py-3">
          <div class="flex items-center gap-3">
            <div class="flex-1 bg-gray-200 dark:bg-slate-700/60 rounded-full h-2 overflow-hidden shadow-inner">
              <div class="h-2 rounded-full ${barColor} ranking-progress-bar" style="width: ${pct}%"></div>
            </div>
            <span class="font-mono font-bold text-[11px] text-gray-500 dark:text-gray-400 w-8 text-right">${pct}%</span>
          </div>
        </td>
        <td class="px-4 py-3 text-right pr-4">
          ${statusPill}
        </td>
      </tr>
    `;
  });

  html += `
      </tbody>
    </table>
  `;

  if (totalRankingPages > 1) {
    html += `
      <div class="mt-4 pt-3 border-t border-gray-100 dark:border-white/5 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs">
        <div class="font-bold text-gray-500 dark:text-gray-400">
          Showing ${rankStart + 1} to ${rankEnd} of ${totalRankingItems} (Page ${currentRankingPage} of ${totalRankingPages})
        </div>
        <div class="flex items-center gap-1.5">
          <button type="button" id="rankingPrevBtn" ${currentRankingPage <= 1 ? 'disabled' : ''} class="px-3 py-1.5 bg-white dark:bg-slate-900 border border-gray-200 dark:border-white/10 rounded-xl font-bold text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer">
            ‹ Previous
          </button>
          <button type="button" id="rankingNextBtn" ${currentRankingPage >= totalRankingPages ? 'disabled' : ''} class="px-3 py-1.5 bg-white dark:bg-slate-900 border border-gray-200 dark:border-white/10 rounded-xl font-bold text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer">
            Next ›
          </button>
        </div>
      </div>
    `;
  }

  container.innerHTML = html;

  const rkPrev = container.querySelector('#rankingPrevBtn');
  if (rkPrev) {
    rkPrev.addEventListener('click', () => {
      if (currentRankingPage > 1) {
        currentRankingPage--;
        renderViolationRankings();
      }
    });
  }
  const rkNext = container.querySelector('#rankingNextBtn');
  if (rkNext) {
    rkNext.addEventListener('click', () => {
      if (currentRankingPage < totalRankingPages) {
        currentRankingPage++;
        renderViolationRankings();
      }
    });
  }
}

function renderViolationHistoryTable() {
  const tbody = document.getElementById('violationHistoryTableBody');
  if (!tbody) return;

  const totalBadge = document.getElementById('violationHistoryTotalBadge');
  const pageInfo = document.getElementById('violationHistoryPageInfo');
  const prevBtn = document.getElementById('violationPrevPageBtn');
  const nextBtn = document.getElementById('violationNextPageBtn');
  const pagesContainer = document.getElementById('violationPaginationPages');

  const q = (violationHistorySearchQuery || '').trim().toLowerCase();
  const sevFilter = violationHistorySeverityFilter || 'all';

  const filtered = currentViolationHistory.filter(item => {
    if (sevFilter === 'critical' && item.severity !== 'Critical') return false;
    if (sevFilter === 'moderate' && item.severity !== 'Moderate') return false;

    if (q) {
      const hay = `${item.buildingName} ${item.floorName} ${item.roomName} ${item.nodeName} ${item.ruleCondition} ${item.content} ${item.timestamp}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const totalItems = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / violationHistoryPageSize));

  if (violationHistoryCurrentPage > totalPages) {
    violationHistoryCurrentPage = totalPages;
  }
  if (violationHistoryCurrentPage < 1) {
    violationHistoryCurrentPage = 1;
  }

  const startIndex = (violationHistoryCurrentPage - 1) * violationHistoryPageSize;
  const endIndex = Math.min(startIndex + violationHistoryPageSize, totalItems);
  const pageItems = filtered.slice(startIndex, endIndex);

  if (totalBadge) totalBadge.textContent = `${totalItems} Event${totalItems === 1 ? '' : 's'}`;
  if (pageInfo) {
    pageInfo.textContent = totalItems === 0
      ? 'Showing 0 to 0 of 0 violations'
      : `Showing ${startIndex + 1} to ${endIndex} of ${totalItems} violations (Page ${violationHistoryCurrentPage} of ${totalPages})`;
  }

  const clearHistBtn = document.getElementById('clearViolationHistoryBtn');
  if (clearHistBtn) {
    clearHistBtn.disabled = totalItems === 0;
    if (totalItems === 0) {
      clearHistBtn.classList.add('opacity-50', 'cursor-not-allowed');
      clearHistBtn.classList.remove('hover:bg-rose-500/20', 'cursor-pointer');
    } else {
      clearHistBtn.classList.remove('opacity-50', 'cursor-not-allowed');
      clearHistBtn.classList.add('hover:bg-rose-500/20', 'cursor-pointer');
    }
  }

  if (prevBtn) prevBtn.disabled = violationHistoryCurrentPage <= 1;
  if (nextBtn) nextBtn.disabled = violationHistoryCurrentPage >= totalPages;

  if (pagesContainer) {
    let pagesHtml = '';
    const maxButtons = 5;
    let startPage = Math.max(1, violationHistoryCurrentPage - Math.floor(maxButtons / 2));
    let endPage = Math.min(totalPages, startPage + maxButtons - 1);
    if (endPage - startPage + 1 < maxButtons) {
      startPage = Math.max(1, endPage - maxButtons + 1);
    }

    if (startPage > 1) {
      pagesHtml += `<button type="button" class="page-num-btn px-2.5 py-1 text-xs font-bold rounded-lg border border-gray-200 dark:border-white/10 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-800 cursor-pointer" data-page="1">1</button>`;
      if (startPage > 2) {
        pagesHtml += `<span class="px-1 text-gray-400">...</span>`;
      }
    }

    for (let p = startPage; p <= endPage; p++) {
      const isActive = p === violationHistoryCurrentPage;
      pagesHtml += `
        <button type="button" class="page-num-btn px-2.5 py-1 text-xs font-bold rounded-lg border transition-all cursor-pointer ${isActive ? 'bg-[#10b981] text-white border-[#10b981] shadow-xs' : 'border-gray-200 dark:border-white/10 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-800'}" data-page="${p}">${p}</button>
      `;
    }

    if (endPage < totalPages) {
      if (endPage < totalPages - 1) {
        pagesHtml += `<span class="px-1 text-gray-400">...</span>`;
      }
      pagesHtml += `<button type="button" class="page-num-btn px-2.5 py-1 text-xs font-bold rounded-lg border border-gray-200 dark:border-white/10 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-800 cursor-pointer" data-page="${totalPages}">${totalPages}</button>`;
    }

    pagesContainer.innerHTML = pagesHtml;

    pagesContainer.querySelectorAll('.page-num-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetPage = parseInt(btn.dataset.page, 10);
        if (!isNaN(targetPage) && targetPage !== violationHistoryCurrentPage) {
          violationHistoryCurrentPage = targetPage;
          renderViolationHistoryTable();
        }
      });
    });
  }

  if (pageItems.length === 0) {
    tbody.innerHTML = `
      <tr class="text-center">
        <td colspan="10" class="px-5 py-14 text-center">
          <div class="flex flex-col items-center justify-center max-w-sm mx-auto">
            <div class="w-14 h-14 rounded-2xl bg-emerald-500/10 dark:bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 flex items-center justify-center mb-3 shadow-xs">
              <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                <polyline points="9 12 11 14 15 10"/>
              </svg>
            </div>
            <h4 class="font-bold text-sm text-slate-800 dark:text-white mb-1">Zero Policy Violations</h4>
            <p class="text-xs text-slate-500 dark:text-gray-400 leading-relaxed">
              All monitored air conditioning units and sensor nodes are currently operating within configured safe parameters.
            </p>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  let rowsHtml = '';
  pageItems.forEach((item, idx) => {
    const rowNum = startIndex + idx + 1;
    const isCritical = item.severity === 'Critical';
    const sevBadge = isCritical
      ? '<span class="px-2.5 py-1 rounded-full text-[11px] font-bold bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-400 border border-rose-300 dark:border-rose-500/30">Critical</span>'
      : '<span class="px-2.5 py-1 rounded-full text-[11px] font-bold bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400 border border-amber-300 dark:border-amber-500/30">Moderate</span>';

    const recordedClass = isCritical
      ? 'text-rose-600 dark:text-rose-400 font-bold font-mono'
      : 'text-amber-600 dark:text-amber-400 font-bold font-mono';

    rowsHtml += `
      <tr class="violation-row-hover hover:bg-gray-50/60 dark:hover:bg-slate-800/40 transition-colors">
        <td class="px-4 py-3 text-center font-mono text-gray-500 dark:text-gray-400 font-semibold">${rowNum}</td>
        <td class="px-4 py-3 whitespace-nowrap">
          <span class="font-medium text-gray-800 dark:text-gray-200 block">${item.timestamp}</span>
        </td>
        <td class="px-4 py-3 font-medium text-gray-800 dark:text-gray-200">${item.buildingName}</td>
        <td class="px-4 py-3 font-medium text-gray-800 dark:text-gray-200">${item.floorName}</td>
        <td class="px-4 py-3 font-bold text-gray-900 dark:text-white">${item.roomName}</td>
        <td class="px-4 py-3">
          <span class="px-2 py-0.5 bg-gray-100 dark:bg-slate-800 rounded font-mono text-[11px] text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-white/5">${item.nodeName}</span>
        </td>
        <td class="px-4 py-3 font-semibold text-gray-700 dark:text-gray-300">${item.ruleCondition}</td>
        <td class="px-4 py-3 ${recordedClass}">${item.recordedValue}</td>
        <td class="px-4 py-3 text-center">${sevBadge}</td>
        <td class="px-4 py-3 text-right pr-4">
          <button type="button" class="view-violation-detail-btn px-3 py-1 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 rounded-lg font-bold text-xs transition-all cursor-pointer inline-flex items-center gap-1 shadow-xs" data-id="${item.id}">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
              <circle cx="12" cy="12" r="3"></circle>
            </svg>
            <span>View Details</span>
          </button>
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = rowsHtml;

  tbody.querySelectorAll('.view-violation-detail-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openViolationDetailModal(btn.dataset.id);
    });
  });
}

function openViolationDetailModal(eventId) {
  const item = currentViolationHistory.find(e => String(e.id) === String(eventId));
  if (!item) return;

  const modal = document.getElementById('violationDetailModal');
  if (!modal) return;

  const isCritical = item.severity === 'Critical';
  const severityBadge = document.getElementById('modalSeverityBadge');
  if (severityBadge) {
    severityBadge.textContent = isCritical ? 'Critical Breach' : 'Moderate Breach';
    severityBadge.className = isCritical
      ? 'text-xs font-bold px-2.5 py-0.5 rounded-full bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-400 border border-rose-300 dark:border-rose-500/30'
      : 'text-xs font-bold px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400 border border-amber-300 dark:border-amber-500/30';
  }

  const severityIcon = document.getElementById('modalSeverityIcon');
  if (severityIcon) {
    severityIcon.className = isCritical
      ? 'w-11 h-11 rounded-2xl bg-rose-500/15 text-rose-600 dark:text-rose-400 border border-rose-500/30 flex items-center justify-center shrink-0'
      : 'w-11 h-11 rounded-2xl bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30 flex items-center justify-center shrink-0';
  }

  const eventIdEl = document.getElementById('modalEventIdText');
  if (eventIdEl) eventIdEl.textContent = `Event #${item.id}`;

  const bEl = document.getElementById('modalBuildingName');
  if (bEl) bEl.textContent = item.buildingName || 'Main Campus';

  const fEl = document.getElementById('modalFloorName');
  if (fEl) fEl.textContent = item.floorName || 'First Floor';

  const rEl = document.getElementById('modalRoomName');
  if (rEl) rEl.textContent = item.roomName || 'Room';

  const sNameEl = document.getElementById('modalControlName');
  if (sNameEl) sNameEl.textContent = item.nodeName || 'AC Control Unit';

  const sIdEl = document.getElementById('modalControlId');
  if (sIdEl) sIdEl.textContent = item.rawNotif?.node_id ? `Control ID: ${item.rawNotif.node_id}` : (item.room?.id ? `Room ID: ${item.room.id}` : 'AC Node Control');

  const recValEl = document.getElementById('modalRecordedValue');
  if (recValEl) {
    recValEl.textContent = item.recordedValue || 'Exceeded';
    recValEl.className = isCritical
      ? 'text-2xl font-black text-rose-600 dark:text-rose-400 font-mono'
      : 'text-2xl font-black text-amber-600 dark:text-amber-400 font-mono';
  }

  const compEl = document.getElementById('modalThresholdComparison');
  if (compEl) compEl.textContent = `Breached ${item.ruleCondition}`;

  const condEl = document.getElementById('modalRuleCondition');
  if (condEl) condEl.textContent = `${item.ruleCondition} Threshold Violation`;

  const timeEl = document.getElementById('modalTimestamp');
  if (timeEl) timeEl.textContent = item.timestamp;

  const notifMsgEl = document.getElementById('modalNotificationMessage');
  if (notifMsgEl) notifMsgEl.textContent = item.content || 'Environmental temperature rule threshold exceeded configured bounds.';

  const viewNotifBtn = document.getElementById('modalViewInNotificationsBtn');
  if (viewNotifBtn) {
    const rawNotifId = item.rawNotif?.id || item.id;
    const roomId = item.roomId || item.room_id || (item.room ? item.room.id : '');
    const notifUrl = `Notification.html?notif=${encodeURIComponent(rawNotifId)}${roomId ? `&room=${encodeURIComponent(roomId)}` : ''}`;
    viewNotifBtn.href = notifUrl;
    viewNotifBtn.onclick = () => {
      const navPayload = {
        room: roomId,
        notif: rawNotifId,
        highlight: rawNotifId,
        message: item.content,
        timestamp: Date.now()
      };
      try { sessionStorage.setItem('pendingNav', JSON.stringify(navPayload)); } catch (_) {}
      try { localStorage.setItem('ecoTrack_pendingNotificationNav', JSON.stringify(navPayload)); } catch (_) {}
    };
  }

  const deleteRecBtn = document.getElementById('modalDeleteViolationBtn');
  if (deleteRecBtn) {
    deleteRecBtn.onclick = () => {
      deleteSingleViolationRecord(item.id);
    };
  }

  modal.style.display = 'flex';
}

function closeViolationDetailModal() {
  const modal = document.getElementById('violationDetailModal');
  if (modal) modal.style.display = 'none';
}

function parseRoomNodes(nodesField) {
  if (!nodesField) return [];
  if (Array.isArray(nodesField)) return nodesField;
  if (typeof nodesField === 'string') {
    try {
      return nodesField ? JSON.parse(nodesField) : [];
    } catch (_) {
      return [];
    }
  }
  return [];
}

function getApplicableRules(rules, roomId, nodeId, nodePbId) {
  return rules.filter(rule => {
    if (rule.room_id && rule.room_id !== roomId) return false;

    const targetsNode = (rule.nodeIds && (rule.nodeIds.includes(nodeId) || rule.nodeIds.includes(nodePbId))) ||
                        (rule.nodes && (rule.nodes.includes(nodeId) || rule.nodes.includes(nodePbId)));

    const isRoomWide = (!rule.nodeIds || rule.nodeIds.length === 0) && (!rule.nodes || rule.nodes.length === 0);

    return targetsNode || isRoomWide;
  });
}

function isRuleActiveAndEnabled(rule) {
  if (!rule) return false;
  if (rule.enabled === false || rule.enabled === 'false' || rule.enabled === 0) return false;
  if (rule.active === false || rule.active === 'false' || rule.active === 0) return false;
  if (rule.status === 'disabled' || rule.status === 'inactive') return false;
  return true;
}

function isRuleViolated(rule, telemetry) {
  if (!telemetry || !rule) return false;
  // A rule that is disabled in the rules modal must NEVER evaluate violations
  if (!isRuleActiveAndEnabled(rule)) return false;

  if (rule.type === 'battery') {
    const bat = Number(telemetry.battery);
    if (Number.isNaN(bat)) return false;
    const ruleVal = Number(rule.value);
    const batPct = bat <= 5 ? Math.max(0, Math.min(100, Math.round(((bat - 3.0) / 1.2) * 100))) : bat;
    if (rule.condition === 'below') return batPct < ruleVal;
    if (rule.condition === 'equals') return batPct === ruleVal;
    if (rule.condition === 'above') return batPct > ruleVal;
    return false;
  }

  if (rule.type === 'temperature') {
    const temp = Number(telemetry.temperature ?? telemetry.temp);
    if (Number.isNaN(temp)) return false;
    const ruleValue = normalizeTemperatureRuleValue(rule.value, rule.unit);
    if (rule.condition === 'above') return temp > ruleValue;
    if (rule.condition === 'below') return temp < ruleValue;
    return false;
  }

  return false;
}

function isBatteryNotification(notif, batteryRuleIds = new Set()) {
  if (!notif) return false;
  if (notif.rule_id && batteryRuleIds.has(String(notif.rule_id))) return true;
  const text = String(notif.content || notif.message || notif.title || '').toLowerCase();
  if (text.includes('battery')) return true;
  return false;
}

function isRoutineScheduleNotification(notif) {
  if (!notif) return false;
  if (notif.type === 'schedule' || notif.category === 'schedule' || notif.is_schedule) return true;
  if (notif.type === 'wake' || notif.type === 'sleep' || notif.type === 'system') return true;

  const text = String(notif.content || notif.message || notif.title || '').toLowerCase();
  return (
    text.includes('wake') ||
    text.includes('sleep') ||
    text.includes('schedule') ||
    text.includes('scheduled') ||
    text.includes('scheduler') ||
    text.includes('interval') ||
    text.includes('cycle') ||
    text.includes('routine')
  );
}

function normalizeTemperatureRuleValue(value, unit) {
  const numericValue = Number(value);
  if (Number.isNaN(numericValue)) return 0;
  if (unit === '°F') return (numericValue - 32) * (5 / 9);
  return numericValue;
}

