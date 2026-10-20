 // ===== TELEMETRY PAGE - NODE MANAGEMENT =====

// Initialize Database Clients
const sb = window.supabaseClient || window.sb;
const pb = window.pb || (typeof PocketBase === 'function' ? new PocketBase() : null);

let rooms = {}; // { roomId: { id, name, floor_id, nodeLimit, nodes: [] } }
let buildings = {};
let floors = {};
let nodes = [];
let availableNodes = [];
let clearType = 'buildings'; // 'buildings', 'floors', 'rooms'
let draggedNode = null;
let selectedRoomId = null;
let editingRoomId = null;
let editingBuildingId = null;
let editingFloorId = null;
let pendingDeleteLocationId = null;
let pendingDeleteLocationType = null;
let pendingDeleteLocationName = null;
let targetBuildingIdForFloor = null;
let targetFloorIdForRoom = null;

// Live node data sourced from the Python backend
const activeNodesData = [];

// ===== PYTHON BACKEND BRIDGE =====
const BACKEND_URL = 'http://localhost:5000';
let _sseSource = null;           // active EventSource
let _connectedPort = null;       // port name we are connected to

let _statusPollTimer = null;

/**
 * Fetch available serial / COM ports from Python backend and
 * render them inside the #portScanResults container.
 */
async function scanPorts() {
  const btn = document.getElementById('scanPortsBtn');
  const container = document.getElementById('portScanResults');
  if (!container) return;

  if (btn) { btn.disabled = true; btn.textContent = 'Scanning…'; }
  container.innerHTML = '<p class="text-gray-400 text-xs animate-pulse">Scanning ports…</p>';

  try {
    const res = await fetch(`${BACKEND_URL}/api/serial-ports`);
    if (!res.ok) throw new Error(await res.text());
    const ports = await res.json();

    if (!ports.length) {
      container.innerHTML = '<p class="text-gray-500 text-xs">No serial ports found.</p>';
      return;
    }

    container.innerHTML = '';
    ports.forEach(p => {
      const row = document.createElement('div');
      row.className = 'flex items-center justify-between glass-surface-soft rounded-lg px-3 py-2 gap-2';
      row.innerHTML = `
        <div class="min-w-0">
          <p class="text-cyan-400 font-bold text-sm">${p.port}</p>
          <p class="text-gray-400 text-xs truncate" title="${p.description}">${p.description || 'Unknown device'}</p>
          ${p.manufacturer ? `<p class="text-gray-500 text-xs">${p.manufacturer}</p>` : ''}
        </div>
        <button
          class="port-connect-btn shrink-0 px-3 py-1 rounded text-xs font-bold btn-glass transition-colors"
          data-port="${p.port}"
        >Connect</button>
      `;
      row.querySelector('.port-connect-btn').addEventListener('click', () => connectPort(p.port));
      container.appendChild(row);
    });

    // After rendering, check if a port is already connected and update UI
    if (_connectedPort) {
      _updatePortConnectButtons(true, _connectedPort);
    }
  } catch (err) {
    container.innerHTML = `<p class="text-red-400 text-xs">Error: ${err.message}. Is the Python backend running?</p>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Scan Ports'; }
  }
}

/**
 * Tell Python to open the given port, then subscribe to the SSE stream.
 */
async function connectPort(port, baud = 9600) {
  if (_connectedPort) {
    await disconnectPort();
  }

  showNotification(`Connecting to ${port}…`);
  try {
    const res = await fetch(`${BACKEND_URL}/api/serial-connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port, baud })
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.message);

    _connectedPort = port;
    _updateConnectionUI(true, port);
    showNotification(`✓ Connected to ${port}`);
    _startSSE();

    // Show loading state for available nodes
    const availableList = document.getElementById('availableNodesList');
    if (availableList) {
      availableList.innerHTML = `
        <div class="text-center py-4">
          <p class="text-gray-400 text-sm animate-pulse">Searching for AC control nodes...</p>
        </div>
      `;
    }
  } catch (err) {
    showNotification(`✗ ${err.message}`);
  }
}

/**
 * Tell Python to close the active serial port and stop the SSE stream.
 */
async function disconnectPort() {
  _stopSSE();
  try {
    await fetch(`${BACKEND_URL}/api/serial-disconnect`, { method: 'POST' });
  } catch (_) {/* ignore */}
  const prev = _connectedPort;
  _connectedPort = null;
  _updateConnectionUI(false);
  if (prev) showNotification(`Disconnected from ${prev}`);
}

/**
 * Open an SSE connection and route every incoming packet to the
 * live node data array, updating or creating node cards in real time.
 */
function _startSSE() {
  _stopSSE();
  _sseSource = new EventSource(`${BACKEND_URL}/api/stream`);

  _sseSource.onmessage = (e) => {
    try {
      const packet = JSON.parse(e.data);
      _ingestPacket(packet);
    } catch (_) {/* malformed */}
  };

  _sseSource.onerror = () => {
    // Auto-reconnect is handled by the browser; sync status from backend
    _refreshSerialStatus();
  };
}

async function _refreshSerialStatus() {
  try {
    const res = await fetch(`${BACKEND_URL}/api/serial-status`);
    if (!res.ok) throw new Error('status failed');
    const status = await res.json();
    if (status.connected) {
      _connectedPort = status.port || _connectedPort;
      _updateConnectionUI(true, _connectedPort || '');
      if (!_sseSource) _startSSE();
    } else {
      _connectedPort = null;
      _updateConnectionUI(false);
    }
  } catch (_) {
    _updateConnectionUI(false);
  }
}

function _stopSSE() {
  if (_sseSource) {
    _sseSource.close();
    _sseSource = null;
  }
}

/**
 * Process one telemetry packet from the serial device.
 * Fields expected: id, name?, temp, pressure, rssi, battery, status
 */
function telemetryNumber(value) {
  return value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
}

function telemetryDisplay(value, decimals = 1) {
  const number = telemetryNumber(value);
  return number === null ? 'Unavailable' : number.toFixed(decimals);
}

function _ingestPacket(packet) {
  if (!packet || !packet.id) return;

  const nodeId = packet.id;
  const nodeName = packet.name || packet.id;

  // Locate existing node in activeNodesData or in rooms to preserve schedule interval and metadata
  let existing = activeNodesData.find(n => n.id === nodeId || n.name === nodeName || n.id === nodeName);
  if (!existing) {
    for (const r of Object.values(rooms)) {
      if (r.nodes) {
        const found = r.nodes.find(n => n.id === nodeId || n.name === nodeName || n.id === nodeName);
        if (found) { existing = found; break; }
      }
    }
  }

  // Normalise field names while strictly preserving real interval and schedule settings
  const node = {
    id:          nodeId,
    name:        nodeName,
    pb_id:       packet.pb_id || existing?.pb_id || null,
    temp:        telemetryNumber(packet.temp ?? packet.temperature),
    pressure:    telemetryNumber(packet.pressure),
    rssi:        telemetryNumber(packet.rssi),
    battery:     telemetryNumber(packet.battery ?? packet.voltage),
    status:      packet.status || existing?.status || 'online',
    wakeTime:    packet.wakeTime || existing?.wakeTime || '06:00',
    sleepTime:   packet.sleepTime || existing?.sleepTime || '22:00',
    intervalVal: parseInt(packet.intervalVal ?? existing?.intervalVal ?? 15),
    intervalUnit: packet.intervalUnit || existing?.intervalUnit || 'Minutes',
    aircon_type: packet.aircon_type || existing?.aircon_type || null,
    created:     existing?.created || new Date().toISOString()
  };

  // Upsert into activeNodesData
  const idx = activeNodesData.findIndex(n => n.id === node.id || n.name === node.name);
  if (idx >= 0) {
    activeNodesData[idx] = node;
  } else {
    activeNodesData.push(node);
    // Asynchronously resolve the pb_id and DB attributes via Supabase if missing
    if (sb && !node.pb_id) {
      sb.from('nodes').select('*').eq('name', node.name).maybeSingle()
        .then(({ data: rec }) => {
          if (rec) {
            node.pb_id = rec.id;
            node.created = rec.created;
            if (rec.aircon_type) node.aircon_type = rec.aircon_type;
            if (rec.interval_val) node.intervalVal = parseInt(rec.interval_val);
            if (rec.interval_unit) node.intervalUnit = rec.interval_unit;
          }
        })
        .catch(() => {});
    }

    // Clear "Searching..." message on first node found
    if (activeNodesData.length === 1) {
      const availableList = document.getElementById('availableNodesList');
      if (availableList) availableList.innerHTML = '';
    }
    // Add to the available-nodes sidebar automatically
    _appendAvailableNode(node);
  }

  // Also sync updated readings into room.nodes in memory
  Object.values(rooms).forEach(room => {
    if (room.nodes) {
      const rn = room.nodes.find(n => n.id === node.id || n.name === node.name);
      if (rn) {
        rn.temp = node.temp;
        rn.pressure = node.pressure;
        rn.battery = node.battery;
        rn.rssi = node.rssi;
        rn.status = node.status;
        rn.wakeTime = node.wakeTime;
        rn.sleepTime = node.sleepTime;
        rn.intervalVal = node.intervalVal;
        rn.intervalUnit = node.intervalUnit;
        rn.aircon_type = node.aircon_type;
      }
    }
  });

  // Refresh any placed cards in nodeInterface matching this node
  const placedCards = document.querySelectorAll(
    `[data-node-card][data-node-id="${node.id}"], [data-node-card][data-node-id="${node.name}"]`
  );
  placedCards.forEach(card => {
    const fresh = createNodeElement(node);
    card.innerHTML = fresh.innerHTML;
    // Add subtle visual update pulse
    card.classList.remove('telem-pulse-active');
    void card.offsetWidth;
    card.classList.add('telem-pulse-active');
  });

  // If node detail modal is open for this node, refresh preview card in place
  if (window._currentDetailNodeId && (window._currentDetailNodeId === node.id || window._currentDetailNodeId === node.name)) {
    const content = document.getElementById('nodeDetailModalContent');
    if (content) {
      const detailCard = createNodeElement(node);
      detailCard.classList.add('node-detail-card');
      content.innerHTML = '';
      content.appendChild(detailCard);
    }
  }

  // Update the live-reading badge if one exists
  _updateLiveBadge(node);

  // Save incoming control reading into PocketBase control logs (throttled)
  // Skip if the caller explicitly set _skipDBSave (handled by separate DB cadence loop)
  if (!packet._skipDBSave && typeof saveNodeTelemetryToSqlite === 'function') {
    saveNodeTelemetryToSqlite({ ...packet, name: node.name, pb_id: node.pb_id, battery: packet.battery ?? packet.voltage }).catch(() => {});
  }

  // Real-time rule evaluation across active nodes
  // STRICT RULE: Only evaluate if the control is assigned to a room in the AC Control Interface!
  // Unassigned nodes in "Available AC Controls" (the lobby) must never trigger notifications.
  if (!packet._skipDBSave && typeof window.evaluateRulesForTelemetry === 'function') {
    const isAssigned = (node && node.room_id && String(node.room_id).trim() !== '') ||
                       (packet && packet.room_id && String(packet.room_id).trim() !== '');
    if (isAssigned) {
      try {
        window.evaluateRulesForTelemetry(node);
      } catch (_) {}
    }
  }
}

/** Append a brand-new draggable node to the sidebar list */
function _appendAvailableNode(nodeData) {
  const availableList = document.getElementById('availableNodesList');
  if (!availableList) return;
  const el = createNodeElement(nodeData);
  el.classList.add('draggable-node');
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    draggedNode = el;
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', nodeData.id);
  });
  availableList.appendChild(el);
}

/** Update (or create) a small "LIVE" badge below the connection button */
function _updateLiveBadge(node) {
  const badge = document.getElementById('liveBadge');
  if (!badge) return;
  badge.textContent = `📡 ${node.id} — ${telemetryDisplay(node.temp, 0)}°C | ${telemetryDisplay(node.pressure)} kPa`;
  badge.style.display = 'block';
}

/** Toggle the connect/disconnect button and status dot */
function _updateConnectionUI(connected, port = '') {
  const dot = document.getElementById('connectionDot');
  const label = document.getElementById('connectionLabel');
  const disconnectBtn = document.getElementById('disconnectBtn');

  if (dot) {
    dot.className = `w-2 h-2 rounded-full ${connected ? 'bg-green-400 animate-pulse' : 'bg-red-500'}`;
  }
  if (label) {
    label.textContent = connected ? `Connected · ${port}` : 'Not connected';
    label.className = `text-xs font-bold ${connected ? 'text-green-400' : 'text-gray-500'}`;
  }
  if (disconnectBtn) {
    disconnectBtn.style.display = connected ? 'inline-flex' : 'none';
  }

  // Update the individual port connect buttons
  _updatePortConnectButtons(connected, port);
}

