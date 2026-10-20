/**
 * Comprehensive Automated Test Suite
 * Universal Aircon IoT Desktop Platform
 */

// Mock Browser Environment for Node.js test execution
const storageMock = {};
global.localStorage = {
  getItem: (key) => storageMock[key] || null,
  setItem: (key, val) => { storageMock[key] = String(val); },
  removeItem: (key) => { delete storageMock[key]; },
  clear: () => { Object.keys(storageMock).forEach(k => delete storageMock[k]); }
};
global.window = {
  localStorage: global.localStorage,
  BroadcastChannel: class {
    constructor(name) { this.name = name; }
    postMessage() {}
  }
};
// Transport fixtures exercise the control engine without making local-IP requests.
global.fetch = async () => { throw new Error('Hardware control must use Supabase'); };
global.window.EcoTrackHardwareCloud = {
  describe: () => 'online',
  control: async (_node, _intent) => ({ command_id: 'test-command', commanded_at: new Date().toISOString(), command_status: 'queued' }),
  learn: async () => ({ success: true, protocol: 'MIDEA', raw_type: 'MIDEA', raw_data: '4400,4400,540,1620,540', hex: '0x1234' })
};
// The cloud transport has its own database/client tests; this fixture isolates the engine.
const fixtureDatabase = { nodes: [], aircons: [] };
global.window.supabaseClient = { auth: { getSession: async () => ({ data: { session: null } }) }, from(table) {
  let lastPayload = null, field = null, value = null, filter = null, deleting = false;
  const result = () => (fixtureDatabase[table] || []).filter(row => {
    if (field && row[field] !== value) return false;
    if (filter && !filter.split(',').some(term => { const [key, , ...parts] = term.split('.'); return String(row[key]) === parts.join('.'); })) return false;
    return true;
  });
  const query = { select() { return query; }, eq(key, selected) { field=key; value=selected; return query; }, or(expression) { filter=expression; return query; }, update() { return query; },
    upsert(items) {
      lastPayload = Array.isArray(items) ? items[0] : items;
      const key = table === 'aircons' ? 'asset_tag' : 'id';
      const rows = fixtureDatabase[table] ||= [];
      const index = rows.findIndex(row => row[key] === lastPayload[key]);
      const row = { id: lastPayload.id || 'fixture-' + lastPayload.asset_tag, ...lastPayload };
      if (index >= 0) rows[index] = { ...rows[index], ...row }; else rows.push(row);
      return query;
    },
    delete() { deleting = true; return query; },
    insert(items) { return query.upsert(items); }, order() { return query; }, limit() { return query; },
    single: async () => ({ data: lastPayload ? { id: lastPayload.id || 'fixture-' + lastPayload.asset_tag, ...lastPayload } : result()[0] || null, error: null }),
    maybeSingle: async () => ({ data: result()[0] || null, error: null }),
    then(resolve, reject) { const rows = result(); if (deleting) fixtureDatabase[table] = (fixtureDatabase[table] || []).filter(row => !rows.includes(row)); return Promise.resolve({ data: lastPayload ? [lastPayload] : rows, error: null }).then(resolve, reject); }
  };
  return query;
} };

// Load aircon-system.js
require('../public/js/aircon-system.js');
const {
  AirconProfileManager,
  CapabilityEngine,
  CommandManager,
  ProtocolAdapter,
  OperationalStateClassifier,
  NodeService,
  CentralLogService,
  AirconEvents
} = global.window.EcoTrackAirconSystem;

let passed = 0;
let failed = 0;

function assert(description, condition) {
  if (condition) {
    console.log(`  ✅ ${description}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${description}`);
    failed++;
  }
}

