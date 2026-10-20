// Generated from mobile src/services/aircon-state.ts by fix-ipc-and-logged-settings.cjs.
(function(root){ const exports={};
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseAirconSnapshot = parseAirconSnapshot;
exports.describeAirconState = describeAirconState;
exports.remoteObservation = remoteObservation;
exports.selectSettings = selectSettings;
exports.displaySettings = displaySettings;
function parseAirconSnapshot(value) {
    if (typeof value === 'string') {
        try {
            return parseAirconSnapshot(JSON.parse(value));
        }
        catch {
            return null;
        }
    }
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
function powerValue(value) {
    if (value === true || value === 1 || ['on', 'true', '1'].includes(String(value).toLowerCase()))
        return true;
    if (value === false || value === 0 || ['off', 'false', '0'].includes(String(value).toLowerCase()))
        return false;
    return null;
}
// Only use a complete, checksummed TCL normal packet for legacy feature flags.
function legacyTclFeatures(frame, protocol) {
    if (protocol !== 'TCL112AC') return {};
    const hex = String(frame.hex || '').replace(/^0x/i, '');
    if (!/^[0-9a-f]{28}$/i.test(hex)) return {};
    const bytes = hex.match(/../g).map(byte => parseInt(byte, 16));
    if (bytes[0] !== 0x23 || bytes[1] !== 0xcb || bytes[2] !== 0x26 || (bytes[3] & 3) !== 1 ||
        (bytes.slice(0, 13).reduce((sum, byte) => sum + byte, 0) & 255) !== bytes[13]) return {};
    return {turbo:!!(bytes[6] & 0x20), swing:!!(bytes[8] & 0x38) || !!(bytes[12] & 8), eco:!!(bytes[5] & 0x80)};
}
function receiverCapabilities(value) {
    const data = parseAirconSnapshot(value);
    if (!data) return null;
    const caps = {};
    for (const feature of ['power','temperature','swing','turbo','eco','sleep','timer','quiet','display','filter','clean','beep','i_feel','swing_vertical','swing_horizontal'])
        if (typeof data[feature] === 'boolean') caps[feature] = data[feature];
    for (const [key, allowed] of [['modes',['cool','heat','dry','fan','auto']], ['fans',['auto','low','medium','high','max','quiet','silent','turbo']]])
        if (Array.isArray(data[key]) && data[key].length && data[key].every(item => allowed.includes(item)))
            caps[key] = [...new Set(data[key])];
    if (typeof data.min_temp === 'number' && typeof data.max_temp === 'number' &&
        data.min_temp >= 10 && data.max_temp <= 40 && data.min_temp <= data.max_temp) {
        caps.min_temp = caps.temperature_min = data.min_temp;
        caps.max_temp = caps.temperature_max = data.max_temp;
    }
    return Object.keys(caps).length ? caps : null;
}
function remoteObservation(capture, receivedAt, previous) {
    const frame=parseAirconSnapshot(capture),saved=parseAirconSnapshot(previous)||{};
    if(!frame)return {};
    const retained=Object.fromEntries(Object.entries(saved).filter(([k])=>k.startsWith('observed_remote_')));
    const decodedFrame=frame.frame_kind!=='settings_only'&&parseAirconSnapshot(frame.state)?frame:parseAirconSnapshot(frame.last_decoded);
    const decoded=decodedFrame?.frame_kind==='settings_only'?null:parseAirconSnapshot(decodedFrame?.state);
    if(!decoded||(!decodedFrame.raw_data&&!(Number(decodedFrame.raw_count)>0)))return retained;
    const receivedProtocol=String(decodedFrame.protocol||decodedFrame.raw_type||'').trim().toUpperCase();
    const protocol=/^[A-Z][A-Z0-9_]{1,48}$/.test(receivedProtocol)&&receivedProtocol!=='UNKNOWN'?receivedProtocol:null;
    if(!protocol)return retained;
    const partial=decodedFrame.frame_kind==='partial_state',update={};
    if(powerValue(decoded.power)!==null)update.power=powerValue(decoded.power);
    if(decoded.temp!==null&&decoded.temp!==undefined&&decoded.temp!==''&&Number.isFinite(Number(decoded.temp)))update.temp=Number(decoded.temp);
    if(['cool','heat','dry','fan','auto'].includes(decoded.mode))update.mode=decoded.mode;
    const fan=protocol==='TCL112AC'&&decoded.fan==='turbo'?'high':decoded.fan;
    if(['auto','low','medium','high','max','quiet','silent','turbo'].includes(fan))update.fan=fan;
    const legacy=partial?{}:legacyTclFeatures(decodedFrame,protocol);
    for(const key of ['turbo','swing','eco','sleep','quiet','display','filter','clean','beep','i_feel','swing_vertical','swing_horizontal']){
      const known=powerValue(decoded[key])??legacy[key]??null;if(known!==null)update[key]=known;
    }
    if(!Object.keys(update).length)return retained;
    const capabilities=receiverCapabilities(decodedFrame.ac_capabilities);
    const identity=JSON.stringify([decodedFrame.boot_count,decodedFrame.sequence,decodedFrame.captured_at_epoch_ms,
      decodedFrame.captured_at_ms,protocol,decodedFrame.hex,update,capabilities,decodedFrame.remote_model]);
    const epoch=Number(decodedFrame.captured_at_epoch_ms),serverTime=Date.parse(decodedFrame.received_at||'');
    const validEpoch=Number.isFinite(epoch)&&epoch>0&&epoch<=8640000000000000&&(!Number.isFinite(serverTime)||epoch<=serverTime+5000);
    const capturedAt=validEpoch?new Date(epoch).toISOString():Number.isFinite(serverTime)?new Date(serverTime).toISOString():receivedAt||null;
    const observedAt=identity===saved.observed_remote_frame?saved.observed_remote_at:capturedAt;
    if(Date.parse(observedAt||'')<Date.parse(saved.observed_remote_at||''))return retained;
    const same=saved.observed_remote_protocol===protocol;
    const fields={...(same?saved.observed_remote_state:{}),...update,source:'ir_receiver'};
    for(const key of ['power','temp','mode','fan','turbo','swing','eco','sleep'])if(fields[key]===undefined)fields[key]=null;
    const times={...(same?saved.observed_remote_field_at:{}),...Object.fromEntries(Object.keys(update).map(key=>{const at=decodedFrame.field_at?.[key],parsed=Date.parse(at||'');return [key,Number.isFinite(parsed)&&parsed<=Date.parse(observedAt||'')+5000?at:observedAt];}))};
    return {observed_remote_state:fields,observed_remote_field_at:times,observed_remote_at:observedAt,
      observed_remote_frame:identity,observed_remote_protocol:protocol,
      observed_remote_model:Number.isInteger(decodedFrame.remote_model)&&decodedFrame.remote_model>0?decodedFrame.remote_model:same?saved.observed_remote_model:null,
      observed_remote_capabilities:capabilities||(same?saved.observed_remote_capabilities:null)};
}
function selectSettings(value) {
    const snapshot=parseAirconSnapshot(value)||{},state={},times={},sources={};
    for(const [kind,data,at] of [
      ['configured',snapshot.configured_state,0],['requested',snapshot.desired_state,Date.parse(snapshot.commanded_at||'')||0],
      ['reported',snapshot.reported_state,Date.parse(snapshot.reported_at||'')||0],['remote',snapshot.observed_remote_state,Date.parse(snapshot.observed_remote_at||'')||0]]){
      const input=parseAirconSnapshot(data);if(!input)continue;
      for(const [key,value] of Object.entries(input)){
        if(value==null||key==='source')continue;
        const stamp=kind==='remote'?Date.parse(snapshot.observed_remote_field_at?.[key]||snapshot.observed_remote_at||'')||0:at;
        if(times[key]===undefined||stamp>=times[key]){state[key]=value;times[key]=stamp;sources[key]=kind;}
      }
    }
    const keys=Object.keys(state);
    return {state:keys.length?state:null,source:sources.power||sources.mode||sources.temp||sources.fan||sources[keys[0]]||'unknown',field_sources:sources};
}

function displaySettings(value) {
    const state=selectSettings(value).state;
    const power=powerValue(state?.power);
    const mode=String(state?.mode||'').trim().toLowerCase();
    const fan=String(state?.fan||'').trim().toLowerCase();
    const modeLabel=['cool','dry','fan','auto','heat'].includes(mode)?mode.toUpperCase():'—';
    const fanLabel=['low','medium','high','max','auto','quiet','silent','turbo'].includes(fan)?fan.toUpperCase():'—';
    const powerLabel=power===true?'ON':power===false?'OFF':'—';
    const temperature=Number.isFinite(state?.temp)?state.temp:null;
    const summary=[powerLabel==='—'?null:powerLabel,modeLabel==='—'?null:modeLabel,
        temperature===null?null:temperature+'°C',fanLabel==='—'?null:fanLabel+' FAN',
        state?.turbo===true?'TURBO':null].filter(Boolean).join(' · ')||'—';
    return {state,power,powerLabel,modeLabel,fanLabel,temperature,summary};
}

/** Commands describe selected settings; only reported feedback describes operation. */
function describeAirconState(value) {
    const snapshot = parseAirconSnapshot(value);
    const reported = snapshot?.reported_state;
    const observed = selectSettings(snapshot);
    if (observed.source === 'remote') {
        const state = observed.state;
        const mode = String(state.mode || '').toUpperCase();
        const label = state.power === false ? 'REMOTE OFF' : state.power === true ? 'REMOTE ON' + (mode ? ' / ' + mode : '') : 'REMOTE SETTINGS';
        const fanLabel = state.fan ? String(state.fan).toUpperCase() + ' FAN' : '';
        return {label,fanLabel,commandStatus:'',confirmed:false,power:null,remoteObserved:true,observedPower:state.power,summary:[label,fanLabel,state.turbo === true ? 'TURBO ON' : ''].filter(Boolean).join(' · ')};
    }
    if (!snapshot?.desired_state && !reported && snapshot?.configured_state) {
        const mode = String(snapshot.configured_state.mode || '').trim().toLowerCase();
        const fan = String(snapshot.configured_state.fan || '').trim().toLowerCase();
        if (['cool', 'dry', 'fan', 'auto', 'heat'].includes(mode)) {
            const label = `${mode.toUpperCase()} SETTINGS`;
            const fanLabel = ['low', 'medium', 'high', 'auto', 'quiet', 'silent', 'turbo'].includes(fan) ? `${fan.toUpperCase()} FAN` : '';
            return { label, fanLabel, commandStatus: '', confirmed: false, power: null,
                summary: [label, fanLabel].filter(Boolean).join(' · ') };
        }
    }
    const reportTime = Date.parse(snapshot?.reported_at || '');
    const commandTime = Date.parse(snapshot?.commanded_at || '');
    const useReported = Boolean(reported && (!snapshot?.desired_state ||
        (Number.isFinite(reportTime) && (!Number.isFinite(commandTime) || reportTime >= commandTime))));
    const state = useReported ? reported : snapshot?.desired_state;
    const power = powerValue(state?.power);
    const mode = String(state?.mode || '').trim().toLowerCase();
    const fan = String(state?.fan || '').trim().toLowerCase();
    const validFans = ['low', 'medium', 'high', 'auto', 'quiet', 'silent', 'turbo'];
    const fanLabel = power !== false && validFans.includes(fan) ? `${fan.toUpperCase()} FAN` : '';
    const commandStatus = ['queued', 'transmitted', 'failed'].includes(snapshot?.command_status || '')
        ? snapshot.command_status.toUpperCase() : '';
    let label = 'UNCONFIRMED';
    if (power === false)
        label = useReported ? 'OFF / STANDBY' : 'POWER OFF REQUESTED';
    if (power === true) {
        if (useReported) {
            label = { fan: 'FAN ONLY', dry: 'DRY MODE', heat: 'HEAT MODE', auto: 'AUTO MODE',
                cool: state?.compressor_active === true ? 'ACTIVE COOLING' :
                    state?.compressor_active === false ? 'COOLING IDLE' : 'COOL MODE' }[mode] || 'ON (MODE UNKNOWN)';
        }
        else {
            label = { cool: 'COOLING REQUESTED', fan: 'FAN REQUESTED', dry: 'DRY REQUESTED',
                heat: 'HEATING REQUESTED', auto: 'AUTO REQUESTED' }[mode] || 'POWER ON REQUESTED';
        }
    }
    return { label, fanLabel, commandStatus, confirmed: useReported && power !== null,
        power: useReported ? power : null, summary: [label, fanLabel, commandStatus].filter(Boolean).join(' · ') };
}

root.EcoTrackAirconState=exports;
})(typeof window==='undefined'?globalThis:window);




﻿/**
 * Universal Aircon IoT System â€” Core Desktop Client Engine
 * Handles Aircon Profiles, Capability Engine, Command Management,
 * Protocol Adapters, IR Learning, Control State Tracking,
 * AC Controller Device Registry, and Central Logging.
 * 
 * Provides unified interoperability across all Desktop pages.
 */

(function(window) {
  'use strict';

  // ===== EVENT BUS FOR INTER-MODULE SYNCHRONIZATION =====
  class EventEmitter {
    constructor() {
      this.events = {};
    }
    on(event, listener) {
      if (!this.events[event]) this.events[event] = [];
      this.events[event].push(listener);
      return () => this.off(event, listener);
    }
    off(event, listener) {
      if (!this.events[event]) return;
      this.events[event] = this.events[event].filter(l => l !== listener);
    }
    emit(event, data, broadcast = true) {
      if (this.events[event]) {
        this.events[event].forEach(listener => {
          try { listener(data); } catch (err) { console.error(`Error in event listener for ${event}:`, err); }
        });
      }
      // Cross-tab / cross-window sync via BroadcastChannel if available
      try {
        if (broadcast && window.BroadcastChannel) {
          if (!this.bc) this.bc = new BroadcastChannel('ecotrack_aircon_channel');
          this.bc.postMessage({ event, data, sender: 'aircon_system' });
        }
      } catch (_) {}
      // DOM CustomEvent dispatch on window for pages that use window.addEventListener
      try {
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
          window.dispatchEvent(new CustomEvent(event, { detail: data }));
        }
      } catch (_) {}
    }
  }

  const AirconEvents = new EventEmitter();
  let sharedIrCodes = [];
  let irCodeStorageReady = false;
  let irCodeStorageError = null;
  let irCodeWriteRevision = 0;

  async function readSharedIrCodes(sb) {
    const rows = [], seen = new Set();
    let after = null, total = null;
    for (;;) {
      let query = sb.from('ecotrack_ir_codes').select('*', { count: 'exact' }).order('id').limit(250);
      if (after !== null) query = query.gt('id', after);
      const response = await query;
      if (response.error) return response;
      if (!Array.isArray(response.data)) throw new Error('Unexpected IR code response.');
      if (after === null && Number.isInteger(response.count)) total = response.count;
      for (const row of response.data) {
        if (!row.id || seen.has(row.id)) throw new Error('IR code pagination returned a repeated identity.');
        seen.add(row.id); rows.push(row);
      }
      if (!response.data.length || (total !== null ? rows.length >= total : response.data.length < 250)) return { data: rows, error: null };
      after = response.data.at(-1).id;
    }
  }

  // Listen for broadcast messages from other windows/tabs
  try {
    if (window.BroadcastChannel) {
      const bc = new BroadcastChannel('ecotrack_aircon_channel');
      bc.onmessage = (msg) => {
        if (msg.data && msg.data.event && msg.data.sender === 'aircon_system') {
          if (msg.data.event === 'hardware:updated' && applyHardwareUpdate(msg.data.data?.hardware, false)) return;
          if (msg.data.event === 'ir:updated') scheduleDatabaseSync();
          if (AirconEvents.events[msg.data.event]) {
            AirconEvents.events[msg.data.event].forEach(l => l(msg.data.data));
          }
        }
      };
    }
  } catch (_) {}

  // ===== AIRCON IDENTITY & DEDUPLICATION ENGINE =====
  function normalizeAirconNodeId(nodeId) {
    if (!nodeId) return '';
    return String(nodeId).toLowerCase().trim()
      .replace(/\s*\([^)]*\)/g, '') // remove parentheticals: e.g. " (room 1)", " (unassigned)"
      .replace(/^node_/, 'node-')
      .replace(/node-0+/, 'node-') // node-001 -> node-1
      .trim();
  }

  function isAutoGeneratedTag(deviceId, nodeId) {
    if (!deviceId) return true;
    const d = String(deviceId).trim();
    if (d.startsWith('AC-node-')) return true;
    if (d.startsWith('AC-EcoTrack-')) return true;
    if (nodeId && (d === 'AC-' + nodeId || d.toLowerCase() === ('ac-' + nodeId).toLowerCase())) return true;
    return false;
  }

  function deduplicateAirconList(list) {
    if (!Array.isArray(list)) return [];
    const result = [];
    const seenDeviceIds = new Set();
    const seenNodeIds = new Set();

    // Prioritize formatted / user-edited / richer profiles over auto-generated AC-node-* tags
    const sorted = [...list].sort((a, b) => {
      if (!a || !b) return 0;
      const aAuto = isAutoGeneratedTag(a.device_id, a.node_id);
      const bAuto = isAutoGeneratedTag(b.device_id, b.node_id);
      if (aAuto && !bAuto) return 1;
      if (!aAuto && bAuto) return -1;
      
      const aHasBrand = a.brand && a.brand !== 'Generic';
      const bHasBrand = b.brand && b.brand !== 'Generic';
      if (!aHasBrand && bHasBrand) return 1;
      if (aHasBrand && !bHasBrand) return -1;

      return 0;
    });

    const seenNodeMap = new Map(); // normNode -> canonical aircon

    sorted.forEach(ac => {
      if (!ac || !ac.device_id) return;
      const devId = String(ac.device_id).trim();
      const devIdLower = devId.toLowerCase();
      const normNode = normalizeAirconNodeId(ac.node_id);
      const isAuto = isAutoGeneratedTag(devId, ac.node_id);

      // If exact device_id already registered, skip
      if (seenDeviceIds.has(devIdLower)) return;

      // If node_id already registered:
      // If either this unit or the existing unit has an auto-generated placeholder ID, they are duplicate profiles for the same node!
      if (normNode && seenNodeMap.has(normNode)) {
        const existing = seenNodeMap.get(normNode);
        const existingIsAuto = isAutoGeneratedTag(existing.device_id, existing.node_id);

        if (isAuto || existingIsAuto) {
          if ((!existing.brand || existing.brand === 'Daikin' || existing.brand === 'Generic') && ac.brand && ac.brand !== 'Generic') {
            existing.brand = ac.brand;
            existing.protocol_name = ac.protocol_name || CapabilityEngine.resolveProtocolName(ac.brand);
            existing.protocol = existing.protocol_name;
            existing.capabilities = CapabilityEngine.getCapabilities(existing.protocol_name);
          }
          if ((!existing.location || existing.location.includes('Facility Zone')) && ac.location && !ac.location.includes('Facility Zone')) {
            existing.location = ac.location;
            existing.room = ac.room || existing.room;
            existing.room_name = ac.room_name || existing.room_name;
            existing.floor = ac.floor || existing.floor;
            existing.building = ac.building || existing.building;
          }
          if (ac.state && (!existing.state || typeof existing.state.temperature !== 'number')) {
            existing.state = ac.state;
          }
          return;
        }
      }

      seenDeviceIds.add(devIdLower);
      if (normNode) seenNodeMap.set(normNode, ac);
      result.push({ ...ac });
    });

    return result;
  }

  // ===== PURGE STALE MOCK DATA FROM PREVIOUS SESSIONS & AUTO-DEDUPLICATE =====
  // Only purge legacy demo mock data (e.g. Living Room, Master Bedroom) or outdated (node- patterns
  try {
    const rawAircons = localStorage.getItem('ecoTrack_aircons');
    if (rawAircons) {
      const aircons = JSON.parse(rawAircons);
      const hasMock = Array.isArray(aircons) && aircons.some(a =>
        a && a.name && (a.name.includes('Living Room') || a.name.includes('Master Bedroom') || a.name.includes('(node-') || a.name.includes('(EcoTrack-'))
      );
      if (hasMock) {
        localStorage.removeItem('ecoTrack_nodes');
        localStorage.removeItem('ecoTrack_aircons');
        localStorage.removeItem('ecoTrack_ir_commands');
        console.log('[AirconSystem] Purged legacy mock/outdated aircon names from localStorage.');
      } else if (Array.isArray(aircons) && aircons.length > 0) {
        // Immediate startup deduplication to prevent inflated unit counts
        const deduped = deduplicateAirconList(aircons);
        if (deduped.length !== aircons.length) {
          localStorage.setItem('ecoTrack_aircons', JSON.stringify(deduped));
          console.log(`[AirconSystem] Immediate startup deduplication: purged ${aircons.length - deduped.length} duplicate aircon entries (${aircons.length} -> ${deduped.length}).`);
        }
      }
    }
  } catch (_) {}

  // ===== DEFAULT SEED DATA (empty â€” all data comes from Supabase or user registration) =====
  const DEFAULT_NODES = [];

  const DEFAULT_AIRCONS = [];

  const DEFAULT_IR_COMMANDS = [];

  // ===== CENTRAL LOGGING SERVICE =====
  class CentralLogService {
    static getLogs(limit = 100) {
      try {
        const raw = localStorage.getItem('ecoTrack_system_logs');
        const logs = raw ? JSON.parse(raw) : [];
        return logs.slice(0, limit);
      } catch (_) {
        return [];
      }
    }

    static clearLogs() {
      try {
        localStorage.setItem('ecoTrack_system_logs', JSON.stringify([]));
      } catch (_) {}
      if (typeof AirconEvents !== 'undefined' && typeof AirconEvents.emit === 'function') {
        AirconEvents.emit('log:cleared');
      }
    }

    /**
     * @param {Object} entry
     * @param {string} entry.device_id
     * @param {string} [entry.node_id]
     * @param {'CONTROL' | 'IR' | 'MONITORING' | 'NODE' | 'STATE' | 'CONFIG'} entry.module
     * @param {string} entry.event
     * @param {'SUCCESS' | 'FAILED' | 'PENDING' | 'WARNING' | 'INFO' | 'OFFLINE'} entry.result
     * @param {string} [entry.details]
     */
    static log({ device_id, node_id, module, event, result, details }) {
      const entry = {
        id: 'log_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        timestamp: new Date().toISOString(),
        device_id: device_id || 'SYSTEM',
        node_id: node_id || 'N/A',
        module: module || 'GENERAL',
        event: event || 'ACTION',
        result: result || 'INFO',
        details: details || ''
      };

      try {
        const raw = localStorage.getItem('ecoTrack_system_logs');
        const logs = raw ? JSON.parse(raw) : [];
        logs.unshift(entry);
        if (logs.length > 500) logs.pop();
        localStorage.setItem('ecoTrack_system_logs', JSON.stringify(logs));
      } catch (err) {
        console.warn('Could not persist system log:', err);
      }

      AirconEvents.emit('log:new', entry);

      return entry;
    }
  }

  // ===== DATABASE SYNC ENGINE (Supabase Master Source) =====
  let isDatabaseSyncing = false;
  let databaseSyncPending = false;
  let databaseReferenceRefreshPending = false;
  let referenceCache = null;
  let referenceRead = null;
  let referenceEpoch = 0;
  let databaseAuthVersion = 0;
  let databaseRealtimeClient = null;
  let databaseSyncTimer = null;
  let databaseRefreshTimer = null;
  let scheduledReferenceRefresh = false;

  let registryReady = false;
  let lastHardwareEventAt = 0;
  let lastDatabaseSnapshotAt = 0;
  const hardwareOverlay = new Map();
  const hardwareEventVersions = new Map();
  let hardwareRevision = 0;
  const registeredNodeRows = new Map();

  function hardwareVersion(row) {
    const value = row?.last_seen || '';
    const time = Date.parse(value);
    const submillisecond = typeof value === 'string' ? /\.\d{3}(\d+)(?:Z|[+-])/.exec(value)?.[1] : null;
    return Number.isFinite(time) ? time + (submillisecond ? Number('0.' + submillisecond) : 0) : 0;
  }
  function mergeHardwareState(row, readRevision = Infinity) {
    const newer = hardwareOverlay.get(row.node_id);
    const selected = newer && (hardwareEventVersions.get(row.node_id) || 0) > readRevision && hardwareVersion(newer) > hardwareVersion(row) ? newer : row;
    const hardware = { ...selected, connection_status: window.EcoTrackHardwareCloud?.describe(selected) || selected.connection_status || 'offline' };
    hardwareOverlay.set(row.node_id, hardware);
    return hardware;
  }
  function profileWithHardware(profile, hardware) {
    const snapshot = { ...profile.control_snapshot,
      ...window.EcoTrackAirconState.remoteObservation(hardware.latest_ir, hardware.last_seen, profile.control_snapshot) };
    const description = window.EcoTrackAirconState.describeAirconState(snapshot);
    const selected = window.EcoTrackAirconState.selectSettings(snapshot).state;
    const protocol = snapshot.observed_remote_protocol || profile.configured_protocol || profile.protocol_name;
    const flag = value => value == null ? null : ['on','true','1'].includes(String(value).toLowerCase()) ? true : ['off','false','0'].includes(String(value).toLowerCase()) ? false : null;
    return { ...profile, control_snapshot: snapshot, protocol_name: protocol, protocol,
      detected_protocol: snapshot.observed_remote_protocol || null,
      capabilities: CapabilityEngine.getCapabilities({ ...profile, state:{...profile.state,mode:selected?.mode}, protocol_name: protocol, control_snapshot: snapshot }),
      hardware_capabilities: hardware.capabilities || {},
      ir_monitoring: hardware.capabilities?.ir_receiver === true,
      ir_controlling: hardware.capabilities?.ir_transmitter === true,
      status: hardware.connection_status === 'online' ? 'online' : 'offline',
      state: selected ? { ...profile.state, power: flag(selected.power), temperature: selected.temp,
        ...Object.fromEntries(['quiet','display','filter','clean','beep','i_feel','swing_vertical','swing_horizontal'].map(k=>[k,flag(selected[k])])),
        mode: selected.mode, fan: selected.fan, swing: flag(selected.swing), turbo: flag(selected.turbo),
        eco: flag(selected.eco), sleep: flag(selected.sleep) } : profile.state,
      operational_state: { classification: description.confirmed || description.remoteObserved ? description.label : 'UNCONFIRMED',
        target_temperature: selected?.temp ?? null, mode: selected?.mode ?? null,
        last_updated: snapshot.observed_remote_at || snapshot.reported_at || null }
    };
  }
  // Events only update authenticated, registered controllers; they never create assets.
  function applyHardwareUpdate(row, broadcast = true) {
    if (!row || typeof row.node_id !== 'string' || !hardwareVersion(row) || !row.capabilities || typeof row.capabilities !== 'object') return false;
    if (!registryReady || !registeredNodeRows.has(row.node_id)) return false;
    if (row.device_id !== hardwareOverlay.get(row.node_id)?.device_id) return false;
    lastHardwareEventAt = Date.now();
    const previous = hardwareOverlay.get(row.node_id);
    if (hardwareVersion(previous) >= hardwareVersion(row)) return true;
    const nodes = JSON.parse(localStorage.getItem('ecoTrack_nodes') || '[]');
    const aircons = JSON.parse(localStorage.getItem('ecoTrack_aircons') || '[]');
    const matched = nodes.filter(node => node.db_id === row.node_id);
    if (matched.length !== 1) return false;
    const hardware = mergeHardwareState(row);
    hardwareEventVersions.set(row.node_id, ++hardwareRevision);
    const node = matched[0], online = hardware.connection_status === 'online';
    Object.assign(node, { cloud_state: hardware, last_seen: hardware.last_seen,
      status: hardware.connection_status === 'sleeping' ? 'Sleeping' : online ? 'Connected' : 'Offline',
      capabilities: hardware.capabilities || {}, firmware: hardware.firmware_version,
      ir_tx: hardware.capabilities?.ir_transmitter === true, ir_rx: hardware.capabilities?.ir_receiver === true,
      hardware: hardware.capabilities?.ir_transmitter ? 'ESP32-S3 IR controller' : 'ESP32-S3 IR receiver',
      controls: hardware.capabilities?.ir_transmitter ? ['IR Control', 'IR Learning'] : ['IR Learning'],
      ip_address: hardware.ip_address, wifi_ssid: hardware.wifi_ssid, rssi: hardware.rssi });
    const changed = [];
    const updated = aircons.map(profile => {
      if (profile.controller_node_id !== row.node_id) return profile;
      const next = profileWithHardware(profile, hardware); changed.push(next); return next;
    });
    localStorage.setItem('ecoTrack_nodes', JSON.stringify(nodes));
    localStorage.setItem('ecoTrack_aircons', JSON.stringify(updated));
    AirconEvents.emit('hardware:updated', { node_id: row.node_id, hardware, nodes: [node], aircons: changed }, broadcast);
    return true;
  }
  function receiveHardwareEvent(payload) {
    const row = payload?.eventType === 'DELETE' ? null : payload?.new || payload?.payload?.row;
    try { if (!applyHardwareUpdate(row)) scheduleDatabaseSync(); }
    catch (_) { scheduleDatabaseSync(); }
  }
  function isConnectionOnlyNodeEvent(payload) {
    const row = payload?.new, previous = registeredNodeRows.get(row?.id);
    const heartbeatFields = new Set(['status','rssi','ip_address','wifi_ssid','updated']);
    return payload?.eventType !== 'DELETE' && row && previous &&
      Object.keys({ ...previous, ...row }).every(key => heartbeatFields.has(key) || JSON.stringify(row[key]) === JSON.stringify(previous[key]));
  }
  function receiveNodeEvent(payload) {
    const row = payload?.new;
    if (isConnectionOnlyNodeEvent(payload)) {
      registeredNodeRows.set(row.id, row);
      return true;
    }
    if (payload?.eventType === 'DELETE') { registeredNodeRows.delete(payload.old?.id); hardwareOverlay.delete(payload.old?.id); }
    scheduleDatabaseSync();
  }

  function invalidateReferenceData() {
    referenceEpoch += 1;
    referenceCache = null;
    referenceRead = null;
  }
  function readReferenceData(sb, force) {
    if (force) invalidateReferenceData();
    if (referenceCache?.client === sb && Date.now() - referenceCache.loadedAt < 30000) return Promise.resolve(referenceCache.rows);
    if (referenceRead?.client === sb) return referenceRead.promise;
    const epoch = referenceEpoch;
    const request = { client: sb, promise: null };
    request.promise = Promise.all(['rooms', 'floors', 'buildings'].map(table => sb.from(table).select('*'))).then(rows => {
      const failed = rows.find(row => row.error);
      if (failed) throw failed.error;
      if (epoch === referenceEpoch) referenceCache = { client: sb, rows, loadedAt: Date.now() };
      return rows;
    }).finally(() => { if (referenceRead === request) referenceRead = null; });
    referenceRead = request;
    return request.promise;
  }
  function scheduleDatabaseSync(refreshReferences = false) {
    scheduledReferenceRefresh ||= refreshReferences;
    if (refreshReferences) invalidateReferenceData();
    if (databaseSyncTimer) return;
    databaseSyncTimer = setTimeout(() => {
      databaseSyncTimer = null;
      const force = scheduledReferenceRefresh;
      scheduledReferenceRefresh = false;
      void syncWithDatabase(force);
    }, 150);
  }
  function resolveRegisteredAirconNode(aircon, aircons, nodes) {
    const links = [aircon.node_id, aircon.controller_node_id].filter(Boolean);
    const matches = nodes.filter(node => links.includes(node.id) || links.includes(node.name));
    if (matches.length !== 1) return null;
    const node = matches[0];
    const owners = aircons.filter(owner => [owner.node_id, owner.controller_node_id]
      .some(link => link && (link === node.id || link === node.name)));
    return owners.length === 1 ? node : null;
  }

  async function syncWithDatabase(refreshReferences = true) {
    if (isDatabaseSyncing) {
      databaseSyncPending = true;
      databaseReferenceRefreshPending ||= refreshReferences;
      return;
    }
    const sb = window.supabaseClient || window.sb;
    if (!sb || typeof sb.from !== 'function') return;

    try {
      isDatabaseSyncing = true;
      const authVersion = databaseAuthVersion;
      const irRevision = irCodeWriteRevision;
      const readRevision = hardwareRevision;
      await window.ecotrackAuthReady;
      if (sb.auth?.getSession) {
        const { data, error } = await sb.auth.getSession();
        if (error) throw error;
        if (!data?.session || authVersion !== databaseAuthVersion) return;
      }
      const [nodesRes, [roomsRes, floorsRes, bldRes], airconsRes, codesRes] = await Promise.all([
        sb.from('nodes').select('*').order('name'),
        readReferenceData(sb, refreshReferences),
        sb.from('aircons').select('*'),
        readSharedIrCodes(sb).catch(error => ({ data: null, error }))
      ]);
      if (authVersion !== databaseAuthVersion) return;
      if (nodesRes.error || airconsRes.error) throw nodesRes.error || airconsRes.error;
      if (!Array.isArray(nodesRes.data) || !Array.isArray(airconsRes.data)) throw new Error('Unexpected device registry response');

      let hardwareStates = [];
      if (window.EcoTrackHardwareCloud) {
        hardwareStates = await window.EcoTrackHardwareCloud.listStatus();
      }
      if (authVersion !== databaseAuthVersion) return;
      const hardwareByNode = new Map(hardwareStates.map(item => [item.node_id, mergeHardwareState(item, readRevision)]));
      registeredNodeRows.clear();
      for (const row of nodesRes.data) registeredNodeRows.set(row.id, row);
      for (const id of hardwareOverlay.keys()) if (!registeredNodeRows.has(id)) hardwareOverlay.delete(id);
      const sbNodes = nodesRes.data || [];
      const sbRooms = roomsRes.data || [];
      const sbFloors = floorsRes.data || [];
      const sbBuildings = bldRes.data || [];
      const sbAircons = (airconsRes && airconsRes.data) ? airconsRes.data : [];

      const buildingMap = {};
      sbBuildings.forEach(b => { buildingMap[b.id] = b.name; });

      const floorMap = {};
      sbFloors.forEach(f => {
        floorMap[f.id] = {
          name: f.name,
          building: buildingMap[f.building_id] || 'main campus'
        };
      });

      const roomMap = {};
      sbRooms.forEach(r => {
        const flr = floorMap[r.floor_id] || { name: 'first floor', building: 'main campus' };
        roomMap[r.id] = {
          name: r.name,
          floor: flr.name,
          building: flr.building
        };
      });

      // Map real Supabase nodes into AC Controller Devices
      const pendingControllers = new Set(window.EcoTrackHardwareCloud?.pendingRegistrations?.() || []);
      const realNodes = sbNodes.filter(n => !pendingControllers.has(n.id) || sbAircons.some(ac => ac.controller_node_id === n.id || ac.node_id === n.id)).map((n, idx) => {
        let rInfo = roomMap[n.room_id];
        if (!rInfo) {
          rInfo = { name: 'Unassigned', floor: 'Unassigned', building: 'Unassigned' };
        }

        const hardware = hardwareByNode.get(n.id);
        const isOnline = hardware?.connection_status === 'online';
        const numPart = (n.name || n.id || String(idx + 1)).replace(/\D/g, '') || String(idx + 1);
        const matchedAcForNode = sbAircons.find(a => 
          a.id === n.monitor_aircon_id ||
          a.node_id === n.name || a.node_id === n.id || 
          a.controller_node_id === n.name || a.controller_node_id === n.id ||
          (a.asset_tag && (n.name === a.asset_tag || n.id === a.asset_tag || n.aircon_id === a.asset_tag))
        );
        const resolvedBrand = matchedAcForNode?.brand || n.brand || null;

        return {
          node_id: hardware?.device_id || n.name || n.id,
          name: n.name,
          status: hardware?.connection_status === 'sleeping' ? 'Sleeping' : isOnline ? 'Connected' : 'Offline',
          hardware: hardware?.capabilities?.ir_transmitter ? 'ESP32-S3 IR controller' : 'ESP32-S3 IR receiver',
          firmware: hardware?.firmware_version || null,
          capabilities: hardware?.capabilities || {},
          cloud_state: hardware || null,
          connection: 'WiFi (2.4GHz) / Supabase Realtime',
          controls: hardware?.capabilities?.ir_transmitter ? ['IR Control', 'IR Learning'] : ['IR Learning'],
          ir_tx: hardware?.capabilities?.ir_transmitter === true,
          ir_rx: hardware?.capabilities?.ir_receiver === true,
          brand: resolvedBrand,
          protocol_name: matchedAcForNode?.protocol_name || matchedAcForNode?.protocol || n.protocol_name || null,
          mac_address: n.mac_address || null,
          battery_percent: typeof hardware?.capabilities?.battery_percent==='number'?hardware.capabilities.battery_percent:(n.battery_unit==='percent'?n.battery:null),
          admin_verified_at: n.admin_verified_at || null,
          deployment_saved_at: n.deployment_saved_at || null,
          ip_address: hardware?.ip_address || null,
          wifi_ssid: hardware?.wifi_ssid || null,
          rssi: hardware?.rssi ?? null,
          temp: null,
          pressure: null,
          room_id: n.room_id,
          room_name: rInfo.name,
          floor_id: sbRooms.find(room => room.id === n.room_id)?.floor_id || null,
          building_id: sbFloors.find(floor => floor.id === sbRooms.find(room => room.id === n.room_id)?.floor_id)?.building_id || null,
          floor: rInfo.floor,
          building: rInfo.building,
          location: `${rInfo.name} (${rInfo.building} • ${rInfo.floor})`,
          aircon_type: n.aircon_type || matchedAcForNode?.aircon_type || 'Split Type (Inverter)',
          db_id: n.id,device_mode:n.device_mode || 'controller',monitor_aircon_id:n.monitor_aircon_id,monitoring_id:n.monitoring_id,sensor_config:n.sensor_config,
          last_seen: hardware?.last_seen || null
        };
      });

      // Existing cached aircons from localStorage (cleaned of any duplicates)
      let cachedAircons = [];
      try {
        const raw = localStorage.getItem('ecoTrack_aircons');
        if (raw) cachedAircons = deduplicateAirconList(JSON.parse(raw));
      } catch (_) {}

      // Build unified, deduplicated list of real aircon units (Strict 1 Unit per Node)
      const realAircons = [];
      const processedTags = new Set();
      const processedNodeIds = new Set();

      // 1. First add all aircons explicitly registered in Supabase aircons table (from Admin or Mobile Staff)
      sbAircons.forEach(ac => {
        const tag = ac.asset_tag || ac.id;
        if (!tag || processedTags.has(tag.toLowerCase())) return;

        const matchedNode = resolveRegisteredAirconNode(ac, sbAircons, sbNodes);
        const effectiveNodeName = matchedNode ? (hardwareByNode.get(matchedNode.id)?.device_id || matchedNode.name || matchedNode.id) : '';
        const normNode = normalizeAirconNodeId(effectiveNodeName);
        if (normNode && processedNodeIds.has(normNode)) return;

        const rId = ac.room_id || matchedNode?.room_id;
        const rInfo = (rId && roomMap[rId]) || { name: 'Unassigned', floor: 'Unassigned', building: 'Unassigned' };
        const cleanRoom = (rInfo.name || '').trim().replace(/\b\w/g, l => l.toUpperCase());
        const canonicalName = `${cleanRoom} AC (${tag})`;

        const existingLocal = cachedAircons.find(c => 
          c.aircon_id === ac.id || c.device_id.toLowerCase() === tag.toLowerCase()
        );

        const isCustomUserEdited = existingLocal?.name && 
          !existingLocal.name.includes('(node-') && 
          !existingLocal.name.includes('(EcoTrack-') && 
          !existingLocal.name.includes('Living Room') &&
          !existingLocal.name.includes('Master Bedroom');
        const finalName = ac.name?.trim() || ac.asset_tag || (isCustomUserEdited ? existingLocal.name : canonicalName);

        const isOnline = matchedNode ? hardwareByNode.get(matchedNode.id)?.connection_status === 'online' : false;
        const configuredProtocol = ac.protocol_name || ac.protocol || 'UNKNOWN';
        const hardwareState = matchedNode ? hardwareByNode.get(matchedNode.id) : null;
        const snapshot = { desired_state: ac.desired_state, reported_state: ac.reported_state, reported_at: ac.reported_at, commanded_at: ac.commanded_at, command_id: ac.command_id, command_status: ac.command_status,
          ...window.EcoTrackAirconState.remoteObservation(hardwareState?.latest_ir, hardwareState?.last_seen, existingLocal?.control_snapshot) };
        const proto = snapshot.observed_remote_protocol || configuredProtocol;
        const description = window.EcoTrackAirconState.describeAirconState(snapshot);
        const selectedState = window.EcoTrackAirconState.selectSettings(snapshot).state;
        const controlState = selectedState ? {
          ...(existingLocal?.state || {}),
          power: description.confirmed ? description.power : ['on', 'true', '1'].includes(String(selectedState.power).toLowerCase()) ? true : ['off', 'false', '0'].includes(String(selectedState.power).toLowerCase()) ? false : null,
          ...Object.fromEntries(['quiet','display','filter','clean','beep','i_feel','swing_vertical','swing_horizontal'].map(k=>[k,selectedState[k]==null?null:selectedState[k]===true||selectedState[k]==='on'])),
          temperature: selectedState.temp, mode: selectedState.mode, fan: selectedState.fan,
          swing: selectedState.swing == null ? null : selectedState.swing === true || selectedState.swing === 'on',
          turbo: selectedState.turbo == null ? null : selectedState.turbo === true || selectedState.turbo === 'on',
          eco: selectedState.eco == null ? null : selectedState.eco === true || selectedState.eco === 'on',
          sleep: selectedState.sleep == null ? null : selectedState.sleep === true || selectedState.sleep === 'on',
          updated_at: ac.updated_at
        } : { power: null, temperature: null, mode: null, fan: null };

        realAircons.push({
          aircon_id: ac.id,
          controller_node_id: matchedNode?.id || null,
          room_id: rId || null,
          control_snapshot: snapshot,
          hardware_capabilities: hardwareState?.capabilities || {},
          ir_monitoring: hardwareState?.capabilities?.ir_receiver === true,
          ir_controlling: hardwareState?.capabilities?.ir_transmitter === true,
          device_id: tag,
          name: finalName,
          brand: ac.brand || 'Unspecified',
          model: ac.model || ac.aircon_type || existingLocal?.model || 'Split Type (Inverter)',
          aircon_type: ac.aircon_type || ac.model || existingLocal?.aircon_type || 'Split Type (Inverter)',
          location: (existingLocal?.room_id === rId && existingLocal?.location) || `${cleanRoom} (${rInfo.building || 'Main Campus'} • ${rInfo.floor || '1st Floor'})`,
          building: rInfo.building || '',
          floor: rInfo.floor || '',
          room: cleanRoom,
          room_name: cleanRoom,
          node_id: effectiveNodeName,
          status: isOnline ? 'online' : 'offline',
          protocol_name: proto,
          protocol: proto,
          configured_protocol: configuredProtocol,
          detected_protocol: snapshot.observed_remote_protocol || null,
          capability_profile: ac.capability_profile || {},
          capabilities: CapabilityEngine.getCapabilities({...ac,protocol_name:proto,control_snapshot:snapshot,state:controlState}),
          state: controlState,
          operational_state: { classification: description.confirmed || description.remoteObserved ? description.label : 'UNCONFIRMED',
            target_temperature: selectedState?.temp ?? null, mode: selectedState?.mode ?? null,
            last_updated: ac.reported_at || null }
        });

        processedTags.add(tag.toLowerCase());
        if (normNode) processedNodeIds.add(normNode);
      });

      // Supabase assets are authoritative; reads never recreate deleted profiles from cache or controllers.

      // 4. Final deduplication guarantee
      const finalAircons = deduplicateAirconList(realAircons);

      localStorage.setItem('ecoTrack_nodes', JSON.stringify(realNodes));
      localStorage.setItem('ecoTrack_aircons', JSON.stringify(finalAircons));
      localStorage.removeItem('ecoTrack_aircons_cache');
      if (irRevision === irCodeWriteRevision) {
        const previousCodes = JSON.stringify(sharedIrCodes);
        const previousError = irCodeStorageError?.message;
        irCodeStorageReady = !codesRes.error;
        irCodeStorageError = codesRes.error ? new Error('Shared IR codes are unavailable. Ask your administrator to enable IR code sharing.') : null;
        const visibleAircons = new Map(sbAircons.map(ac => [ac.id, ac.asset_tag || ac.id]));
        sharedIrCodes = (codesRes.data || []).filter(row => visibleAircons.has(row.aircon_id))
          .map(row => ({ ...row, device_id: visibleAircons.get(row.aircon_id) }));
        if (previousCodes !== JSON.stringify(sharedIrCodes) || previousError !== irCodeStorageError?.message)
          AirconEvents.emit('ir:updated', { action: 'sync' }, false);
      }
      registryReady = true;
      lastDatabaseSnapshotAt = Date.now();

      AirconEvents.emit('node:updated', realNodes);
      AirconEvents.emit('aircon:updated', finalAircons);
      AirconEvents.emit('devices:synced', { nodes: realNodes, aircons: finalAircons });
    } catch (e) {
      console.warn('[AirconSystem] Supabase sync error:', e);
    } finally {
      isDatabaseSyncing = false;
      if (databaseSyncPending) {
        const force = databaseReferenceRefreshPending;
        databaseSyncPending = false;
        databaseReferenceRefreshPending = false;
        void syncWithDatabase(force);
      }
    }
  }

  // Subscribe to real-time changes on nodes table
  function initSupabaseRealtime() {
    const sb = window.supabaseClient || window.sb;
    if (sb && typeof sb.channel === 'function' && databaseRealtimeClient !== sb) {
      databaseRealtimeClient = sb;
      sb.auth?.onAuthStateChange?.(() => {
        if (databaseRealtimeClient !== sb) return;
        databaseAuthVersion += 1;
        sharedIrCodes = []; irCodeStorageReady = false; irCodeStorageError = null; irCodeWriteRevision += 1;
        AirconEvents.emit('ir:updated', { action: 'session' }, false);
        registryReady = false; hardwareOverlay.clear(); hardwareEventVersions.clear(); registeredNodeRows.clear(); lastHardwareEventAt = 0;
        invalidateReferenceData();
        scheduleDatabaseSync(true);
      });
      try {
        sb.channel('realtime_aircon_nodes')
          .on('postgres_changes', { event: '*', schema: 'public', table: 'nodes' }, receiveNodeEvent)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'aircons' }, () => scheduleDatabaseSync())
          .on('postgres_changes', { event: '*', schema: 'public', table: 'ecotrack_ir_codes' }, () => scheduleDatabaseSync())
          .on('postgres_changes', { event: '*', schema: 'public', table: 'ecotrack_device_state' }, receiveHardwareEvent)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms' }, () => scheduleDatabaseSync(true))
          .on('postgres_changes', { event: '*', schema: 'public', table: 'floors' }, () => scheduleDatabaseSync(true))
          .on('postgres_changes', { event: '*', schema: 'public', table: 'buildings' }, () => scheduleDatabaseSync(true))
          .subscribe(status => {
            if (status === 'SUBSCRIBED') scheduleDatabaseSync();
          });
      } catch (_) {}
      try {
        sb.channel('ecotrack:hardware', { config: { private: true } })
          .on('broadcast', { event: 'device_state' }, receiveHardwareEvent)
          .subscribe(status => { if (status === 'SUBSCRIBED') scheduleDatabaseSync(); });
      } catch (_) {} // Postgres Changes and the polling recovery path remain available.
    }
    if (sb && !databaseRefreshTimer) {
      databaseRefreshTimer = setInterval(() => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        if (Date.now() - lastHardwareEventAt < 10000 && Date.now() - lastDatabaseSnapshotAt < 30000) return;
        void syncWithDatabase(false);
      }, 5000);
    }
  }

  // Listen for Supabase ready
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'hidden') scheduleDatabaseSync();
    });
    window.addEventListener('beforeunload', () => {
      clearInterval(databaseRefreshTimer);
      clearTimeout(databaseSyncTimer);
      databaseRefreshTimer = null;
      databaseSyncTimer = null;
    });
    window.addEventListener('supabase:ready', () => {
      syncWithDatabase();
      initSupabaseRealtime();
    });
  }
  if (typeof window !== 'undefined' && (window.supabaseClient || window.sb)) {
    syncWithDatabase();
    initSupabaseRealtime();
  }

  // ===== AC CONTROLLER DEVICE SERVICE =====
  class ACControllerDeviceService {
    static getDevices() {
      try {
        const raw = localStorage.getItem('ecoTrack_nodes');
        if (raw) {
          const parsed = JSON.parse(raw);
          // Only purge old mock nodes with fake room names (Living/Bed, Kitchen/Dining)
          const isStale = Array.isArray(parsed) && parsed.some(n => n.name && (n.name.includes('Living/Bed') || n.name.includes('Kitchen/Dining')));
          if (Array.isArray(parsed) && parsed.length > 0 && !isStale) {
            let modified = false;
            parsed.forEach(n => {
              if (!n) return;
              delete n.wifi_password; delete n.password; delete n.device_token;
              if (window.EcoTrackHardwareCloud) {
                const status = window.EcoTrackHardwareCloud.describe(n.cloud_state);
                n.status = status === 'online' ? 'Connected' : status === 'sleeping' ? 'Sleeping' : 'Offline';
              }
              if (n.room_name && n.room_name !== 'Unassigned' && n.name && n.name.includes('(Unassigned)')) {
                n.name = `${n.node_id || n.name.split(' ')[0]} (${n.room_name})`;
                modified = true;
              }
            });
            if (modified) {
              try { localStorage.setItem('ecoTrack_nodes', JSON.stringify(parsed)); } catch (_) {}
            }
            const pending = new Set(window.EcoTrackHardwareCloud?.pendingRegistrations?.() || []);
            let profiles = [];
            try { profiles = JSON.parse(localStorage.getItem('ecoTrack_aircons') || '[]'); } catch (_) {}
            return parsed.filter(node => !pending.has(node.db_id) || profiles.some(ac => ac.controller_node_id === node.db_id || ac.node_id === node.db_id));
          }
        }
        return DEFAULT_NODES;
      } catch (_) {
        return DEFAULT_NODES;
      }
    }

    static async updateNodeLocation(node_id, { building_id, building_name, floor_id, floor_name, room_id, room_name }) {
      return this.editDevice(node_id, { building_id, building: building_name, floor_id, floor: floor_name,
        room_id, room_name, location: `${room_name} (${building_name || 'Unassigned'} • ${floor_name || 'Unassigned'})` });
    }

    static async editDevice(node_id, updatedData) {
      const sb = window.supabaseClient || window.sb;
      if (!sb?.from) throw new Error('Connect to Supabase before editing this controller.');
      const current = this.getNode(node_id);
      if (!current) throw new Error('Registered controller not found.');
      let databaseId = current.db_id;
      if (!databaseId) {
        const lookup = await sb.from('nodes').select('id').eq('name', current.node_id).maybeSingle();
        if (lookup.error || !lookup.data?.id) throw new Error(lookup.error?.message || 'Controller not found in Supabase.');
        databaseId = lookup.data.id;
      }
      // A custom AC name and controller metadata are saved in one transaction on upgraded databases.
      if(updatedData.aircon_name!==undefined && sb.rpc){
        const linked=AirconProfileManager.getAll().filter(ac=>ac.controller_node_id===databaseId || ac.node_id===current.node_id);
        const changes={name:updatedData.name ?? current.name,room_id:updatedData.room_id!==undefined?updatedData.room_id:current.room_id ?? null,
          brand:updatedData.brand!==undefined?updatedData.brand:current.brand ?? null,aircon_type:updatedData.aircon_type ?? current.aircon_type,
          protocol_name:updatedData.protocol_name ?? linked[0]?.protocol_name ?? linked[0]?.protocol ?? current.protocol_name ?? 'UNKNOWN',aircon_name:updatedData.aircon_name};
        const response=await sb.rpc('ecotrack_admin_edit_controller',{p_node_id:databaseId,p_changes:changes});
        if(response.error && !(response.error.code==='PGRST202' && linked.every(ac=>!updatedData.aircon_name || ac.name===updatedData.aircon_name)))
          throw new Error(response.error.code==='PGRST202'?'Install supabase_aircon_names_migration.sql to save a custom AC name.':response.error.message);
        if(!response.error){
          const result=response.data;
          if(result?.success!==true || result.node?.id!==databaseId || !Array.isArray(result.aircons))throw new Error('Controller changes were not confirmed by Supabase.');
          const merged={...current,...updatedData,...result.node,node_id:current.node_id,db_id:databaseId,status:current.status,
            last_seen:current.last_seen,cloud_state:current.cloud_state,capabilities:current.capabilities};
          delete merged.aircon_name;
          const profiles=AirconProfileManager.getAll().map(ac=>{
            const row=result.aircons.find(row=>row.id===ac.aircon_id || row.asset_tag===ac.device_id);
            if(!row)return ac;
            const updated={...ac,name:row.name || row.asset_tag,brand:row.brand,model:row.model,aircon_type:row.aircon_type,
              room_id:row.room_id,room_name:updatedData.room_name || ac.room_name,location:updatedData.location || ac.location,
              protocol_name:row.protocol_name,protocol:row.protocol_name,configured_protocol:row.protocol_name};
            updated.capabilities=CapabilityEngine.getCapabilities(updated);return updated;
          });
          const nodes=this.getDevices().map(n=>n.db_id===databaseId || n.node_id===current.node_id?merged:n);
          localStorage.setItem('ecoTrack_nodes',JSON.stringify(nodes));localStorage.setItem('ecoTrack_aircons',JSON.stringify(profiles));
          AirconEvents.emit('node:updated',merged);AirconEvents.emit('aircon:updated',profiles);AirconEvents.emit('devices:synced',{nodes,aircons:profiles});
          window.EcoDataBus?.invalidate('nodes');window.EcoDataBus?.invalidate('aircons');window.EcoDataBus?.invalidate('scheduler:data');
          return merged;
        }
      }
      const payload = { updated: new Date().toISOString() };
      for (const field of ['name', 'room_id', 'brand', 'aircon_type', 'protocol_name']) {
        if (updatedData[field] !== undefined) payload[field] = updatedData[field];
      }
      const { data, error } = await sb.from('nodes').update(payload).eq('id', databaseId).select('*').single();
      if (error || data?.id !== databaseId || Object.entries(payload).some(([field,value]) => field !== 'updated' && data[field] !== value)) throw new Error(error?.message || 'Controller changes were not confirmed in Supabase.');
      const linked = AirconProfileManager.getAll().filter(ac => ac.controller_node_id === databaseId || ac.node_id === current.node_id);
      for (const ac of linked) {
        await AirconProfileManager.save({ ...ac, controller_node_id: databaseId,
          room_id: data.room_id ?? null, room_name: updatedData.room_name || ac.room_name,
          location: updatedData.location || ac.location, name: updatedData.aircon_name?.trim() || ac.name,
          brand: updatedData.brand === null ? 'Unspecified' : updatedData.brand || ac.brand, model: updatedData.aircon_type || ac.model,
          aircon_type: updatedData.aircon_type || ac.aircon_type,
          protocol: updatedData.protocol_name || ac.protocol_name, protocol_name: updatedData.protocol_name || ac.protocol_name });
      }
      const merged = { ...current, ...updatedData, db_id: databaseId, node_id: current.node_id,
        room_id: data.room_id ?? null, admin_verified_at:data.admin_verified_at || current.admin_verified_at || null,
        deployment_saved_at:data.deployment_saved_at || current.deployment_saved_at || null, last_seen: current.cloud_state?.last_seen || current.last_seen || null,
        status: current.status, capabilities: current.capabilities, cloud_state: current.cloud_state };
      delete merged.wifi_password; delete merged.password; delete merged.device_token;
      const devices = this.getDevices().map(node => node.node_id === current.node_id || node.db_id === databaseId ? merged : node);
      localStorage.setItem('ecoTrack_nodes', JSON.stringify(devices));
      window.EcoDataBus?.invalidate('nodes'); window.EcoDataBus?.invalidate('scheduler:data');
      AirconEvents.emit('node:updated', merged);
      AirconEvents.emit('devices:synced', { nodes: devices, aircons: AirconProfileManager.getAll() });
      return merged;
    }

    static async saveRemoteProfile(nodeId, profile) {
      const sb = window.supabaseClient || window.sb;
      if (!sb || typeof sb.rpc !== 'function') throw new Error('Sign in and connect to Supabase to save the AC profile.');
      const current = this.getNode(nodeId);
      if (!current) throw new Error('Controller unavailable. Refresh the device list and retry.');
      let databaseId = current.db_id;
      if (!databaseId) {
        const lookup = await sb.from('nodes').select('id').eq('name', nodeId).maybeSingle();
        if (lookup.error || !lookup.data?.id) throw new Error('The registered controller could not be confirmed in Supabase.');
        databaseId = lookup.data.id;
      }
      const payload = { brand: profile.brand.trim(), aircon_type: profile.aircon_type, protocol_name: profile.protocol_name };
      if (!payload.brand || !payload.protocol_name) throw new Error('Choose an AC brand and IR protocol before saving.');
      const { data, error } = await sb.rpc('ecotrack_device_mutation', {
        p_operation: 'update_node', p_id: databaseId, p_payload: payload
      });
      if (error || data?.node?.id !== databaseId || data.node.brand !== payload.brand ||
          data.node.aircon_type !== payload.aircon_type || data.node.protocol_name !== payload.protocol_name) {
        throw new Error(error?.message || 'The AC profile save was not confirmed.');
      }
      const savedProfile = { db_id: databaseId, brand: data.node.brand,
        aircon_type: data.node.aircon_type, protocol_name: data.node.protocol_name };
      const devices = this.getDevices().map(device => device.node_id === current.node_id || device.db_id === databaseId
        ? { ...device, ...savedProfile } : device);
      const saved = devices.find(device => device.db_id === databaseId) || { ...current, ...savedProfile };
      const linked = AirconProfileManager.getAll().filter(ac =>
        ac.node_id === current.node_id || ac.node_id === databaseId || ac.controller_node_id === databaseId);
      const profiles = linked.length ? linked : [{ device_id: `AC-${current.node_id}`, node_id: current.node_id,
        controller_node_id: databaseId, room_id: current.room_id || null, name: current.name || current.node_id }];
      for (const ac of profiles) {
        await AirconProfileManager.save({ ...ac, brand: saved.brand, model: saved.aircon_type, aircon_type: saved.aircon_type,
          protocol: saved.protocol_name, protocol_name: saved.protocol_name, capabilities: CapabilityEngine.getCapabilities(saved.protocol_name) });
      }
      localStorage.setItem('ecoTrack_nodes', JSON.stringify(devices));
      AirconEvents.emit('node:updated', saved);
      AirconEvents.emit('devices:synced', { nodes: devices, aircons: AirconProfileManager.getAll() });
      window.EcoDataBus?.invalidate('nodes');
      window.EcoDataBus?.invalidate('scheduler:data');
      return saved;
    }

    static editNode(node_id, updatedData) { return this.editDevice(node_id, updatedData); }

    static async deleteDevice(node_id, options = {}) {
      const sb = window.supabaseClient || window.sb;
      if (!sb?.from) throw new Error('Connect to Supabase before removing this controller.');
      const target = this.getNode(node_id) || { node_id, name: node_id };
      if (!target?.node_id && !target?.db_id) throw new Error('Registered controller not found.');
      let lookup = null;
      if (target.db_id) {
        lookup = await sb.from('nodes').select('id,name').eq('id', target.db_id).maybeSingle();
      }
      if (!lookup?.data) {
        lookup = await sb.from('nodes').select('id,name').eq('name', target.node_id).maybeSingle();
      }
      if (!lookup?.data) {
        lookup = await sb.from('nodes').select('id,name').eq('id', target.node_id).maybeSingle();
      }
      if (lookup?.error || !lookup?.data?.id) throw new Error(lookup?.error?.message || 'Controller not found in Supabase.');
      const id = lookup.data.id;
      const linked = await sb.from('aircons').select('id,asset_tag,node_id,controller_node_id')
        .or(`node_id.eq.${id},controller_node_id.eq.${id},node_id.eq.${lookup.data.name}`);
      if (linked.error) throw linked.error;
      const linkedAircons = (linked.data || []).filter(ac => [id, lookup.data.name].includes(ac.node_id) || ac.controller_node_id === id);
      if (linkedAircons.length > 0 && !options.unassignLinked && !options.force)
        throw new Error('This controller is assigned to an AC profile. Unassign it in Aircon Control configuration before removing the controller.');
      // Adopt old local mirrors before an auto-created AC or its node is removed.
      if (window.electron?.invoke) {
        try { await window.electron.invoke('monitoring-sync-registry'); } catch (_) {}
      }
      if (linkedAircons.length > 0) {
        for (const ac of linkedAircons) {
          const isAuto = isAutoGeneratedTag(ac.asset_tag, target.node_id) || isAutoGeneratedTag(ac.asset_tag, id);
          if (isAuto || options.deleteAutoGenerated) {
            await sb.from('aircons').delete().eq('id', ac.id);
          } else {
            await sb.from('aircons').update({ node_id: null, controller_node_id: null, status: 'offline' }).eq('id', ac.id);
          }
        }
      }
      const removed = await sb.from('nodes').delete().eq('id', id);
      if (removed.error) throw removed.error;
      const confirmation = await sb.from('nodes').select('id').eq('id', id).maybeSingle();
      if (confirmation.error || confirmation.data) throw new Error(confirmation.error?.message || 'Supabase did not confirm controller removal.');
      if (window.electron?.invoke) {
        try {
          const mirror = await window.electron.invoke('monitoring-sync-registry');
          if (!mirror?.success) window.EcoToast?.show('Device removed. Refresh local monitoring when the backend reconnects.', 'warning');
        } catch (_) { window.EcoToast?.show('Device removed. Refresh local monitoring when the backend reconnects.', 'warning'); }
      }
      const devices = this.getDevices().filter(node => node.db_id !== id && node.node_id !== target.node_id && node.node_id !== node_id);
      localStorage.setItem('ecoTrack_nodes', JSON.stringify(devices));

      if (linkedAircons.length > 0) {
        const remainingAircons = AirconProfileManager.getAll().filter(ac => {
          const matched = linkedAircons.find(l => l.id === ac.aircon_id || l.asset_tag === ac.device_id || l.id === ac.id);
          if (!matched) return true;
          const isAuto = isAutoGeneratedTag(ac.device_id, target.node_id) || isAutoGeneratedTag(ac.device_id, id);
          if (isAuto || options.deleteAutoGenerated) return false;
          ac.node_id = null;
          ac.controller_node_id = null;
          ac.status = 'offline';
          return true;
        });
        localStorage.setItem('ecoTrack_aircons', JSON.stringify(remainingAircons));
        AirconEvents.emit('aircons:synced', remainingAircons);
      }

      window.EcoDataBus?.invalidate('nodes');
      window.EcoDataBus?.invalidate('aircons');
      window.EcoDataBus?.invalidate('scheduler:data');
      AirconEvents.emit('node:deleted', { node_id: target.node_id, target });
      AirconEvents.emit('devices:synced', { nodes: devices, aircons: AirconProfileManager.getAll() });
      return true;
    }

    static deleteNode(node_id) { return this.deleteDevice(node_id); }

    static getNodes() { return this.getDevices(); }

    static getDevice(device_node_id) {
      const devices = this.getDevices();
      return devices.find(n => n.node_id === device_node_id || n.db_id === device_node_id || n.name === device_node_id) || null;
    }

    static getNode(node_id) { return this.getDevice(node_id); }

    static isDeviceOnline(device_node_id) {
      const dev = this.getDevice(device_node_id);
      return dev ? (dev.status.toLowerCase() === 'connected' || dev.status.toLowerCase() === 'online') : false;
    }

    static isNodeOnline(node_id) { return this.isDeviceOnline(node_id); }

    static updateDevicePingStatus(node_id, probeResult = {}) {
      const isOnline = probeResult?.success === true;
      const status = isOnline ? 'Connected' : (probeResult?.sleeping ? 'Sleeping' : 'Offline');
      const nowIso = new Date().toISOString();
      const current = this.getNode(node_id);
      if (!current) return null;

      const devices = this.getDevices();
      const idx = devices.findIndex(n => n.node_id === current.node_id || n.db_id === current.db_id || n.name === current.node_id);
      if (idx >= 0) {
        const target = devices[idx];
        target.status = status;
        if (isOnline) {
          target.last_seen = nowIso;
          if (!target.cloud_state) target.cloud_state = {};
          target.cloud_state.last_seen = nowIso;
          target.cloud_state.connection_status = 'online';
          if (Number.isFinite(probeResult.rssi)) {
            target.rssi = probeResult.rssi;
            target.cloud_state.rssi = probeResult.rssi;
          }
          if (probeResult.ip_address) {
            target.ip_address = probeResult.ip_address;
            target.cloud_state.ip_address = probeResult.ip_address;
          }
          if (probeResult.firmware_version) {
            target.firmware = probeResult.firmware_version;
            target.cloud_state.firmware_version = probeResult.firmware_version;
          }
        } else {
          if (target.cloud_state) {
            target.cloud_state.connection_status = probeResult?.sleeping ? 'sleeping' : 'offline';
          }
        }
        devices[idx] = target;
        try { localStorage.setItem('ecoTrack_nodes', JSON.stringify(devices)); } catch (_) {}
      }

      // Propagate online/offline status to bound aircons
      const aircons = AirconProfileManager.getAll();
      let airconsModified = false;
      aircons.forEach(ac => {
        if (ac.node_id === current.node_id || (current.db_id && ac.controller_node_id === current.db_id)) {
          ac.status = isOnline ? 'online' : (probeResult?.sleeping ? 'sleeping' : 'offline');
          airconsModified = true;
        }
      });
      if (airconsModified) {
        try { localStorage.setItem('ecoTrack_aircons', JSON.stringify(aircons)); } catch (_) {}
        AirconEvents.emit('aircons:synced', aircons);
      }

      // Async update in Supabase if client is ready
      try {
        const sb = typeof window !== 'undefined' && (window.supabaseClient || window.sb);
        if (sb && typeof sb.from === 'function') {
          const dbId = current.db_id;
          const updatePayload = {
            status: isOnline ? 'online' : 'offline',
            updated: nowIso
          };
          if (isOnline) {
            if (Number.isFinite(probeResult?.rssi)) updatePayload.rssi = probeResult.rssi;
            if (probeResult?.ip_address) updatePayload.ip_address = probeResult.ip_address;
          }
          if (dbId) {
            sb.from('nodes').update(updatePayload).eq('id', dbId).then(() => {}).catch(() => {});
            sb.from('ecotrack_device_state').update({
              last_seen: nowIso,
              rssi: Number.isFinite(probeResult?.rssi) ? probeResult.rssi : null
            }).eq('node_id', dbId).then(() => {}).catch(() => {});
          } else {
            sb.from('nodes').update(updatePayload).eq('name', current.node_id).then(() => {}).catch(() => {});
          }
        }
      } catch (_) {}

      window.EcoDataBus?.invalidate('nodes');
      window.EcoDataBus?.invalidate('scheduler:data');
      AirconEvents.emit('node:status', { node_id: current.node_id, status, probeResult });
      AirconEvents.emit('devices:synced', { nodes: devices, aircons });
      return devices[idx] || current;
    }

    static updateNodePingStatus(node_id, probeResult) { return this.updateDevicePingStatus(node_id, probeResult); }

    static async saveDevice(deviceData) {
      const sb = typeof window !== 'undefined' && (window.supabaseClient || window.sb);
      if (deviceData.cloud_registered && !sb?.from) throw new Error('Supabase is required to connect an AC profile.');
      let effectiveRoomId = deviceData.room_id || null;

      const safeDeviceData = { ...deviceData };
      delete safeDeviceData.wifi_password; delete safeDeviceData.device_token; delete safeDeviceData.password;
      const mergedDevice = {
        ...safeDeviceData,
        room_id: effectiveRoomId,
        last_seen: deviceData.cloud_state?.last_seen || deviceData.last_seen || null
      };

      // Persist to Supabase nodes table
      if (!deviceData.cloud_registered && sb && typeof sb.from === 'function') {
        try {
          const upsertPayload = {
            id: deviceData.db_id || ('node_' + (deviceData.node_id || '').toLowerCase().replace(/[^a-z0-9]/g, '_')),
            name: deviceData.node_id || deviceData.name,
            status: (deviceData.status || 'Connected').toLowerCase() === 'connected' ? 'online' : 'offline',
            rssi: deviceData.rssi ?? null,
            aircon_type: deviceData.aircon_type || 'Split Type (Inverter)',
            room_id: effectiveRoomId,
            ip_address: deviceData.ip_address || null,
            wifi_ssid: deviceData.wifi_ssid || null,
            wake_time: deviceData.wake_time || '06:00',
            sleep_time: deviceData.sleep_time || '22:00',
            interval_val: deviceData.interval_val || 15,
            interval_unit: deviceData.interval_unit || 'Minutes',
            temp: deviceData.temp ?? null,
            updated: new Date().toISOString()
          };
          const saved = await sb.from('nodes').upsert([upsertPayload]);
          if (saved.error) throw saved.error;
        } catch (err) {
          throw new Error(err.message || 'Controller registration failed');
        }
      }

      if (deviceData.registration_assignment) {
        if (!sb?.rpc || !deviceData.cloud_registered) throw new Error('Supabase registration is required.');
        const role=deviceData.registration_assignment.device_mode;
        if (role === 'controller' && this.getNode(deviceData.node_id)?.monitoring_id && window.electron?.invoke) {
          try { await window.electron.invoke('monitoring-sync-registry'); } catch (_) {}
        }
        let query=sb.rpc(role ? 'ecotrack_finish_ac_device_registration' : 'ecotrack_finish_controller_registration', {
          p_node_id:deviceData.db_id,p_device_id:deviceData.node_id,p_setup:deviceData.registration_assignment
        }),timer;
        if(typeof AbortController==='function' && typeof query.abortSignal==='function') {
          const controller=new AbortController();query=query.abortSignal(controller.signal);timer=setTimeout(()=>controller.abort(),25000);
        }
        let response;try {response=await query;} finally {if(timer)clearTimeout(timer);}
        const result=response.data, ac=result?.aircon;
        if (response.error) throw new Error(response.error.message || 'Registration could not be saved.');
        if (result?.success !== true || result.connected !== true || result.node?.id !== deviceData.db_id ||
            (role==='monitoring' ? result.node.device_mode!=='monitoring' || result.node.monitor_aircon_id!==ac?.id : ac?.node_id !== deviceData.db_id || ac?.controller_node_id !== deviceData.db_id) ||
            result.cloud_state?.device_id !== deviceData.node_id)
          throw new Error('The controller and AC relationship was not confirmed.');
        if(role && result.node.device_mode!==role)throw new Error('The requested AC device type was not confirmed.');
        const requestedAcName=deviceData.registration_assignment.aircon_name;
        if(requestedAcName && ac.name!==requestedAcName)throw new Error('Install supabase_aircon_names_migration.sql before saving a custom AC name.');
        Object.assign(mergedDevice, {device_mode:result.node.device_mode || 'controller',monitor_aircon_id:result.node.monitor_aircon_id,monitoring_id:result.node.monitoring_id,sensor_config:result.node.sensor_config,name:result.node.name,brand:result.node.brand,aircon_type:result.node.aircon_type,
          room_id:result.node.room_id,admin_verified_at:result.node.admin_verified_at || null,
          deployment_saved_at:result.node.deployment_saved_at || null,aircon_id:ac.id,cloud_state:result.cloud_state});
        delete mergedDevice.registration_assignment;
        if(role && window.electron?.invoke) {
          try {
            const mirror=await window.electron.invoke('monitoring-sync-registry');
            if(!mirror?.success) window.EcoToast?.show('Device registered. Local monitoring registry needs a refresh.','warning');
          } catch (_) { window.EcoToast?.show('Device registered. Local monitoring registry needs a refresh.','warning'); }
        }
        const aircons=AirconProfileManager.getAll();
        const index=aircons.findIndex(item=>item.aircon_id===ac.id || item.device_id===ac.asset_tag);
        const saved={...(index>=0?aircons[index]:{}),aircon_id:ac.id,device_id:ac.asset_tag,name:ac.name || ac.asset_tag,
          brand:ac.brand,model:ac.model,aircon_type:ac.aircon_type,room_id:ac.room_id,node_id:role==='monitoring' ? ac.node_id : deviceData.node_id,
          controller_node_id:ac.controller_node_id,protocol_name:ac.protocol_name||ac.protocol,
          reported_state:ac.reported_state,reported_at:ac.reported_at,
          state:index>=0?aircons[index].state:{power:null,temperature:null,mode:null,fan:null}};
        if(index>=0)aircons[index]=saved;else aircons.push(saved);
        localStorage.setItem('ecoTrack_aircons',JSON.stringify(deduplicateAirconList(aircons)));
        AirconEvents.emit('aircon:saved',saved);
        AirconEvents.emit('aircons:synced',aircons);
      }

      // Legacy callers retain their existing save path.
      if (deviceData.cloud_registered && !deviceData.registration_assignment) {
        const nodePayload = {name:deviceData.name || deviceData.node_id, room_id:effectiveRoomId,
          brand:deviceData.brand && deviceData.brand !== 'Unassigned Brand' ? deviceData.brand : null,
          aircon_type:deviceData.aircon_type || null, protocol_name:deviceData.protocol_name || null, updated:new Date().toISOString()};
        const committed = await sb.from('nodes').update(nodePayload).eq('id',deviceData.db_id).select('*').single();
        if (committed.error || committed.data?.id !== deviceData.db_id || Object.entries(nodePayload).some(([field,value]) => field !== 'updated' && committed.data[field] !== value))
          throw new Error(committed.error?.message || 'Controller metadata was not confirmed in Supabase.');
        let existing = deviceData.aircon_id ? AirconProfileManager.getById(deviceData.aircon_id) :
          AirconProfileManager.getAll().find(ac => ac.controller_node_id === deviceData.db_id || ac.node_id === deviceData.node_id);
        if (deviceData.aircon_id) {
          const selected = await sb.from('aircons').select('*').eq('id', deviceData.aircon_id).maybeSingle();
          if (selected.error || !selected.data?.id) throw new Error(selected.error?.message || 'The selected AC profile is no longer available.');
          if ([selected.data.node_id, selected.data.controller_node_id].some(id => id && id !== deviceData.db_id)) throw new Error('The selected AC already has a controller. Unassign it first.');
          existing = { ...existing, aircon_id: selected.data.id, device_id: selected.data.asset_tag,
            brand: selected.data.brand, model: selected.data.model, aircon_type: selected.data.aircon_type,
            protocol_name: selected.data.protocol_name || selected.data.protocol };
        }
        await AirconProfileManager.save({ ...existing,
          device_id: existing?.device_id || `AC-${deviceData.node_id}`,
          name: existing?.name || deviceData.name || deviceData.node_id,
          node_id: deviceData.node_id, controller_node_id: deviceData.db_id,
          room_id: effectiveRoomId, room_name: deviceData.room_name,
          brand: deviceData.brand && deviceData.brand !== 'Unassigned Brand' ? deviceData.brand : existing?.brand || 'Unspecified',
          model: deviceData.aircon_type || 'Unspecified', aircon_type: deviceData.aircon_type || 'Unspecified',
          protocol_name: deviceData.protocol_name ||
            (!deviceData.brand || deviceData.brand === 'Unassigned Brand' || deviceData.brand === existing?.brand ? existing?.protocol_name : null) ||
            CapabilityEngine.resolveProtocolName(deviceData.brand || existing?.brand),
          state: existing?.state || { power: null, temperature: null, mode: null, fan: null }
        });
      }
      const devices = this.getDevices();
      const idx = devices.findIndex(n => n.node_id === deviceData.node_id || n.name === deviceData.node_id);
      if (idx >= 0) {
        devices[idx] = { ...devices[idx], ...mergedDevice };
      } else {
        devices.push(mergedDevice);
      }
      localStorage.setItem('ecoTrack_nodes', JSON.stringify(devices));
      AirconEvents.emit('node:updated', mergedDevice);
      AirconEvents.emit('device:updated', mergedDevice);
      AirconEvents.emit('devices:synced', devices);

      // Invalidate cache for immediate refresh
      if (typeof window !== 'undefined' && window.EcoDataBus) {
        window.EcoDataBus.invalidate('scheduler:data');
        window.EcoDataBus.invalidate('nodes');
        window.EcoDataBus.invalidate('rooms');
      }

      // Cross-tab broadcast for instant scheduler updates
      try {
        if (typeof window !== 'undefined' && window.BroadcastChannel) {
          const bc = new BroadcastChannel('ecotrack_aircon_channel');
          bc.postMessage({ event: 'scheduler:refresh', sender: 'aircon_system', room_id: effectiveRoomId });
        }
      } catch (_) {}

      return mergedDevice;
    }

    static async reconnectNode(node_id) {
      await window.EcoTrackHardwareCloud.ping(node_id);
      const cloud = await window.EcoTrackHardwareCloud.getStatus(node_id);
      const devices = this.getDevices();
      const target = devices.find(item => item.node_id === node_id || item.db_id === cloud.node_id);
      if (!target) throw new Error('Registered controller not found. Refresh the device list.');
      Object.assign(target, { status: 'Connected', cloud_state: cloud, last_seen: cloud.last_seen, rssi: cloud.rssi,
        ip_address: cloud.ip_address, wifi_ssid: cloud.wifi_ssid, capabilities: cloud.capabilities });
      localStorage.setItem('ecoTrack_nodes', JSON.stringify(devices));
      AirconEvents.emit('node:updated', target); AirconEvents.emit('devices:synced', devices);
      return target;
    }

    static reconnectDevice(id) { return this.reconnectNode(id); }
    static setNodeOnline(id) { return this.reconnectNode(id); }

    static saveNode(nodeData) { return this.saveDevice(nodeData); }
  }
  const NodeService = ACControllerDeviceService;

  // ===== AIRCON PROFILE MANAGER =====
  class AirconProfileManager {
    static normalizeNodeId(nodeId) { return normalizeAirconNodeId(nodeId); }
    static deduplicateAircons(list) { return deduplicateAirconList(list); }

    static getAll() {
      try {
        const raw = localStorage.getItem('ecoTrack_aircons');
        if (raw) {
          const list = JSON.parse(raw);
          if (Array.isArray(list) && list.length > 0) {
            // Purge stale mock aircons (Living Room, Master Bedroom, etc.)
            const isStale = list.some(a => a && a.name && (a.name.includes('Living Room') || a.name.includes('Master Bedroom')));
            if (isStale) {
              localStorage.removeItem('ecoTrack_aircons');
              return DEFAULT_AIRCONS;
            }

            let modified = false;

            // Automatically deduplicate any multiple instances of the same node / device ID
            const deduped = deduplicateAirconList(list);
            if (deduped.length !== list.length || modified) {
              try { localStorage.setItem('ecoTrack_aircons', JSON.stringify(deduped)); } catch (_) {}
            }
            if (window.EcoTrackHardwareCloud) {
              deduped.forEach(ac => {
                const controller = NodeService.getNode(ac.controller_node_id) || NodeService.getNode(ac.node_id);
                ac.status = controller?.status === 'Sleeping' ? 'sleeping' : controller && NodeService.isNodeOnline(controller.node_id) ? 'online' : 'offline';
              });
            }
            return deduped;
          }
        }
        return DEFAULT_AIRCONS;
      } catch (_) {
        return DEFAULT_AIRCONS;
      }
    }

    static getById(device_id) {
      if (!device_id) return null;
      const aircons = this.getAll();
      const devIdLower = String(device_id).toLowerCase().trim();
      return aircons.find(a => 
        a.device_id.toLowerCase() === devIdLower ||
        a.aircon_id?.toLowerCase() === devIdLower || a.controller_node_id?.toLowerCase() === devIdLower ||
        (a.node_id && a.node_id.toLowerCase() === devIdLower) ||
        normalizeAirconNodeId(a.node_id) === normalizeAirconNodeId(device_id)
      ) || null;
    }

    static async save(input) {
      const sb = window.supabaseClient || window.sb;
      const aircon = { ...input };
      if (!aircon.device_id) throw new Error('An AC asset identifier is required.');
      aircon.protocol_name = aircon.protocol_name || aircon.protocol || CapabilityEngine.resolveProtocolName(aircon);
      aircon.protocol = aircon.protocol_name;

      if (!sb?.from) throw new Error('Supabase is not ready. The AC profile has not been saved.');
      const identity = aircon.controller_node_id || aircon.node_id;
      let registeredNode = null;
      if (identity) {
        const local = NodeService.getNode(identity);
        let result = await sb.from('nodes').select('id,name,room_id').eq('id', local?.db_id || identity).maybeSingle();
        if (result.error) throw result.error;
        if (!result.data) result = await sb.from('nodes').select('id,name,room_id').eq('name', identity).maybeSingle();
        if (result.error) throw result.error;
        if (!result.data?.id) throw new Error('The assigned controller was not found in Supabase. Register it before saving this profile.');
        registeredNode = result.data;
      }
      if (registeredNode) {
        const owners = await sb.from('aircons').select('id,asset_tag,node_id,controller_node_id')
          .or(`node_id.eq.${registeredNode.id},controller_node_id.eq.${registeredNode.id}`);
        if (owners.error) throw owners.error;
        if ((owners.data || []).some(owner => owner.asset_tag !== aircon.device_id && [owner.node_id, owner.controller_node_id].includes(registeredNode.id))) throw new Error('This controller is already assigned to another AC. Edit the existing profile instead.');
      }
      const payload = {
        asset_tag: aircon.device_id, brand: aircon.brand || 'Unspecified',
        model: aircon.model || aircon.aircon_type || 'Unspecified',
        aircon_type: aircon.aircon_type || aircon.model || 'Unspecified',
        node_id: registeredNode?.id || null, controller_node_id: registeredNode?.id || null,
        room_id: aircon.room_id ?? registeredNode?.room_id ?? null,
        protocol: aircon.protocol_name, protocol_name: aircon.protocol_name,
        status: registeredNode && NodeService.isNodeOnline(registeredNode.id) ? 'online' : 'offline',
        updated_at: new Date().toISOString()
      };
      const priorName=this.getById(aircon.device_id)?.name;
      if(aircon.name?.trim() && (!priorName || aircon.name.trim()!==priorName))payload.name=aircon.name.trim();
      const { data, error } = await sb.from('aircons').upsert([payload], { onConflict: 'asset_tag' }).select('*').single();
      if (error) throw new Error(error.message || 'The AC profile could not be saved.');
      if (!data?.id || data.asset_tag !== payload.asset_tag || data.protocol_name !== payload.protocol_name ||
          data.node_id !== payload.node_id || data.controller_node_id !== payload.controller_node_id ||
          data.room_id !== payload.room_id || data.brand !== payload.brand) throw new Error('Supabase did not confirm the AC profile and controller binding.');
      if(payload.name && data.name!==payload.name)throw new Error('The custom AC name was not confirmed by Supabase.');
      const saved = { ...aircon, name:data.name || aircon.name || data.asset_tag, aircon_id: data.id, room_id: data.room_id,
        controller_node_id: data.controller_node_id, node_id: (registeredNode && NodeService.getNode(registeredNode.id)?.node_id) || registeredNode?.name || '',
        brand: aircon.brand || data.brand, protocol: data.protocol_name, protocol_name: data.protocol_name,
        capabilities: { ...CapabilityEngine.getCapabilities({...aircon,protocol_name:data.protocol_name}) }, status: payload.status };
      const aircons = this.getAll();
      const index = aircons.findIndex(a => a.device_id === saved.device_id ||
        (isAutoGeneratedTag(a.device_id, a.node_id) && saved.node_id && normalizeAirconNodeId(a.node_id) === normalizeAirconNodeId(saved.node_id)));
      if (index >= 0) aircons[index] = { ...aircons[index], ...saved };
      else aircons.push(saved);
      const finalAircons = deduplicateAirconList(aircons);
      localStorage.setItem('ecoTrack_aircons', JSON.stringify(finalAircons));
      CentralLogService.log({ device_id: saved.device_id, node_id: saved.node_id, module: 'CONFIG',
        event: index >= 0 ? 'AIRCON_UPDATED' : 'AIRCON_REGISTERED', result: 'SUCCESS',
        details: `${saved.name} (${saved.brand} • Protocol: ${saved.protocol_name})` });
      window.EcoDataBus?.invalidate('scheduler:data');
      window.EcoDataBus?.invalidate('nodes');
      AirconEvents.emit('aircon:saved', saved);
      AirconEvents.emit('aircons:synced', finalAircons);
      AirconEvents.emit('devices:synced', { nodes: NodeService.getNodes(), aircons: finalAircons });
      return saved;
    }

    static async delete(device_id) {
      const target = this.getById(device_id);
      if (!target) return false;
      const sb = window.supabaseClient || window.sb;
      if (!sb?.from) throw new Error('Connect to Supabase before deleting an AC profile.');
      const response = await sb.from('aircons').delete().eq('asset_tag', target.device_id).select('id');
      if (response.error) throw new Error(response.error.message || 'The AC profile was not deleted.');
      const confirmation = await sb.from('aircons').select('id').eq('asset_tag', target.device_id).maybeSingle();
      if (confirmation.error || confirmation.data) throw new Error(confirmation.error?.message || 'Supabase did not confirm deletion.');
      const aircons = this.getAll().filter(ac => ac.device_id !== target.device_id);
      localStorage.setItem('ecoTrack_aircons', JSON.stringify(aircons));
      window.EcoDataBus?.invalidate('scheduler:data'); window.EcoDataBus?.invalidate('nodes');
      AirconEvents.emit('aircon:deleted', target.device_id);
      AirconEvents.emit('devices:synced', { nodes: NodeService.getNodes(), aircons });
      return true;
    }

    static updateState(device_id, stateUpdates, controlSnapshot) {
      const aircons = this.getAll();
      const target = aircons.find(a => a.device_id === device_id);
      if (!target) return null;

      if (controlSnapshot) target.control_snapshot = controlSnapshot;
      target.state = {
        ...target.state,
        ...stateUpdates,
        updated_at: new Date().toISOString()
      };

      localStorage.setItem('ecoTrack_aircons', JSON.stringify(aircons));
      AirconEvents.emit('aircon:state_changed', target);

      return target.state;
    }
  }

  // ===== CAPABILITY ENGINE =====