/**
 * Update the state of all individual "Connect" buttons in the port list.
 * @param {boolean} connected - Is a port currently connected?
 * @param {string} activePort - The name of the active port, if any.
 */
function _updatePortConnectButtons(connected, activePort = '') {
  document.querySelectorAll('.port-connect-btn').forEach(btn => {
    const portForBtn = btn.getAttribute('data-port');
    if (connected) {
      if (portForBtn === activePort) {
        btn.disabled = true;
        btn.textContent = 'Connected';
        btn.classList.remove('bg-cyan-500/20', 'hover:bg-cyan-500/40', 'text-cyan-400');
        btn.classList.add('bg-green-500/20', 'text-green-400', 'cursor-not-allowed');
      } else {
        btn.disabled = true;
        btn.classList.add('cursor-not-allowed', 'opacity-50');
      }
    } else {
      // We are not connected, so all buttons should be enabled
      btn.disabled = false;
      btn.textContent = 'Connect';
      btn.classList.remove('bg-green-500/20', 'text-green-400', 'cursor-not-allowed', 'opacity-50');
      btn.classList.add('bg-cyan-500/20', 'hover:bg-cyan-500/40', 'text-cyan-400');
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initializeTelemetry();
});

/**
 * Load all nodes from Supabase into activeNodesData.
 * Also fetch latest telemetry for each node to display real values.
 */
function readStartupNodes(reads) {
  if (!reads.has('nodes')) {
    const pending = Promise.resolve(sb.from('nodes').select('*')).then(result => {
      if (result.error && reads.get('nodes') === pending) reads.delete('nodes');
      return result;
    }, error => {
      if (reads.get('nodes') === pending) reads.delete('nodes');
      throw error;
    });
    reads.set('nodes', pending);
  }
  return reads.get('nodes');
}
async function loadAvailableNodesFromDB(reads = new Map()) {
  console.log('[EcoTrack] loadAvailableNodesFromDB called');
  try {
    let nodeRecords = [];
    if (!sb) return;
    await window.ecotrackAuthReady;
    if (sb.auth?.getSession) {
      const { data, error } = await sb.auth.getSession();
      if (error) throw error;
      if (!data?.session) return;
    }
    const { data, error } = await readStartupNodes(reads);
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error('Unexpected controller registry response');
    nodeRecords = data;
    console.log('[EcoTrack] Loaded', nodeRecords.length, 'nodes from Supabase');
    
    if (!nodeRecords.length) {
      activeNodesData = [];
      populateAvailableNodes();
      return;
    }

    let telemetryRecords = [];
    const telemetryMap = {};
    if (sb) {
      try {
        const { data } = await sb.from('telemetry').select('*').order('created', { ascending: false });
        if (data && data.length) telemetryRecords = data;
      } catch (_) {}
    }
    if (!telemetryRecords.length && pb && typeof pb.collection === 'function') {
      try {
        telemetryRecords = await pb.collection('telemetry').getFullList({ sort: '-created' });
      } catch (_) {}
    }

    telemetryRecords.forEach(t => {
      if (t.node_id && !telemetryMap[t.node_id]) {
        telemetryMap[t.node_id] = t;
      }
      if (t.sensor_name && !telemetryMap[t.sensor_name]) {
        telemetryMap[t.sensor_name] = t;
      }
    });

    nodeRecords.forEach(n => {
      const latestTelemetry = telemetryMap[n.name] || telemetryMap[n.id] || {};
      const existing = activeNodesData.find(a => a.id === n.name);
      if (existing) {
        existing.pb_id = n.id;
        if (n.created) existing.created = n.created;
        if (n.aircon_type) existing.aircon_type = n.aircon_type;
        existing.intervalVal = parseInt(n.interval_val) || existing.intervalVal || 15;
        existing.intervalUnit = n.interval_unit || existing.intervalUnit || 'Minutes';
        if (n.wake_time && n.wake_time !== '00:00') existing.wakeTime = n.wake_time;
        if (n.sleep_time && n.sleep_time !== '00:00') existing.sleepTime = n.sleep_time;
        if (latestTelemetry.temperature !== undefined) existing.temp = latestTelemetry.temperature;
        if (latestTelemetry.pressure !== undefined) existing.pressure = latestTelemetry.pressure;
        if (latestTelemetry.battery !== undefined) existing.battery = latestTelemetry.battery;
        if (latestTelemetry.rssi !== undefined) existing.rssi = latestTelemetry.rssi;
        if (latestTelemetry.status) existing.status = latestTelemetry.status;
        return;
      }

      activeNodesData.push({
        id: n.name,
        name: n.name,
        pb_id: n.id,
        temp: telemetryNumber(latestTelemetry.temperature ?? n.temp),
        pressure: telemetryNumber(latestTelemetry.pressure ?? n.pressure),
        rssi: telemetryNumber(latestTelemetry.rssi ?? n.rssi),
        battery: telemetryNumber(latestTelemetry.battery ?? n.battery),
        status: latestTelemetry.status ?? n.status ?? 'online',
        wakeTime: n.wake_time && n.wake_time !== '00:00' ? n.wake_time : '06:00',
        sleepTime: n.sleep_time && n.sleep_time !== '00:00' ? n.sleep_time : '22:00',
        intervalVal: parseInt(n.interval_val) || 15,
        intervalUnit: n.interval_unit || 'Minutes',
        created: n.created,
        aircon_type: n.aircon_type || null
      });
    });
    console.log('[EcoTrack] activeNodesData now has', activeNodesData.length, 'items');
  } catch (err) {
    console.warn('[EcoTrack] Could not load nodes from Supabase:', err);
  }
}

/**
 * Populate the Available AC Controls sidebar with nodes that are not assigned to any room.
 */
function populateAvailableNodes() {
  const availableList = document.getElementById('availableNodesList');
  if (!availableList) return;

  // Find all assigned node IDs across all rooms
  const assignedNodeIds = new Set();
  Object.values(rooms).forEach(r => {
    if (r.nodes) {
      r.nodes.forEach(n => {
        if (n.id) assignedNodeIds.add(n.id);
        if (n.name) assignedNodeIds.add(n.name);
      });
    }
  });

  // Filter nodes that are not assigned to any room
  const unassigned = activeNodesData.filter(n => !assignedNodeIds.has(n.id) && !assignedNodeIds.has(n.name));

  if (unassigned.length === 0) {
    availableList.innerHTML = `
      <div class="text-center py-8">
        <p class="text-gray-500 dark:text-gray-400 text-sm font-medium">No available controls</p>
        <p class="text-gray-400 dark:text-gray-500 text-xs mt-1">All registered controls are currently assigned</p>
      </div>
    `;
    return;
  }

  availableList.innerHTML = '';
  unassigned.forEach(node => {
    _appendAvailableNode(node);
  });
}

function _appendAvailableNode(node) {
  const availableList = document.getElementById('availableNodesList');
  if (!availableList) return;

  // Check if already in list
  const existing = availableList.querySelector(`[data-node-id="${node.id}"], [data-node-id="${node.name}"]`);
  if (existing) {
    const fresh = createNodeElement(node);
    existing.innerHTML = fresh.innerHTML;
    return;
  }

  // Remove empty message if present
  const empty = availableList.querySelector('.text-center');
  if (empty) empty.remove();

  const card = createNodeElement(node);
  card.classList.add('cursor-grab', 'draggable-node');
  card.setAttribute('data-node-id', node.id);
  card.draggable = true;

  card.addEventListener('dragstart', (e) => {
    draggedNode = node;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', node.id);
    card.classList.add('opacity-50');
  });

  card.addEventListener('dragend', () => {
    card.classList.remove('opacity-50');
  });

  card.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0) return;
    openNodeDetailModal(node);
  });

  availableList.appendChild(card);
}

// ===== SUPABASE REALTIME SUBSCRIPTION =====
function setupSupabaseRealtime() {
  if (!sb || typeof sb.channel !== 'function') return;

  try {
    // 1. Subscribe to Real-time Telemetry updates
    sb.channel('realtime-telemetry-channel')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'telemetry' }, payload => {
        console.log('[Supabase Realtime] Telemetry update:', payload);
        const t = payload.new;
        if (t) {
          const packet = {
            id: t.node_id || t.sensor_name,
            name: t.sensor_name || t.node_id,
            pb_id: t.node_id,
            temp: telemetryNumber(t.temperature),
            pressure: telemetryNumber(t.pressure),
            battery: telemetryNumber(t.battery),
            rssi: telemetryNumber(t.rssi),
            status: t.status || 'online',
            aircon_type: t.aircon_type,
            _skipDBSave: true
          };
          _ingestPacket(packet);
        }
      })
      .subscribe();

    // 2. Subscribe to Real-time Node config updates
    sb.channel('realtime-nodes-channel')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'nodes' }, payload => {
        console.log('[Supabase Realtime] Node update:', payload);
        const n = payload.new;
        if (n) {
          const packet = {
            id: n.name || n.id,
            name: n.name,
            pb_id: n.id,
            temp: telemetryNumber(n.temp),
            pressure: telemetryNumber(n.pressure),
            battery: telemetryNumber(n.battery),
            rssi: telemetryNumber(n.rssi),
            status: n.status || 'online',
            wakeTime: n.wake_time && n.wake_time !== '00:00' ? n.wake_time : '06:00',
            sleepTime: n.sleep_time && n.sleep_time !== '00:00' ? n.sleep_time : '22:00',
            intervalVal: parseInt(n.interval_val) || 15,
            intervalUnit: n.interval_unit || 'Minutes',
            aircon_type: n.aircon_type || null,
            _skipDBSave: true
          };
          _ingestPacket(packet);
        }
      })
      .subscribe();
  } catch (err) {
    console.warn('[Supabase Realtime] Channel subscription error:', err);
  }
}

