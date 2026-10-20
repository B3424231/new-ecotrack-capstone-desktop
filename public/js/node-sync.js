/** Saves controller telemetry to SQLite and live readings to Supabase. */

(function(global) {
  function getSupabase() {
    if (typeof window !== 'undefined' && (window.supabaseClient || window.sb)) {
      return window.supabaseClient || window.sb;
    }
    if (typeof require !== 'undefined') {
      try {
        const { createClient } = require('@supabase/supabase-js');
        return createClient(
          process.env.SUPABASE_URL || '',
          process.env.SUPABASE_ANON_KEY || ''
        );
      } catch (_) {}
    }
    return null;
  }

  const measurement = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);

  // In-memory cache for node metadata and save rate-limiting
  const _nodeMetadataCache = {};
  const _lastTelemetrySaveTime = {};
  const _telemetrySavesInFlight = new Set();

  const locationName = value => typeof value === 'string' &&
    !/^(?:unassigned|unknown|unavailable|null|undefined|[-—])$/i.test(value.trim()) ? value.trim() : '';
  const completeLocation = loc => loc && ['roomName', 'floorName', 'buildingName'].every(key => locationName(loc[key]));
  function fillLocation(loc, fallback) {
    if (!fallback || (loc.roomName && loc.roomName !== locationName(fallback.roomName)) ||
        (loc.floorName && loc.floorName !== locationName(fallback.floorName))) return loc;
    return Object.fromEntries(['roomName', 'floorName', 'buildingName'].map(key => [key, loc[key] || locationName(fallback[key])]));
  }

  /**
   * Save a single control log telemetry reading into SQLite with the node's
   * corresponding Supabase metadata.
   */
  async function saveNodeTelemetryToSqlite(packet) {
    if (!packet || !packet.id) return null;
    if (['off','offline','disconnected','sleeping','asleep'].includes(String(packet.status || '').toLowerCase())) return null;
    const nodeName = packet.name || packet.id;
    const now = Date.now();

    // Rate-limit saves to telemetry to avoid spamming (max once per second per node)
    if (_telemetrySavesInFlight.has(nodeName) || (_lastTelemetrySaveTime[nodeName] && (now - _lastTelemetrySaveTime[nodeName]) < 900)) {
      return null;
    }
    _telemetrySavesInFlight.add(nodeName);

    const sb = getSupabase();

    try {
      const controller = global.EcoTrackAirconSystem?.NodeService?.getNode(packet.pb_id || packet.id);
      const roomId = Object.prototype.hasOwnProperty.call(packet, 'room_id') ? packet.room_id : controller?.room_id;
      const cacheKey = JSON.stringify([packet.pb_id || controller?.db_id || packet.id, roomId || null]);
      let loc = {
        roomName: locationName(packet.room_name),
        floorName: locationName(packet.floor_name) || locationName(packet.floor),
        buildingName: locationName(packet.building_name) || locationName(packet.building)
      };
      if (controller && (!Object.prototype.hasOwnProperty.call(packet, 'room_id') || packet.room_id === controller.room_id)) {
        loc = fillLocation(loc, { roomName: controller.room_name,
          floorName: locationName(controller.floor_name) || locationName(controller.floor),
          buildingName: locationName(controller.building_name) || locationName(controller.building) });
      }
      let airconType = packet.aircon_type || null;

      // Check in-memory cache first to avoid repetitive queries
      if (_nodeMetadataCache[cacheKey]) {
        const cached = _nodeMetadataCache[cacheKey];
        loc = fillLocation(loc, cached.loc);
        if (!airconType) airconType = cached.airconType;
      }

      if (sb && (!completeLocation(loc) || !airconType)) {
        try {
          const databaseId = packet.pb_id || controller?.db_id;
          const { data: nodeData } = await sb.from('nodes').select('*').eq(databaseId ? 'id' : 'name', databaseId || nodeName).maybeSingle();
          if (nodeData) {
            if (!airconType) airconType = nodeData.aircon_type || null;
            const assignedRoom = Object.prototype.hasOwnProperty.call(packet, 'room_id') ? packet.room_id : nodeData.room_id;
            if (assignedRoom) {
              const { data: room } = await sb.from('rooms').select('*').eq('id', assignedRoom).maybeSingle();
              if (room) {
                let floorName = 'Unassigned';
                let buildingName = 'Unassigned';
                if (room.floor_id) {
                  const { data: floor } = await sb.from('floors').select('*').eq('id', room.floor_id).maybeSingle();
                  if (floor) {
                    floorName = floor.name;
                    if (floor.building_id) {
                      const { data: bld } = await sb.from('buildings').select('*').eq('id', floor.building_id).maybeSingle();
                      if (bld) buildingName = bld.name;
                    }
                  }
                }
                loc = fillLocation(loc, { roomName: room.name, floorName, buildingName });
              }
            }
          }
        } catch (_) {}
      }

      // Retry incomplete metadata next time rather than caching a placeholder forever.
      if (completeLocation(loc)) _nodeMetadataCache[cacheKey] = { loc, airconType };
      loc = Object.fromEntries(['roomName', 'floorName', 'buildingName'].map(key => [key, loc[key] || 'Unassigned']));

      const reportedAcState = packet.ac_on ?? packet.acOn ?? packet.power_state ?? packet.powerState ?? packet.ac_state ?? packet.acState;
      const intervalVal = Number(packet.intervalVal ?? packet.interval_val);
      const intervalUnit = String(packet.intervalUnit ?? packet.interval_unit ?? '').toLowerCase();
      const secondsMultiplier = intervalUnit.startsWith('sec') ? 1 : intervalUnit.startsWith('min') ? 60 : (intervalUnit.startsWith('hour') || intervalUnit.startsWith('hr')) ? 3600 : 0;
      const intervalSeconds = Number(packet.interval_seconds ?? packet.intervalSeconds ?? (intervalVal * secondsMultiplier));

      const reported = String(reportedAcState ?? '').toLowerCase().replace(/[_-]/g, ' ');
      const resolvedAcOn = reportedAcState === true || reportedAcState === 1 || ['on','true','1','active cooling','cooling','fan only','running'].includes(reported) ? true
        : reportedAcState === false || reportedAcState === 0 || ['off','false','0','standby','idle','stopped'].includes(reported) ? false : null;

      const aircons = window.EcoTrackAirconSystem?.AirconProfileManager.getAll() || [];
      const matches = aircons.filter(ac => ac.node_id === nodeName || ac.node_id === packet.pb_id);
      const aircon = matches.length === 1 ? matches[0] : null;
      const hasPacketSnapshot = Object.prototype.hasOwnProperty.call(packet, 'control_snapshot');
      let controlSnapshot = hasPacketSnapshot ? packet.control_snapshot : aircon?.control_snapshot;
      // A received measurement is valid even when the AC is OFF or its power is
      // unknown. Selected settings must never suppress physical OFF evidence.
      // Capture selected settings at ingestion, without treating them as a command or feedback.
      // A null snapshot on an unbound profile cannot supply historical state.
      if (!hasPacketSnapshot && aircon?.aircon_id && controlSnapshot &&
          !controlSnapshot.desired_state && !controlSnapshot.reported_state && aircon.state) {
        controlSnapshot = {
          ...controlSnapshot,
          configured_state: { mode: aircon.state.mode, fan: aircon.state.fan, temp: aircon.state.temperature },
          configured_at: new Date().toISOString()
        };
      }
      const telemPayload = {
        aircon_id: packet.aircon_id ?? aircon?.aircon_id ?? null,
        control_snapshot: controlSnapshot ? JSON.parse(JSON.stringify(controlSnapshot)) : null,
        ac_state: packet.ac_state ?? packet.acState ?? null,
        ...(packet.telemetry_id ? { id: packet.telemetry_id } : {}),
        ...(resolvedAcOn !== null ? { ac_on: resolvedAcOn } : {}),
        ...(Number.isFinite(intervalSeconds) && intervalSeconds > 0 ? { interval_seconds: intervalSeconds } : {}),
        ...(packet.wake_time ? { wake_time: packet.wake_time } : {}),
        ...(packet.sleep_time ? { sleep_time: packet.sleep_time } : {}),
        node_id: packet.pb_id || packet.id || nodeName,
        sensor_name: nodeName,
        room_name: loc.roomName,
        floor_name: loc.floorName,
        building_name: loc.buildingName,
        aircon_type: airconType,
        temperature: measurement(packet.temp ?? packet.temperature),
        pressure: measurement(packet.pressure),
        battery: measurement(packet.battery),
        rssi: measurement(packet.rssi),
        status: packet.status || 'online',
        created: new Date().toISOString()
      };

      // 1. Direct save into local SQLite3 database (backend/telemetry.db on port 5000)
      let record = null;
      try {
        const backendUrl = global.ECOTRACK_CONFIG?.backendUrl || global.electron?.env?.BACKEND_URL || 'http://localhost:5000';
        const res = await fetch(`${backendUrl}/api/telemetry`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(telemPayload)
        });
        if (!res.ok) throw new Error(`Telemetry write failed (HTTP ${res.status})`);
        record = await res.json();
        if (!record?.id) throw new Error('Telemetry API did not confirm a saved row');
        _lastTelemetrySaveTime[nodeName] = Date.now();
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('ecotrack:telemetry-saved', { detail: telemPayload }));
        }
      } catch (err) {
        console.warn('[EcoTrack Sync] Local telemetry write failed:', err.message);
        return null;
      }

      // 2. Also update live control readings on Supabase nodes table so all pages reflect real-time values
      if (sb) try {
        await sb.from('nodes').update({
          temp: telemPayload.temperature,
          battery: telemPayload.battery,
          rssi: telemPayload.rssi,
          status: telemPayload.status,
          updated: new Date().toISOString()
        }).eq('name', nodeName);
      } catch (_) {}

      return record;
    } catch (e) {
      console.warn('[EcoTrack Sync] Failed to save telemetry to SQLite3:', e.message);
      return null;
    } finally {
      _telemetrySavesInFlight.delete(nodeName);
    }
  }

  // ===== BACKGROUND TELEMETRY CADENCE SERVICE =====
  // Reconcile pending cloud command receipts on pages without the telemetry view.
  // Cached node values are never turned into new measurements by this timer.
  let _bgCadenceTimer = null;
  let _assignedNodesCache = null;
  let _assignedNodesCacheTime = 0;

  function readCloudWithDeadline(query) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('Cloud status read timed out'));
        controller.abort();
      }, 15000);
    });
    const read = Promise.resolve().then(() => typeof query.abortSignal === 'function'
      ? query.abortSignal(controller.signal) : query);
    return Promise.race([read, timeout]).finally(() => clearTimeout(timer));
  }

  async function getAssignedNodesWithSchedule() {
    const now = Date.now();
    if (_assignedNodesCache && (now - _assignedNodesCacheTime) < 15000) {
      return _assignedNodesCache;
    }
    const sb = getSupabase();
    if (!sb) return [];
    try {
      const { data: nodes, error } = await readCloudWithDeadline(sb.from('nodes').select('*').not('room_id', 'is', null));
      if (!error && Array.isArray(nodes)) {
        _assignedNodesCache = nodes;
        _assignedNodesCacheTime = now;
        return nodes;
      }
    } catch (_) {}
    return _assignedNodesCache || [];
  }

  function isNodeWithinOperatingWindow(node, now = Date.now()) {
    const minutes = value => {
      const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(value ?? ''));
      return match && Number(match[1]) < 24 && Number(match[2]) < 60 ? Number(match[1]) * 60 + Number(match[2]) : null;
    };
    const wake = minutes(node.wake_time ?? node.wakeTime), sleep = minutes(node.sleep_time ?? node.sleepTime);
    if (wake === null || sleep === null || wake === sleep) return true;
    // The controller schedules use UTC+8, independently of the computer's timezone.
    const local = new Date(now + 8 * 3600000), current = local.getUTCHours() * 60 + local.getUTCMinutes();
    return wake < sleep ? current >= wake && current < sleep : current >= wake || current < sleep;
  }

  const _commandReceiptChecks = new Map();
  const _commandReceiptInFlight = new Set();
  async function reconcilePendingCommandReceipt(node, now = Date.now()) {
    if (typeof window === 'undefined') return;
    const system = window.EcoTrackAirconSystem, sb = getSupabase();
    const matches = (system?.AirconProfileManager?.getAll?.() || []).filter(ac => ac.node_id === node.id || ac.node_id === node.name);
    if (matches.length !== 1 || !sb?.from) return;
    const ac = matches[0], snapshot = ac.control_snapshot;
    if (!ac.aircon_id || !snapshot?.command_id || snapshot.command_status !== 'queued') return;
    if (_commandReceiptInFlight.has(ac.aircon_id)) return;
    const previous = _commandReceiptChecks.get(ac.aircon_id);
    if (previous?.command_id === snapshot.command_id && now - previous.checkedAt < 5000) return;
    _commandReceiptChecks.set(ac.aircon_id, { command_id: snapshot.command_id, checkedAt: now });
    _commandReceiptInFlight.add(ac.aircon_id);
    try {
      const { data: command, error } = await readCloudWithDeadline(sb.from('ecotrack_device_commands').select('id,node_id,kind,payload,status,result')
        .eq('id', snapshot.command_id).maybeSingle());
      if (error || command?.id !== snapshot.command_id || command.node_id !== node.id || command.kind !== 'ac_intent' || command.payload?.aircon_id !== ac.aircon_id) return;
      const current = system.AirconProfileManager.getAll().find(profile => profile.aircon_id === ac.aircon_id);
      if (current?.control_snapshot?.command_id !== snapshot.command_id || current.control_snapshot.command_status !== 'queued') return;
      const receipt = command.result;
      const status = command.status === 'completed' && receipt?.success === true && receipt.command_id === command.id && receipt.delivery_status === 'transmitted' ? 'transmitted' :
        ['failed','expired'].includes(command.status) ? 'failed' : null;
      if (status) system.AirconProfileManager.updateState(ac.device_id, {}, { ...current.control_snapshot, command_status: status });
    } catch (_) { /* Preserve queued status until an authenticated cloud receipt is available. */ }
    finally { _commandReceiptInFlight.delete(ac.aircon_id); }
  }

  let _backgroundReadPending = false;
  async function stepBackgroundTelemetryCadence() {
    if (_backgroundReadPending) return;
    _backgroundReadPending = true;
    try {
      const assignedNodes = await getAssignedNodesWithSchedule();
      await Promise.all(assignedNodes.map(node => reconcilePendingCommandReceipt(node)));
    } finally { _backgroundReadPending = false; }
  }

  function startBackgroundTelemetryCadence() {
    if (_bgCadenceTimer) return;
    // Only reconcile delivery receipts; new telemetry comes from actual received reports.
    stepBackgroundTelemetryCadence();
    _bgCadenceTimer = setInterval(stepBackgroundTelemetryCadence, 5000);
  }

  if (typeof window !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        setTimeout(startBackgroundTelemetryCadence, 1500);
      });
    } else {
      setTimeout(startBackgroundTelemetryCadence, 1500);
    }
  }

  // Export functions
  const EcoTrackNodeSync = {
    saveNodeTelemetryToSqlite,
    isNodeWithinOperatingWindow,
    reconcilePendingCommandReceipt,
    stepBackgroundTelemetryCadence,
    startBackgroundTelemetryCadence
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = EcoTrackNodeSync;
  }
  if (typeof global !== 'undefined') {
    global.EcoTrackNodeSync = EcoTrackNodeSync;
    global.saveNodeTelemetryToSqlite = saveNodeTelemetryToSqlite;
    global.startBackgroundTelemetryCadence = startBackgroundTelemetryCadence;
  }
})(typeof window !== 'undefined' ? window : global);

