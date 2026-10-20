/* Supabase hardware transport + nearby BLE provisioning. No local-IP dispatch. */
(function (root) {
  'use strict';
  const SERVICE = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
  const INFO = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';
  const WIFI = '1c95d5e3-d8f7-413a-bf3d-7a2e5d7be87e';
  const CAPTURE = 'b80301f3-639c-4eaf-bcc0-537759229321';
  const state = { device: null, info: null, writer: null, identity: null, service: null, capture: null };
  let bluetoothOperation = Promise.resolve();
  function serializeBluetooth(operation) {
    const result = bluetoothOperation.then(operation, operation);
    bluetoothOperation = result.catch(() => {});
    return result;
  }
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const timestamp = () => root.performance?.now?.() ?? Date.now();
  const client = () => {
    const sb = root.supabaseClient || root.sb;
    if (!sb?.rpc) throw new Error('Sign in and connect to Supabase first.');
    return sb;
  };
  function publicKey(key) {
    if (key?.startsWith('sb_publishable_')) return true;
    try { return JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role === 'anon'; }
    catch (_) { return false; }
  }
  function failure(error, operation = '') {
    const missing = ['PGRST202', 'PGRST205', '42P01'].includes(error?.code);
    const registration = /^ecotrack_(controller_registration_status|validate_controller_assignment|prepare_controller_registration|finish_controller_registration)$/.test(operation);
    const message = missing && /ac_device_assignment|ac_device_registration/.test(operation) ? 'Install the AC device roles migration before registering this device type.' : missing ? registration
      ? 'Registration setup is missing. Run supabase_controller_registration_migration.sql in Supabase SQL Editor after its existing prerequisites.'
      : 'Cloud hardware setup is missing. Run supabase_cloud_hardware_migration.sql in Supabase SQL Editor.' : error?.message || 'Cloud request failed.';
    return Object.assign(new Error(message), { code: error?.code });
  }
  async function rpc(name, args) {
    let query = client().rpc(name, args), timer;
    if (/^ecotrack_(controller_registration_status|validate_controller_assignment|prepare_controller_registration)$/.test(name) &&
        typeof AbortController === 'function' && typeof query.abortSignal === 'function') {
      const controller = new AbortController();query=query.abortSignal(controller.signal);
      timer=setTimeout(()=>controller.abort(),25000);
    }
    let response;
    try {response=await query;} finally {if(timer)clearTimeout(timer);}
    if (response.error) throw failure(response.error, name);
    if (!response.data) throw new Error('Supabase returned no confirmation.');
    return response.data;
  }
  const pendingKey = () => 'ecoTrack_controller_drafts:' + (root.ECOTRACK_CONFIG?.supabaseUrl || root.supabaseClient?.supabaseUrl || 'current');
  function pendingRegistrations() {
    try {
      const ids = JSON.parse(root.localStorage?.getItem(pendingKey()) || '[]');
      return Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : [];
    } catch (_) { return []; }
  }
  function setPendingRegistration(nodeId, pending) {
    const ids = new Set(pendingRegistrations());
    if (pending) ids.add(nodeId); else ids.delete(nodeId);
    try { root.localStorage?.setItem(pendingKey(), JSON.stringify([...ids])); } catch (_) {}
  }
  function completeRegistration(nodeId) {
    setPendingRegistration(nodeId, false);
    root.EcoDataBus?.invalidate('nodes');
    root.EcoDataBus?.invalidate('scheduler:data');
    if (state.device?.gatt?.connected) state.device.gatt.disconnect();
  }

  function identityMatches(info) {
    return /^esp32s3-[a-f0-9]{12}$/.test(info?.device_id || '') && info.cloud_protocol === 1;
  }
  function bluetoothFailure(error, operation = 'Bluetooth request', device = state.device) {
    if (typeof error?.code === 'string' && error.code.startsWith('BLE_')) return error;
    if (error?.name === 'NetworkError' || /gatt|bluetooth/i.test(error?.message || '')) {
      const connected = device?.gatt?.connected === true;
      const detail = typeof error?.message === 'string' ? error.message : 'No device response.';
      return Object.assign(new Error((connected ? 'ESP32 Bluetooth is connected, but ' : 'Bluetooth could not complete ') +
        operation + (connected ? ' failed. ' : '. ') + detail + ' Select Reconnect ESP32 to check the connection again.', { cause: error }), {
          code: 'BLE_CONNECTION_FAILED', bluetooth_connected: connected, operation, original_name: error?.name, original_code: error?.code
        });
    }
    return error;
  }
  async function readInfo() {
    if (!state.device?.gatt?.connected || !state.info) throw Object.assign(new Error('Bluetooth disconnected. Select Reconnect ESP32 to continue with the same controller.'), { code: 'BLE_DISCONNECTED' });
    let value;
    try { const characteristic = state.info; value = await serializeBluetooth(() => characteristic.readValue()); } catch (error) { throw bluetoothFailure(error, 'reading device information'); }
    const info = JSON.parse(new TextDecoder().decode(value));
    if (!identityMatches(info)) throw new Error('Install the new EcoTrack cloud receiver sketch on this ESP32 first.');
    if (state.identity && state.identity !== info.device_id) throw Object.assign(new Error('Bluetooth device identity does not match this setup. Reconnect the selected ESP32.'), { code: 'BLE_DEVICE_MISMATCH' });
    state.identity = info.device_id;
    if (typeof root.CustomEvent === 'function')
      root.dispatchEvent?.(new root.CustomEvent('ecotrack:bluetooth-info', { detail: { device_id: info.device_id, info } }));
    return info;
  }
  async function attachDevice(device, expectedDeviceId) {
    let operation = 'connecting to the ESP32';
    try {
      const server = await device.gatt.connect();
      operation = 'discovering setup characteristics';
      const service = await server.getPrimaryService(SERVICE);
      state.device = device;
      state.service = service; state.capture = null;
      state.identity = null;
      state.info = await service.getCharacteristic(INFO);
      state.writer = await service.getCharacteristic(WIFI);
      const info = await readInfo();
      if (expectedDeviceId && info.device_id !== expectedDeviceId) {
        device.gatt.disconnect();
        state.info = null; state.writer = null; state.service = null; state.capture = null;
        throw Object.assign(new Error('Reconnect the selected ESP32. The Bluetooth device does not match this controller.'), { code: 'BLE_DEVICE_MISMATCH' });
      }
      device.addEventListener?.('gattserverdisconnected', () => {
        if (state.device !== device || state.service !== service) return;
        state.info = null; state.writer = null; state.service = null; state.capture = null;
        if (typeof root.CustomEvent === 'function')
          root.dispatchEvent?.(new root.CustomEvent('ecotrack:bluetooth-disconnected', { detail: { device_id: info.device_id } }));
      });
      return { ...info, bluetooth_name: device.name || info.device_id };
    } catch (error) { throw bluetoothFailure(error, operation, device); }
  }
  async function connect(expectedDeviceId) {
    if (!root.navigator?.bluetooth?.requestDevice) throw new Error('Bluetooth provisioning requires EcoTrack desktop with a working Bluetooth adapter.');
    const previous = {...state};
    let device;
    try { device = await root.navigator.bluetooth.requestDevice({ filters: [{ namePrefix: 'EcoTrack-' }], optionalServices: [SERVICE] }); }
    catch (error) {
      const message = error?.name === 'NotFoundError'
        ? 'No ESP32 was selected. Select Reconnect ESP32 and choose the same controller.'
        : 'Bluetooth selection could not be completed. Check Windows Bluetooth and select Reconnect ESP32.';
      throw Object.assign(new Error(message), { code: 'BLE_DISCONNECTED' });
    }
    try {
      const info = await attachDevice(device, expectedDeviceId);
      if (previous.device !== device && previous.device?.gatt?.connected) previous.device.gatt.disconnect();
      return info;
    } catch (error) {
      if (device !== previous.device && device.gatt?.connected) device.gatt.disconnect();
      Object.assign(state, previous);
      throw error;
    }
  }
  async function reconnect(expectedDeviceId) {
    if (!/^esp32s3-[a-f0-9]{12}$/.test(expectedDeviceId || ''))
      throw Object.assign(new Error('Reconnect the selected ESP32 through Bluetooth.'), { code: 'BLE_DEVICE_MISMATCH' });
    let device = state.device;
    if (device && state.identity && state.identity !== expectedDeviceId) device = null;
    if (!device && root.navigator?.bluetooth?.getDevices) {
      const devices = (await root.navigator.bluetooth.getDevices()).filter(item => item.name === 'EcoTrack-' + expectedDeviceId);
      if (devices.length === 1) device = devices[0];
    }
    if (!device) throw Object.assign(new Error('Select Reconnect ESP32 and choose the same controller. Keep it powered on and nearby.'), { code: 'BLE_DISCONNECTED' });
    let info;
    if (device === state.device && device.gatt?.connected && state.info) {
      try { info = { ...await readInfo(), bluetooth_name: device.name || expectedDeviceId }; }
      catch (error) {
        if (error?.code !== 'BLE_CONNECTION_FAILED' || !device.gatt?.connected) throw error;
        // Re-discover characteristic handles on the existing link; never replay provisioning writes.
        await delay(150);
        info = await attachDevice(device, expectedDeviceId);
      }
    } else info = await attachDevice(device, expectedDeviceId);
    if (info.device_id !== expectedDeviceId)
      throw Object.assign(new Error('Reconnect the selected ESP32. The Bluetooth device does not match this controller.'), { code: 'BLE_DEVICE_MISMATCH' });
    return info;
  }
  async function resume() {
    // Only resume a previously authorized device; never infer hardware from a saved IP.
    try {
      if (state.device?.gatt?.connected && state.info) return { ...await readInfo(), bluetooth_name: state.device.name || state.identity };
      let device = state.device;
      if (!device && root.navigator?.bluetooth?.getDevices) {
        const authorized = (await root.navigator.bluetooth.getDevices()).filter(item => item.name?.startsWith('EcoTrack-'));
        if (authorized.length !== 1) return null;
        device = authorized[0];
      }
      return device ? await attachDevice(device) : null;
    } catch (_) { return null; }
  }
  function validateCredentials(info, payload) {
    if (payload.device_id && payload.device_id !== info.device_id) throw new Error('Wrong Bluetooth device selected.');
    if (typeof payload.ssid !== 'string' || !payload.ssid.trim() || new TextEncoder().encode(payload.ssid).length > 32 ||
        typeof payload.pass !== 'string' || new TextEncoder().encode(payload.pass).length < 8 || new TextEncoder().encode(payload.pass).length > 63) throw new Error('Enter a Wi-Fi name and a password of 8..63 bytes.');
  }
  async function provision(payload, cloud = false) {
    const info = await readInfo();
    validateCredentials(info, payload);
    const requestId = root.crypto.randomUUID();
    const bytes = new TextEncoder().encode(JSON.stringify({ ...payload, device_id: info.device_id, request_id: requestId }));
    if (bytes.length > 2048) throw new Error('Provisioning payload is too large.');
    const total = Math.ceil(bytes.length / 160);
    for (let index = 0; index < total; index++) {
      const header = new TextEncoder().encode(`${requestId}:${index}:${total}:`);
      const part = bytes.slice(index * 160, (index + 1) * 160);
      const packet = new Uint8Array(header.length + part.length);
      packet.set(header); packet.set(part, header.length);
      try { const characteristic = state.writer; await serializeBluetooth(() => characteristic.writeValueWithResponse(packet)); } catch (error) { throw bluetoothFailure(error, 'writing Wi-Fi and cloud settings'); }
    }
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      await delay(700);
      const current = await readInfo();
      if (current.request_id !== requestId) continue;
      if (current.wifi_status === 'error' || (cloud && current.cloud_status === 'error')) throw new Error(current.error || 'The device rejected this connection.');
      if (current.wifi_status === 'connected' && (!cloud || current.cloud_status === 'verified')) return current;
    }
    throw new Error(cloud ? 'Wi-Fi connected, but no Supabase device acknowledgement arrived. Check the migration, internet connection, and Serial Monitor.' : 'ESP32 did not confirm Wi-Fi connection. Check its 2.4 GHz network and password.');
  }
  async function registrationStatus(info) {
    if (!identityMatches(info)) throw new Error('Reconnect the selected ESP32 before checking registration.');
    const response = await rpc('ecotrack_controller_registration_status', {p_device_id:info.device_id});
    if (response.requires_credentials === true) return {...response,state:'refresh'};
    if (!response.node?.id) throw new Error('Controller registration could not be confirmed.');
    if (info.cloud_status === 'unconfigured' || info.node_id && info.node_id !== response.node.id) return {...response,state:'refresh'};
    if (info.cloud_status === 'error' && /auth|credential|reprovision|registration|token/i.test(info.error || ''))
      return {...response,state:'refresh'};
    const cloud = response.cloud_state;
    if (cloud?.device_id !== info.device_id || describe(cloud) !== 'online' || info.cloud_status !== 'verified')
      return {...response,state:'waiting'};
    return {...response,state:'reuse',info,cloud_state:{...cloud,connection_status:'online'}};
  }
  async function validateAssignment(deviceId, setup) {
    const result = await rpc(setup.device_mode ? 'ecotrack_validate_ac_device_assignment' : 'ecotrack_validate_controller_assignment', {p_device_id:deviceId,p_setup:setup});
    if (result.valid !== true) throw new Error('AC assignment was not confirmed.');
    return result;
  }
  async function register(metadata, credentials, expectedDeviceId, options = {}) {
    const info = expectedDeviceId ? await reconnect(expectedDeviceId) : await readInfo();
    if (expectedDeviceId && info.device_id !== expectedDeviceId)
      throw Object.assign(new Error('Reconnect the selected ESP32. The Bluetooth device does not match this controller.'), { code: 'BLE_DEVICE_MISMATCH' });
    validateCredentials(info, credentials || {});
    const config = root.ECOTRACK_CONFIG;
    if (!config?.supabaseUrl?.startsWith('https://') || !publicKey(config.supabaseKey)) throw new Error('A Supabase HTTPS URL and publishable key are required.');
    const registration = options.preserveMetadata
      ? await rpc('ecotrack_prepare_controller_registration', {p_device_id:info.device_id})
      : await rpc('ecotrack_register_cloud_device', { p_device_id: info.device_id, p_metadata: metadata });
    if (!registration.node?.id || !/^[a-f0-9]{64}$/.test(registration.device_token || '')) throw new Error('Invalid cloud device registration response.');
    setPendingRegistration(registration.node.id, true);
    try {
      const confirmed = await provision({ ...credentials, supabase_url: config.supabaseUrl, supabase_key: config.supabaseKey,
        device_token: registration.device_token, device_id: info.device_id }, true);
      const cloudState = await getStatus(registration.node.id);
      if (cloudState.device_id !== confirmed.device_id || cloudState.connection_status !== 'online') throw new Error('Device cloud heartbeat was not confirmed.');
      // Keep Bluetooth available for retry if the following metadata/binding save fails.
      return { node: registration.node, info: confirmed, cloud_state: cloudState };
    } finally { delete registration.device_token; }
  }
  async function resolveNode(nodeId) {
    const local = root.EcoTrackAirconSystem?.NodeService?.getNode?.(nodeId);
    if (local?.db_id || local?.pb_id) return local.db_id || local.pb_id;
    let query = client().from('nodes').select('id');
    let response = await query.eq('id', nodeId).maybeSingle();
    if (response.error) throw failure(response.error);
    if (response.data?.id) return response.data.id;
    response = await client().from('nodes').select('id').eq('name', nodeId).maybeSingle();
    if (response.error) throw failure(response.error);
    if (!response.data?.id) throw new Error('This controller was not found in Supabase. Complete Save & Verify Controller in the registration wizard first.');
    return response.data.id;
  }
  function describe(device) {
    const wake = Date.parse(device?.sleeping_until || '');
    const seen = Date.parse(device?.last_seen || '');
    if (Number.isFinite(wake) && wake > Date.now()) return 'sleeping';
    return Number.isFinite(seen) && Date.now() - seen <= 45000 && seen <= Date.now() + 5000 ? 'online' : 'offline';
  }
  async function getStatus(nodeId) {
    const id = await resolveNode(nodeId);
    const response = await client().from('ecotrack_device_state').select('*').eq('node_id', id).maybeSingle();
    if (response.error) throw failure(response.error);
    if (!response.data) throw new Error('Provision this controller through Bluetooth first.');
    return { ...response.data, connection_status: describe(response.data) };
  }
  async function listStatus() {
    const response = await client().from('ecotrack_device_state').select('*');
    if (response.error) throw failure(response.error);
    if (!Array.isArray(response.data)) throw new Error('Invalid cloud device status response.');
    return response.data.map(item => ({ ...item, connection_status: describe(item) }));
  }
  async function request(nodeId, kind, payload = {}, options = {}) {
    const started = timestamp();
    const id = await resolveNode(nodeId);
    const queued = await rpc('ecotrack_cloud_request', { p_node_id: id, p_kind: kind, p_payload: payload, p_request_id: root.crypto.randomUUID() });
    if (!queued.id || queued.node_id !== id || queued.kind !== kind) throw new Error('Supabase did not confirm the hardware request.');
    if (options.wait === false) return queued;
    return waitForResult(queued, { ...options, started });
  }
  async function waitForResult(queued, options = {}) {
    const id = queued.node_id;
    const started = options.started ?? timestamp();
    const deadline = Date.now() + (options.timeoutMs || 25000);
    while (Date.now() < deadline) {
      const response = await client().from('ecotrack_device_commands').select('*').eq('id', queued.id).maybeSingle();
      if (response.error) throw failure(response.error);
      const command = response.data;
      if (!command || command.node_id !== id) throw new Error('Hardware request disappeared or became inaccessible.');
      if (command.status === 'completed') {
        if (command.result?.success !== true || command.result.command_id !== queued.id) throw new Error('Invalid hardware acknowledgement.');
        return { ...command.result, command_id: queued.id, round_trip_ms: Math.round(timestamp() - started), source: 'supabase' };
      }
      if (['failed', 'expired', 'superseded'].includes(command.status)) throw Object.assign(new Error(command.result?.error || `Hardware request ${command.status}.`), { code: command.status.toUpperCase(), command_id: queued.id });
      await delay(500);
    }
    throw Object.assign(new Error('No device acknowledgement received. The controller may be asleep, offline, or reconnecting.'), { code: 'ACK_TIMEOUT', command_id: queued.id });
  }
  async function ping(nodeId) {
    const device = await getStatus(nodeId);
    if (device.connection_status === 'sleeping') throw Object.assign(new Error(`Controller is sleeping until ${new Date(device.sleeping_until).toLocaleString()}.`), { code: 'DEVICE_SLEEPING' });
    return request(nodeId, 'ping', {}, { timeoutMs: 20000 });
  }
  async function learn(nodeId) {
    return request(nodeId, 'learn_ir', {}, { timeoutMs: 30000 });
  }
  async function learnNearby(nodeId, options = {}) {
    const info = await reconnect(nodeId);
    if (info.device_id !== nodeId) throw new Error('Reconnect the selected ESP32 before listening.');
    if (info.capabilities?.ble_ir_monitor !== true || !state.service)
      throw new Error('This receiver needs the updated sketch for Bluetooth IR detection. You can also Save & Verify Controller first, then detect its remote in Edit through Supabase.');
    if (!state.capture) {
      try { state.capture = await serializeBluetooth(() => state.service.getCharacteristic(CAPTURE)); }
      catch (error) {
        if (error?.name === 'NotFoundError' || /No Characteristics|matching UUID/i.test(error?.message || ''))
          throw Object.assign(new Error('Bluetooth IR capture is unavailable on this connection. Upload the complete current EcoTrack sketch, then remove the old Windows Bluetooth pairing and reconnect. Reported firmware: ' + (info.firmware_version || 'unknown') + '.'), { code: 'BLE_CAPTURE_UNAVAILABLE' });
        throw bluetoothFailure(error, 'discovering the IR capture characteristic');
      }
    }
    const readCapture = async () => {
      let value;
      try { const characteristic = state.capture; value = await serializeBluetooth(() => characteristic.readValue()); }
      catch (error) { throw bluetoothFailure(error, 'reading the IR capture'); }
      if (!state.device?.gatt?.connected) throw new Error('Reconnect the ESP32 through Bluetooth.');
      return JSON.parse(new TextDecoder().decode(value));
    };
    const first = await readCapture();
    const sequence = Number(first.sequence || 0);
    const deadline = Date.now() + 6000;
    options.onListening?.();
    while (Date.now() < deadline) {
      await delay(200);
      const capture = await readCapture();
      if (Number(capture.sequence) > sequence && Number(capture.raw_count) >= 3 && capture.protocol)
        return {...capture,success:true,source:'bluetooth'};
    }
    throw new Error('No new IR signal received. Point the AC remote at the receiver and press a button while listening.');
  }

  async function latest(nodeId) {
    const device = await getStatus(nodeId);
    if (!device.latest_ir?.raw_data && !(device.latest_ir?.state && Number(device.latest_ir?.raw_count) > 0)) throw new Error('No actual IR capture has been uploaded by this receiver.');
    return { ...device.latest_ir, success: true, source: 'supabase' };
  }
  async function control(nodeId, payload) {
    const device = await getStatus(nodeId);
    if (device.capabilities?.ir_transmitter !== true) throw Object.assign(new Error('This ESP32 is receiver-only. Add an IR transmitter before using power, temperature, mode, or fan controls.'), { code: 'RECEIVER_ONLY' });
    const queued = await request(nodeId, 'ac_intent', payload, { wait: false });
    return { ...queued, command_id: queued.id, command_status: 'queued', commanded_at: queued.created_at };
  }
  let dialogSequence = 0;
  function inputDialog(title, message, choices, passkey = false) {
    return new Promise(resolve => {
      const make = (tag, className, text) => {
        const element = root.document.createElement(tag);
        element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
      };
      const dialog = make('dialog', 'ecotrack-bluetooth-dialog');
      const id = 'ecotrack-bluetooth-' + ++dialogSequence;
      dialog.setAttribute('aria-labelledby', id + '-title');
      dialog.setAttribute('aria-describedby', id + '-description');
      const header = make('div', 'ecotrack-bluetooth-dialog__header');
      const heading = make('h2', 'ecotrack-bluetooth-dialog__title', title);
      heading.id = id + '-title';
      const dismiss = make('button', 'ecotrack-bluetooth-dialog__close', '\u00d7');
      dismiss.type = 'button';
      dismiss.setAttribute('aria-label', 'Close Bluetooth dialog');
      header.append(heading, dismiss);
      const text = make('p', 'ecotrack-bluetooth-dialog__description', message);
      text.id = id + '-description';
      const options = make('div', 'ecotrack-bluetooth-dialog__options');
      const footer = make('div', 'ecotrack-bluetooth-dialog__footer');
      dialog.append(header, text, options, footer);
      let field, firstChoice;
      const validation = make('p', 'ecotrack-bluetooth-dialog__validation', 'Enter a six-digit Bluetooth code.');
      validation.id = id + '-validation';
      validation.hidden = true;
      validation.setAttribute('role', 'alert');
      if (passkey) {
        field = make('input', 'ecotrack-bluetooth-dialog__input');
        field.inputMode = 'numeric'; field.maxLength = 6; field.autocomplete = 'off';
        field.setAttribute('aria-label', 'Six-digit Bluetooth code');
        field.setAttribute('aria-describedby', validation.id);
        options.append(field, validation);
      }
      let settled = false;
      const close = value => {
        if (settled) return;
        settled = true;
        dialog.close(); dialog.remove(); resolve(value);
      };
      dismiss.addEventListener('click', () => close(null));
      for (const choice of choices) {
        const cancel = choice.value === null || choice.value === false;
        const button = make('button', cancel ? 'ecotrack-bluetooth-dialog__cancel' : 'ecotrack-bluetooth-dialog__choice', choice.label);
        button.type = 'button';
        button.addEventListener('click', () => {
          if (passkey && choice.value && !/^\d{6}$/.test(field.value)) {
            validation.hidden = false;
            field.setAttribute('aria-invalid', 'true');
            field.focus(); return;
          }
          close(passkey && choice.value ? field.value : choice.value);
        });
        (cancel ? footer : options).append(button);
        if (!cancel && !firstChoice) firstChoice = button;
      }
      dialog.addEventListener('cancel', event => { event.preventDefault(); close(null); });
      dialog.addEventListener('close', () => close(null));
      // Escape dismisses this picker without closing the registration wizard below it.
      dialog.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
      root.document.body.append(dialog);
      dialog.showModal();
      (field || firstChoice || dismiss).focus();
    });
  }
  if (root.electron?.on && root.document) {
    root.electron.on('bluetooth-select-request', async (_event, data) => {
      const choice = await inputDialog('Select nearby EcoTrack device', 'Choose the ESP32 you want to configure.', [...data.devices.map(item => ({ label: item.deviceName || item.deviceId, value: item.deviceId })), { label: 'Cancel', value: null }]);
      await root.electron.invoke('bluetooth-select-response', { request_id: data.request_id, device_id: choice });
    });
    root.electron.on('bluetooth-pairing-request', async (_event, data) => {
      const entering = data.pairingKind === 'providePin';
      const answer = await inputDialog('Secure Bluetooth pairing', entering ? 'Enter the six-digit pairing code printed in the ESP32 Serial Monitor (115200 baud).' : `Confirm pairing with ${data.deviceId}${data.pin ? ': ' + data.pin : ''}.`, [{ label: 'Pair', value: true }, { label: 'Cancel', value: false }], entering);
      await root.electron.invoke('bluetooth-pairing-response', { request_id: data.request_id, confirmed: !!answer, pin: entering && answer ? answer : undefined });
    });
  }
  try {
    const raw = root.localStorage?.getItem('ecoTrack_nodes');
    if (raw) {
      const nodes = JSON.parse(raw);
      for (const node of nodes) { delete node.wifi_password; delete node.password; delete node.device_token; }
      root.localStorage.setItem('ecoTrack_nodes', JSON.stringify(nodes));
    }
  } catch (_) {}
  root.EcoTrackHardwareCloud = { connect, reconnect, resume, readInfo, provision, register, registrationStatus, validateAssignment, pendingRegistrations, completeRegistration, request, waitForResult, ping, learn, learnNearby, latest, control, getStatus, listStatus, describe, resolveNode };
})(typeof window !== 'undefined' ? window : globalThis);