function initializeTelemetry() {
  // Mount skeleton placeholder while fetching from database
  const roomsList = document.getElementById('roomsList');
  if (roomsList && roomsList.children.length === 0) {
    window.EcoTrackSkeletons?.renderRoomListSkeleton('roomsList', { count: 4 });
  }

  // Initialize available nodes from Supabase DB
  const startupReads = new Map();
  loadAvailableNodesFromDB(startupReads).then(() => {
    loadRoomsFromDB(startupReads).then(() => {
      populateAvailableNodes();
    });
  });

  // Activate Supabase Realtime instead of serial backend
  setupSupabaseRealtime();
  
  // Setup event listeners
  document.getElementById('confirmRoomBtn').addEventListener('click', confirmAddRoom);
  document.getElementById('cancelRoomBtn').addEventListener('click', closeAddRoomModal);
  const roomNameInputEl = document.getElementById('roomNameInput');
  if (roomNameInputEl) {
    roomNameInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        confirmAddRoom();
      }
    });
  }
  
  // Building Modal Events
  const addBuildingBtn = document.getElementById('addBuildingBtn');
  if (addBuildingBtn) {
    addBuildingBtn.addEventListener('click', () => {
      editingBuildingId = null;
      document.getElementById('buildingNameInput').value = '';
      document.getElementById('addBuildingModal').querySelector('h3').innerHTML = '<svg viewBox=\"0 0 24 24\" width=\"20\" height=\"20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" class=\"text-[#10b981]\"><path d=\"M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z\" /><polyline points=\"9 22 9 12 15 12 15 22\" /></svg>Add New Building';
      document.getElementById('addBuildingModal').style.display = 'flex';
    });
  }
  document.getElementById('cancelBuildingBtn').addEventListener('click', () => {
    document.getElementById('addBuildingModal').style.display = 'none';
  });
  document.getElementById('confirmBuildingBtn').addEventListener('click', async () => {
    const name = document.getElementById('buildingNameInput').value.trim();
    if (!name) return showNotification('Please enter a building name');
    try {
      if (sb) {
        if (editingBuildingId) {
          await sb.from('buildings').update({ name, updated: new Date().toISOString() }).eq('id', editingBuildingId);
          showNotification('Building updated');
        } else {
          await sb.from('buildings').insert([{ name }]);
          showNotification('Building added');
        }
      }
      document.getElementById('addBuildingModal').style.display = 'none';
      loadRoomsFromDB();
    } catch(e) { console.error(e); showNotification('Failed to save building'); }
  });

  // Floor Modal Events
  document.getElementById('cancelFloorBtn').addEventListener('click', () => {
    document.getElementById('addFloorModal').style.display = 'none';
  });
  document.getElementById('confirmFloorBtn').addEventListener('click', async () => {
    const name = document.getElementById('floorNameInput').value.trim();
    if (!name) return showNotification('Please enter a floor name');
    try {
      if (sb) {
        if (editingFloorId) {
          await sb.from('floors').update({ name, updated: new Date().toISOString() }).eq('id', editingFloorId);
          showNotification('Floor updated');
        } else {
          if (!targetBuildingIdForFloor) return;
          await sb.from('floors').insert([{ name, building_id: targetBuildingIdForFloor }]);
          showNotification('Floor added');
        }
      }
      document.getElementById('addFloorModal').style.display = 'none';
      loadRoomsFromDB();
    } catch(e) { console.error(e); showNotification('Failed to save floor'); }
  });

  const closeNodeDetailModalBtn = document.getElementById('closeNodeDetailModalBtn');
  if (closeNodeDetailModalBtn) closeNodeDetailModalBtn.addEventListener('click', closeNodeDetailModal);

  // Serial port controls (available on manual trigger only, no auto-connection)
  const scanBtn = document.getElementById('scanPortsBtn');
  if (scanBtn) scanBtn.addEventListener('click', scanPorts);

  const disconnectBtn = document.getElementById('disconnectBtn');
  if (disconnectBtn) disconnectBtn.addEventListener('click', disconnectPort);

  document.getElementById('clearNodesBtn').addEventListener('click', openClearNodesModal);
  const clearCabinetBtn = document.getElementById('clearRoomCabinetBtn');
  if (clearCabinetBtn) {
    const showContextMenu = (e) => {
      e.preventDefault();
      e.stopPropagation();

      const existingMenu = document.querySelector('.context-menu');
      if (existingMenu) existingMenu.remove();

      const contextMenu = document.createElement('div');
      contextMenu.className = 'context-menu absolute bg-white border-[2px] border-[#10b981] rounded-lg shadow-xl z-50 overflow-hidden';
      contextMenu.style.left = e.pageX + 'px';
      contextMenu.style.top = e.pageY + 'px';
      contextMenu.innerHTML = `
        <button class="clear-all-buildings-btn w-full px-4 py-2 text-left text-red-500 hover:bg-red-50 transition-colors text-sm font-semibold border-b border-gray-100">
          Clear all buildings
        </button>
        <button class="clear-all-floors-btn w-full px-4 py-2 text-left text-red-500 hover:bg-red-50 transition-colors text-sm font-semibold border-b border-gray-100">
          Clear all floors
        </button>
        <button class="clear-all-rooms-btn w-full px-4 py-2 text-left text-red-500 hover:bg-red-50 transition-colors text-sm font-semibold">
          Clear all rooms
        </button>
      `;

      document.body.appendChild(contextMenu);

      contextMenu.querySelector('.clear-all-buildings-btn').addEventListener('click', () => {
        contextMenu.remove();
        openClearRoomsModal('buildings');
      });
      contextMenu.querySelector('.clear-all-floors-btn').addEventListener('click', () => {
        contextMenu.remove();
        openClearRoomsModal('floors');
      });
      contextMenu.querySelector('.clear-all-rooms-btn').addEventListener('click', () => {
        contextMenu.remove();
        openClearRoomsModal('rooms');
      });

      setTimeout(() => {
        document.addEventListener('click', function closeMenu() {
          contextMenu.remove();
          document.removeEventListener('click', closeMenu);
        });
      }, 0);
    };

    clearCabinetBtn.addEventListener('click', showContextMenu);
    clearCabinetBtn.addEventListener('contextmenu', showContextMenu);
  }
  document.getElementById('confirmClearBtn').addEventListener('click', confirmClearNodes);
  document.getElementById('cancelClearBtn').addEventListener('click', closeClearNodesModal);
  const clearRoomsModal = document.getElementById('clearRoomsModal');
  if (clearRoomsModal) {
    clearRoomsModal.addEventListener('click', (e) => {
      if (e.target.id === 'clearRoomsModal') {
        closeClearRoomsModal();
      }
    });
  }
  const confirmClearRoomsBtn = document.getElementById('confirmClearRoomsBtn');
  if (confirmClearRoomsBtn) confirmClearRoomsBtn.addEventListener('click', confirmClearRooms);
  const cancelClearRoomsBtn = document.getElementById('cancelClearRoomsBtn');
  if (cancelClearRoomsBtn) cancelClearRoomsBtn.addEventListener('click', closeClearRoomsModal);
  const closeClearRoomsBtn = document.getElementById('closeClearRoomsBtn');
  if (closeClearRoomsBtn) closeClearRoomsBtn.addEventListener('click', closeClearRoomsModal);
  const deleteLocationModal = document.getElementById('deleteLocationModal');
  if (deleteLocationModal) {
    deleteLocationModal.addEventListener('click', (e) => {
      if (e.target.id === 'deleteLocationModal') {
        closedeleteLocationModal();
      }
    });
  }
  const confirmDeleteLocationBtn = document.getElementById('confirmDeleteLocationBtn');
  if (confirmDeleteLocationBtn) confirmDeleteLocationBtn.addEventListener('click', confirmDeleteLocation);
  const cancelDeleteLocationBtn = document.getElementById('cancelDeleteLocationBtn');
  if (cancelDeleteLocationBtn) cancelDeleteLocationBtn.addEventListener('click', closedeleteLocationModal);
  const closeDeleteLocationBtn = document.getElementById('closeDeleteLocationBtn');
  if (closeDeleteLocationBtn) closeDeleteLocationBtn.addEventListener('click', closedeleteLocationModal);
  
  // Close modal when clicking outside (on background only)
  document.getElementById('addRoomModal').addEventListener('click', (e) => {
    if (e.target.id === 'addRoomModal') {
      closeAddRoomModal();
    }
  });
  
  // Close clear nodes modal when clicking outside
  document.getElementById('clearNodesModal').addEventListener('click', (e) => {
    if (e.target.id === 'clearNodesModal') {
      closeClearNodesModal();
    }
  });

  const nodeDetailModal = document.getElementById('nodeDetailModal');
  if (nodeDetailModal) {
    nodeDetailModal.addEventListener('click', (e) => {
      if (e.target.id === 'nodeDetailModal') {
        closeNodeDetailModal();
      }
    });
  }
  
  // Setup drag and drop for main interface - REBUILD v3
  const nodeInterface = document.getElementById('nodeInterface');
  
  // Use capture phase to catch drag events at document level
  document.addEventListener('dragenter', (e) => {
    console.log('DRAGENTER on document');
    e.preventDefault();
    e.stopPropagation();
  }, true);
  
  document.addEventListener('dragover', (e) => {
    console.log('DRAGOVER on document');
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    
    // Check if over nodeInterface
    const rect = nodeInterface.getBoundingClientRect();
    const isOver = e.clientX >= rect.left && e.clientX <= rect.right &&
                   e.clientY >= rect.top && e.clientY <= rect.bottom;
    
    if (isOver) {
      nodeInterface.style.borderColor = 'rgb(34, 197, 94)';
      nodeInterface.style.backgroundColor = 'rgba(34, 197, 94, 0.1)';
      console.log('Over nodeInterface - HIGHLIGHTING');
    } else {
      nodeInterface.style.borderColor = 'rgb(71, 85, 105)';
      nodeInterface.style.backgroundColor = 'transparent';
    }
  }, true);
  
  document.addEventListener('drop', (e) => {
    console.log('✓✓✓ DROP EVENT ON DOCUMENT ✓✓✓');
    e.preventDefault();
    e.stopPropagation();
    
    // Check if over nodeInterface
    const rect = nodeInterface.getBoundingClientRect();
    const isOver = e.clientX >= rect.left && e.clientX <= rect.right &&
                   e.clientY >= rect.top && e.clientY <= rect.bottom;
    
    console.log('Is over nodeInterface?', isOver);
    
    nodeInterface.style.borderColor = 'rgb(71, 85, 105)';
    nodeInterface.style.backgroundColor = 'transparent';
    
    if (!isOver) {
      console.log('Drop not over interface, ignoring');
      return;
    }
    
    // Get the AC Control ID from dataTransfer
    const nodeId = e.dataTransfer.getData('text/plain');
    console.log('Dropped AC Control ID:', nodeId);
    
    if (!nodeId) {
      showNotification('Error: No node data');
      return;
    }
    
    if (!selectedRoomId) {
      showNotification('Please select a room first');
      return;
    }
    
    const room = rooms[selectedRoomId];
    if (!room) {
      showNotification('Error: Room not found');
      return;
    }
    
    const maxLimit = Math.max(room.nodeLimit || 0, 50);
    if (room.nodes.length >= maxLimit) {
      showNotification(`Room limit reached (${maxLimit} AC control nodes max)`);
      return;
    }
    
    const nodeData = activeNodesData.find(n => n.id === nodeId);
    if (!nodeData) {
      showNotification('Error: Node not found');
      return;
    }
    
    // Global check: ensure node isn't already assigned to ANY room
    let assignedToRoom = null;
    for (const [rId, r] of Object.entries(rooms)) {
      if (r.nodes && r.nodes.some(n => n.id === nodeId)) {
        assignedToRoom = r.name || rId;
        break;
      }
    }
    
    if (assignedToRoom) {
      showNotification(`Node already assigned to ${assignedToRoom}`);
      return;
    }
    
    // Clear empty state
    const emptyState = nodeInterface.querySelector('.pointer-events-none');
    if (emptyState) {
      nodeInterface.innerHTML = '';
    }
    
    // Add node to room
    const newNode = { ...nodeData };
    room.nodes.push(newNode);
    updateRoomNodeCount(selectedRoomId);
    saveRoomToDB(selectedRoomId);
    
    // Create and add the fully-styled card
    const nodeCard = createPlacedNodeCard(nodeId);
    nodeInterface.appendChild(nodeCard);
    
    // Refresh the sidebar so the node disappears from Available AC Controls
    populateAvailableNodes();
    
    showNotification(`✓ Added ${nodeData.name}`);
    console.log('SUCCESS!');
  }, true);

  // Real-time synchronization: listen for schedule/metadata updates on Supabase nodes
  if (sb && typeof sb.channel === 'function') {
    try {
      sb.channel('nodes-realtime-telemetry')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'nodes' }, payload => {
          if (payload.new) {
            const updated = payload.new;
            console.log('[EcoTrack Realtime] Node updated from Supabase:', updated.name, updated.interval_val, updated.interval_unit);

            // Update in activeNodesData
            const active = activeNodesData.find(a => a.name === updated.name || a.pb_id === updated.id);
            if (active) {
              active.intervalVal = parseInt(updated.interval_val) || active.intervalVal;
              active.intervalUnit = updated.interval_unit || active.intervalUnit;
              if (updated.wake_time && updated.wake_time !== '00:00') active.wakeTime = updated.wake_time;
              if (updated.sleep_time && updated.sleep_time !== '00:00') active.sleepTime = updated.sleep_time;
              if (updated.aircon_type) active.aircon_type = updated.aircon_type;
            }

            // Update in rooms
            Object.values(rooms).forEach(r => {
              if (r.nodes) {
                const rn = r.nodes.find(a => a.name === updated.name || a.pb_id === updated.id);
                if (rn) {
                  rn.intervalVal = parseInt(updated.interval_val) || rn.intervalVal;
                  rn.intervalUnit = updated.interval_unit || rn.intervalUnit;
                  if (updated.wake_time && updated.wake_time !== '00:00') rn.wakeTime = updated.wake_time;
                  if (updated.sleep_time && updated.sleep_time !== '00:00') rn.sleepTime = updated.sleep_time;
                  if (updated.aircon_type) rn.aircon_type = updated.aircon_type;
                }
              }
            });

            // Re-render placed cards in interface
            if (selectedRoomId) {
              loadRoomNodes(selectedRoomId);
            }
          }
        })
        .subscribe();
    } catch (e) {
      console.warn('Realtime channel error:', e);
    }
  }
}

// ===== NOTIFICATION SYSTEM =====
function showNotification(message, duration = 3000) {
  const notification = document.createElement('div');
  notification.className = 'toast';
  notification.textContent = message;
  document.body.appendChild(notification);
  
  setTimeout(() => {
    notification.style.animation = 'slideOut 0.3s ease-in-out';
    setTimeout(() => notification.remove(), 300);
  }, duration);
}

