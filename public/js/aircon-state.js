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