// Generated registry data is injected by scripts/generate_ac_capabilities.py.
// This resolver never uses a physical manufacturer to infer an encoder.
const AcCapabilityRegistry = (() => {
  const registry = {"schema_version":1,"registry_version":"irremote-2.9.0-1","library_version":"2.9.0","reference":"https://github.com/crankyoldgit/IRremoteESP8266/tree/v2.9.0/src","features":["power","temperature","turbo","quiet","eco","swing_vertical","swing_horizontal","sleep","display","filter","clean","beep","timer","i_feel"],"aliases":{"MIDEA_IR":"MIDEA","MITSUBISHI":"MITSUBISHI_AC","PANASONIC":"PANASONIC_AC","SAMSUNG":"SAMSUNG_AC","CARRIER":"CARRIER_AC64","HAIER":"HAIER_AC","HITACHI":"HITACHI_AC","FUJITSU":"FUJITSU_AC","TOSHIBA":"TOSHIBA_AC","SHARP":"SHARP_AC","WHIRLPOOL":"WHIRLPOOL_AC"},"protocols":{"TCL112AC":{"protocol":"TCL112AC","source":"IRremoteESP8266 2.9.0","confidence":"library","features":{"power":true,"temperature":true,"turbo":true,"quiet":true,"eco":true,"swing_vertical":true,"swing_horizontal":true,"sleep":false,"display":true,"filter":true,"clean":false,"beep":false,"timer":false,"i_feel":false},"temperature":{"min":16,"max":31,"step":0.5,"unit":"C","modes":["auto","cool","heat","dry"]},"modes":["auto","cool","heat","dry","fan"],"fan_map":{"auto":0,"low":2,"medium":3,"high":4,"quiet":1},"fan_decode_aliases":{"1":"quiet","5":"high"},"mode_rules":{"fan":{"temperature_control":false}},"models":{"1":"TAC09CHSD","2":"GZ055BE1"},"model_rules":{},"decode_fields":["power","temp","mode","fan","turbo","eco","display","filter","swing_vertical","swing_horizontal"]},"DAIKIN":{"protocol":"DAIKIN","source":"IRremoteESP8266 2.9.0","confidence":"library","features":{"power":true,"temperature":true,"turbo":true,"quiet":true,"eco":true,"swing_vertical":true,"swing_horizontal":true,"sleep":false,"display":false,"filter":false,"clean":true,"beep":false,"timer":false,"i_feel":false},"temperature":{"min":10,"max":32,"step":0.5,"unit":"C","modes":["auto","cool","heat","dry"]},"modes":["auto","cool","heat","dry","fan"],"fan_map":{"auto":0,"low":2,"medium":3,"high":4,"quiet":1,"max":5},"fan_decode_aliases":{"1":"quiet","5":"max"},"mode_rules":{"fan":{"temperature_control":false}},"models":{},"model_rules":{},"decode_fields":["power","temp","mode","fan","turbo","quiet","eco","clean","swing_vertical","swing_horizontal"]},"DAIKIN2":{"protocol":"DAIKIN2","source":"IRremoteESP8266 2.9.0","confidence":"library","features":{"power":true,"temperature":true,"turbo":true,"quiet":true,"eco":true,"swing_vertical":true,"swing_horizontal":true,"sleep":false,"display":true,"filter":true,"clean":true,"beep":true,"timer":false,"i_feel":false},"temperature":{"min":10,"max":32,"step":1,"unit":"C","modes":["auto","cool","heat","dry"]},"modes":["auto","cool","heat","dry","fan"],"fan_map":{"auto":0,"low":2,"medium":3,"high":4,"quiet":1,"max":5},"fan_decode_aliases":{"1":"quiet","5":"max"},"mode_rules":{"fan":{"temperature_control":false},"cool":{"min":18}},"models":{},"model_rules":{},"decode_fields":["power","temp","mode","fan","turbo","quiet","eco","display","filter","clean","beep","sleep","swing_vertical","swing_horizontal"]},"DAIKIN64":{"protocol":"DAIKIN64","source":"IRremoteESP8266 2.9.0","confidence":"library","features":{"power":true,"temperature":true,"turbo":true,"quiet":true,"eco":false,"swing_vertical":true,"swing_horizontal":false,"sleep":true,"display":false,"filter":false,"clean":false,"beep":false,"timer":false,"i_feel":false},"temperature":{"min":16,"max":30,"step":1,"unit":"C","modes":["cool","heat","dry"]},"modes":["cool","heat","dry","fan"],"fan_map":{"auto":0,"low":2,"medium":3,"high":4,"quiet":1,"max":5},"fan_decode_aliases":{"1":"quiet","5":"max"},"mode_rules":{"fan":{"temperature_control":false}},"models":{},"model_rules":{},"power_toggle":true,"decode_fields":["temp","mode","fan","turbo","quiet","sleep","swing_vertical"]},"DAIKIN216":{"protocol":"DAIKIN216","source":"IRremoteESP8266 2.9.0","confidence":"library","features":{"power":true,"temperature":true,"turbo":true,"quiet":true,"eco":false,"swing_vertical":true,"swing_horizontal":true,"sleep":false,"display":false,"filter":false,"clean":false,"beep":false,"timer":false,"i_feel":false},"temperature":{"min":10,"max":32,"step":1,"unit":"C","modes":["auto","cool","heat","dry"]},"modes":["auto","cool","heat","dry","fan"],"fan_map":{"auto":0,"low":2,"medium":3,"high":4,"quiet":1,"max":5},"fan_decode_aliases":{"1":"quiet","5":"max"},"mode_rules":{"fan":{"temperature_control":false}},"models":{},"model_rules":{},"decode_fields":["power","temp","mode","fan","turbo","quiet","swing_vertical","swing_horizontal"]},"GREE":{"protocol":"GREE","source":"IRremoteESP8266 2.9.0","confidence":"library","features":{"power":true,"temperature":true,"turbo":true,"quiet":false,"eco":true,"swing_vertical":true,"swing_horizontal":true,"sleep":true,"display":true,"filter":false,"clean":true,"beep":false,"timer":false,"i_feel":true},"temperature":{"min":16,"max":30,"step":1,"unit":"C","modes":["auto","cool","heat","dry"]},"modes":["auto","cool","heat","dry","fan"],"fan_map":{"auto":0,"low":1,"medium":3,"high":4},"fan_decode_aliases":{"1":"low","2":"medium","5":"high"},"mode_rules":{"fan":{"temperature_control":false},"auto":{"temperature_control":false,"fixed_temp":25},"dry":{"fixed_fan":"low"}},"models":{"1":"YAW1F","2":"YBOFB","3":"YX1FSF"},"model_rules":{},"decode_fields":["power","temp","mode","fan","turbo","eco","display","clean","sleep","swing_vertical","swing_horizontal","i_feel"]},"MIDEA":{"protocol":"MIDEA","source":"IRremoteESP8266 2.9.0","confidence":"library","features":{"power":true,"temperature":true,"turbo":true,"quiet":true,"eco":true,"swing_vertical":true,"swing_horizontal":false,"sleep":true,"display":true,"filter":false,"clean":true,"beep":false,"timer":false,"i_feel":true},"temperature":{"min":17,"max":30,"step":1,"unit":"C","modes":["auto","cool","heat","dry"]},"modes":["auto","cool","heat","dry","fan"],"fan_map":{"auto":0,"low":2,"medium":3,"high":4},"fan_decode_aliases":{"1":"low","5":"high"},"mode_rules":{"fan":{"temperature_control":false}},"models":{},"model_rules":{},"decode_fields":["power","temp","mode","fan","eco","sleep","swing_vertical"]},"PANASONIC_AC":{"protocol":"PANASONIC_AC","source":"IRremoteESP8266 2.9.0","confidence":"library","features":{"power":true,"temperature":true,"turbo":true,"quiet":true,"eco":false,"swing_vertical":true,"swing_horizontal":true,"sleep":false,"display":false,"filter":true,"clean":false,"beep":false,"timer":false,"i_feel":false},"temperature":{"min":16,"max":30,"step":1,"unit":"C","modes":["auto","cool","heat","dry"]},"modes":["auto","cool","heat","dry","fan"],"fan_map":{"auto":0,"low":2,"medium":3,"high":4,"quiet":1,"max":5},"fan_decode_aliases":{"1":"quiet","5":"max"},"mode_rules":{"fan":{"temperature_control":false}},"models":{"1":"kPanasonicLke","2":"kPanasonicNke","3":"kPanasonicDke","4":"kPanasonicJke","5":"kPanasonicCkp","6":"kPanasonicRkr"},"model_rules":{},"decode_fields":["power","temp","mode","fan","turbo","quiet","filter","swing_vertical","swing_horizontal"]},"SAMSUNG_AC":{"protocol":"SAMSUNG_AC","source":"IRremoteESP8266 2.9.0","confidence":"library","features":{"power":true,"temperature":true,"turbo":true,"quiet":true,"eco":true,"swing_vertical":true,"swing_horizontal":true,"sleep":false,"display":true,"filter":true,"clean":true,"beep":true,"timer":false,"i_feel":false},"temperature":{"min":16,"max":30,"step":1,"unit":"C","modes":["auto","cool","heat","dry"]},"modes":["auto","cool","heat","dry","fan"],"fan_map":{"auto":0,"low":2,"medium":3,"high":4,"max":5},"fan_decode_aliases":{"1":"low","5":"max"},"mode_rules":{"fan":{"temperature_control":false},"auto":{"fixed_fan":"auto"}},"models":{},"model_rules":{},"notes":["Sleep requires a duration; boolean sleep is not encoded by this profile."],"decode_fields":["power","temp","mode","fan","turbo","quiet","eco","display","filter","clean","beep","sleep","swing_vertical","swing_horizontal"]},"MITSUBISHI_AC":{"protocol":"MITSUBISHI_AC","source":"IRremoteESP8266 2.9.0","confidence":"library","features":{"power":true,"temperature":true,"turbo":false,"quiet":true,"eco":false,"swing_vertical":true,"swing_horizontal":true,"sleep":false,"display":false,"filter":false,"clean":false,"beep":false,"timer":false,"i_feel":false},"temperature":{"min":16,"max":31,"step":0.5,"unit":"C","modes":["auto","cool","heat","dry"]},"modes":["auto","cool","heat","dry","fan"],"fan_map":{"auto":0,"low":2,"medium":3,"high":4,"quiet":1,"max":5},"fan_decode_aliases":{"1":"quiet","5":"max"},"mode_rules":{"fan":{"temperature_control":false}},"models":{},"model_rules":{},"decode_fields":["power","temp","mode","fan","quiet","swing_vertical","swing_horizontal"]},"CARRIER_AC64":{"protocol":"CARRIER_AC64","source":"IRremoteESP8266 2.9.0","confidence":"library","features":{"power":true,"temperature":true,"turbo":false,"quiet":false,"eco":false,"swing_vertical":true,"swing_horizontal":false,"sleep":true,"display":false,"filter":false,"clean":false,"beep":false,"timer":false,"i_feel":false},"temperature":{"min":16,"max":30,"step":1,"unit":"C","modes":["cool","heat"]},"modes":["cool","heat","fan"],"fan_map":{"auto":0,"low":2,"medium":3,"high":4},"fan_decode_aliases":{"1":"low","5":"high"},"mode_rules":{"fan":{"temperature_control":false}},"models":{},"model_rules":{},"decode_fields":["power","temp","mode","fan","sleep","swing_vertical"]},"FUJITSU_AC":{"protocol":"FUJITSU_AC","source":"IRremoteESP8266 2.9.0","confidence":"library","features":{"power":true,"temperature":true,"turbo":false,"quiet":true,"eco":false,"swing_vertical":true,"swing_horizontal":false,"sleep":false,"display":false,"filter":false,"clean":false,"beep":false,"timer":false,"i_feel":false},"temperature":{"min":16,"max":30,"step":1,"unit":"C","modes":["auto","cool","heat","dry"]},"modes":["auto","cool","heat","dry","fan"],"fan_map":{"auto":0,"low":2,"medium":3,"high":4,"quiet":1},"fan_decode_aliases":{"1":"quiet","5":"high"},"mode_rules":{"fan":{"temperature_control":false}},"models":{"1":"ARRAH2E","2":"ARDB1","3":"ARREB1E","4":"ARJW2","5":"ARRY4","6":"ARREW4E"},"model_rules":{"1":{"temperature":{"step":0.25},"features":{"turbo":false,"eco":false,"swing_horizontal":true},"full_state_min_bits":128},"2":{"temperature":{"step":0.25},"features":{"turbo":false,"eco":false,"swing_horizontal":false},"full_state_min_bits":120},"3":{"temperature":{"step":0.25},"features":{"turbo":true,"eco":true,"swing_horizontal":false},"full_state_min_bits":128},"4":{"temperature":{"step":0.25},"features":{"turbo":false,"eco":false,"swing_horizontal":true},"full_state_min_bits":120},"5":{"temperature":{"step":0.25},"features":{"turbo":false,"eco":false,"swing_horizontal":true},"full_state_min_bits":128},"6":{"temperature":{"step":0.5},"features":{"turbo":false,"eco":false,"swing_horizontal":true},"full_state_min_bits":128}},"requires_model":true,"full_state_min_bits":128,"decode_fields":["power","temp","mode","fan","turbo","quiet","eco","filter","clean","swing_vertical","swing_horizontal"]},"HAIER_AC":{"protocol":"HAIER_AC","source":"IRremoteESP8266 2.9.0","confidence":"library","features":{"power":true,"temperature":true,"turbo":false,"quiet":false,"eco":false,"swing_vertical":true,"swing_horizontal":false,"sleep":true,"display":false,"filter":true,"clean":false,"beep":false,"timer":false,"i_feel":false},"temperature":{"min":16,"max":30,"step":1,"unit":"C","modes":["auto","cool","heat","dry"]},"modes":["auto","cool","heat","dry","fan"],"fan_map":{"auto":0,"low":2,"medium":3,"high":4},"fan_decode_aliases":{"1":"low","5":"high"},"mode_rules":{"fan":{"temperature_control":false}},"models":{},"model_rules":{},"decode_fields":["temp","mode","fan","filter","sleep","swing_vertical"]},"TOSHIBA_AC":{"protocol":"TOSHIBA_AC","source":"IRremoteESP8266 2.9.0","confidence":"library","features":{"power":true,"temperature":true,"turbo":true,"quiet":false,"eco":true,"swing_vertical":true,"swing_horizontal":false,"sleep":false,"display":false,"filter":true,"clean":false,"beep":false,"timer":false,"i_feel":false},"temperature":{"min":17,"max":30,"step":1,"unit":"C","modes":["auto","cool","heat","dry"]},"modes":["auto","cool","heat","dry","fan"],"fan_map":{"auto":0,"low":2,"medium":3,"high":4,"max":5},"fan_decode_aliases":{"1":"low","5":"max"},"mode_rules":{"fan":{"temperature_control":false}},"models":{"1":"kToshibaGenericRemote_B"},"model_rules":{},"decode_fields":["power","temp","mode","fan","turbo","eco","filter"]},"SHARP_AC":{"protocol":"SHARP_AC","source":"IRremoteESP8266 2.9.0","confidence":"library","features":{"power":true,"temperature":true,"turbo":true,"quiet":false,"eco":false,"swing_vertical":true,"swing_horizontal":false,"sleep":false,"display":true,"filter":true,"clean":true,"beep":false,"timer":false,"i_feel":false},"temperature":{"min":15,"max":30,"step":1,"unit":"C","modes":["cool","heat"]},"modes":["auto","cool","heat","dry"],"fan_map":{"auto":0,"low":2,"medium":3,"high":4,"max":5},"fan_decode_aliases":{"1":"low","5":"max"},"mode_rules":{"fan":{"temperature_control":false},"auto":{"temperature_control":false},"dry":{"temperature_control":false}},"models":{"1":"A907","2":"A705","3":"A903"},"model_rules":{},"decode_fields":["power","temp","mode","fan","turbo","eco","display","filter","clean","swing_vertical"]},"HITACHI_AC":{"protocol":"HITACHI_AC","source":"IRremoteESP8266 2.9.0","confidence":"library","features":{"power":true,"temperature":true,"turbo":false,"quiet":false,"eco":false,"swing_vertical":true,"swing_horizontal":true,"sleep":false,"display":false,"filter":false,"clean":false,"beep":false,"timer":false,"i_feel":false},"temperature":{"min":16,"max":32,"step":1,"unit":"C","modes":["auto","cool","heat","dry"]},"modes":["auto","cool","heat","dry","fan"],"fan_map":{"auto":0,"low":2,"medium":3,"high":4,"max":5},"fan_decode_aliases":{"1":"low","5":"max"},"mode_rules":{"fan":{"temperature_control":false}},"models":{},"model_rules":{},"decode_fields":["power","temp","mode","fan","swing_vertical","swing_horizontal"]},"WHIRLPOOL_AC":{"protocol":"WHIRLPOOL_AC","source":"IRremoteESP8266 2.9.0","confidence":"library","features":{"power":true,"temperature":true,"turbo":true,"quiet":false,"eco":false,"swing_vertical":true,"swing_horizontal":false,"sleep":true,"display":true,"filter":false,"clean":false,"beep":false,"timer":false,"i_feel":false},"temperature":{"min":18,"max":30,"step":1,"unit":"C","modes":["auto","cool","heat","dry"]},"modes":["auto","cool","heat","dry","fan"],"fan_map":{"auto":0,"low":2,"medium":3,"high":4},"fan_decode_aliases":{"1":"low","5":"high"},"mode_rules":{"fan":{"temperature_control":false},"auto":{"temperature_control":false,"fixed_fan":"auto"}},"models":{"1":"DG11J13A","2":"DG11J191"},"model_rules":{"1":{"temperature":{"min":18,"max":32}},"2":{"temperature":{"min":16,"max":30}}},"power_toggle":true,"decode_fields":["power","temp","mode","fan","turbo","display","sleep","swing_vertical"]},"TEKNOPOINT":{"protocol":"TEKNOPOINT","source":"IRremoteESP8266 2.9.0","confidence":"library","features":{"power":true,"temperature":true,"turbo":true,"quiet":true,"eco":true,"swing_vertical":true,"swing_horizontal":true,"sleep":false,"display":true,"filter":true,"clean":false,"beep":false,"timer":false,"i_feel":false},"temperature":{"min":16,"max":31,"step":0.5,"unit":"C","modes":["auto","cool","heat","dry"]},"modes":["auto","cool","heat","dry","fan"],"fan_map":{"auto":0,"low":2,"medium":3,"high":4,"quiet":1},"fan_decode_aliases":{"1":"quiet","5":"high"},"mode_rules":{"fan":{"temperature_control":false}},"models":{"1":"TAC09CHSD","2":"GZ055BE1"},"model_rules":{},"decode_fields":["power","temp","mode","fan","turbo","eco","display","filter","swing_vertical","swing_horizontal"]}},"verified_models":{}};
  const clone = value => JSON.parse(JSON.stringify(value));
  const featureNames = registry.features;
  const object = value => value && typeof value==='object' && !Array.isArray(value);
  function protocol(value) {
    const raw=typeof value==='string'?value:value?.control_snapshot?.observed_remote_protocol || value?.detected_protocol || value?.protocol_name || value?.protocol || '';
    const name=String(raw).trim().toUpperCase();
    return registry.aliases[name] || (registry.protocols[name]?name:'UNKNOWN');
  }
  function model(value) {
    if(!object(value))return null;
    const profile=value.capability_profile;
    if(profile?.protocol===protocol(value)&&profile.model_verified===true&&Number.isInteger(profile.remote_model))return profile.remote_model;
    const found=value.control_snapshot?.observed_remote_model ?? value.detected_remote_model ?? value.remote_model ?? profile?.remote_model;
    return Number.isInteger(found)&&found>0?found:null;
  }
  function merge(base, change) {
    if(!object(change))return base;
    for(const [key,value] of Object.entries(change)){
      if(object(value)&&object(base[key]))merge(base[key],value);else base[key]=clone(value);
    }return base;
  }
  function resolve(value) {
    const name=protocol(value), remoteModel=model(value), definition=registry.protocols[name];
    const empty={protocol:name,protocol_name:name,features:Object.fromEntries(featureNames.map(name=>[name,false])),temperature:null,modes:[],fan_map:{},mode_rules:{},models:{},source:'unknown',confidence:'unknown',unknown:true};
    const profile=definition?clone(definition):empty;
    if(definition&&remoteModel!==null&&profile.model_rules?.[remoteModel])merge(profile,profile.model_rules[remoteModel]);
    const saved=object(value?.capability_profile)?value.capability_profile:{};
    const matching=saved.protocol===name&&(!saved.remote_model || saved.remote_model===remoteModel);
    const verifiedModel=matching&&saved.model_verified===true&&saved.ac_model?.trim();
    if(verifiedModel){
      const exact=registry.verified_models[name+'|'+saved.ac_model+'|'+remoteModel];
      if(exact)merge(profile,exact);
    }
    const encoderFeatures={...profile.features};
    // Receiver reports can narrow unverified support, but cannot invent an encoder.
    const receiver=value?.control_snapshot?.observed_remote_capabilities;
    if(receiver&&protocol(value)===name){
      for(const feature of featureNames)if(receiver[feature]===false)profile.features[feature]=false;
      if(receiver.swing===false)profile.features.swing_vertical=false;
    }
    const statuses={};
    for(const feature of featureNames){
      const encoded=profile.features[feature]===true, manual=matching?saved.features?.[feature]:null;
      const verified=['verified_supported','verified_unsupported'].includes(manual?.status);
      statuses[feature]={status:verified?manual.status:encoded?'library_unverified':'unknown',
        source:verified?'physical_test':encoded?profile.source:'unknown',confidence:verified?'user_confirmed':encoded?'library':'unknown',
        encoded,verified_by:verified?manual.verified_by:null,verified_at:verified?manual.verified_at:null};
      profile.features[feature]=(encoded||verified&&manual.status==='verified_supported'&&encoderFeatures[feature]===true)&&manual?.status!=='verified_unsupported';
    }
    const options={};
    for(const [kind,values] of [['mode',profile.modes],['fan',Object.keys(profile.fan_map)]]){
      options[kind]={};
      for(const option of values){
        const manual=matching?saved.options?.[kind]?.[option]:null;
        options[kind][option]={status:['verified_supported','verified_unsupported'].includes(manual?.status)?manual.status:'library_unverified',
          source:typeof manual?.status==='string'&&manual.status.startsWith('verified_')?'physical_test':profile.source};
      }
    }
    profile.modes=profile.modes.filter(name=>options.mode[name]?.status!=='verified_unsupported');
    for(const name of Object.keys(profile.fan_map))if(options.fan[name]?.status==='verified_unsupported')delete profile.fan_map[name];
    if(matching&&saved.temperature?.status==='verified_supported'&&profile.temperature){
      const t=saved.temperature,b=profile.temperature;
      if([t.min,t.max,t.step].every(Number.isFinite)&&t.min>=b.min&&t.max<=b.max&&t.min<=t.max&&t.step>=b.step&&
        Math.abs(t.step/b.step-Math.round(t.step/b.step))<1e-6&&Math.abs((t.min-b.min)/b.step-Math.round((t.min-b.min)/b.step))<1e-6){
        profile.temperature={...b,min:t.min,max:t.max,step:t.step};
        statuses.temperature={...statuses.temperature,status:'verified_supported',source:'physical_test',confidence:'user_confirmed',verified_at:t.verified_at};
      }
    }
    profile.remote_model=remoteModel;
    profile.model_name=profile.models?.[remoteModel] || null;
    profile.model_source=matching&&saved.model_verified===true?'physical_test':remoteModel!==null?'decoder_or_configuration':'unknown';
    profile.ac_model=matching?saved.ac_model || null:null;
    profile.verification_stale=!!saved.protocol&&!matching;
    profile.feature_status=statuses;profile.option_status=options;profile.registry_version=registry.registry_version;
    profile.can_transmit=!!definition&&(!profile.requires_model || !!profile.models?.[remoteModel]);
    return profile;
  }
  function range(value, mode) {
    const profile=value?.feature_status?value:resolve(value), base=profile.temperature;
    if(!base)return null;
    const rule=profile.mode_rules?.[mode] || {};
    return {...base,min:rule.fixed_temp ?? Math.max(base.min,rule.min ?? base.min),max:rule.fixed_temp ?? Math.min(base.max,rule.max ?? base.max),
      controllable:profile.features.temperature===true&&rule.temperature_control!==false&&(!mode||base.modes.includes(mode)),
      fixed_fan:rule.fixed_fan || null};
  }
  function capabilities(value, mode) {
    const p=resolve(value),currentMode=mode || value?.state?.mode, t=range(p,currentMode);
    return {...p,...p.features,protocol_name:p.protocol,min_temp:t?.min ?? null,max_temp:t?.max ?? null,
      temperature_min:t?.min ?? null,temperature_max:t?.max ?? null,temperature_step:t?.step ?? null,temperature_unit:t?.unit || null,
      temperature_controllable:t?.controllable===true,temperature_modes:p.temperature?.modes || [],
      fans:t?.fixed_fan?Object.keys(p.fan_map).filter(f=>f===t.fixed_fan):Object.keys(p.fan_map),fan_speeds:t?.fixed_fan?Object.keys(p.fan_map).filter(f=>f===t.fixed_fan):Object.keys(p.fan_map),swing:p.features.swing_vertical,
      source:p.source,confidence:p.confidence};
  }
  function validateTemperature(value, requested, mode, retainedSetting=false) {
    const p=resolve(value),t=range(p,mode || value?.state?.mode);
    if(!p.can_transmit||!t||(!retainedSetting&&p.features.temperature!==true))return {valid:false,message:'Choose a supported exact protocol/model before changing temperature.'};
    if(typeof requested!=='number'||!Number.isFinite(requested)||requested<t.min||requested>t.max||
      Math.abs((requested-t.min)/t.step-Math.round((requested-t.min)/t.step))>1e-6)
      return {valid:false,message:'Temperature must be '+t.min+'–'+t.max+'°'+t.unit+' in '+t.step+'° steps.'};
    return {valid:true,value:requested};
  }
  function validateState(value,state) {
    const p=resolve(value),errors=[];
    if(!p.can_transmit)return {valid:false,errors:['Choose a supported exact protocol/model.']};
    if(!['on','off',true,false].includes(state?.power))errors.push('Invalid power.');
    if(!p.modes.includes(state?.mode))errors.push('Unsupported operating mode.');
    if(!Object.hasOwn(p.fan_map,state?.fan || ''))errors.push('Unsupported fan speed.');
    const t=validateTemperature(value,state?.temp ?? state?.temperature,state?.mode,true);if(!t.valid)errors.push(t.message);
    const rule=p.mode_rules[state?.mode] || {};
    if(rule.fixed_fan&&state.fan!==rule.fixed_fan)errors.push(state.mode+' requires '+rule.fixed_fan+' fan.');
    for(const [key,feature] of Object.entries({swing:'swing_vertical',swing_vertical:'swing_vertical',swing_horizontal:'swing_horizontal',turbo:'turbo',quiet:'quiet',eco:'eco',sleep:'sleep',display:'display',filter:'filter',clean:'clean',beep:'beep',i_feel:'i_feel'})){
      if(state[key]===undefined||state[key]===null)continue;
      if(!['on','off',true,false].includes(state[key]))errors.push('Invalid '+key+'.');
      else if(!p.features[feature]&&[true,'on'].includes(state[key]))errors.push(feature+' is unavailable for this protocol/model.');
    }return {valid:!errors.length,errors};
  }
  return {data:registry,protocol,model,resolve,range,capabilities,validateTemperature,validateState};
})();

  class CapabilityEngine {
    static get registry() { return AcCapabilityRegistry; }
    static get BRAND_PROTOCOL_LIMITS() { return Object.fromEntries(Object.keys(AcCapabilityRegistry.data.protocols).map(p=>[p.toLowerCase(),this.getCapabilities(p)])); }
    static resolveProtocolName(value) { return AcCapabilityRegistry.protocol(value); }
    static getCapabilities(value,mode) { return AcCapabilityRegistry.capabilities(value,mode); }
    // App controls use whole-degree targets; protocol/received-state validation stays exact.
    static getControlTemperatureRange(value,mode) {
      const caps=this.getCapabilities(value,mode);
      if(!caps.can_transmit || !caps.temperature_controllable ||
          !Number.isFinite(caps.temperature_min) || !Number.isFinite(caps.temperature_max))return null;
      const values=[];
      for(let temp=Math.ceil(caps.temperature_min);temp<=Math.floor(caps.temperature_max);temp++) {
        if(AcCapabilityRegistry.validateTemperature(value,temp,mode).valid)values.push(temp);
      }
      return values.length ? {min:values[0],max:values[values.length-1],step:1,values} : null;
    }
    static nextControlTemperature(value,current,direction) {
      if(!['number','string'].includes(typeof current) || (typeof current==='string'&&!current.trim()) ||
          !Number.isFinite(Number(current)) || ![1,-1].includes(direction))return null;
      const values=this.getControlTemperatureRange(value)?.values || [];
      return direction===1 ? values.find(temp=>temp>Number(current)) ?? null
        : [...values].reverse().find(temp=>temp<Number(current)) ?? null;
    }
    static validateControlTemperature(value,temp,mode) {
      return typeof temp==='number' && Number.isInteger(temp) &&
        Boolean(this.getControlTemperatureRange(value,mode)?.values.includes(temp));
    }
    static formatTemperature(temp,suffix='') {
      return ['number','string'].includes(typeof temp) && !(typeof temp==='string'&&!temp.trim()) && Number.isFinite(Number(temp))
        ? String(Number(temp))+suffix : '—';
    }
    static isSupported(value,feature,selected=null) {
      const caps=this.getCapabilities(value);
      if(!caps.can_transmit)return false;
      const name=String(feature||'').toLowerCase();
      if(name==='temp'||name==='temperature')return caps.temperature_controllable && (selected===null || AcCapabilityRegistry.validateTemperature(value,selected).valid);
      if(name==='mode')return selected===null?caps.modes.length>0:caps.modes.includes(String(selected).toLowerCase());
      if(name==='fan')return selected===null?caps.fans.length>0:caps.fans.includes(String(selected).toLowerCase()) && (!AcCapabilityRegistry.range(value,value?.state?.mode)?.fixed_fan || selected===AcCapabilityRegistry.range(value,value?.state?.mode).fixed_fan);
      return caps[name==='swing'?'swing_vertical':name]===true;
    }
    static clampTemperature(value,temp) {
      const result=AcCapabilityRegistry.validateTemperature(value,temp);
      if(!result.valid)throw new Error(result.message);
      return temp; // Kept for older callers; invalid values are reported, never silently clamped.
    }
    static getSupportedProtocols() { return Object.keys(AcCapabilityRegistry.data.protocols).map(p=>this.getCapabilities(p)); }
    static async verify(deviceId,profile,revision) {
      const device=AirconProfileManager.getById(deviceId),sb=window.supabaseClient||window.sb;
      if(!device?.aircon_id||!sb)throw new Error('Choose a registered AC first.');
      const response=await sb.rpc('ecotrack_verify_ac_capabilities',{p_aircon_id:device.aircon_id,p_expected_revision:revision||0,p_profile:profile});
      if(response.error)throw new Error(response.error.message);
      const saved=response.data?.aircon;
      if(response.data?.success!==true || saved?.id!==device.aircon_id || !saved.capability_profile)throw new Error('Capability persistence was not confirmed.');
      const updated={...device,capability_profile:saved.capability_profile};
      updated.capabilities=this.getCapabilities(updated);
      const aircons=AirconProfileManager.getAll().map(ac=>ac.aircon_id===saved.id?updated:ac);
      localStorage.setItem('ecoTrack_aircons',JSON.stringify(aircons));
      AirconEvents.emit('aircon:updated',updated);
      AirconEvents.emit('devices:synced',{nodes:NodeService.getNodes(),aircons});
      window.EcoDataBus?.invalidate('aircons');
      return response.data;
    }
  }

  // ===== PROTOCOL ADAPTER & IR SERVICE =====
  class ProtocolAdapter {
    /** Learn an actual remote capture through Supabase, from any network. */
    static decodeRemoteCapture(data) {
      const protocol = String(data.raw_type || data.protocol || '').trim().toUpperCase();
      if (!protocol || (!data.raw_data && !(Number(data.raw_count) >= 3)))
        return {success:false,message:'No valid IR frame was received. Retry while pressing the physical remote.'};
      // A shared IR protocol identifies the encoding, not the unit's maker or custom name.
      return {...data,success:true,brand:null,protocol,ambiguous:true,
        message:'IR protocol ' + protocol + ' captured. The custom aircon name and manufacturer stay unchanged; enter them separately.'};
    }
    static async detectRemoteBrand(nodeId, options = {}) {
      try {
        const data = options.nearby ? await window.EcoTrackHardwareCloud.learnNearby(nodeId, options) : await window.EcoTrackHardwareCloud.learn(nodeId);
        return this.decodeRemoteCapture(data);
      } catch (error) { return {success:false,message:error.message,code:error.code}; }
    }
    static getSupportedProtocols() { return CapabilityEngine.getSupportedProtocols(); }
    static async sniffProtocol(nodeId) {
      try { return await window.EcoTrackHardwareCloud.learn(nodeId); }
      catch (error) { return { success: false, message: error.message, code: error.code, source: 'supabase' }; }
    }
    static async getLatestLearned(nodeId) {
      try { return await window.EcoTrackHardwareCloud.latest(nodeId); }
      catch (error) { return { success: false, message: error.message, code: error.code, source: 'supabase' }; }
    }

    static getCommandsForDevice(device_id) {
      const device = AirconProfileManager.getById(device_id);
      const commands = sharedIrCodes.filter(row => row.aircon_id === device?.aircon_id || row.device_id === device_id);
      try {
        const raw = localStorage.getItem('ecoTrack_ir_commands');
        const legacy = raw ? JSON.parse(raw) : DEFAULT_IR_COMMANDS;
        return [...commands, ...legacy.filter(c => c.device_id === device_id && !commands.some(row => row.command_type === c.command_type))
          .map(row => ({ ...row, local_only: true }))];
      } catch (_) {
        return commands;
      }
    }

    static getStorageStatus() { return { ready: irCodeStorageReady, error: irCodeStorageError?.message || null }; }

    static normalizeCapture(input) {
      const protocol = String(input?.protocol || input?.raw_type || '').trim().toUpperCase();
      const raw = typeof input?.raw_data === 'string' ? input.raw_data.replace(/\s/g, '') : '';
      if (!/^[A-Z][A-Z0-9_]{1,48}$/.test(protocol) || raw.length > 32768 || !/^\d+(,\d+){2,4095}$/.test(raw))
        throw new Error('Supply actual captured IR timings and an exact protocol.');
      const timings = raw.split(',');
      if (timings.some(value => value.length > 7 || Number(value) < 1 || Number(value) > 1000000)) throw new Error('Invalid IR timing duration.');
      const metadata = {};
      for (const field of ['raw_type','sequence','boot_count','hex','frame_kind','state','ac_capabilities','remote_model','captured_at_ms','captured_at_epoch_ms','received_at'])
        if (input[field] !== undefined) metadata[field] = input[field];
      const capture = { ...metadata, protocol, raw_data: raw, raw_count: timings.length };
      if (JSON.stringify(capture).length > 65536) throw new Error('IR capture is too large.');
      return capture;
    }

    static async saveCommand(cmd) {
      const device = AirconProfileManager.getById(cmd?.device_id || cmd?.aircon_id);
      const sb = window.supabaseClient || window.sb;
      if (!device?.aircon_id || !sb?.rpc) throw new Error('Select a registered AC and sign in before saving an IR code.');
      const commandType = String(cmd.command_type || '').trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(commandType)) throw new Error('Enter a valid IR command name.');
      const capture = this.normalizeCapture({ ...(cmd.capture || {}), protocol: cmd.protocol || cmd.capture?.protocol,
        raw_data: cmd.raw_data || cmd.capture?.raw_data });
      const authVersion = databaseAuthVersion;
      const response = await sb.rpc('ecotrack_save_ir_code', { p_aircon_id: device.aircon_id,
        p_command_type: commandType, p_capture: capture, p_source: 'desktop' });
      if (response.error) throw new Error(response.error.message);
      const row = response.data;
      if (!row?.id || row.aircon_id !== device.aircon_id || row.command_type !== commandType ||
          row.protocol !== capture.protocol || row.raw_data !== capture.raw_data) throw new Error('The saved IR code was not confirmed.');
      if (authVersion !== databaseAuthVersion) throw new Error('Your session changed while saving the IR code. Sign in again and refresh.');
      const saved = { ...row, device_id: device.device_id };
      irCodeWriteRevision += 1;
      sharedIrCodes = [...sharedIrCodes.filter(item => item.id !== saved.id && !(item.aircon_id === saved.aircon_id && item.command_type === saved.command_type)), saved];
      irCodeStorageReady = true; irCodeStorageError = null;
      AirconEvents.emit('ir:command_saved', saved);
      AirconEvents.emit('ir:updated', { device_id: device.device_id, action: 'save', command: saved });
      return saved;
    }

    static async deleteCommand(idOrDeviceId, commandType = null) {
      const device = commandType ? AirconProfileManager.getById(idOrDeviceId) : null;
      const target = sharedIrCodes.find(row => commandType ? row.aircon_id === device?.aircon_id && row.command_type === commandType : row.id === idOrDeviceId);
      if (!target) return false;
      const sb = window.supabaseClient || window.sb;
      if (!sb?.rpc) throw new Error('Sign in before deleting an IR code.');
      const authVersion = databaseAuthVersion;
      const response = await sb.rpc('ecotrack_delete_ir_code', { p_aircon_id: target.aircon_id, p_command_type: target.command_type });
      if (response.error) throw new Error(response.error.message);
      if (response.data?.aircon_id !== target.aircon_id || response.data?.deleted !== true || response.data?.id !== target.id)
        throw new Error('The IR code deletion was not confirmed. Refresh before retrying.');
      if (authVersion !== databaseAuthVersion) throw new Error('Your session changed while deleting the IR code. Sign in again and refresh.');
      irCodeWriteRevision += 1;
      sharedIrCodes = sharedIrCodes.filter(row => row.id !== target.id);
      AirconEvents.emit('ir:command_deleted', target);
      AirconEvents.emit('ir:updated', { device_id: target.device_id, action: 'delete', command: target });
      return true;
    }

    static getCustomFunctions(device_id) {
      try {
        const raw = localStorage.getItem(`ecoTrack_custom_funcs_${device_id}`);
        return raw ? JSON.parse(raw) : [];
      } catch (_) {
        return [];
      }
    }

    static addCustomFunction(device_id, funcName) {
      try {
        const cleanName = (funcName || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/_+/g, '_');
        if (!cleanName) return null;
        const funcs = this.getCustomFunctions(device_id);
        if (!funcs.includes(cleanName)) {
          funcs.push(cleanName);
          localStorage.setItem(`ecoTrack_custom_funcs_${device_id}`, JSON.stringify(funcs));
          AirconEvents.emit('ir:function_added', { device_id, function_name: cleanName });
          AirconEvents.emit('ir:updated', { device_id, action: 'add_function', function_name: cleanName });
        }
        return cleanName;
      } catch (err) {
        console.error('Failed to add custom function:', err);
        return null;
      }
    }

    static async deleteFunction(device_id, funcName) {
      try {
        let funcs = this.getCustomFunctions(device_id);
        const wasCustom = funcs.includes(funcName);
        // Keep the local function intact if the shared-code deletion is denied.
        await this.deleteCommand(device_id, funcName);
        if (wasCustom) {
          funcs = funcs.filter(f => f !== funcName);
          localStorage.setItem(`ecoTrack_custom_funcs_${device_id}`, JSON.stringify(funcs));
        }
        AirconEvents.emit('ir:function_deleted', { device_id, function_name: funcName, wasCustom });
        AirconEvents.emit('ir:updated', { device_id, action: 'delete_function', function_name: funcName });
        return true;
      } catch (err) {
        console.error('Failed to delete function:', err);
        return false;
      }
    }

    /**
     * Check command coverage and functions for an aircon
     */
    static getCoverage(device) {
      if (!device) return { items: [], total: 0, mappedCount: 0, percent: 0, protocol: 'midea_ir' };
      const proto = CapabilityEngine.resolveProtocolName(device);
      const caps = CapabilityEngine.getCapabilities(device);

      const knownCmds = this.getCommandsForDevice(device.device_id).map(c => c.command_type);
      const needed = ['POWER_ON', 'POWER_OFF'];
      if (caps && caps.modes) {
        caps.modes.forEach(m => needed.push(`MODE_${m.toUpperCase()}`));
      }
      needed.push('TEMP_UP', 'TEMP_DOWN');
      if (caps && caps.fans) {
        caps.fans.forEach(f => needed.push(`FAN_${f.toUpperCase()}`));
      }
      if (caps && caps.swing) needed.push('SWING');
      if (caps && caps.sleep) needed.push('SLEEP');
      if (caps && caps.turbo) needed.push('TURBO');
      if (caps && caps.eco) needed.push('ECO');

      // Include user-added custom functions for this device
      const customFuncs = this.getCustomFunctions(device.device_id);
      customFuncs.forEach(cf => {
        if (!needed.includes(cf)) needed.push(cf);
      });

      // Include any stored commands that exist in library
      knownCmds.forEach(kc => {
        if (!needed.includes(kc)) needed.push(kc);
      });

      const coverage = needed.map(cmdType => ({
        type: cmdType,
        mapped: knownCmds.includes(cmdType),
        isCustom: customFuncs.includes(cmdType)
      }));

      const mappedCount = coverage.filter(c => c.mapped).length;
      return {
        protocol: proto,
        capabilities: caps,
        items: coverage,
        total: needed.length,
        mappedCount,
        percent: needed.length > 0 ? Math.round((mappedCount / needed.length) * 100) : 0
      };
    }
  }

  // ===== COMMAND MANAGER =====
  const controllerCommandQueues = new Map();
  class CommandManager {
    /**
     * Dispatch an aircon control command via dynamic protocol state generation
     * @param {Object} req
     * @param {string} req.device_id - MANDATORY target device ID
     * @param {'POWER' | 'TEMP' | 'MODE' | 'FAN' | 'SWING' | 'SLEEP' | 'TURBO' | 'ECO'} req.command
     * @param {any} req.value
     * @returns {Promise<{ success: boolean, message: string, state?: Object, code?: string, intent?: Object }>}
     */
    static dispatch(req) {
      const key = req?.device_id || 'UNKNOWN';
      const pending = (controllerCommandQueues.get(key) || Promise.resolve())
        .catch(() => {}).then(() => this.dispatchCommand(req));
      controllerCommandQueues.set(key, pending);
      return pending.finally(() => {
        if (controllerCommandQueues.get(key) === pending) controllerCommandQueues.delete(key);
      });
    }

    static async dispatchCommand(req) {
      const { device_id, command, value } = req;
      const requestId = req.request_id || 'REQ-' + Date.now().toString(36).toUpperCase();

      // 1. Validate Target Device ID
      if (!device_id) {
        const errorMsg = 'Command rejected: Missing target device_id. Commands cannot be broadcast untargeted.';
        CentralLogService.log({
          device_id: 'UNKNOWN',
          module: 'CONTROL',
          event: 'COMMAND_REJECTED',
          result: 'FAILED',
          details: errorMsg
        });
        return { success: false, message: errorMsg };
      }

      // 2. Validate Device Existence
      const device = AirconProfileManager.getById(device_id);
      if (!device) {
        const errorMsg = `Command rejected: Aircon with ID ${device_id} not found in system registry.`;
        CentralLogService.log({
          device_id,
          module: 'CONTROL',
          event: 'COMMAND_FAILED',
          result: 'FAILED',
          details: errorMsg
        });
        return { success: false, message: errorMsg };
      }

      if (req.protocol !== undefined) {
        if (typeof req.protocol !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(req.protocol)) return { success: false, code: 'INVALID_PROTOCOL', message: 'Choose a valid IR protocol.' };
        const receivedProtocol = device.control_snapshot?.observed_remote_protocol || device.detected_protocol;
        if (receivedProtocol && req.protocol.toUpperCase() !== receivedProtocol.toUpperCase())
          return {success:false,code:'DETECTED_PROTOCOL_MISMATCH',message:'The IR receiver detected ' + receivedProtocol + '. Use that protocol or capture a new remote signal first.'};
        device.protocol_name = req.protocol;
        device.protocol = req.protocol;
        device.capabilities = CapabilityEngine.getCapabilities(device);
      }

      // 3. Check Assigned AC Controller Device Status
      const node = NodeService.getNode(device.node_id);
      if (!node) {
        const errorMsg = `Command not sent: Assigned hardware node (${device.node_id}) is currently OFFLINE.`;
        CentralLogService.log({
          device_id,
          node_id: device.node_id,
          module: 'CONTROL',
          event: 'COMMAND_BLOCKED_NODE_OFFLINE',
          result: 'OFFLINE',
          details: `${command} = ${JSON.stringify(value)} aborted because node is unreachable.`
        });
        return { 
          success: false, 
          message: errorMsg, 
          code: 'NODE_OFFLINE', 
          node_id: device.node_id, 
          device_id: device.device_id,
          command,
          value,
          node: node || null,
          device
        };
      }

      // 4. Validate Capability against Protocol Limits Dictionary
      if (!CapabilityEngine.isSupported({...device,state:{...device.state,mode:req.state?.mode || device.state?.mode}}, command, value)) {
        const errorMsg = `Capability violation: ${device.brand} ${device.model} (${device.name}) does not support ${command} ${value !== null && value !== undefined ? '(' + value + ')' : ''}.`;
        CentralLogService.log({
          device_id,
          node_id: device.node_id,
          module: 'CONTROL',
          event: 'COMMAND_UNSUPPORTED',
          result: 'FAILED',
          details: errorMsg
        });
        return { 
          success: false, 
          message: errorMsg, 
          code: 'UNSUPPORTED_CAPABILITY',
          node_id: device.node_id,
          device_id: device.device_id,
          command,
          value,
          device
        };
      }

      // 5. Build State Mutation
      const stateUpdates = {};
      switch (command) {
        case 'POWER':
          stateUpdates.power = Boolean(value);
          break;
        case 'TEMP':
          stateUpdates.temperature = CapabilityEngine.clampTemperature(device, Number(value));
          break;
        case 'MODE':
          stateUpdates.mode = String(value).toLowerCase();
          break;
        case 'FAN':
          stateUpdates.fan = String(value).toLowerCase();
          break;
        case 'SWING': case 'SWING_VERTICAL':
          stateUpdates.swing = Boolean(value);
          stateUpdates.swing_vertical = Boolean(value);
          break;
        case 'SLEEP':
          stateUpdates.sleep = Boolean(value);
          break;
        case 'TURBO':
          stateUpdates.turbo = Boolean(value);
          break;
        case 'ECO':
          stateUpdates.eco = Boolean(value);
          break;
        case 'QUIET': case 'SWING_HORIZONTAL': case 'DISPLAY': case 'FILTER': case 'CLEAN': case 'BEEP': case 'I_FEEL':
          stateUpdates[command.toLowerCase()] = Boolean(value);
          break;
        default:
          break;
      }

      // IR Studio can submit the selected complete state as one cloud request.
      if (req.state !== undefined) {
        const mapping = { power: 'POWER', temperature: 'TEMP', mode: 'MODE', fan: 'FAN', swing: 'SWING', sleep: 'SLEEP', turbo: 'TURBO', eco: 'ECO', quiet:'QUIET',swing_vertical:'SWING_VERTICAL',swing_horizontal:'SWING_HORIZONTAL',display:'DISPLAY',filter:'FILTER',clean:'CLEAN',beep:'BEEP',i_feel:'I_FEEL' };
        if (!req.state || typeof req.state !== 'object' || Array.isArray(req.state)) return { success: false, code: 'INVALID_STATE', message: 'Invalid complete AC settings.' };
        for (const [field, selected] of Object.entries(req.state)) {
          if (!Object.hasOwn(mapping, field) ||
              (!['temperature','mode','fan'].includes(field) && typeof selected !== 'boolean') ||
              (field === 'temperature' && (typeof selected !== 'number' || !Number.isFinite(selected))) ||
              (['mode','fan'].includes(field) && typeof selected !== 'string')) return { success: false, code: 'INVALID_STATE', message: `Invalid AC setting: ${field}.` };
          if (!(field==='temperature'?AcCapabilityRegistry.validateTemperature(device,selected,req.state.mode || device.state?.mode,true).valid:CapabilityEngine.isSupported({...device,state:{...device.state,mode:req.state.mode || device.state?.mode}}, mapping[field], selected)) && !(!['temperature','mode','fan','power'].includes(field) && selected===false)) return { success: false, code: 'UNSUPPORTED_CAPABILITY', message: `This AC profile does not support ${field}: ${selected}.` };
          stateUpdates[field] = ['mode','fan'].includes(field) ? selected.toLowerCase() : selected;
        }
      }

      // 6. Construct Structured JSON Intent Payload (Dynamic Full-State IR Generation)
      const protocolName = device.control_snapshot?.observed_remote_protocol || device.detected_protocol || device.protocol_name || device.protocol || CapabilityEngine.resolveProtocolName(device);
      const nextPower = stateUpdates.power !== undefined ? (stateUpdates.power ? 'on' : 'off') : ((device.state && device.state.power) ? 'on' : 'off');
      const nextMode = stateUpdates.mode || (device.state && device.state.mode) || 'cool';
      let nextTemp = stateUpdates.temperature ?? device.state?.temperature ?? 24;
      let nextFan = stateUpdates.fan || device.state?.fan || 'auto';
      const adjustments=[];
      const modeRange=AcCapabilityRegistry.range(device,nextMode);
      if(command==='MODE' && modeRange){
        if(modeRange.min===modeRange.max && nextTemp!==modeRange.min){nextTemp=modeRange.min;stateUpdates.temperature=nextTemp;adjustments.push(nextMode+' fixes temperature at '+nextTemp+'°C');}
        if(modeRange.fixed_fan && nextFan!==modeRange.fixed_fan){nextFan=modeRange.fixed_fan;stateUpdates.fan=nextFan;adjustments.push(nextMode+' requires '+nextFan+' fan');}
      }

      const intentPayload = {
        protocol: protocolName,
        requested_feature: command,
        model: AcCapabilityRegistry.model(device),
        capability_revision: device.capability_profile?.revision || 0,
        registry_version: AcCapabilityRegistry.data.registry_version,
        state: {
          power: nextPower,
          mode: nextMode,
          temp: nextTemp,
          fan: nextFan
        }
      };

      if (stateUpdates.swing !== undefined || (device.state && device.state.swing != null)) {
        intentPayload.state.swing = (stateUpdates.swing !== undefined ? stateUpdates.swing : device.state.swing) ? 'on' : 'off';
      }
      if (stateUpdates.sleep !== undefined || (device.state && device.state.sleep != null)) {
        intentPayload.state.sleep = (stateUpdates.sleep !== undefined ? stateUpdates.sleep : device.state.sleep) ? 'on' : 'off';
      }
      if (stateUpdates.turbo !== undefined || (device.state && device.state.turbo != null)) {
        intentPayload.state.turbo = (stateUpdates.turbo !== undefined ? stateUpdates.turbo : device.state.turbo) ? 'on' : 'off';
      }
      if (stateUpdates.eco !== undefined || (device.state && device.state.eco != null)) {
        intentPayload.state.eco = (stateUpdates.eco !== undefined ? stateUpdates.eco : device.state.eco) ? 'on' : 'off';
      }

      const activeCaps=CapabilityEngine.getCapabilities(device,nextMode);
      for(const key of ['quiet','swing_vertical','swing_horizontal','display','filter','clean','beep','i_feel']){
        const selected=stateUpdates[key] ?? device.state?.[key];
        if(selected!=null && activeCaps[key])intentPayload.state[key]=selected?'on':'off';
      }
      // Do not carry unsupported enabled extras from a different received protocol.
      for(const key of ['swing','sleep','turbo','eco'])if(!activeCaps[key])delete intentPayload.state[key];
      const validated=AcCapabilityRegistry.validateState(device,intentPayload.state);
      if(!validated.valid)return {success:false,code:'INVALID_AC_STATE',message:validated.errors.join(' '),intent:intentPayload};

      CentralLogService.log({
        device_id,
        node_id: device.node_id,
        module: 'IR',
        event: 'REQUESTING_COMMAND',
        result: 'PENDING',
        details: `Requesting cloud command for ${device.node_id} via ${protocolName}: ${JSON.stringify(intentPayload.state)} (Req: ${requestId})`
      });

      let savedCommand;
      try {
        const sb = window.supabaseClient || window.sb;
        if (!window.EcoTrackHardwareCloud || !sb) throw new Error('Supabase hardware transport is unavailable.');
        const record = await sb.from('aircons').select('id').eq('asset_tag', device.device_id).maybeSingle();
        if (record.error || !record.data?.id) throw new Error(record.error?.message || 'Registered aircon not found.');
        savedCommand = await window.EcoTrackHardwareCloud.control(device.node_id, { ...intentPayload, aircon_id: record.data.id });
      } catch (error) {
        return { success: false, code: error.code || 'CLOUD_COMMAND_FAILED', message: error.message, intent: intentPayload };
      }
      const delivered = false;
      const deliveryPersistenceError = null;
      device.control_snapshot = {
        ...device.control_snapshot,
        desired_state: intentPayload.state, commanded_at: savedCommand.commanded_at,
        command_id: savedCommand.command_id, command_status: 'queued',
        reported_state: device.control_snapshot?.reported_state, reported_at: device.control_snapshot?.reported_at
      };

      // 7. Commit State Update
      const updatedState = AirconProfileManager.updateState(device_id, stateUpdates, device.control_snapshot);
      device.state = updatedState;

      CentralLogService.log({
        device_id,
        node_id: device.node_id,
        module: 'CONTROL',
        event: delivered ? 'COMMAND_SUCCESS' : 'COMMAND_QUEUED',
        result: delivered ? 'SUCCESS' : 'PENDING',
        details: `${command} ${delivered ? 'transmitted' : 'queued'} for ${device.name} [Intent: ${protocolName}]`
      });

      // Fire synchronization events across all buses (preserving EcoDataBus contract)
      AirconEvents.emit('aircon:state_changed', device);
      const allNodes = NodeService.getNodes();
      const allAircons = AirconProfileManager.getAll();
      AirconEvents.emit('devices:synced', { nodes: allNodes, aircons: allAircons });

      if (typeof window !== 'undefined' && window.EcoDataBus) {
        window.EcoDataBus.invalidate('aircons');
        window.EcoDataBus.invalidate('nodes');
        window.EcoDataBus.emit('devices:synced', { nodes: allNodes, aircons: allAircons });
      }

      return {
        success: true,
        message: (delivered ? `IR command ${command} transmitted to ${device.name}.` : `Command ${command} queued for ${device.name}.`) + (adjustments.length?' '+adjustments.join('; ')+'.':''),
        delivery_status: delivered ? 'transmitted' : 'queued',
        state_sync_error: deliveryPersistenceError,
        state: updatedState,
        request_id: requestId,
        intent: intentPayload
      };
    }
  }

  // ===== COMMAND STATE TRACKER (CONTROL ONLY - NO SENSORS) =====
  class CommandStateTracker {
    /**
     * Formats and returns the active commanded status of an aircon
     * @param {Object} device
     * @returns {string} e.g. "POWER ON • COOL (24°C)" or "POWER OFF"
     */
    static getCommandSummary(device) {
      if (!device || !device.state) return 'POWER OFF';
      const s = device.state;
      if (!s.power) return 'POWER OFF';
      const mode = (s.mode || 'cool').toUpperCase();
      const temp = s.temperature ? `${s.temperature}°C` : '';
      const fan = s.fan ? `FAN: ${s.fan.toUpperCase()}` : '';
      return ['POWER ON', mode, temp, fan].filter(Boolean).join(' • ');
    }

    static getSummary(device) {
      return this.getCommandSummary(device);
    }

    /**
     * State classification based strictly on commanded state (no environmental sensors)
     */
    static classify(temp, power = true, targetTemp = 24) {
      return power ? 'ACTIVE' : 'OFF';
    }

    /**
     * Sensor mismatch check eliminated for control-only system
     */
    static evaluateMismatch(device) {
      return false;
    }
  }

  // ===== EXPORT TO GLOBAL WINDOW SCOPE =====
  window.EcoTrackAirconSystem = {
    AirconProfileManager,
    CapabilityEngine,
    AcCapabilityRegistry,
    CommandManager,
    ProtocolAdapter,
    CommandStateTracker,
    OperationalStateClassifier: CommandStateTracker,
    ACControllerDeviceService,
    NodeService: ACControllerDeviceService,
    CentralLogService,
    AirconEvents,
    syncWithDatabase,
    receiveHardwareEvent,
    isConnectionOnlyNodeEvent,
    DEFAULT_NODES,
    DEFAULT_AIRCONS,
    DEFAULT_IR_COMMANDS
  };

  console.log('âš¡ EcoTrack Universal Aircon Core Control Engine Initialized.');

})(typeof window !== 'undefined' ? window : globalThis);