// ===== CLEAR NODES MODAL =====
function openClearNodesModal() {
  if (!selectedRoomId) {
    showNotification('Please select a room first.');
    return;
  }
  document.getElementById('clearNodesModal').style.display = 'flex';
}

function closeClearNodesModal() {
  document.getElementById('clearNodesModal').style.display = 'none';
}

function confirmClearNodes() {
  if (selectedRoomId && rooms[selectedRoomId]) {
    // Clear the nodes from the room
    rooms[selectedRoomId].nodes = [];
    
    // Update the UI
    updateRoomNodeCount(selectedRoomId);
    loadRoomNodes(selectedRoomId);
    
    // Repopulate the available nodes list to show All AC Controls again
    populateAvailableNodes();
    
    // Save to PocketBase
    saveRoomToDB(selectedRoomId);
  }
  closeClearNodesModal();
}

// ===== CLEAR ROOMS MODAL =====
function openClearRoomsModal(type) {
  clearType = type || 'buildings';
  const title = document.getElementById('clearModalTitle');
  const text = document.getElementById('clearModalText');
  const btn = document.getElementById('confirmClearRoomsBtn');

  if (clearType === 'buildings') {
    if (!Object.keys(buildings).length) return showNotification('No buildings to clear');
    title.textContent = 'Clear All Buildings';
    text.textContent = 'Are you sure you want to clear all buildings? This removes every building, floor, room and its AC controls.';
    btn.textContent = 'Clear Buildings';
  } else if (clearType === 'floors') {
    if (!Object.keys(floors).length) return showNotification('No floors to clear');
    title.textContent = 'Clear All Floors';
    text.textContent = 'Are you sure you want to clear all floors? This removes every floor, room and its AC controls.';
    btn.textContent = 'Clear Floors';
  } else if (clearType === 'rooms') {
    if (!Object.keys(rooms).length) return showNotification('No rooms to clear');
    title.textContent = 'Clear All Rooms';
    text.textContent = 'Are you sure you want to clear all rooms? This removes every room and its AC controls.';
    btn.textContent = 'Clear Rooms';
  }

  document.getElementById('clearRoomsModal').style.display = 'flex';
}

function closeClearRoomsModal() {
  document.getElementById('clearRoomsModal').style.display = 'none';
}

async function confirmClearRooms() {
  const roomIds = Object.keys(rooms);
  const floorIds = Object.keys(floors);
  const buildingIds = Object.keys(buildings);

  // 1. Close modal immediately for zero delay
  closeClearRoomsModal();
  
  // 2. In-memory and UI cleanup
  rooms = {};
  if (clearType === 'floors' || clearType === 'buildings') floors = {};
  if (clearType === 'buildings') buildings = {};

  renderHierarchy();
  populateAvailableNodes();

  selectedRoomId = null;
  const nodeInterface = document.getElementById('nodeInterface');
  if (nodeInterface) {
    nodeInterface.innerHTML = `
      <div class="text-center col-span-2 flex items-center justify-center py-12 pointer-events-none">
        <div>
          <p class="text-gray-500 text-sm mb-2">Drag AC control nodes here</p>
          <p class="text-gray-600 text-xs">AC control nodes will appear in 2x2 grid</p>
        </div>
      </div>
    `;
  }
  const titleEl = document.getElementById('nodeInterfaceTitle');
  if (titleEl) titleEl.textContent = 'Node Interface';

  showNotification('Cleared successfully');

  // 3. Asynchronous database cleanup
  if (sb) {
    try {
      const validRoomIds = roomIds.filter(id => !id.startsWith('room-'));
      if (validRoomIds.length) {
        await Promise.all([
          sb.from('nodes').update({ room_id: null }).in('room_id', validRoomIds),
          sb.from('rooms').delete().in('id', validRoomIds)
        ]);
      }

      if (clearType === 'floors' || clearType === 'buildings') {
        const validFloorIds = floorIds.filter(id => !id.startsWith('floor-'));
        if (validFloorIds.length) {
          await sb.from('floors').delete().in('id', validFloorIds);
        }
      }
      
      if (clearType === 'buildings') {
        const validBuildingIds = buildingIds.filter(id => !id.startsWith('building-'));
        if (validBuildingIds.length) {
          await sb.from('buildings').delete().in('id', validBuildingIds);
        }
      }
    } catch (e) {
      console.error('Clear failed in database:', e);
    }
  }
}

// ===== ROOM MANAGEMENT =====
function openAddRoomModal(floorId) {
  targetFloorIdForRoom = floorId;
  const modal = document.getElementById('addRoomModal');
  modal.style.display = 'flex';
  modal.style.pointerEvents = 'auto';
  editingRoomId = null;
  _setRoomModalText('Add New Room', 'Confirm');
  
  // Clear room name input
  const roomNameInput = document.getElementById('roomNameInput');
  if (roomNameInput) {
    roomNameInput.value = '';
    roomNameInput.style.pointerEvents = 'auto';
  }
  
  // Set hidden limit if present
  const nodeLimitInput = document.getElementById('nodeLimitInput');
  if (nodeLimitInput) nodeLimitInput.value = '10';

  // Set AC Control Count Output display to 0 for new room
  const controlCountVal = document.getElementById('roomControlCountValue') || document.getElementById('roomSensorCountValue');
  const controlCountLabel = document.getElementById('roomControlCountLabel') || document.getElementById('roomSensorCountLabel');
  if (controlCountVal) controlCountVal.textContent = '0';
  if (controlCountLabel) controlCountLabel.textContent = 'controls assigned';
  
  // Immediate focus
  if (roomNameInput) {
    roomNameInput.focus();
    roomNameInput.select();
  }
}

function closeAddRoomModal() {
  const modal = document.getElementById('addRoomModal');
  modal.style.display = 'none';
  editingRoomId = null;
  _setRoomModalText('Add New Room', 'Confirm');
}

function confirmAddRoom() {
  const roomNameInput = document.getElementById('roomNameInput');
  const roomName = roomNameInput ? roomNameInput.value.trim() : '';
  
  if (!roomName) {
    showNotification('Please enter a room name');
    if (roomNameInput) roomNameInput.focus();
    return;
  }

  if (editingRoomId) {
    const room = rooms[editingRoomId];
    if (!room) {
      showNotification('Room not found');
      return;
    }
    updateRoomInDB(editingRoomId, roomName);
    return;
  }

  // Create the room with default capacity
  createRoomInDB(roomName, 10);
}

function _setRoomModalText(titleText, buttonText) {
  const title = document.getElementById('roomModalTitle');
  const confirmBtn = document.getElementById('confirmRoomBtn');
  if (title) title.textContent = titleText;
  if (confirmBtn) confirmBtn.textContent = buttonText;
}

function openEditRoomModal(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  const modal = document.getElementById('addRoomModal');
  modal.style.display = 'flex';
  modal.style.pointerEvents = 'auto';
  editingRoomId = roomId;
  _setRoomModalText('Edit Room', 'Save');

  const roomNameInput = document.getElementById('roomNameInput');
  if (roomNameInput) {
    roomNameInput.value = room.name;
    roomNameInput.style.pointerEvents = 'auto';
  }

  const nodeLimitInput = document.getElementById('nodeLimitInput');
  if (nodeLimitInput) nodeLimitInput.value = room.nodeLimit || 10;

  // Set AC Control Count Output display to current assigned controls
  const controlCountVal = document.getElementById('roomControlCountValue') || document.getElementById('roomSensorCountValue');
  const controlCountLabel = document.getElementById('roomControlCountLabel') || document.getElementById('roomSensorCountLabel');
  const count = (room.nodes && Array.isArray(room.nodes)) ? room.nodes.length : 0;
  if (controlCountVal) controlCountVal.textContent = count;
  if (controlCountLabel) controlCountLabel.textContent = count === 1 ? 'control assigned' : 'controls assigned';

  if (roomNameInput) {
    roomNameInput.focus();
    roomNameInput.select();
  }
}

// ===== SUPABASE INTEGRATION =====
async function loadRoomsFromDB(reads = new Map()) {
  try {
    let buildingRecords = [];
    let floorRecords = [];
    let roomRecords = [];
    let nodeRecords = [];

    if (sb) {
      const [bRes, fRes, rRes, nRes] = await Promise.all([
        sb.from('buildings').select('*'),
        sb.from('floors').select('*'),
        sb.from('rooms').select('*').order('created', { ascending: false }),
        readStartupNodes(reads)
      ]);
      buildingRecords = bRes.data || [];
      floorRecords = fRes.data || [];
      roomRecords = rRes.data || [];
      nodeRecords = nRes.data || [];
    }
    
    // Fetch latest telemetry for room nodes (recent 200 items instead of downloading entire database)
    let telemetryMap = {};
    let roomTelemetryRecords = [];
    if (sb) {
      try {
        const { data } = await sb.from('telemetry').select('*').order('created', { ascending: false }).limit(200);
        if (data && data.length) roomTelemetryRecords = data;
      } catch (_) {}
    }
    if (!roomTelemetryRecords.length && pb && typeof pb.collection === 'function') {
      try {
        const result = await pb.collection('telemetry').getList(1, 200, { sort: '-created' });
        roomTelemetryRecords = result.items || [];
      } catch (_) {}
    }

    roomTelemetryRecords.forEach(t => {
      if (t.node_id && !telemetryMap[t.node_id]) telemetryMap[t.node_id] = t;
      if (t.sensor_name && !telemetryMap[t.sensor_name]) telemetryMap[t.sensor_name] = t;
    });
    
    buildings = {};
    floors = {};
    rooms = {};
    
    buildingRecords.forEach(b => buildings[b.id] = { id: b.id, name: b.name });
    floorRecords.forEach(f => floors[f.id] = { id: f.id, name: f.name, building_id: f.building_id });
    
    const roomsList = document.getElementById('roomsList');
    if (roomsList) roomsList.innerHTML = '';
    
    let firstRoomId = null;
    roomRecords.forEach(record => {
      // Find all nodes for this room
      const roomNodes = nodeRecords
        .filter(n => n.room_id === record.id)
        .map(n => {
          const latestTelemetry = telemetryMap[n.name] || telemetryMap[n.id] || {};
          return {
            id: n.name, // The UI expects the hardware ID (e.g. node-1) which is stored in n.name
            pb_id: n.id, // Keep pb_id for updates
            name: n.name,
            status: latestTelemetry.status || n.status || 'online',
            temp: telemetryNumber(latestTelemetry.temperature ?? n.temp),
            pressure: telemetryNumber(latestTelemetry.pressure ?? n.pressure),
            rssi: telemetryNumber(latestTelemetry.rssi ?? n.rssi),
            battery: telemetryNumber(latestTelemetry.battery ?? n.battery),
            wakeTime: n.wake_time && n.wake_time !== '00:00' ? n.wake_time : '06:00',
            sleepTime: n.sleep_time && n.sleep_time !== '00:00' ? n.sleep_time : '22:00',
            intervalVal: parseInt(n.interval_val) || 15,
            intervalUnit: n.interval_unit || 'Minutes',
            created: n.created,
            aircon_type: n.aircon_type || null
          };
        });

      rooms[record.id] = {
        id: record.id,
        name: record.name,
        floor_id: record.floor_id,
        nodeLimit: record.node_limit || 5,
        nodes: roomNodes
      };
      
      if (!firstRoomId) firstRoomId = record.id;
    });

    renderHierarchy();
    populateAvailableNodes();

    if (firstRoomId) {
      selectRoomById(firstRoomId);
    }
  } catch (error) {
    console.warn('Supabase load error (rooms):', error);
  }
}