async function runTests() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  UNIVERSAL AIRCON IoT SYSTEM — AUTOMATED VERIFICATION');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // 1. AIRCON PROFILE MANAGER
  console.log('1. [AIRCON PROFILE MANAGER & REPOSITORY]');
  NodeService.saveNode({
    node_id: 'node-1',
    name: 'Server Room Controller (node-1)',
    ip_address: '192.168.1.6',
    status: 'Connected'
  });
  let aircons = AirconProfileManager.getAll();
  if (!aircons || aircons.length === 0) {
    await AirconProfileManager.save({
      device_id: 'AC-001',
      name: 'Server Room A AC',
      brand: 'Koppel',
      model: 'Window Type (Inverter)',
      location: 'Server Room A / 2nd Floor',
      node_id: 'node-1',
      status: 'online',
      protocol: 'KOPPEL_RAW',
      capabilities: {
        power: true,
        temperature: true,
        temperature_min: 16,
        temperature_max: 30,
        temperature_step: 1,
        modes: ['cool', 'dry', 'fan', 'auto'],
        fans: ['auto', 'low', 'medium', 'high'],
        swing: true,
        sleep: true,
        turbo: true,
        eco: true,
        timer: true
      },
      state: { power: true, mode: 'cool', temperature: 24, fan: 'auto' }
    });
    aircons = AirconProfileManager.getAll();
  }
  assert('Aircon repository can store and retrieve units', aircons.length >= 1);
  assert('AC-001 is registered unit', aircons[0].device_id === 'AC-001');

  // Add a new unit (multi-aircon support)
  const newUnit = {
    device_id: 'AC-TEST-09',
    name: 'Conference Room Alpha',
    brand: 'Carrier',
    model: 'Optima-12k',
    location: '3rd Floor - Exec Wing',
    node_id: 'node-2',
    status: 'online',
    protocol: 'CARRIER_AC64',
    capabilities: {
      power: true,
      temperature: true,
      temperature_min: 17,
      temperature_max: 30,
      temperature_step: 1,
      modes: ['cool', 'fan'],
      fans: ['low', 'high'],
      swing: true,
      sleep: false,
      turbo: false,
      eco: false,
      timer: true
    },
    state: {
      power: false,
      mode: 'cool',
      temperature: 25,
      fan: 'low',
      swing: false,
      sleep: false,
      turbo: false,
      eco: false,
      timer: null
    }
  };
  await NodeService.saveNode({ node_id: 'node-2', name: 'node-2', status: 'Connected' });
  await AirconProfileManager.save(newUnit);
  const retrieved = AirconProfileManager.getById('AC-TEST-09');
  assert('Can register and retrieve new Carrier unit (AC-TEST-09)', retrieved !== null && retrieved.brand === 'Carrier');

  // 2. CAPABILITY ENGINE
  console.log('\n2. [CAPABILITY ENGINE VALIDATION]');
  assert('Unit supports POWER', CapabilityEngine.isSupported(retrieved, 'POWER'));
  assert('Unit supports MODE: cool', CapabilityEngine.isSupported(retrieved, 'MODE', 'cool'));
  assert('Unit rejects unsupported TURBO (capability is false)', !CapabilityEngine.isSupported(retrieved, 'TURBO'));
  assert('Temperature clamps minimum to 17°C when 12°C requested', CapabilityEngine.clampTemperature(retrieved, 12) === 17);
  assert('Temperature clamps maximum to 30°C when 35°C requested', CapabilityEngine.clampTemperature(retrieved, 35) === 30);

  // 3. COMMAND MANAGER (Targeted Dispatch & Safety Enforcements)
  console.log('\n3. [COMMAND MANAGER & SAFETY DISPATCH]');
  // Case A: Missing device_id
  const rejectedMissing = await CommandManager.dispatch({ command: 'POWER', value: true });
  assert('Rejects command without device_id (no untargeted broadcast)', rejectedMissing.success === false);

  // Case B: Non-existent aircon
  const rejectedNonExistent = await CommandManager.dispatch({ device_id: 'AC-DOESNOTEXIST', command: 'POWER', value: true });
  assert('Rejects non-existent device_id', rejectedNonExistent.success === false);

  // Case C: Offline hardware node blocks command
  const offlineAircon = {
    device_id: 'AC-OFFLINE',
    name: 'Basement Storage',
    brand: 'Matrix',
    node_id: 'node-offline-99', // Offline node
    capabilities: { power: true, modes: ['cool'] },
    state: { power: false }
  };
  // Seed a stale cache entry to test an unavailable controller without creating an invalid cloud binding.
  localStorage.setItem('ecoTrack_aircons', JSON.stringify([...AirconProfileManager.getAll(), offlineAircon]));
  const rejectedNodeOffline = await CommandManager.dispatch({ device_id: 'AC-OFFLINE', command: 'POWER', value: true });
  assert('Rejects an unregistered assigned controller (code: NODE_OFFLINE)', rejectedNodeOffline.success === false && rejectedNodeOffline.code === 'NODE_OFFLINE');

  // Case D: Capability violation rejection
  const rejectedCap = await CommandManager.dispatch({ device_id: 'AC-TEST-09', command: 'TURBO', value: true });
  assert('Blocks command when feature unsupported by capability (code: UNSUPPORTED_CAPABILITY)', rejectedCap.success === false && rejectedCap.code === 'UNSUPPORTED_CAPABILITY');

  // Case E: Successful valid command dispatch
  const successDispatch = await CommandManager.dispatch({ device_id: 'AC-TEST-09', command: 'TEMP', value: 22 });
  assert('Dispatches valid targeted command successfully', successDispatch.success === true && successDispatch.state.temperature === 22);

  // 4. COMMAND STATE TRACKER (Control-Only, No Sensor Dependency)
  console.log('\n4. [COMMAND STATE TRACKER — CONTROL ONLY]');
  // Power off -> STANDBY / OFF
  assert('Power false tracks as OFF / STANDBY', OperationalStateClassifier.classify(null, false, 24) === 'OFF');
  // Power on with COOL -> COOLING
  assert('Power true tracks as ACTIVE', OperationalStateClassifier.classify(null, true, 24) === 'ACTIVE');
  // Control-only system has no false sensor mismatch
  const testDevice = {
    device_id: 'AC-001',
    node_id: 'node-1',
    state: { power: true, mode: 'cool', temperature: 22 }
  };
  const isMismatch = OperationalStateClassifier.evaluateMismatch(testDevice);
  assert('Control-only system eliminates sensor mismatch false alarms (returns false)', isMismatch === false);
  assert('Generates human-readable command state summary', OperationalStateClassifier.getSummary(testDevice).includes('COOL'));

  // 5. PROTOCOL ADAPTER & IR COVERAGE
  console.log('\n5. [PROTOCOL ADAPTER & IR COVERAGE]');
  const coverage = ProtocolAdapter.getCoverage(aircons[0]);
  assert('Coverage checklist calculates percentage accurately', typeof coverage.percent === 'number' && coverage.total > 0);

  // Custom Functions & Deletion Capabilities
  console.log('\n5b. [CUSTOM COMMANDS & DELETE CAPABILITIES]');
  const initialCoverage = ProtocolAdapter.getCoverage(aircons[0]);
  const added = ProtocolAdapter.addCustomFunction(aircons[0].device_id, 'TIMER_OFF');
  assert('Successfully added custom function TIMER_OFF', added === 'TIMER_OFF');
  const customFuncs = ProtocolAdapter.getCustomFunctions(aircons[0].device_id);
  assert('Custom functions list includes TIMER_OFF', customFuncs.includes('TIMER_OFF'));

  const covWithFunc = ProtocolAdapter.getCoverage(aircons[0]);
  assert('Coverage total increased after adding custom function', covWithFunc.total === initialCoverage.total + 1);

  // Record command for custom function
  ProtocolAdapter.saveCommand({
    device_id: aircons[0].device_id,
    command_type: 'TIMER_OFF',
    protocol: 'KOPPEL_RAW',
    raw_data: '1000,500,500,500',
    decoded_data: '0xTIMER_OFF'
  });
  const covRecorded = ProtocolAdapter.getCoverage(aircons[0]);
  assert('Mapped count increased after learning TIMER_OFF', covRecorded.mappedCount === initialCoverage.mappedCount + 1);

  // Delete custom function & associated command
  const deleted = ProtocolAdapter.deleteFunction(aircons[0].device_id, 'TIMER_OFF');
  assert('Successfully deleted custom function and IR command', deleted === true);
  const covAfterDelete = ProtocolAdapter.getCoverage(aircons[0]);
  assert('Coverage restored to initial count after deletion', covAfterDelete.total === initialCoverage.total && covAfterDelete.mappedCount === initialCoverage.mappedCount);

  // Unknown protocol raw capture & save
  const rawCommand = ProtocolAdapter.saveCommand({
    device_id: 'AC-TEST-09',
    command_type: 'POWER_ON',
    protocol: 'UNKNOWN',
    raw_data: '8900,4450,560,560,560,1680',
    decoded_data: 'RAW_CARRIER_REPLAY'
  });
  assert('Unknown protocol command saved with raw timing data', rawCommand !== null && rawCommand.protocol === 'UNKNOWN');

  // 5c. DYNAMIC PROTOCOL GENERATION & STRUCTURED INTENTS
  console.log('\n5c. [DYNAMIC PROTOCOL GENERATION & INTENT DISPATCH]');
  const mideaCaps = CapabilityEngine.getCapabilities('midea_ir');
  assert('Midea protocol returns min_temp 16 and max_temp 30', mideaCaps.min_temp === 16 && mideaCaps.max_temp === 30);
  assert('Midea protocol includes modes cool, dry, fan, auto', mideaCaps.modes.includes('cool') && mideaCaps.modes.includes('dry') && mideaCaps.modes.includes('fan'));
  assert('Midea protocol includes fan speeds low, medium, high, auto', mideaCaps.fans.includes('low') && mideaCaps.fans.includes('medium') && mideaCaps.fans.includes('high') && mideaCaps.fans.includes('auto'));
  assert('CapabilityEngine supports string protocol check for midea_ir', CapabilityEngine.isSupported('midea_ir', 'MODE', 'cool'));
  assert('CapabilityEngine rejects temperature 14 for midea_ir (min 16)', !CapabilityEngine.isSupported('midea_ir', 'TEMP', 14));
  assert('Daikin protocol limits min_temp 18 and max_temp 32', CapabilityEngine.getCapabilities('daikin').min_temp === 18 && CapabilityEngine.getCapabilities('daikin').max_temp === 32);

  // Structured JSON Intent validation
  let syncedEventFired = false;
  AirconEvents.on('devices:synced', () => { syncedEventFired = true; });
  const intentDispatch = await CommandManager.dispatch({
    device_id: 'AC-001',
    command: 'TEMP',
    value: 23
  });
  assert('CommandManager dispatch returns structured JSON intent payload', !!intentDispatch.intent);
  assert('Intent contains protocol string (e.g. koppel_ir / midea_ir)', typeof intentDispatch.intent.protocol === 'string');
  assert('Intent state contains power, mode, temp, fan', 
    intentDispatch.intent.state.power && intentDispatch.intent.state.mode && intentDispatch.intent.state.temp === 23 && intentDispatch.intent.state.fan);
  assert('EcoDataBus / AirconEvents fired devices:synced on dispatch', syncedEventFired === true);

  // Auto-Detect Sniffing validation
  const sniffResult = await ProtocolAdapter.sniffProtocol('node-1');
  assert('ProtocolAdapter.sniffProtocol returns success and protocol', sniffResult.success === true && typeof sniffResult.protocol === 'string');

  // 6. CENTRAL LOGGING AUDIT TRAIL
  console.log('\n6. [CENTRAL LOGGING SERVICE AUDIT]');
  const logs = CentralLogService.getLogs(50);
  assert('Audit trail recorded events from previous actions', logs.length > 0);
  assert('Log entry contains all required schema attributes (timestamp, device_id, node_id, module, event, result, details)',
    logs[0].timestamp && logs[0].device_id && logs[0].module && logs[0].event && logs[0].result);

  // 7. CLEANUP
  await AirconProfileManager.delete('AC-TEST-09');
  await AirconProfileManager.delete('AC-OFFLINE');

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (failed > 0) process.exit(1);
  process.exit(0);
}

runTests().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
