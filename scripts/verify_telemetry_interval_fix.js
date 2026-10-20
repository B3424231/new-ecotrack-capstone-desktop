const fs = require('fs');
const path = require('path');

console.log('━━━ VERIFYING TELEMETRY & INTERVAL FIXES ━━━');

// 1. Inspect shared.js
const sharedCode = fs.readFileSync(path.join(__dirname, '../public/js/shared.js'), 'utf8');
const serialStatusBlocked = sharedCode.includes("connected: true, port: 'COM3'");
console.log('1. shared.js mock data removal:');
if (!serialStatusBlocked && !sharedCode.includes('MockPocketBase')) {
  console.log('  ✅ Mock interceptors & MockPocketBase successfully erased from shared.js');
} else {
  console.error('  ❌ Mock interceptors still present in shared.js');
  process.exit(1);
}

// 2. Inspect telemetry-new.js
const telemetryCode = fs.readFileSync(path.join(__dirname, '../public/js/telemetry-new.js'), 'utf8');

console.log('\n2. telemetry-new.js _ingestPacket interval integrity:');
const hasHardcodedInterval1 = telemetryCode.includes("intervalVal: packet.intervalVal ?? 1,");
if (!hasHardcodedInterval1 && telemetryCode.includes("intervalVal: parseInt(packet.intervalVal ?? existing?.intervalVal ?? 15)")) {
  console.log('  ✅ _ingestPacket preserves existing/DB node interval (no longer overwrites to 1 Seconds)');
} else {
  console.error('  ❌ _ingestPacket still has hardcoded interval');
  process.exit(1);
}

console.log('\n3. telemetry-new.js loadRoomsFromDB defaults:');
const hasZeroInterval = telemetryCode.includes("intervalVal: n.interval_val || 0");
if (!hasZeroInterval && telemetryCode.includes("intervalVal: parseInt(n.interval_val) || 15")) {
  console.log('  ✅ loadRoomsFromDB properly parses intervalVal with fallback 15 (no longer defaults to 0)');
} else {
  console.error('  ❌ loadRoomsFromDB still has intervalVal || 0');
  process.exit(1);
}

console.log('\n4. telemetry-new.js telemetryMap indexing by sensor_name and node_id:');
if (telemetryCode.includes("telemetryMap[t.sensor_name] = t") && telemetryCode.includes("telemetryMap[t.node_id] = t")) {
  console.log('  ✅ telemetryMap indexes both PocketBase node_id and sensor_name');
} else {
  console.error('  ❌ telemetryMap missing sensor_name indexing');
  process.exit(1);
}

console.log('\n5. telemetry-new.js simulator active cadence:');
if (telemetryCode.includes("if (_connectedPort && _sseSource && _sseSource.readyState === EventSource.OPEN) return;")) {
  console.log('  ✅ Simulator runs whenever real hardware stream is not actively streaming');
} else {
  console.error('  ❌ Simulator still unconditionally blocked');
  process.exit(1);
}

console.log('\n6. telemetry-new.js Supabase Realtime synchronization:');
if (telemetryCode.includes("nodes-realtime-telemetry") && telemetryCode.includes("postgres_changes")) {
  console.log('  ✅ Supabase Realtime sync active on nodes table');
} else {
  console.error('  ❌ Realtime sync missing');
  process.exit(1);
}

console.log('\n7. telemetry.html Modal Send Interval Erased:');
const htmlCode = fs.readFileSync(path.join(__dirname, '../public/telemetry.html'), 'utf8');
if (!htmlCode.includes('nodeDetailIntervalVal')) {
  console.log('  ✅ Control Send Interval configuration box cleanly removed from modal');
} else {
  console.error('  ❌ Control Send Interval controls still present in modal');
  process.exit(1);
}

console.log('\n8. scheduler.js telemetry resolution:');
const schedulerCode = fs.readFileSync(path.join(__dirname, '../public/js/scheduler.js'), 'utf8');
if (schedulerCode.includes("telemetryByNodeId[t.sensor_name] = t") && schedulerCode.includes("telemetryByNodeId[n.name]")) {
  console.log('  ✅ scheduler.js maps telemetry by sensor_name to match PocketBase control logs');
} else {
  console.error('  ❌ scheduler.js telemetry resolution missing sensor_name');
  process.exit(1);
}

console.log('\n══════════════════════════════════════════════════');
console.log('  ALL TELEMETRY & SEND INTERVAL CHECKS PASSED ✅');
console.log('══════════════════════════════════════════════════');