function renderHierarchy() {
  const roomsList = document.getElementById('roomsList');
  if (!roomsList) return;
  roomsList.innerHTML = '';
  
  if (Object.keys(buildings).length === 0) {
    roomsList.innerHTML = '<div class="text-center p-4 text-gray-500 text-sm">No buildings. Click the + House icon to create one.</div>';
    return;
  }
  
  // Group floors by building
  const buildingFloors = {};
  Object.values(buildings).forEach(b => buildingFloors[b.id] = []);
  Object.values(floors).forEach(f => {
    if (buildingFloors[f.building_id]) {
      buildingFloors[f.building_id].push(f);
    }
  });
  
  // Group rooms by floor
  const floorRooms = {};
  Object.values(floors).forEach(f => floorRooms[f.id] = []);
  Object.values(rooms).forEach(r => {
    if (r.floor_id && floorRooms[r.floor_id]) {
      floorRooms[r.floor_id].push(r);
    } else {
      // Or if no floor, maybe just an orphaned room? We can ignore or handle.
    }
  });
  
  // Render Buildings
  Object.values(buildings).forEach(building => {
    const bDiv = document.createElement('div');
    bDiv.className = 'mb-2';
    
    // Building Header
    const bHeader = document.createElement('div');
    bHeader.className = 'flex items-center justify-between bg-emerald-500/10 dark:bg-emerald-950/40 px-3 py-2 rounded-t border-b border-emerald-500/30 cursor-pointer hover:bg-emerald-500/20 transition-colors';
    bHeader.innerHTML = `
      <div class="flex items-center gap-2 min-w-0 flex-1 mr-2">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" class="text-[#10b981] shrink-0">
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <polyline points="9 22 9 12 15 12 15 22" />
        </svg>
        <span class="font-bold text-[#18392B] dark:text-cyan-300 text-xs sm:text-sm truncate" title="${building.name}">${building.name}</span>
      </div>
      <button class="add-floor-btn p-1.5 bg-emerald-500/20 hover:bg-emerald-500/40 rounded-lg text-[#10b981] shrink-0 transition-colors border-0 cursor-pointer" title="Add Floor">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
    `;
    bHeader.querySelector('.add-floor-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      targetBuildingIdForFloor = building.id;
      document.getElementById('floorNameInput').value = '';
      document.getElementById('addFloorModal').style.display = 'flex';
    });
    
    const floorsContainer = document.createElement('div');
    floorsContainer.className = 'bg-white dark:bg-[#0c1328]/40 border-x border-b border-gray-200 dark:border-white/5 rounded-b p-2 flex flex-col gap-2';
    
    // Toggle building
    bHeader.addEventListener('click', () => {
      floorsContainer.style.display = floorsContainer.style.display === 'none' ? 'flex' : 'none';
    });
    
    // Building Context Menu
    bHeader.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const existingMenu = document.querySelector('.context-menu');
      if (existingMenu) existingMenu.remove();
      
      const contextMenu = document.createElement('div');
      contextMenu.className = 'context-menu absolute bg-white dark:bg-[#0c1328] border-2 border-emerald-500/50 rounded-xl shadow-2xl z-[9999] overflow-hidden min-w-[160px] animate-dropdown';
      contextMenu.style.left = e.pageX + 'px';
      contextMenu.style.top = e.pageY + 'px';
      contextMenu.innerHTML = `
        <button class="edit-building-btn w-full px-4 py-2.5 text-left text-gray-800 dark:text-gray-100 hover:bg-emerald-50 dark:hover:bg-slate-800 transition-colors text-xs font-bold border-b border-gray-100 dark:border-white/10 flex items-center gap-2 cursor-pointer bg-transparent">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" class="text-emerald-500"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
          Edit Building
        </button>
        <button class="delete-building-btn w-full px-4 py-2.5 text-left text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors text-xs font-bold flex items-center gap-2 cursor-pointer bg-transparent">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
          Delete Building
        </button>
      `;
      document.body.appendChild(contextMenu);
      
      contextMenu.querySelector('.edit-building-btn').addEventListener('click', () => {
        contextMenu.remove();
        editingBuildingId = building.id;
        document.getElementById('buildingNameInput').value = building.name;
        document.getElementById('addBuildingModal').querySelector('h3').innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" class="text-[#10b981]"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>Edit Building';
        document.getElementById('addBuildingModal').style.display = 'flex';
      });
      contextMenu.querySelector('.delete-building-btn').addEventListener('click', () => {
        contextMenu.remove();
        requestDeleteLocation(building.id, 'building', building.name);
      });
      
      setTimeout(() => {
        document.addEventListener('click', function closeMenu() {
          contextMenu.remove();
          document.removeEventListener('click', closeMenu);
        });
      }, 0);
    });
    
    // Render Floors
    const myFloors = buildingFloors[building.id] || [];
    if (myFloors.length === 0) {
      floorsContainer.innerHTML = '<div class="text-xs text-gray-400 p-2 text-center">No floors</div>';
    }
    
    myFloors.forEach(floor => {
      const fDiv = document.createElement('div');
      fDiv.className = 'border border-gray-100 dark:border-white/5 rounded bg-gray-50 dark:bg-slate-900/60';
      
      const fHeader = document.createElement('div');
      fHeader.className = 'flex items-center justify-between px-2.5 py-1.5 border-b border-gray-100 dark:border-white/5 cursor-pointer hover:bg-gray-100/80 dark:hover:bg-slate-800/80 transition-colors rounded-t';
      fHeader.innerHTML = `
        <div class="flex items-center gap-1.5 min-w-0 flex-1 mr-2">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" class="text-gray-400 shrink-0">
             <rect x="4" y="4" width="16" height="16" rx="2" ry="2" />
             <line x1="4" y1="12" x2="20" y2="12" />
          </svg>
          <span class="text-xs font-semibold text-gray-700 dark:text-gray-200 truncate" title="${floor.name}">${floor.name}</span>
        </div>
        <button class="add-room-btn p-1 bg-cyan-500/10 hover:bg-cyan-500/20 rounded-md text-cyan-600 dark:text-cyan-400 shrink-0 transition-colors border-0 cursor-pointer" title="Add Room">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      `;
      fHeader.querySelector('.add-room-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        openAddRoomModal(floor.id);
      });
      
      const roomsContainer = document.createElement('div');
      roomsContainer.className = 'p-1 flex flex-col gap-1';
      
      // Toggle floor
      fHeader.addEventListener('click', () => {
        roomsContainer.style.display = roomsContainer.style.display === 'none' ? 'flex' : 'none';
      });
      
      // Floor Context Menu
      fHeader.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const existingMenu = document.querySelector('.context-menu');
        if (existingMenu) existingMenu.remove();
        
        const contextMenu = document.createElement('div');
        contextMenu.className = 'context-menu absolute bg-white dark:bg-[#0c1328] border-2 border-cyan-500/50 rounded-xl shadow-2xl z-[9999] overflow-hidden min-w-[160px] animate-dropdown';
        contextMenu.style.left = e.pageX + 'px';
        contextMenu.style.top = e.pageY + 'px';
        contextMenu.innerHTML = `
          <button class="edit-floor-btn w-full px-4 py-2.5 text-left text-gray-800 dark:text-gray-100 hover:bg-cyan-50 dark:hover:bg-slate-800 transition-colors text-xs font-bold border-b border-gray-100 dark:border-white/10 flex items-center gap-2 cursor-pointer bg-transparent">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" class="text-cyan-500"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
            Edit Floor
          </button>
          <button class="delete-floor-btn w-full px-4 py-2.5 text-left text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors text-xs font-bold flex items-center gap-2 cursor-pointer bg-transparent">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            Delete Floor
          </button>
        `;
        document.body.appendChild(contextMenu);
        
        contextMenu.querySelector('.edit-floor-btn').addEventListener('click', () => {
          contextMenu.remove();
          editingFloorId = floor.id;
          document.getElementById('floorNameInput').value = floor.name;
          document.getElementById('addFloorModal').querySelector('h3').innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" class="text-[#10b981]"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>Edit Floor';
          document.getElementById('addFloorModal').style.display = 'flex';
        });
        contextMenu.querySelector('.delete-floor-btn').addEventListener('click', () => {
          contextMenu.remove();
          requestDeleteLocation(floor.id, 'floor', floor.name);
        });
        
        setTimeout(() => {
          document.addEventListener('click', function closeMenu() {
            contextMenu.remove();
            document.removeEventListener('click', closeMenu);
          });
        }, 0);
      });
      
      const myRooms = floorRooms[floor.id] || [];
      if (myRooms.length === 0) {
         roomsContainer.innerHTML = '<div class="text-[10px] text-gray-400 p-1 text-center">No rooms</div>';
      }
      
      myRooms.forEach(room => {
         const rElement = _createRoomDOMElement(room.id, room.name, room.nodeLimit, room.nodes.length);
         roomsContainer.appendChild(rElement);
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

async function createRoomInDB(name, limit = 10) {
  try {
    if (sb) {
      await sb.from('rooms').insert([{
        name: name,
        node_limit: limit,
        floor_id: targetFloorIdForRoom
      }]);
    }
    
    loadRoomsFromDB();
    closeAddRoomModal();
    
    showNotification('Room created');
  } catch (error) {
    console.error('Failed to create room in Supabase:', error);
    showNotification('Failed to create room');
    closeAddRoomModal();
  }
}

async function saveRoomToDB(roomId) {
  const room = rooms[roomId];
  if (!room || roomId.startsWith('room-') || !sb) return;
  
  try {
    // 1. Get current nodes in Supabase for this room
    const { data: currentNodes } = await sb.from('nodes').select('*').eq('room_id', roomId);
    const nodesInRoom = currentNodes || [];
    
    const dbNodeNames = nodesInRoom.map(n => n.name);
    const memNodeNames = room.nodes.map(n => n.name || n.id);
    
    // 2. Remove room_id from nodes that are no longer in this room
    for (const n of nodesInRoom) {
      if (!memNodeNames.includes(n.name)) {
        await sb.from('nodes').update({ room_id: null, updated: new Date().toISOString() }).eq('id', n.id);
      }
    }
    
    // 3. Add room_id to nodes that are new to this room
    for (const memNode of room.nodes) {
      const nodeName = memNode.name || memNode.id;
      if (!dbNodeNames.includes(nodeName)) {
        try {
          const { data: existing } = await sb.from('nodes').select('*').eq('name', nodeName).maybeSingle();
          if (existing) {
            await sb.from('nodes').update({ room_id: roomId, updated: new Date().toISOString() }).eq('id', existing.id);
            memNode.pb_id = existing.id;
            memNode.created = existing.created;
            const active = activeNodesData.find(a => a.id === nodeName);
            if (active) {
              active.pb_id = existing.id;
              active.created = existing.created;
            }
            
            // Automatically update any rules attached to this node to belong to the new room
            try {
              const { data: ruleNodes } = await sb.from('rule_nodes').select('rule_id').eq('node_id', existing.id);
              if (ruleNodes && ruleNodes.length) {
                const ruleIds = ruleNodes.map(rn => rn.rule_id);
                await sb.from('rules').update({ room_id: roomId, updated: new Date().toISOString() }).in('id', ruleIds);
              }
            } catch(e) {}
          } else {
            const { data: rec } = await sb.from('nodes').insert([{
              name: nodeName,
              status: memNode.status || 'offline',
              room_id: roomId,
              interval_val: 15,
              interval_unit: 'Minutes'
            }]).select().single();
            if (rec) {
              memNode.pb_id = rec.id;
              memNode.created = rec.created;
              const active = activeNodesData.find(a => a.id === nodeName);
              if (active) {
                active.pb_id = rec.id;
                active.created = rec.created;
              }
            }
          }
        } catch (e) {
          console.warn('Node sync error:', e);
        }
      }
    }

  } catch (error) {
    console.error('Failed to sync room nodes in Supabase:', error);
  }
}

async function updateRoomInDB(roomId, name, limit) {
  const room = rooms[roomId];
  if (!room) return;

  room.name = name;
  if (limit !== undefined) {
    room.nodeLimit = limit;
  }

  const roomElement = document.querySelector(`[data-room="${roomId}"]`);
  if (roomElement) {
    const nameElement = roomElement.querySelector('.room-name');
    if (nameElement) nameElement.textContent = name;
  }
  updateRoomNodeCount(roomId);

  if (selectedRoomId === roomId) {
    const plugSvg = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="text-cyan-400 shrink-0"><path d="M12 17v5M9 8h6M18 11V9a4 4 0 0 0-4-4h-4a4 4 0 0 0-4 4v2a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2zM9 2v3M15 2v3"/></svg>`;
    document.getElementById('nodeInterfaceTitle').innerHTML = `${plugSvg}${name}`;
  }

  try {
    if (!roomId.startsWith('room-') && sb) {
      const updateData = {
        name,
        updated: new Date().toISOString()
      };
      if (limit !== undefined) {
        updateData.node_limit = limit;
      }
      await sb.from('rooms').update(updateData).eq('id', roomId);
    }
    showNotification('Room updated');
  } catch (error) {
    console.error('Failed to update room in Supabase:', error);
  }

  editingRoomId = null;
  closeAddRoomModal();
}

function requestDeleteLocation(id, type = 'room', name = '') {
  if (!id) return;
  pendingDeleteLocationId = id;
  pendingDeleteLocationType = type;

  let displayName = name;
  if (!displayName) {
    if (type === 'building' && buildings[id]) displayName = buildings[id].name;
    else if (type === 'floor' && floors[id]) displayName = floors[id].name;
    else if (type === 'room' && rooms[id]) displayName = rooms[id].name;
    else displayName = id;
  }

  const roomNameEl = document.getElementById('deleteLocationName');
  if (roomNameEl) roomNameEl.textContent = `"${displayName}"`;

  const deleteMsg = document.getElementById('deleteLocationMessage');
  if (deleteMsg) {
    if (type === 'building') {
      deleteMsg.innerHTML = `Are you sure you want to delete <span id="deleteLocationName" class="text-rose-500 font-bold">"${displayName}"</span>? This will permanently remove the building, its floors, rooms, and unassign any control hardware.`;
    } else if (type === 'floor') {
      deleteMsg.innerHTML = `Are you sure you want to delete <span id="deleteLocationName" class="text-rose-500 font-bold">"${displayName}"</span>? This will permanently remove the floor, its rooms, and unassign any control hardware.`;
    } else {
      deleteMsg.innerHTML = `Are you sure you want to delete <span id="deleteLocationName" class="text-rose-500 font-bold">"${displayName}"</span>? This removes the room and unassigns its control hardware.`;
    }
  }

  opendeleteLocationModal();
}

function opendeleteLocationModal() {
  const modal = document.getElementById('deleteLocationModal');
  if (modal) modal.style.display = 'flex';
}

function closedeleteLocationModal() {
  const modal = document.getElementById('deleteLocationModal');
  if (modal) modal.style.display = 'none';
  pendingDeleteLocationId = null;
  pendingDeleteLocationType = null;
}

async function confirmDeleteLocation() {
  if (!pendingDeleteLocationId) {
    closedeleteLocationModal();
    return;
  }
  const id = pendingDeleteLocationId;
  const type = pendingDeleteLocationType || 'room';

  // 1. Instantly close modal for zero UI delay
  closedeleteLocationModal();

  // 2. Snapshot state for rollback if needed
  const prevRooms = JSON.parse(JSON.stringify(rooms));
  const prevFloors = JSON.parse(JSON.stringify(floors));
  const prevBuildings = JSON.parse(JSON.stringify(buildings));

  // 3. Immediate In-Memory Cleanup (Optimistic)
  if (type === 'building') {
    delete buildings[id];
    Object.keys(floors).forEach(fId => {
      if (floors[fId].building_id === id) {
        Object.keys(rooms).forEach(rId => {
          if (rooms[rId].floor_id === fId) delete rooms[rId];
        });
        delete floors[fId];
      }
    });
  } else if (type === 'floor') {
    delete floors[id];
    Object.keys(rooms).forEach(rId => {
      if (rooms[rId].floor_id === id) delete rooms[rId];
    });
  } else if (type === 'room') {
    delete rooms[id];
  }

  // 4. Immediate Interface Reset if deleted room was active
  if (selectedRoomId === id || !rooms[selectedRoomId]) {
    selectedRoomId = null;
    const nodeInterface = document.getElementById('nodeInterface');
    if (nodeInterface) {
      nodeInterface.innerHTML = `
        <div class="text-center col-span-2 flex items-center justify-center py-12 pointer-events-none">
          <div>
            <p class="text-gray-500 text-sm mb-2">Select a room to view AC Controls</p>
          </div>
        </div>
      `;
    }
    const nodeInterfaceTitle = document.getElementById('nodeInterfaceTitle');
    if (nodeInterfaceTitle) {
      nodeInterfaceTitle.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" class="text-cyan-400"><rect x="4" y="2" width="16" height="20" rx="2" ry="2" /><path d="M12 2V6" stroke-width="2" /><line x1="2" y1="12" x2="22" y2="12" stroke-width="1" /></svg>AC Control Interface';
    }
    const clearNodesBtn = document.getElementById('clearNodesBtn');
    if (clearNodesBtn) clearNodesBtn.style.display = 'none';
  }

  // 5. Render instantly on screen
  renderHierarchy();
  populateAvailableNodes();
  showNotification(`${type.charAt(0).toUpperCase() + type.slice(1)} deleted successfully`);

  // 6. Asynchronous Batched Cloud Sync in Background
  try {
    if (sb) {
      if (type === 'room') {
        await Promise.all([
          sb.from('nodes').update({ room_id: null }).eq('room_id', id),
          sb.from('rooms').delete().eq('id', id)
        ]);
      } else if (type === 'floor') {
        const { data: fRooms } = await sb.from('rooms').select('id').eq('floor_id', id);
        const rIds = (fRooms || []).map(r => r.id);
        if (rIds.length > 0) {
          await Promise.all([
            sb.from('nodes').update({ room_id: null }).in('room_id', rIds),
            sb.from('rooms').delete().in('id', rIds)
          ]);
        }
        await sb.from('floors').delete().eq('id', id);
      } else if (type === 'building') {
        const { data: bFloors } = await sb.from('floors').select('id').eq('building_id', id);
        const fIds = (bFloors || []).map(f => f.id);
        if (fIds.length > 0) {
          const { data: fRooms } = await sb.from('rooms').select('id').in('floor_id', fIds);
          const rIds = (fRooms || []).map(r => r.id);
          if (rIds.length > 0) {
            await Promise.all([
              sb.from('nodes').update({ room_id: null }).in('room_id', rIds),
              sb.from('rooms').delete().in('id', rIds)
            ]);
          }
          await sb.from('floors').delete().in('id', fIds);
        }
        await sb.from('rooms').delete().eq('building_id', id);
        await sb.from('buildings').delete().eq('id', id);
      }
    }
  } catch (error) {
    console.error(`Failed to delete ${type} in Supabase:`, error);
    showNotification(`Failed to persist ${type} deletion. Restoring...`, 4000);
    rooms = prevRooms;
    floors = prevFloors;
    buildings = prevBuildings;
    renderHierarchy();
    populateAvailableNodes();
  }
}

function _createRoomDOMElement(roomId, roomName, nodeLimit, currentNodes) {
  const roomItem = document.createElement('div');
  roomItem.className = 'room-item bg-white dark:bg-slate-900/60 border border-gray-200 dark:border-white/10 p-2.5 rounded-xl cursor-pointer hover:bg-emerald-50/50 dark:hover:bg-slate-800/80 transition-all';
  roomItem.setAttribute('data-room', roomId);
  roomItem.setAttribute('role', 'button');
  roomItem.setAttribute('tabindex', '0');
  roomItem.setAttribute('aria-selected', 'false');
  roomItem.innerHTML = `
    <div class="flex items-center justify-between gap-2">
      <div class="min-w-0 flex-1">
        <p class="room-name text-xs font-bold text-gray-800 dark:text-gray-100 truncate" title="${roomName}">${roomName}</p>
        <p class="text-[10px] text-gray-500 dark:text-gray-400 font-medium node-count">${currentNodes} ac control nodes</p>
      </div>
    </div>
  `;
  roomItem.addEventListener('click', selectRoom);
  roomItem.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      selectRoomById(roomId);
    }
  });
  roomItem.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();

    const existingMenu = document.querySelector('.context-menu');
    if (existingMenu) existingMenu.remove();

    const contextMenu = document.createElement('div');
    contextMenu.className = 'context-menu absolute bg-white dark:bg-[#0c1328] border-2 border-emerald-500/50 rounded-xl shadow-2xl z-[9999] overflow-hidden min-w-[160px] animate-dropdown';
    contextMenu.style.left = e.pageX + 'px';
    contextMenu.style.top = e.pageY + 'px';
    contextMenu.innerHTML = `
      <button class="edit-room-btn w-full px-4 py-2.5 text-left text-gray-800 dark:text-gray-100 hover:bg-emerald-50 dark:hover:bg-slate-800 transition-colors text-xs font-bold border-b border-gray-100 dark:border-white/10 flex items-center gap-2 cursor-pointer bg-transparent">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" class="text-emerald-500"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
        Edit Room
      </button>
      <button class="delete-room-btn w-full px-4 py-2.5 text-left text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors text-xs font-bold flex items-center gap-2 cursor-pointer bg-transparent">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
        Delete Room
      </button>
    `;

    document.body.appendChild(contextMenu);

    contextMenu.querySelector('.edit-room-btn').addEventListener('click', () => {
      contextMenu.remove();
      openEditRoomModal(roomId);
    });

    contextMenu.querySelector('.delete-room-btn').addEventListener('click', () => {
      contextMenu.remove();
      requestDeleteLocation(roomId, 'room', (rooms[roomId] ? rooms[roomId].name : ''));
    });

    setTimeout(() => {
      document.addEventListener('click', function closeMenu() {
        contextMenu.remove();
        document.removeEventListener('click', closeMenu);
      });
    }, 0);
  });
  return roomItem;
}

function selectRoom(e) {
  const roomId = e?.currentTarget?.getAttribute('data-room');
  if (roomId) selectRoomById(roomId);
}

function selectRoomById(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  // Remove previous selection
  document.querySelectorAll('.room-item').forEach(item => {
    item.classList.remove('border-[2px]', 'border-[#10b981]', 'shadow-md', 'bg-emerald-50', 'dark:border-[#10b981]', 'dark:bg-emerald-950/20');
    item.setAttribute('aria-selected', 'false');
    item.classList.add('border-gray-200', 'dark:border-white/10');
  });

  // Add selection to clicked room
  const roomElement = document.querySelector(`[data-room="${roomId}"]`);
  if (roomElement) {
    roomElement.classList.remove('border-gray-200', 'dark:border-white/10');
    roomElement.classList.add('border-[2px]', 'border-[#10b981]', 'shadow-md', 'bg-emerald-50', 'dark:border-[#10b981]', 'dark:bg-emerald-950/20');
    roomElement.setAttribute('aria-selected', 'true');
  }

  // Update selected room
  selectedRoomId = roomId;

  // Update Node Interface title with selected room name
  const plugSvg = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="text-cyan-400 shrink-0"><path d="M12 17v5M9 8h6M18 11V9a4 4 0 0 0-4-4h-4a4 4 0 0 0-4 4v2a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2zM9 2v3M15 2v3"/></svg>`;
  document.getElementById('nodeInterfaceTitle').innerHTML = `${plugSvg}${room.name}`;

  // Load nodes for this room in the interface
  loadRoomNodes(selectedRoomId);
}

function loadRoomNodes(roomId) {
  const nodeInterface = document.getElementById('nodeInterface');
  nodeInterface.innerHTML = '';
  
  const room = rooms[roomId];
  if (!room || room.nodes.length === 0) {
    // FIX #2: Changed h-full to py-12 to maintain a large, hittable drop target area
    nodeInterface.innerHTML = `
      <div class="text-center col-span-2 flex items-center justify-center py-12 pointer-events-none">
        <div>
          <p class="text-gray-500 text-sm mb-2">Drag AC control nodes here</p>
          <p class="text-gray-600 text-xs">AC control nodes will appear in 2x2 grid</p>
        </div>
      </div>
    `;
    return;
  }
  
  room.nodes.forEach(nodeData => {
    const activeNode = activeNodesData.find(m => m.id === nodeData.id);
    if (activeNode) {
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = createNodeElement(activeNode).innerHTML;
      const nodeCard = createPlacedNodeCard(tempDiv, nodeData.id);
      nodeInterface.appendChild(nodeCard);
    } else {
      // If node is offline or not yet received from serial stream, 
      // we can still render it using the saved nodeData from the room
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = createNodeElement(nodeData).innerHTML;
      const nodeCard = createPlacedNodeCard(tempDiv, nodeData.id);
      nodeCard.classList.add('opacity-50'); // visually indicate it's offline/stale
      nodeInterface.appendChild(nodeCard);
    }
  });
}

function updateRoomNodeCount(roomId) {
  const room = rooms[roomId];
  const roomElement = document.querySelector(`[data-room="${roomId}"]`);
  if (roomElement) {
    const nodeCount = room.nodes.length;
    const countElement = roomElement.querySelector('.node-count');
    const progressFill = roomElement.querySelector('.room-progress-fill');
    const capacityElement = roomElement.querySelector('.room-capacity');
    if (countElement) {
      countElement.textContent = `${nodeCount} ac control nodes`;
    }
    if (progressFill && room.nodeLimit > 0) {
      const occupancy = Math.min((nodeCount / room.nodeLimit) * 100, 100);
      progressFill.style.width = `${occupancy}%`;
    }
    if (capacityElement && room.nodeLimit > 0) {
      const occupancy = Math.min((nodeCount / room.nodeLimit) * 100, 100);
      capacityElement.textContent = `${occupancy.toFixed(0)}%`;
    }
  }
}

// ===== NODE LIST MANAGEMENT =====
function populateAvailableNodes() {
  console.log('[EcoTrack] populateAvailableNodes called, activeNodesData.length =', activeNodesData.length);
  const availableList = document.getElementById('availableNodesList');
  if (!availableList) { console.error('[EcoTrack] availableNodesList element NOT found!'); return; }
  availableList.innerHTML = '';
  
  if (activeNodesData.length === 0) {
    availableList.innerHTML = '<p class="text-gray-500 text-sm text-center py-4">No controls found</p>';
    return;
  }

  // Helper to find if node is assigned to any room
  const getNodeAssignedRoom = (nodeId) => {
    for (const [roomId, room] of Object.entries(rooms)) {
      if (room.nodes && room.nodes.some(n => n.id === nodeId)) {
        return room.name;
      }
    }
    return null;
  };

  activeNodesData.forEach(nodeData => {
    try {
      const assignedRoom = getNodeAssignedRoom(nodeData.id);
      
      // If assigned to a room, skip rendering it in the "Available AC Controls" list entirely
      if (assignedRoom) {
        return; 
      }
      
      const nodeElement = createNodeElement(nodeData);
      nodeElement.classList.add('draggable-node');
      nodeElement.draggable = true;
      // Inline dragstart handler for available nodes
      nodeElement.addEventListener('dragstart', (e) => {
        draggedNode = nodeElement;
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('text/plain', nodeData.id);
        console.log('Started dragging:', nodeData.id);
      });
      
      availableList.appendChild(nodeElement);
    } catch (err) {
      console.error('[EcoTrack] Failed to render node:', nodeData.id, err);
      const errorEl = document.createElement('div');
      errorEl.className = 'text-red-400 text-xs p-2 border border-red-500/30 rounded mb-2';
      errorEl.textContent = `Error rendering ${nodeData.id}: ${err.message}`;
      availableList.appendChild(errorEl);
    }
  });
}

function getSignalBars(rssi) {
  // Convert RSSI to signal bars (1-4)
  // -30 to -60: 4 bars (Excellent)
  // -60 to -70: 3 bars (Good)
  // -70 to -80: 2 bars (Fair)
  // -80 and below: 1 bar (Poor)
  if (rssi > -60) return 4;
  if (rssi > -70) return 3;
  if (rssi > -80) return 2;
  return 1;
}

function getBatteryBars(voltage) {
  // Convert battery voltage to bars (1-4)
  if (voltage >= 4.0) return 4;
  if (voltage >= 3.6) return 3;
  if (voltage >= 3.2) return 2;
  return 1;
}

function createNodeElement(data) {
  const div = document.createElement('div');
  // Ensure all numeric fields are actually numbers (PocketBase may return strings)
  data.temp = telemetryNumber(data.temp);
  data.pressure = telemetryNumber(data.pressure);
  data.rssi = telemetryNumber(data.rssi);
  data.battery = telemetryNumber(data.battery);

  const signalBars = data.rssi === null ? null : getSignalBars(data.rssi);
  const batteryPercent = data.battery === null ? null : Math.round((data.battery / 4.2) * 100);
  const isOnline = data.status === 'online';
  const formatTime12h = (timeStr, defaultTime = '06:00 AM') => {
    if (!timeStr || timeStr === '00:00') return defaultTime;
    const parts = timeStr.split(':');
    if (parts.length < 2) return timeStr;
    let h = parseInt(parts[0], 10);
    let m = parts[1].split(' ')[0];
    if (timeStr.toLowerCase().includes('am') || timeStr.toLowerCase().includes('pm')) return timeStr;
    const suffix = h >= 12 ? 'PM' : 'AM';
    const hours12 = ((h + 11) % 12) + 1;
    return `${hours12}:${m} ${suffix}`;
  };

  const wakeTime = formatTime12h(data.wakeTime, '06:00 AM');
  const sleepTime = formatTime12h(data.sleepTime, '10:00 PM');
  const intervalVal = parseInt(data.intervalVal) || 15;
  const intervalUnit = data.intervalUnit || 'Minutes';
  let displayUnit = intervalUnit;
  if (displayUnit.toLowerCase().startsWith('minute') || displayUnit.toLowerCase() === 'min' || displayUnit.toLowerCase() === 'mins') {
    displayUnit = 'min';
  } else if (displayUnit.toLowerCase().startsWith('second') || displayUnit.toLowerCase() === 'sec') {
    displayUnit = 'sec';
  } else if (displayUnit.toLowerCase().startsWith('hour') || displayUnit.toLowerCase() === 'hr') {
    displayUnit = 'hr';
  }

  // Signal strength text
  let signalText = signalBars === null ? 'Unavailable' : 'WEAK';
  let signalColor = '#fb7185';
  if (signalBars >= 4) { signalText = 'STRONG'; signalColor = '#34d399'; }
  else if (signalBars >= 3) { signalText = 'GOOD'; signalColor = '#34d399'; }
  else if (signalBars >= 2) { signalText = 'FAIR'; signalColor = '#fbbf24'; }

  // SVGs for different states
  const snowflakeSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="2" x2="12" y2="22"/><path d="M20 12H4"/><path d="m6 8 6 4-6 4"/><path d="m18 8-6 4 6 4"/><path d="m8 4 4 4 4-4"/><path d="m8 20 4-4 4 4"/></svg>`;
  const fanSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.827 16.379a6.082 6.082 0 0 1-8.618-7.002l5.412 1.45a6.082 6.082 0 0 1 7.002-8.618l-1.45 5.412a6.082 6.082 0 0 1 8.618 7.002l-5.412-1.45a6.082 6.082 0 0 1-7.002 8.618l1.45-5.412Z"/><path d="M12 12v.01"/></svg>`;
  const powerSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>`;

  // Resolve the exact controller binding and shared commanded/reported state.
  const aircons = window.EcoTrackAirconSystem?.AirconProfileManager.getAll() || [];
  const matches = aircons.filter(ac => ac.node_id === data.id || ac.node_id === data.name);
  const description = window.EcoTrackAirconState.describeAirconState(matches.length === 1 ? matches[0].control_snapshot : null);
  let acState = description.summary;
  let activeIconSvg = description.label.includes('FAN') ? fanSvg : description.power === false ? powerSvg : snowflakeSvg;
  if (!isOnline) acState = 'OFFLINE · ' + acState;
  // Signal bars HTML
  const signalBarsHtml = [1, 2, 3, 4, 5].map((bar) => {
    const filled = signalBars !== null && bar <= signalBars + 1;
    const height = 4 + (bar) * 3;
    return `<div class="bar ${filled ? 'filled' : 'empty'}" style="height: ${height}px;"></div>`;
  }).join('');

  // Battery bar color
  let batteryBarColor = 'linear-gradient(90deg, #34d399, #22d3ee)';
  if (batteryPercent < 20) batteryBarColor = 'linear-gradient(90deg, #fb7185, #f97316)';
  else if (batteryPercent < 50) batteryBarColor = 'linear-gradient(90deg, #fbbf24, #f97316)';



  div.className = 'telemetry-node-card relative w-full';
  div.innerHTML = `
    <div class="node-id" style="display:none;">${data.id}</div>

    <!-- SVG gradient definitions for wave charts -->
    <svg width="0" height="0" style="position:absolute;">
      <defs>
        <linearGradient id="waveCyan-${data.id}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="rgba(87, 227, 255, 0.3)"/>
          <stop offset="100%" stop-color="rgba(87, 227, 255, 0)"/>
        </linearGradient>
        <linearGradient id="waveGreen-${data.id}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="rgba(52, 211, 153, 0.3)"/>
          <stop offset="100%" stop-color="rgba(52, 211, 153, 0)"/>
        </linearGradient>
      </defs>
    </svg>

    <!-- HEADER -->
    <div class="telem-header">
      <div class="telem-header-left">
        <div class="telem-label">Control Node</div>
        <div class="telem-device-name" title="${data.name}">${data.name}</div>
        <div class="telem-status-badge ${isOnline ? 'online' : 'offline'}">
          <div class="telem-status-dot ${isOnline ? 'online' : 'offline'}"></div>
          ${isOnline ? 'ONLINE' : 'OFFLINE'}
        </div>
      </div>
      <div class="telem-aircon-badge">
        <div class="telem-aircon-icon">${activeIconSvg}</div>
        <div class="telem-aircon-info">
          <div class="telem-aircon-label">AIRCON STATE</div>
          <div class="telem-aircon-state">${acState}</div>
        </div>
      </div>
    </div>

    <!-- METRIC TILES -->
    <div class="telem-metrics-grid">
      <!-- Temperature -->
      <div class="telem-metric-tile temp">
        <div class="telem-metric-content">
          <div class="telem-metric-icon temp-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
              <path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/>
            </svg>
          </div>
          <div class="telem-metric-data">
            <div class="telem-metric-label">TEMPERATURE</div>
            <div class="telem-metric-value">${telemetryDisplay(data.temp, 0)}<span class="unit">°C</span></div>
          </div>
        </div>
        <div class="telem-wave-chart cyan">
          <svg viewBox="0 0 200 40" preserveAspectRatio="none">
            <path d="M0,35 C20,30 40,20 60,22 C80,24 100,18 120,15 C140,12 160,20 180,18 C190,17 200,14 200,14 L200,40 L0,40 Z" fill="url(#waveCyan-${data.id})" stroke="rgba(87,227,255,0.5)" stroke-width="1"/>
            <circle cx="180" cy="18" r="3" class="telem-wave-dot"/>
          </svg>
        </div>
      </div>

      <!-- Pressure -->
      <div class="telem-metric-tile pressure">
        <div class="telem-metric-content">
          <div class="telem-metric-icon pressure-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="m12 14 4-4"/>
              <path d="M3.34 19a10 10 0 1 1 17.32 0"/>
            </svg>
          </div>
          <div class="telem-metric-data">
            <div class="telem-metric-label">PRESSURE</div>
            <div class="telem-metric-value">${telemetryDisplay(data.pressure)}<span class="unit">kPa</span></div>
          </div>
        </div>
        <div class="telem-wave-chart green">
          <svg viewBox="0 0 200 40" preserveAspectRatio="none">
            <path d="M0,30 C30,28 50,22 80,25 C110,28 130,15 150,18 C170,21 185,16 200,14 L200,40 L0,40 Z" fill="url(#waveGreen-${data.id})" stroke="rgba(52,211,153,0.5)" stroke-width="1"/>
            <circle cx="200" cy="14" r="3" class="telem-wave-dot green"/>
          </svg>
        </div>
      </div>
    </div>

    <!-- STATS ROW -->
    <div class="telem-stats-grid">
      <!-- Signal Strength -->
      <div class="telem-stat-tile">
        <div class="telem-stat-label">SIGNAL STRENGTH</div>
        <div class="telem-signal-row">
          <div class="telem-signal-bars">${signalBarsHtml}</div>
          <div class="telem-signal-text">
            <span class="telem-signal-strength" style="color: ${signalColor}">${signalText}</span>
            <span class="telem-signal-dbm">${data.rssi === null ? 'Unavailable' : data.rssi + ' dBm'}</span>
          </div>
        </div>
      </div>

      <!-- Battery Level -->
      <div class="telem-stat-tile">
        <div class="telem-stat-label">BATTERY LEVEL</div>
        <div class="telem-battery-row">
          <div class="telem-battery-icon">
            <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
              <rect x="4" y="6" width="16" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/>
              <rect x="20" y="10" width="2" height="4" rx="0.5" fill="currentColor"/>
              <path d="M11 9l-2 3h3l-2 3" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <div class="telem-battery-info">
            <div class="telem-battery-percent">${batteryPercent === null ? 'Unavailable' : batteryPercent + '%'}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- SCHEDULE -->
    <div class="telem-schedule-panel mt-4">
      <div class="telem-schedule-panel-head">
        <div class="telem-stat-label">SCHEDULE</div>
        <div class="telem-schedule-panel-chip">Power-cycle timing</div>
      </div>

      <div class="telem-schedule-grid">
        <div class="telem-schedule-tile wake" title="Wake: ${wakeTime} - Active sensing starts">
          <div class="telem-schedule-tile-top">
            <div class="telem-schedule-icon wake">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="8" />
                <path d="M12 8v4l3 2" />
              </svg>
            </div>
            <div class="telem-schedule-label">Wake</div>
          </div>
          <div class="telem-schedule-value">${wakeTime}</div>
          <div class="telem-schedule-meta">Active Sensing</div>
        </div>

        <div class="telem-schedule-tile sleep" title="Sleep: ${sleepTime} - Low-power mode starts">
          <div class="telem-schedule-tile-top">
            <div class="telem-schedule-icon sleep">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 12.6A8.5 8.5 0 1 1 11.4 3a7 7 0 0 0 9.6 9.6Z" />
              </svg>
            </div>
            <div class="telem-schedule-label">Sleep</div>
          </div>
          <div class="telem-schedule-value">${sleepTime}</div>
          <div class="telem-schedule-meta">Low Power</div>
        </div>

        <div class="telem-schedule-tile interval" title="Interval: ${intervalVal} ${intervalUnit} - Packet cadence">
          <div class="telem-schedule-tile-top">
            <div class="telem-schedule-icon interval">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 12h6" />
                <path d="M14 12h6" />
                <path d="M9 7l3 5-3 5" />
              </svg>
            </div>
            <div class="telem-schedule-label">Interval</div>
          </div>
          <div class="telem-schedule-value">${intervalVal} <span class="telem-schedule-unit">${displayUnit}</span></div>
          <div class="telem-schedule-meta">Cadence</div>
        </div>
      </div>
    </div>

    <!-- FOOTER -->
    <div class="telem-footer">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
        <circle cx="12" cy="12" r="10"/>
        <polyline points="12 6 12 12 16 14"/>
      </svg>
      <span class="telem-footer-text">UPDATED: ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
    </div>
  `;
  return div;
}

async function saveNodeRegistrationDateTime(nodeData, dateVal, timeVal) {
  try {
    const newDateTime = new Date(`${dateVal}T${timeVal}:00`).toISOString();
    let pbId = nodeData.pb_id;
    if (sb) {
      if (!pbId) {
        const { data: rec } = await sb.from('nodes').select('*').eq('name', nodeData.id).maybeSingle();
        if (rec) {
          pbId = rec.id;
          nodeData.pb_id = pbId;
          nodeData.created = rec.created;
        } else {
          const { data: newRec } = await sb.from('nodes').insert([{
            name: nodeData.id,
            status: nodeData.status || 'offline',
            interval_val: nodeData.intervalVal || 15,
            interval_unit: nodeData.intervalUnit || 'Minutes'
          }]).select().single();
          if (newRec) {
            pbId = newRec.id;
            nodeData.pb_id = pbId;
            nodeData.created = newRec.created;
          }
        }
      }
      if (pbId) {
        await sb.from('nodes').update({ created: newDateTime, updated: new Date().toISOString() }).eq('id', pbId);
      }
    }
    nodeData.created = newDateTime;
    
    // Also update any matching node in activeNodesData and rooms
    const active = activeNodesData.find(a => a.id === nodeData.id);
    if (active) {
      active.created = newDateTime;
      active.pb_id = pbId;
    }
    Object.values(rooms).forEach(room => {
      if (room.nodes) {
        const roomNode = room.nodes.find(rn => rn.id === nodeData.id);
        if (roomNode) {
          roomNode.created = newDateTime;
          roomNode.pb_id = pbId;
        }
      }
    });


    showNotification('Registration date/time updated');
  } catch (err) {
    console.warn('Update creation date/time failed:', err);
    showNotification('Failed to update registration date/time');
  }
}

function openNodeDetailModal(nodeData) {
  if (!nodeData) return;

  const modal = document.getElementById('nodeDetailModal');
  const title = document.getElementById('nodeDetailModalTitle');
  const subtitle = document.getElementById('nodeDetailModalSubtitle');
  const content = document.getElementById('nodeDetailModalContent');

  if (!modal || !title || !subtitle || !content) return;

  const batteryValue = nodeData.battery ?? 0;
  const batteryPercent = Math.round((batteryValue / 4.2) * 100);
  const isOnline = nodeData.status === 'online';

  const installDateObj = nodeData.created ? new Date(nodeData.created) : new Date();
  const dateInput = document.getElementById('nodeDetailModalDate');
  const timeInput = document.getElementById('nodeDetailModalTime');
  const infoContainer = document.getElementById('nodeDetailRegistrationInfo');
  
  if (dateInput) {
    const yyyy = installDateObj.getFullYear();
    const mm = String(installDateObj.getMonth() + 1).padStart(2, '0');
    const dd = String(installDateObj.getDate()).padStart(2, '0');
    dateInput.value = `${yyyy}-${mm}-${dd}`;
    
    // Set click handler to show native date picker panel since indicator is hidden
    dateInput.onclick = (e) => {
      e.preventDefault();
      try { dateInput.showPicker(); } catch (err) {}
    };

    // Attempt saving when user modifies the date
    dateInput.onchange = async () => {
      await saveNodeRegistrationDateTime(nodeData, dateInput.value, timeInput.value || '00:00');
    };
  }
  
  if (timeInput) {
    const hh = String(installDateObj.getHours()).padStart(2, '0');
    const min = String(installDateObj.getMinutes()).padStart(2, '0');
    timeInput.value = `${hh}:${min}`;
    
    // Set click handler to show native time picker panel since indicator is hidden
    timeInput.onclick = (e) => {
      e.preventDefault();
      try { timeInput.showPicker(); } catch (err) {}
    };

    // Attempt saving when user modifies the time
    timeInput.onchange = async () => {
      if (!dateInput.value) return;
      await saveNodeRegistrationDateTime(nodeData, dateInput.value, timeInput.value);
    };
  }
  
  if (infoContainer) infoContainer.classList.remove('hidden');

  // Aircon Type Selector Logic
  const airconTypeSelect = document.getElementById('nodeAirconTypeSelect');
  const attachedTypeNameEl = document.getElementById('nodeDetailAttachedTypeName');
  if (airconTypeSelect) {
    // Load available types from localStorage
    const airconTypes = JSON.parse(localStorage.getItem('ecoTrack_airconTypes')) || [
      { name: 'Window Type (Inverter)' },
      { name: 'Split Type (Inverter)' },
      { name: 'Floor Standing' }
    ];

    // Load saved assignment from PocketBase
    const savedType = nodeData.aircon_type || '';

    // Populate dropdown
    airconTypeSelect.innerHTML = '<option value="">-- Select Type --</option>';
    airconTypes.forEach(type => {
      const opt = document.createElement('option');
      opt.value = type.name;
      opt.textContent = type.name;
      if (type.name === savedType) opt.selected = true;
      airconTypeSelect.appendChild(opt);
    });

    // Update label
    if (attachedTypeNameEl) {
      attachedTypeNameEl.textContent = savedType || 'Not assigned';
    }

    // Save on change to Supabase
    airconTypeSelect.onchange = async () => {
      const selected = airconTypeSelect.value;
      try {
        let pbId = nodeData.pb_id;
        if (sb) {
          if (!pbId) {
            const { data: rec } = await sb.from('nodes').select('*').eq('name', nodeData.id).maybeSingle();
            if (rec) {
              pbId = rec.id;
              nodeData.pb_id = pbId;
            }
          }
          if (pbId) {
            await sb.from('nodes').update({ aircon_type: selected, updated: new Date().toISOString() }).eq('id', pbId);
          }
        }
        nodeData.aircon_type = selected; // Update local memory
        if (attachedTypeNameEl) {
          attachedTypeNameEl.textContent = selected || 'Not assigned';
        }

        if (window.EcoToast) {
          window.EcoToast.success('Aircon type updated successfully.');
        }
      } catch (err) {
        console.error('Failed to save aircon type to Supabase', err);
        if (window.EcoToast) {
          window.EcoToast.error('Failed to save aircon type.');
        } else {
          alert('Failed to save aircon type.');
        }
        // Revert UI
        airconTypeSelect.value = savedType;
      }
    };
  }

  window._currentDetailNodeId = nodeData.id;

  title.textContent = nodeData.name || nodeData.id || 'Node Details';
  subtitle.textContent = `Control node ${nodeData.id || ''}`.trim();
  content.innerHTML = '';
  const detailCard = createNodeElement({
    ...nodeData,
    status: nodeData.status || 'online',
    battery: nodeData.battery ?? batteryValue,
    wakeTime: nodeData.wakeTime || '06:00',
    sleepTime: nodeData.sleepTime || '22:00',
    intervalVal: parseInt(nodeData.intervalVal) || 15,
    intervalUnit: nodeData.intervalUnit || 'Minutes',
  });
  detailCard.classList.add('node-detail-card');
  content.appendChild(detailCard);

  modal.style.display = 'flex';
}

function closeNodeDetailModal() {
  window._currentDetailNodeId = null;
  const modal = document.getElementById('nodeDetailModal');
  if (modal) modal.style.display = 'none';
}



function createPlacedNodeCard(nodeOrNodeId, maybeId) {
  let nodeId = typeof nodeOrNodeId === 'string' ? nodeOrNodeId : maybeId;
  
  // 1. Get data
  let nodeData = activeNodesData.find(n => n.id === nodeId);
  const roomData = rooms[selectedRoomId];
  const nodeInRoom = roomData.nodes.find(n => n.id === nodeId);
  
  if (!nodeData && nodeInRoom) {
    nodeData = nodeInRoom; // Use stale data if node isn't live yet
  }

  // 2. Generate the fully styled base card (preserves the p-6 and 2x2 grid!)
  const card = createNodeElement(nodeData);

  // 3. Add classes for the "placed" state
  card.classList.add('relative', 'cursor-move');
  card.setAttribute('data-node-card', 'true');
  card.setAttribute('data-node-id', nodeId);  // needed for live SSE updates

  // 4. Add drag to move functionality
  card.draggable = true;
  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', nodeId);
  });

  card.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0) return;
    openNodeDetailModal(nodeData);
  });
  
  // 5. Add right-click context menu
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    // Remove any existing context menu
    const existingMenu = document.querySelector('.context-menu');
    if (existingMenu) existingMenu.remove();
    
    // Create context menu
    const contextMenu = document.createElement('div');
    contextMenu.className = 'context-menu absolute glass-elevated glass-card shadow-xl z-50 p-1';
    contextMenu.style.left = e.pageX + 'px';
    contextMenu.style.top = e.pageY + 'px';
    contextMenu.innerHTML = `
      <button class="remove-node-btn w-full px-4 py-2 text-left text-red-400 hover:bg-red-500/20 transition-colors text-sm font-semibold rounded-t-lg">
        ✕ Remove
      </button>
      <button class="cancel-menu-btn w-full px-4 py-2 text-left text-gray-400 hover:bg-slate-700 transition-colors text-sm font-semibold rounded-b-lg">
        ✓ Cancel
      </button>
    `;
    
    document.body.appendChild(contextMenu);
    
    // Handle remove
    contextMenu.querySelector('.remove-node-btn').addEventListener('click', async () => {
      if (selectedRoomId && rooms[selectedRoomId]) {
        rooms[selectedRoomId].nodes = rooms[selectedRoomId].nodes.filter(n => n.id !== nodeId);
        updateRoomNodeCount(selectedRoomId);
        saveRoomToDB(selectedRoomId);
      }

      card.remove();
      contextMenu.remove();
      
      const nodeInterface = document.getElementById('nodeInterface');
      if (nodeInterface.children.length === 0) {
        loadRoomNodes(selectedRoomId);
      }
      
      // Refresh the sidebar so the node reappears in Available AC Controls
      populateAvailableNodes();
    });
    
    // Handle cancel
    contextMenu.querySelector('.cancel-menu-btn').addEventListener('click', () => {
      contextMenu.remove();
    });
    
    // Close menu when clicking elsewhere
    setTimeout(() => {
      document.addEventListener('click', function closeMenu() {
        contextMenu.remove();
        document.removeEventListener('click', closeMenu);
      });
    }, 0);
  });
  
  return card;
}

window.addEventListener('devices:synced', () => {
  document.querySelectorAll('[data-node-card]').forEach(card => {
    const node = activeNodesData.find(n => n.id === card.dataset.nodeId || n.name === card.dataset.nodeId);
    if (node) { const updated = createNodeElement(node); const state = updated.querySelector('.telem-aircon-state'); const current = card.querySelector('.telem-aircon-state'); if (state && current) current.replaceWith(state); }
  });
});
